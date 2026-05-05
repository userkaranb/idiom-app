/**
 * Integration tests for the profile-update path of POST /webhook.
 *
 * Covers: input validation (HTTP 400 / HTTP 200), the profile UPDATE SQL
 * (skipped when the proposal is empty, constructed dynamically otherwise),
 * and no_list merging math.
 *
 * parseFeedback and reflect are mocked at the module level so no Anthropic
 * API key is required. D1Database is satisfied with a plain JS object rather
 * than a formal vi.mock(), keeping the tests free of cloudflare:test imports.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, Profile, IdiomHistory, FeedbackResult, ReflectorProposal } from '../src/types';

// ---------------------------------------------------------------------------
// Module-level mocks (agents only — not the Anthropic SDK)
// ---------------------------------------------------------------------------

const { mockParseFeedback, mockReflect } = vi.hoisted(() => ({
  mockParseFeedback: vi.fn(),
  mockReflect:       vi.fn(),
}));

vi.mock('../src/agents/feedback',  () => ({ parseFeedback: mockParseFeedback }));
vi.mock('../src/agents/reflector', () => ({ reflect:        mockReflect       }));

import { handleWebhook } from '../src/webhook';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_AUTH_TOKEN = 'test-auth-token';
const WEBHOOK_URL = 'http://localhost/webhook';

const BASE_PROFILE: Profile = {
  id: 1,
  regional_preference: 'general',
  vulgarity_tolerance: 0,
  themes: '["work","food"]',
  common_vs_obscure: 2,
  no_list: '[]',
  updated_at: '2024-01-01T00:00:00Z',
};

const NEUTRAL_FEEDBACK: FeedbackResult = {
  sentiment: 'neutral',
  wants_more_colloquial: null,
  wants_more_formal:     null,
  wants_more_vulgar:     null,
  wants_less_vulgar:     null,
  theme_mentions: [],
  raw: 'ok',
};

// ---------------------------------------------------------------------------
// Signature helper
//
// Implements the Twilio HMAC-SHA1 algorithm locally so tests produce valid
// signatures without contacting the Twilio API.
// ---------------------------------------------------------------------------

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
// D1 mock factory
//
// Returns a plain JS object that implements the D1Database surface used by
// handleWebhook. No vi.mock('D1Database') — the object is constructed directly.
// ---------------------------------------------------------------------------

function buildMockEnv(
  profile: Profile,
  recentRow: IdiomHistory | null = null,
) {
  let firstCallIndex = 0;
  const firstResults: Array<Profile | IdiomHistory | null> = [profile, recentRow];

  const runMock  = vi.fn().mockResolvedValue({});
  const bindMock = vi.fn().mockReturnValue({ run: runMock });

  const prepareMock = vi.fn().mockReturnValue({
    first: vi.fn(() => Promise.resolve(firstResults[firstCallIndex++])),
    bind:  bindMock,
    run:   runMock,
  });

  const env: Env = {
    DB: { prepare: prepareMock } as unknown as D1Database,
    ANTHROPIC_API_KEY: '',
    TWILIO_ACCOUNT_SID: 'AC-test-sid',
    TWILIO_AUTH_TOKEN: TEST_AUTH_TOKEN,
    TWILIO_FROM_NUMBER: 'whatsapp:+14155238886',
    TWILIO_TO_NUMBER: 'whatsapp:+15551234567',
  };

  return { env, prepareMock, bindMock, runMock };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/webhook', handleWebhook);
  return app;
}

/**
 * Posts a Twilio-style form-urlencoded request with a valid signature.
 * `From` and `Body` are the Twilio field names for sender and message text.
 */
async function postTwilio(
  app: Hono<{ Bindings: Env }>,
  params: Record<string, string>,
  env: Env,
): Promise<Response> {
  const signature = await computeTwilioSignature(TEST_AUTH_TOKEN, WEBHOOK_URL, params);
  return app.request(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
    },
    body: new URLSearchParams(params).toString(),
  }, env);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /webhook — profile update', () => {
  beforeEach(() => {
    mockParseFeedback.mockReset();
    mockReflect.mockReset();
    mockParseFeedback.mockResolvedValue(NEUTRAL_FEEDBACK);
    mockReflect.mockResolvedValue({} as ReflectorProposal);
  });

  // -- Input validation (HTTP 400) ------------------------------------------

  it('returns 400 with {error:"invalid payload"} when the From field is absent', async () => {
    const { env } = buildMockEnv(BASE_PROFILE);
    const response = await postTwilio(buildApp(), { Body: 'some text' }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  it('returns 400 when "Body" is an empty string', async () => {
    const { env } = buildMockEnv(BASE_PROFILE);
    const response = await postTwilio(buildApp(), { From: 'whatsapp:+14155551234', Body: '' }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  // -- Happy path (HTTP 200) ------------------------------------------------

  it('returns 200 with {ok:true} for a well-formed request', async () => {
    const { env } = buildMockEnv(BASE_PROFILE);
    const response = await postTwilio(
      buildApp(),
      { From: 'whatsapp:+14155551234', Body: 'loved it, more like this please' },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  // -- Profile UPDATE logic --------------------------------------------------

  it('skips the profile UPDATE entirely when the Reflector proposal is empty', async () => {
    mockReflect.mockResolvedValue({} as ReflectorProposal);
    const { env, prepareMock } = buildMockEnv(BASE_PROFILE);

    await postTwilio(buildApp(), { From: 'whatsapp:+1', Body: 'ok' }, env);

    const executedSqls = (prepareMock.mock.calls as [string][]).map(([sql]) => sql);
    expect(executedSqls.some((sql) => sql.startsWith('UPDATE profile'))).toBe(false);
  });

  it('runs a profile UPDATE that includes updated_at when the proposal has fields', async () => {
    mockReflect.mockResolvedValue({ regional_preference: 'Spain' } as ReflectorProposal);
    const { env, prepareMock } = buildMockEnv(BASE_PROFILE);

    await postTwilio(buildApp(), { From: 'whatsapp:+1', Body: 'más español de España' }, env);

    const executedSqls = (prepareMock.mock.calls as [string][]).map(([sql]) => sql);
    const updateSql = executedSqls.find((sql) => sql.startsWith('UPDATE profile'));
    expect(updateSql).toBeDefined();
    expect(updateSql).toContain("updated_at = datetime('now')");
  });

  it('merges no_list_additions into the existing no_list rather than replacing it', async () => {
    const profileWithEntries: Profile = { ...BASE_PROFILE, no_list: '["existing-id"]' };
    mockReflect.mockResolvedValue({ no_list_additions: ['new-id'] } as ReflectorProposal);

    const { env, bindMock } = buildMockEnv(profileWithEntries);
    await postTwilio(buildApp(), { From: 'whatsapp:+1', Body: 'disliked that one' }, env);

    // The only bind call with a no_list argument comes from the UPDATE profile SQL.
    // Its first argument is the JSON-serialised merged list.
    const noListArg = (bindMock.mock.calls[0] as unknown[])[0] as string;
    expect(JSON.parse(noListArg)).toEqual(['existing-id', 'new-id']);
  });
});
