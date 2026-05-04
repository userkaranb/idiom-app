import type { Context } from 'hono';
import type { Env, Profile, IdiomHistory, ReflectorProposal } from './types';
import { parseFeedback } from './agents/feedback';
import { reflect } from './agents/reflector';

export async function handleWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  // 1. Parse and validate request body
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'invalid payload' }, 400);
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as Record<string, unknown>).from !== 'string' ||
    typeof (payload as Record<string, unknown>).body !== 'string' ||
    (payload as Record<string, unknown>).body === ''
  ) {
    return c.json({ error: 'invalid payload' }, 400);
  }

  const { from: _from, body } = payload as { from: string; body: string };
  const env = c.env;

  // 2. Read the current profile
  const profileResult = await env.DB.prepare(
    'SELECT * FROM profile WHERE id = 1',
  ).all<Profile>();
  const profile = profileResult.results[0];
  if (!profile) {
    return c.json({ error: 'profile not found' }, 500);
  }

  // 3. Read the most-recent idiom_history row (may be null — handle gracefully)
  const historyResult = await env.DB.prepare(
    'SELECT * FROM idiom_history ORDER BY id DESC LIMIT 1',
  ).all<IdiomHistory>();
  const recentRow = historyResult.results[0] ?? null;

  // 4. Parse the user's feedback into structured signals
  const feedbackResult = await parseFeedback(env, body);

  // 5. Ask the Reflector which profile fields to mutate
  const proposal = await reflect(env, profile, feedbackResult);

  // 6. Apply the proposal to D1 (skipped entirely when the Reflector proposes nothing)
  await applyProfileUpdate(env, profile, proposal);

  // 7. Record the user's raw feedback on the most-recent history row
  if (recentRow !== null) {
    await env.DB.prepare(
      'UPDATE idiom_history SET user_feedback = ? WHERE id = ?',
    ).bind(feedbackResult.raw, recentRow.id).run();
  }

  return c.json({ ok: true });
}

// ---------------------------------------------------------------------------
// applyProfileUpdate
//
// Builds a dynamic SET clause from whatever fields the Reflector proposed.
// Only columns present in the proposal are included; `updated_at` is always
// refreshed when the UPDATE runs. If the proposal is entirely empty the
// function returns without touching D1 — an empty SET clause would be
// invalid SQL and also meaningless.
// ---------------------------------------------------------------------------

async function applyProfileUpdate(
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

  // Merge additions into the existing no_list rather than replacing it.
  // Treat undefined additions as an empty array (spec requirement).
  const noListAdditions = proposal.no_list_additions ?? [];
  if (noListAdditions.length > 0) {
    const existingNoList: string[] = JSON.parse(profile.no_list);
    const mergedNoList = [...existingNoList, ...noListAdditions];
    setClauses.push('no_list = ?');
    bindings.push(JSON.stringify(mergedNoList));
  }

  if (setClauses.length === 0) {
    return; // Reflector decided nothing should change — skip the UPDATE entirely
  }

  // updated_at is a SQL expression, not a bound value, so it goes directly
  // into the clause list rather than the bindings array.
  setClauses.push("updated_at = datetime('now')");

  const sql = `UPDATE profile SET ${setClauses.join(', ')} WHERE id = 1`;
  await env.DB.prepare(sql).bind(...(bindings as unknown[])).run();
}
