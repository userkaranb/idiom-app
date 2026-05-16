import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, Profile, IdiomHistory, FeedbackResult, ReflectorProposal } from '../src/types';
import type { Repos } from '../src/db';

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
 * Creates a mock Repos whose method stubs are independently trackable via vi.fn().
 * `getCurrent` returns the provided profile fixture (or throws if null, mirroring
 * the real repo). `getMostRecent` returns the provided history row (or null).
 * All write methods resolve immediately.
 */
function buildMockRepos({
  profile,
  recentRow,
}: {
  profile: Profile | null;
  recentRow: IdiomHistory | null;
}): {
  repos: Repos;
  getCurrent: ReturnType<typeof vi.fn>;
  applyReflectorChanges: ReturnType<typeof vi.fn>;
  getMostRecent: ReturnType<typeof vi.fn>;
  recordFeedback: ReturnType<typeof vi.fn>;
} {
  const getCurrent = vi.fn(async () => {
    if (!profile) throw new Error('Profile row not found');
    return profile;
  });
  const applyReflectorChanges = vi.fn().mockResolvedValue(profile ?? baseProfile);
  const getMostRecent         = vi.fn().mockResolvedValue(recentRow);
  const recordFeedback        = vi.fn().mockResolvedValue(undefined);
  const recordSent            = vi.fn().mockResolvedValue(undefined);
  const listAllSentHistory    = vi.fn().mockResolvedValue([]);
  const listRecent            = vi.fn().mockResolvedValue([]);
  const containsPhrase        = vi.fn().mockResolvedValue(false);

  const repos: Repos = {
    profile:      { getCurrent, applyReflectorChanges },
    idiomHistory: { listAllSentHistory, getMostRecent, recordSent, recordFeedback, listRecent, containsPhrase },
  };

  return { repos, getCurrent, applyReflectorChanges, getMostRecent, recordFeedback };
}

function buildEnv(): Env {
  return {
    DB: {} as D1Database,
    ANTHROPIC_API_KEY: 'test-key',
    TWILIO_ACCOUNT_SID: 'AC-test-sid',
    TWILIO_AUTH_TOKEN: TEST_AUTH_TOKEN,
    TWILIO_FROM_NUMBER: '+15702184457',
    TWILIO_TO_NUMBER: '+15551234567',
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('POST /webhook', () => {
  beforeEach(() => {
    mockParseFeedback.mockReset();
    mockReflect.mockReset();

    // Default agent responses — individual tests override as needed.
    mockParseFeedback.mockResolvedValue(baseFeedback);
    mockReflect.mockResolvedValue({} as ReflectorProposal);
  });

  /**
   * Posts a form-urlencoded Twilio-style request to /webhook.
   * Pass `signatureOverride` to test an invalid or missing signature.
   */
  async function postTwilio(
    params: Record<string, string>,
    env: Env,
    repos: Repos,
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

    const app = new Hono<{ Bindings: Env }>();
    app.post('/webhook', (c) => handleWebhook(c, repos));
    return app.request(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: new URLSearchParams(params).toString(),
    }, env);
  }

  // -- Signature verification ------------------------------------------------

  it('returns 403 when the X-Twilio-Signature header is missing', async () => {
    const env = buildEnv();
    const { repos } = buildMockRepos({ profile: baseProfile, recentRow: null });
    const response = await postTwilio(
      { From: '+14155551234', Body: 'hello' },
      env,
      repos,
      null,                   // omit signature header entirely
    );
    expect(response.status).toBe(403);
  });

  it('returns 403 when the X-Twilio-Signature header is wrong', async () => {
    const env = buildEnv();
    const { repos } = buildMockRepos({ profile: baseProfile, recentRow: null });
    const response = await postTwilio(
      { From: '+14155551234', Body: 'hello' },
      env,
      repos,
      'invalid-signature',    // correct format, wrong value
    );
    expect(response.status).toBe(403);
  });

  it('proceeds past 403 when a valid signature is provided', async () => {
    const env = buildEnv();
    const { repos } = buildMockRepos({ profile: baseProfile, recentRow: null });
    const response = await postTwilio(
      { From: '+14155551234', Body: 'loved it' },
      env,
      repos,
    );
    // Signature is valid — should reach the feedback flow, not 403.
    expect(response.status).not.toBe(403);
  });

  // -- Validation (checked after signature passes) --------------------------

  it('returns 400 when the From field is absent', async () => {
    const env = buildEnv();
    const { repos } = buildMockRepos({ profile: baseProfile, recentRow: null });
    const response = await postTwilio({ Body: 'some text' }, env, repos);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  it('returns 400 when the Body field is absent', async () => {
    const env = buildEnv();
    const { repos } = buildMockRepos({ profile: baseProfile, recentRow: null });
    const response = await postTwilio({ From: '+14155551234' }, env, repos);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  it('returns 400 when the Body field is an empty string', async () => {
    const env = buildEnv();
    const { repos } = buildMockRepos({ profile: baseProfile, recentRow: null });
    const response = await postTwilio({ From: '+14155551234', Body: '' }, env, repos);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  // -- Happy path ----------------------------------------------------------

  it('returns 200 with {ok:true} for a well-formed signed request', async () => {
    const env = buildEnv();
    const { repos } = buildMockRepos({ profile: baseProfile, recentRow: null });
    const response = await postTwilio(
      { From: '+14155551234', Body: 'loved it, more like this please' },
      env,
      repos,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  // -- UPDATE skipped when proposal is empty --------------------------------

  it('skips the profile update entirely when the proposal has no fields', async () => {
    mockReflect.mockResolvedValue({} as ReflectorProposal);
    const env = buildEnv();
    const { repos, applyReflectorChanges } = buildMockRepos({ profile: baseProfile, recentRow: null });

    await postTwilio({ From: '+1', Body: 'ok' }, env, repos);

    // applyReflectorChanges is always called, but the repo skips the SQL UPDATE
    // internally when the proposal is empty. The webhook always delegates this
    // decision to the repo — it does not pre-check for emptiness.
    expect(applyReflectorChanges).toHaveBeenCalledWith({});
  });

  // -- updated_at always included when UPDATE runs -------------------------

  it('calls applyReflectorChanges with the full proposal when the Reflector returns fields', async () => {
    const proposal: ReflectorProposal = { regional_preference: 'Spain' };
    mockReflect.mockResolvedValue(proposal);
    const env = buildEnv();
    const { repos, applyReflectorChanges } = buildMockRepos({ profile: baseProfile, recentRow: null });

    await postTwilio({ From: '+1', Body: 'más español de España' }, env, repos);

    expect(applyReflectorChanges).toHaveBeenCalledWith(proposal);
  });

  // -- no_list merging (delegated to profile repo) -------------------------

  it('passes no_list_additions from the proposal to applyReflectorChanges', async () => {
    const proposal: ReflectorProposal = { no_list_additions: ['new-id'] };
    mockReflect.mockResolvedValue(proposal);

    const env = buildEnv();
    const { repos, applyReflectorChanges } = buildMockRepos({ profile: baseProfile, recentRow: null });
    await postTwilio({ From: '+1', Body: 'disliked that one' }, env, repos);

    expect(applyReflectorChanges).toHaveBeenCalledWith(proposal);
  });

  // -- idiom_history update ------------------------------------------------

  it('records user feedback on the most recent idiom_history row when one exists', async () => {
    const rawFeedback = 'loved it, more like this please';
    mockParseFeedback.mockResolvedValue({ ...baseFeedback, raw: rawFeedback });
    mockReflect.mockResolvedValue({} as ReflectorProposal);

    const env = buildEnv();
    const { repos, recordFeedback } = buildMockRepos({
      profile: baseProfile,
      recentRow: baseHistory,
    });

    await postTwilio({ From: '+1', Body: rawFeedback }, env, repos);

    expect(recordFeedback).toHaveBeenCalledWith(baseHistory.id, rawFeedback);
  });

  it('skips the idiom_history feedback update when no recent row exists', async () => {
    mockReflect.mockResolvedValue({} as ReflectorProposal);
    const env = buildEnv();
    const { repos, recordFeedback } = buildMockRepos({ profile: baseProfile, recentRow: null });

    await postTwilio({ From: '+1', Body: 'cool' }, env, repos);

    expect(recordFeedback).not.toHaveBeenCalled();
  });
});
