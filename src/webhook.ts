import { Context } from 'hono';
import type { Env, Profile, IdiomHistory, ReflectorProposal } from './types';
import { parseFeedback } from './agents/feedback';
import { reflect } from './agents/reflector';

// ---------------------------------------------------------------------------
// Request payload
// ---------------------------------------------------------------------------

type WebhookPayload = { from: string; body: string };

function parseWebhookPayload(raw: unknown): WebhookPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.from !== 'string') return null;
  if (typeof candidate.body !== 'string' || candidate.body === '') return null;
  return { from: candidate.from, body: candidate.body };
}

// ---------------------------------------------------------------------------
// Profile update
// ---------------------------------------------------------------------------

/**
 * Builds and runs a dynamic UPDATE against the profile row.
 *
 * Only columns present in the proposal are included in the SET clause, so the
 * Reflector can safely return partial updates. `updated_at` is always
 * refreshed whenever any real change is applied.
 *
 * The UPDATE is skipped entirely when the proposal has no fields — running an
 * empty SET clause would be a SQL error, and there is nothing to persist.
 */
async function applyProposalToProfile(
  env: Env,
  profile: Profile,
  proposal: ReflectorProposal,
): Promise<void> {
  const setClauses: string[] = [];
  const bindings: (string | number)[] = [];

  if (proposal.regional_preference !== undefined) {
    setClauses.push('regional_preference = ?');
    bindings.push(proposal.regional_preference);
  }
  if (proposal.vulgarity_tolerance !== undefined) {
    setClauses.push('vulgarity_tolerance = ?');
    bindings.push(proposal.vulgarity_tolerance);
  }
  if (proposal.common_vs_obscure !== undefined) {
    setClauses.push('common_vs_obscure = ?');
    bindings.push(proposal.common_vs_obscure);
  }
  if (proposal.themes !== undefined) {
    setClauses.push('themes = ?');
    bindings.push(JSON.stringify(proposal.themes));
  }
  if (proposal.no_list_additions !== undefined) {
    // Append new IDs to the existing list rather than replacing it wholesale.
    const existingIds: string[] = JSON.parse(profile.no_list);
    const mergedIds = [...existingIds, ...proposal.no_list_additions];
    setClauses.push('no_list = ?');
    bindings.push(JSON.stringify(mergedIds));
  }

  // Nothing to persist — skip rather than run `UPDATE profile SET WHERE id = 1`.
  if (setClauses.length === 0) return;

  // The Reflector decided something changed: always record when that happened.
  setClauses.push("updated_at = datetime('now')");

  const sql = `UPDATE profile SET ${setClauses.join(', ')} WHERE id = 1`;
  await env.DB.prepare(sql).bind(...bindings).run();
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  // 1. Parse and validate the inbound payload.
  let rawPayload: unknown;
  try {
    rawPayload = await c.req.json();
  } catch {
    return c.json({ error: 'invalid payload' }, 400);
  }

  const payload = parseWebhookPayload(rawPayload);
  if (payload === null) {
    return c.json({ error: 'invalid payload' }, 400);
  }

  const env = c.env;

  // 2. Read the current user profile (always id = 1).
  const profile = await env.DB.prepare('SELECT * FROM profile WHERE id = 1').first<Profile>();
  if (profile === null) throw new Error('Profile row not found');

  // 3. Read the most-recent idiom_history row (may be null if history is empty).
  const recentRow = await env.DB
    .prepare('SELECT * FROM idiom_history ORDER BY id DESC LIMIT 1')
    .first<IdiomHistory>();

  // 4. Parse the freeform reply text into structured feedback signals.
  const feedbackResult = await parseFeedback(env, payload.body);

  // 5. Ask the Reflector which profile fields to mutate.
  const proposal = await reflect(env, profile, feedbackResult);

  // 6. Persist the proposal (skipped automatically when proposal is empty).
  await applyProposalToProfile(env, profile, proposal);

  // 7. Store the raw feedback text on the history row so future Curator
  //    calls have access to what the user actually said.
  if (recentRow !== null) {
    await env.DB
      .prepare('UPDATE idiom_history SET user_feedback = ? WHERE id = ?')
      .bind(feedbackResult.raw, recentRow.id)
      .run();
  }

  return c.json({ ok: true });
}
