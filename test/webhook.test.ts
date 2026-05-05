import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, Profile, IdiomHistory, FeedbackResult, ReflectorProposal } from '../src/types';

// Hoisted so the mock factories below can reference them.
const { mockParseFeedback, mockReflect } = vi.hoisted(() => ({
  mockParseFeedback: vi.fn(),
  mockReflect: vi.fn(),
}));

vi.mock('../src/agents/feedback', () => ({ parseFeedback: mockParseFeedback }));
vi.mock('../src/agents/reflector', () => ({ reflect: mockReflect }));

import { handleWebhook } from '../src/webhook';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_AUTH_TOKEN = 'test-auth-token';
const WEBHOOK_URL = 'http://localhost/webhook';

const baseProfile: Profile = {
  id: 1,
  regional_preference: 'general',
  vulgarity_tolerance: 0,
  themes: '["food","work"]',
  common_vs_obscure: 2,
  no_list: '[]',
  updated_at: '2024-01-01T00:00:00Z',
};

const baseHistory: IdiomHistory = {
  id: 42,
  sent_at: '2024-01-01T13:00:00Z',
  idiom_id: 'some-idiom',
  idiom_text: 'texto',
  colloquialism_id: 'some-coll',
  colloquialism_text: 'texto2',
  curator_justification: 'good fit',
  user_rating: null,
  user_feedback: null,
};

const baseFeedback: FeedbackResult = {
  sentiment: 'positive',
  wants_more_colloquial: null,
  wants_more_formal: null,
  wants_more_vulgar: null,
  wants_less_vulgar: null,
  theme_mentions: [],
  raw: 'great!',
};

// ---------------------------------------------------------------------------
// Signature helpers
//
// Implements the Twilio HMAC-SHA1 algorithm so tests can produce valid
// signatures without contacting the Twilio API.
// ---------------------------------------------------------------------------

/**
 * Computes the HMAC-SHA1 signature Twilio uses to authenticate inbound
 * webhook requests. Matches the algorithm documented at
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security.
 */
async function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): Promise<string> {
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
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock D1 environment whose `.first()` calls return the provided
 * fixtures in order (profile first, then recentRow). All `.bind().run()` and
 * bare `.run()` calls resolve immediately and are tracked via `bindMock` /
 * `runMock` so tests can inspect what SQL and arguments were used.
 */
function buildMockEnv({
  profile,
  recentRow,
}: {
  profile: Profile | null;
  recentRow: IdiomHistory | null;
}): { env: Env; prepareMock: ReturnType<typeof vi.fn>; bindMock: ReturnType<typeof vi.fn>; runMock: ReturnType<typeof vi.fn> } {
  const runMock = vi.fn().mockResolvedValue({});
  const bindMock = vi.fn().mockReturnValue({ run: runMock });

  let firstCallIndex = 0;
  const firstResults: Array<Profile | IdiomHistory | null> = [profile, recentRow];

  const prepareMock = vi.fn().mockReturnValue({
    first: vi.fn(() => Promise.resolve(firstResults[firstCallIndex++])),
    bind: bindMock,
    run: runMock,
  });

  const env: Env = {
    DB: { prepare: prepareMock } as unknown as D1Database,
    ANTHROPIC_API_KEY: 'test-key',
    TWILIO_ACCOUNT_SID: 'AC-test-sid',
    TWILIO_AUTH_TOKEN: TEST_AUTH_TOKEN,
    TWILIO_FROM_NUMBER: 'whatsapp:+14155238886',
    TWILIO_TO_NUMBER: 'whatsapp:+15551234567',
  };

  return { env, prepareMock, bindMock, runMock };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('POST /webhook', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    mockParseFeedback.mockReset();
    mockReflect.mockReset();

    // Default agent responses — individual tests override as needed.
    mockParseFeedback.mockResolvedValue(baseFeedback);
    mockReflect.mockResolvedValue({} as ReflectorProposal);

    app = new Hono<{ Bindings: Env }>();
    app.post('/webhook', handleWebhook);
  });

  /**
   * Posts a form-urlencoded Twilio-style request to /webhook.
   * Pass `signatureOverride` to test an invalid or missing signature.
   */
  async function postTwilio(
    params: Record<string, string>,
    env: Env,
    signatureOverride?: string | null,
  ): Promise<Response> {
    const signature = signatureOverride !== undefined
      ? signatureOverride
      : await computeTwilioSignature(TEST_AUTH_TOKEN, WEBHOOK_URL, params);

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (signature !== null) {
      headers['X-Twilio-Signature'] = signature as string;
    }

    return app.request(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: new URLSearchParams(params).toString(),
    }, env);
  }

  // -- Signature verification ------------------------------------------------

  it('returns 403 when the X-Twilio-Signature header is missing', async () => {
    const { env } = buildMockEnv({ profile: baseProfile, recentRow: null });
    const response = await postTwilio(
      { From: 'whatsapp:+14155551234', Body: 'hello' },
      env,
      null,                   // omit signature header entirely
    );
    expect(response.status).toBe(403);
  });

  it('returns 403 when the X-Twilio-Signature header is wrong', async () => {
    const { env } = buildMockEnv({ profile: baseProfile, recentRow: null });
    const response = await postTwilio(
      { From: 'whatsapp:+14155551234', Body: 'hello' },
      env,
      'invalid-signature',    // correct format, wrong value
    );
    expect(response.status).toBe(403);
  });

  it('proceeds past 403 when a valid signature is provided', async () => {
    const { env } = buildMockEnv({ profile: baseProfile, recentRow: null });
    const response = await postTwilio(
      { From: 'whatsapp:+14155551234', Body: 'loved it' },
      env,
    );
    // Signature is valid — should reach the feedback flow, not 403.
    expect(response.status).not.toBe(403);
  });

  // -- Validation (checked after signature passes) --------------------------

  it('returns 400 when the From field is absent', async () => {
    const { env } = buildMockEnv({ profile: baseProfile, recentRow: null });
    const response = await postTwilio({ Body: 'some text' }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  it('returns 400 when the Body field is absent', async () => {
    const { env } = buildMockEnv({ profile: baseProfile, recentRow: null });
    const response = await postTwilio({ From: 'whatsapp:+14155551234' }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  it('returns 400 when the Body field is an empty string', async () => {
    const { env } = buildMockEnv({ profile: baseProfile, recentRow: null });
    const response = await postTwilio({ From: 'whatsapp:+14155551234', Body: '' }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  // -- Happy path ----------------------------------------------------------

  it('returns 200 with {ok:true} for a well-formed signed request', async () => {
    const { env } = buildMockEnv({ profile: baseProfile, recentRow: null });
    const response = await postTwilio(
      { From: 'whatsapp:+14155551234', Body: 'loved it, more like this please' },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  // -- UPDATE skipped when proposal is empty --------------------------------

  it('skips the profile UPDATE entirely when the proposal has no fields', async () => {
    mockReflect.mockResolvedValue({} as ReflectorProposal);
    const { env, prepareMock } = buildMockEnv({ profile: baseProfile, recentRow: null });

    await postTwilio({ From: 'whatsapp:+1', Body: 'ok' }, env);

    const executedSqls = prepareMock.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(executedSqls.some((sql) => sql.startsWith('UPDATE profile'))).toBe(false);
  });

  // -- updated_at always included when UPDATE runs -------------------------

  it('includes updated_at = datetime("now") in the profile UPDATE when the proposal has fields', async () => {
    mockReflect.mockResolvedValue({ regional_preference: 'Spain' } as ReflectorProposal);
    const { env, prepareMock } = buildMockEnv({ profile: baseProfile, recentRow: null });

    await postTwilio({ From: 'whatsapp:+1', Body: 'más español de España' }, env);

    const executedSqls = prepareMock.mock.calls.map((call: unknown[]) => call[0] as string);
    const updateSql = executedSqls.find((sql) => sql.startsWith('UPDATE profile'));
    expect(updateSql).toBeDefined();
    expect(updateSql).toContain("updated_at = datetime('now')");
  });

  // -- no_list merging -----------------------------------------------------

  it('merges no_list_additions with the existing no_list instead of replacing it wholesale', async () => {
    const profileWithExistingNoList: Profile = { ...baseProfile, no_list: '["old-id"]' };
    mockReflect.mockResolvedValue({ no_list_additions: ['new-id'] } as ReflectorProposal);

    const { env, bindMock } = buildMockEnv({ profile: profileWithExistingNoList, recentRow: null });

    await postTwilio({ From: 'whatsapp:+1', Body: 'disliked that one' }, env);

    const firstBindCallArgs = bindMock.mock.calls[0] as unknown[];
    const noListArg = firstBindCallArgs[0] as string;
    expect(JSON.parse(noListArg)).toEqual(['old-id', 'new-id']);
  });

  it('treats no_list_additions as an empty list when it is absent from the proposal', async () => {
    mockReflect.mockResolvedValue({ vulgarity_tolerance: 1 } as ReflectorProposal);

    const { env, prepareMock } = buildMockEnv({ profile: baseProfile, recentRow: null });

    await postTwilio({ From: 'whatsapp:+1', Body: 'mild slang is fine' }, env);

    const executedSqls = prepareMock.mock.calls.map((call: unknown[]) => call[0] as string);
    const updateSql = executedSqls.find((sql) => sql.startsWith('UPDATE profile'));
    expect(updateSql).toBeDefined();
    expect(updateSql).not.toContain('no_list');
  });

  // -- idiom_history update ------------------------------------------------

  it('updates user_feedback on the most recent idiom_history row when one exists', async () => {
    const rawFeedback = 'loved it, more like this please';
    mockParseFeedback.mockResolvedValue({ ...baseFeedback, raw: rawFeedback });
    mockReflect.mockResolvedValue({} as ReflectorProposal);

    const { env, prepareMock, bindMock } = buildMockEnv({
      profile: baseProfile,
      recentRow: baseHistory,
    });

    await postTwilio({ From: 'whatsapp:+1', Body: rawFeedback }, env);

    const executedSqls = prepareMock.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(executedSqls.some((sql) => sql.includes('UPDATE idiom_history'))).toBe(true);

    const historyBindArgs = bindMock.mock.calls[0] as unknown[];
    expect(historyBindArgs[0]).toBe(rawFeedback);
    expect(historyBindArgs[1]).toBe(baseHistory.id);
  });

  it('skips the idiom_history UPDATE when no recent row exists', async () => {
    mockReflect.mockResolvedValue({} as ReflectorProposal);
    const { env, prepareMock } = buildMockEnv({ profile: baseProfile, recentRow: null });

    await postTwilio({ From: 'whatsapp:+1', Body: 'cool' }, env);

    const executedSqls = prepareMock.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(executedSqls.some((sql) => sql.includes('UPDATE idiom_history'))).toBe(false);
  });
});
