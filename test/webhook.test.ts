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

  // `prepare()` always returns the same shared statement object. Calls to
  // `.first()` on it advance through firstResults in order (SELECT profile,
  // then SELECT idiom_history). Calls to `.bind(...).run()` are tracked via
  // bindMock / runMock.
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

  // Helper that fires a POST against the in-process app.
  async function post(body: unknown, env: Env): Promise<Response> {
    return app.request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, env);
  }

  // -- Validation ----------------------------------------------------------

  it('returns 400 with {error:"invalid payload"} when the body is not valid JSON', async () => {
    const { env } = buildMockEnv({ profile: baseProfile, recentRow: null });
    const response = await app.request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json!!!',
    }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  it('returns 400 when the "from" field is absent', async () => {
    const { env } = buildMockEnv({ profile: baseProfile, recentRow: null });
    const response = await post({ body: 'some text' }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  it('returns 400 when the "body" field is absent', async () => {
    const { env } = buildMockEnv({ profile: baseProfile, recentRow: null });
    const response = await post({ from: '+14155551234' }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  it('returns 400 when the "body" field is an empty string', async () => {
    const { env } = buildMockEnv({ profile: baseProfile, recentRow: null });
    const response = await post({ from: '+14155551234', body: '' }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  it('returns 400 when "from" is not a string', async () => {
    const { env } = buildMockEnv({ profile: baseProfile, recentRow: null });
    const response = await post({ from: 123, body: 'hello' }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  // -- Happy path ----------------------------------------------------------

  it('returns 200 with {ok:true} for a well-formed request', async () => {
    const { env } = buildMockEnv({ profile: baseProfile, recentRow: null });
    const response = await post({ from: '+14155551234', body: 'loved it, more like this please' }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  // -- UPDATE skipped when proposal is empty -------------------------------

  it('skips the profile UPDATE entirely when the proposal has no fields', async () => {
    mockReflect.mockResolvedValue({} as ReflectorProposal);
    const { env, prepareMock } = buildMockEnv({ profile: baseProfile, recentRow: null });

    await post({ from: '+1', body: 'ok' }, env);

    const executedSqls = prepareMock.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(executedSqls.some((sql) => sql.startsWith('UPDATE profile'))).toBe(false);
  });

  // -- updated_at always included when UPDATE runs -------------------------

  it('includes updated_at = datetime("now") in the profile UPDATE when the proposal has fields', async () => {
    mockReflect.mockResolvedValue({ regional_preference: 'Spain' } as ReflectorProposal);
    const { env, prepareMock } = buildMockEnv({ profile: baseProfile, recentRow: null });

    await post({ from: '+1', body: 'más español de España' }, env);

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

    await post({ from: '+1', body: 'disliked that one' }, env);

    // The only bind call is for the profile UPDATE (no recentRow → no history update).
    // Its sole argument is JSON.stringify(mergedNoList).
    const firstBindCallArgs = bindMock.mock.calls[0] as unknown[];
    const noListArg = firstBindCallArgs[0] as string;
    expect(JSON.parse(noListArg)).toEqual(['old-id', 'new-id']);
  });

  it('treats no_list_additions as an empty list when it is absent from the proposal', async () => {
    // Proposal with vulgarity change only — no_list_additions is not present.
    mockReflect.mockResolvedValue({ vulgarity_tolerance: 1 } as ReflectorProposal);

    const { env, prepareMock } = buildMockEnv({ profile: baseProfile, recentRow: null });

    await post({ from: '+1', body: 'mild slang is fine' }, env);

    // UPDATE profile must run without crashing, and must NOT reference no_list.
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

    await post({ from: '+1', body: rawFeedback }, env);

    const executedSqls = prepareMock.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(executedSqls.some((sql) => sql.includes('UPDATE idiom_history'))).toBe(true);

    // With an empty proposal (no profile UPDATE), the only bind call is for
    // the idiom_history update: bind(rawFeedback, recentRow.id).
    const historyBindArgs = bindMock.mock.calls[0] as unknown[];
    expect(historyBindArgs[0]).toBe(rawFeedback);
    expect(historyBindArgs[1]).toBe(baseHistory.id);
  });

  it('skips the idiom_history UPDATE when no recent row exists', async () => {
    mockReflect.mockResolvedValue({} as ReflectorProposal);
    const { env, prepareMock } = buildMockEnv({ profile: baseProfile, recentRow: null });

    await post({ from: '+1', body: 'cool' }, env);

    const executedSqls = prepareMock.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(executedSqls.some((sql) => sql.includes('UPDATE idiom_history'))).toBe(false);
  });
});
