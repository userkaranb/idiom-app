import { Context } from 'hono';
import type { Env } from './types';
import type { Repos } from './db';
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
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles an inbound Twilio WhatsApp reply.
 *
 * Flow: verify signature → parse Twilio form body → read profile → read
 * most-recent history row → Feedback agent → Reflector agent → persist
 * proposal → persist raw feedback.
 *
 * `repos` is constructed once per request in `src/index.ts` from the D1 binding;
 * this handler never touches the raw D1 binding directly.
 */
export async function handleWebhook(
  c: Context<{ Bindings: Env }>,
  repos: Repos,
): Promise<Response> {
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
  const profile = await repos.profile.getCurrent();

  // 4. Read the most-recent idiom_history row (may be null if history is empty).
  const recentRow = await repos.idiomHistory.getMostRecent();

  // 5. Parse the freeform reply text into structured feedback signals.
  const feedbackResult = await parseFeedback(env, body);

  // 6. Ask the Reflector which profile fields to mutate.
  const proposal = await reflect(env, profile, feedbackResult);

  // 7. Persist the proposal (skipped automatically when proposal is empty).
  await repos.profile.applyReflectorChanges(proposal);

  // 8. Store the raw feedback text on the history row so future Curator
  //    calls have access to what the user actually said.
  if (recentRow !== null) {
    await repos.idiomHistory.recordFeedback(recentRow.id, feedbackResult.raw);
  }

  return c.json({ ok: true });
}
