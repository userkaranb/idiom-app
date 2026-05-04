import { Context } from 'hono';
import type { Env, Profile, IdiomHistory, ReflectorProposal } from './types';
import { parseFeedback } from './agents/feedback';
import { reflect } from './agents/reflector';

// ---------------------------------------------------------------------------
// Twilio signature verification
//
// Twilio signs every inbound webhook POST with HMAC-SHA1 over:
//   URL + alphabetically-sorted(paramKey + paramValue pairs concatenated)
// See: https://www.twilio.com/docs/usage/webhooks/webhooks-security
//
// We use the Web Crypto API (available natively in the Workers runtime) rather
// than importing Twilio's node-side validator, which carries Node.js deps that
// are unnecessary here.
// ---------------------------------------------------------------------------

async function verifyTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): Promise<boolean> {
  const sortedParams = Object.keys(params).sort()
    .map(key => key + params[key])
    .join('');
  const stringToSign = url + sortedParams;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign));
  const computed = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return computed === signature;
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
  // 1. Verify the Twilio signature before trusting any of the payload.
  //    Twilio POSTs application/x-www-form-urlencoded, so we parse the body
  //    first (needed for the signature calculation), then verify.
  const signature = c.req.header('x-twilio-signature') ?? '';
  const formData = await c.req.parseBody() as Record<string, string>;

  const isValid = await verifyTwilioSignature(
    c.env.TWILIO_AUTH_TOKEN,
    signature,
    c.req.url,
    formData,
  );
  if (!isValid) {
    return c.text('Forbidden', 403);
  }

  // 2. Extract Twilio's canonical field names (capital-F From, capital-B Body).
  const from = formData['From'];
  const body = formData['Body'];

  if (typeof from !== 'string' || from === '') {
    return c.json({ error: 'invalid payload' }, 400);
  }
  if (typeof body !== 'string' || body === '') {
    return c.json({ error: 'invalid payload' }, 400);
  }

  const env = c.env;

  // 3. Read the current user profile (always id = 1).
  const profile = await env.DB.prepare('SELECT * FROM profile WHERE id = 1').first<Profile>();
  if (profile === null) throw new Error('Profile row not found');

  // 4. Read the most-recent idiom_history row (may be null if history is empty).
  const recentRow = await env.DB
    .prepare('SELECT * FROM idiom_history ORDER BY id DESC LIMIT 1')
    .first<IdiomHistory>();

  // 5. Parse the freeform reply text into structured feedback signals.
  const feedbackResult = await parseFeedback(env, body);

  // 6. Ask the Reflector which profile fields to mutate.
  const proposal = await reflect(env, profile, feedbackResult);

  // 7. Persist the proposal (skipped automatically when proposal is empty).
  await applyProposalToProfile(env, profile, proposal);

  // 8. Store the raw feedback text on the history row so future Curator
  //    calls have access to what the user actually said.
  if (recentRow !== null) {
    await env.DB
      .prepare('UPDATE idiom_history SET user_feedback = ? WHERE id = ?')
      .bind(feedbackResult.raw, recentRow.id)
      .run();
  }

  return c.json({ ok: true });
}
