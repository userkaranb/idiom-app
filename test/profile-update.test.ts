/**
 * Integration tests for the profile-update path of POST /webhook.
 *
 * Covers: input validation (HTTP 400 / HTTP 200), the profile update call
 * (skipped when the proposal is empty, constructed dynamically otherwise),
 * and no_list merging math (which is now encapsulated in ProfileRepo).
 *
 * parseFeedback and reflect are mocked at the module level so no Anthropic
 * API key is required. The Repos interface is satisfied with plain JS objects
 * rather than a real D1 database, keeping the tests fast and focused on
 * webhook behaviour rather than SQL correctness.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, Profile, IdiomHistory, FeedbackResult, ReflectorProposal } from '../src/types';
import type { Repos } from '../src/db';

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
// Repo mock factory
//
// Returns a plain JS object that implements the Repos surface used by
// handleWebhook. `applyReflectorChanges` is a vi.fn() stub so tests can
// inspect what proposals were passed.
// ---------------------------------------------------------------------------

function buildMockRepos(
  profile: Profile,
  recentRow: IdiomHistory | null = null,
) {
  const applyReflectorChanges = vi.fn().mockResolvedValue(profile);
  const recordFeedback        = vi.fn().mockResolvedValue(undefined);

  const repos: Repos = {
    profile: {
      getCurrent: vi.fn().mockResolvedValue(profile),
      applyReflectorChanges,
    },
    idiomHistory: {
      listAllSentHistory: vi.fn().mockResolvedValue([]),
      getMostRecent:      vi.fn().mockResolvedValue(recentRow),
      recordSent:         vi.fn().mockResolvedValue(undefined),
      recordFeedback,
      listRecent:         vi.fn().mockResolvedValue([]),
      containsPhrase:     vi.fn().mockResolvedValue(false),
    },
  };

  return { repos, applyReflectorChanges, recordFeedback };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildApp(repos: Repos) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/webhook', (c) => handleWebhook(c, repos));
  return app;
}

function buildEnv(): Env {
  return {
    DB: {} as D1Database,
    ANTHROPIC_API_KEY: '',
    TWILIO_ACCOUNT_SID: 'AC-test-sid',
    TWILIO_AUTH_TOKEN: TEST_AUTH_TOKEN,
    TWILIO_FROM_NUMBER: '+15702184457',
    TWILIO_TO_NUMBER: '+15551234567',
  };
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
    const { repos } = buildMockRepos(BASE_PROFILE);
    const response = await postTwilio(buildApp(repos), { Body: 'some text' }, buildEnv());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  it('returns 400 when "Body" is an empty string', async () => {
    const { repos } = buildMockRepos(BASE_PROFILE);
    const response = await postTwilio(buildApp(repos), { From: '+14155551234', Body: '' }, buildEnv());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  // -- Happy path (HTTP 200) ------------------------------------------------

  it('returns 200 with {ok:true} for a well-formed request', async () => {
    const { repos } = buildMockRepos(BASE_PROFILE);
    const response = await postTwilio(
      buildApp(repos),
      { From: '+14155551234', Body: 'loved it, more like this please' },
      buildEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  // -- Profile UPDATE logic --------------------------------------------------

  it('calls applyReflectorChanges with an empty proposal when the Reflector returns no fields', async () => {
    mockReflect.mockResolvedValue({} as ReflectorProposal);
    const { repos, applyReflectorChanges } = buildMockRepos(BASE_PROFILE);

    await postTwilio(buildApp(repos), { From: '+1', Body: 'ok' }, buildEnv());

    // The webhook always delegates to the repo — it does not pre-check for
    // emptiness. The repo itself skips the SQL UPDATE when the proposal is empty.
    expect(applyReflectorChanges).toHaveBeenCalledWith({});
  });

  it('calls applyReflectorChanges with the Reflector proposal when it has fields', async () => {
    const proposal: ReflectorProposal = { regional_preference: 'Spain' };
    mockReflect.mockResolvedValue(proposal);
    const { repos, applyReflectorChanges } = buildMockRepos(BASE_PROFILE);

    await postTwilio(buildApp(repos), { From: '+1', Body: 'más español de España' }, buildEnv());

    expect(applyReflectorChanges).toHaveBeenCalledWith(proposal);
  });

  it('passes no_list_additions to applyReflectorChanges rather than merging in the webhook', async () => {
    const proposal: ReflectorProposal = { no_list_additions: ['new-id'] };
    mockReflect.mockResolvedValue(proposal);

    const { repos, applyReflectorChanges } = buildMockRepos(BASE_PROFILE);
    await postTwilio(buildApp(repos), { From: '+1', Body: 'disliked that one' }, buildEnv());

    // Merging logic lives inside ProfileRepo.applyReflectorChanges —
    // the webhook simply forwards the proposal as-is.
    expect(applyReflectorChanges).toHaveBeenCalledWith(proposal);
  });
});
