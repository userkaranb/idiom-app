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

async function postTo(
  app: Hono<{ Bindings: Env }>,
  body: unknown,
  env: Env,
): Promise<Response> {
  return app.request('/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

  it('returns 400 with {error:"invalid payload"} when the request body is not valid JSON', async () => {
    const { env } = buildMockEnv(BASE_PROFILE);
    const response = await buildApp().request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json!!!',
    }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  it('returns 400 when the "from" field is absent', async () => {
    const { env } = buildMockEnv(BASE_PROFILE);
    const response = await postTo(buildApp(), { body: 'some text' }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  it('returns 400 when "body" is an empty string', async () => {
    const { env } = buildMockEnv(BASE_PROFILE);
    const response = await postTo(buildApp(), { from: '+14155551234', body: '' }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  it('returns 400 when "from" is not a string', async () => {
    const { env } = buildMockEnv(BASE_PROFILE);
    const response = await postTo(buildApp(), { from: 999, body: 'hello' }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  // -- Happy path (HTTP 200) ------------------------------------------------

  it('returns 200 with {ok:true} for a well-formed request', async () => {
    const { env } = buildMockEnv(BASE_PROFILE);
    const response = await postTo(
      buildApp(),
      { from: '+14155551234', body: 'loved it, more like this please' },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  // -- Profile UPDATE logic --------------------------------------------------

  it('skips the profile UPDATE entirely when the Reflector proposal is empty', async () => {
    mockReflect.mockResolvedValue({} as ReflectorProposal);
    const { env, prepareMock } = buildMockEnv(BASE_PROFILE);

    await postTo(buildApp(), { from: '+1', body: 'ok' }, env);

    const executedSqls = (prepareMock.mock.calls as [string][]).map(([sql]) => sql);
    expect(executedSqls.some((sql) => sql.startsWith('UPDATE profile'))).toBe(false);
  });

  it('runs a profile UPDATE that includes updated_at when the proposal has fields', async () => {
    mockReflect.mockResolvedValue({ regional_preference: 'Spain' } as ReflectorProposal);
    const { env, prepareMock } = buildMockEnv(BASE_PROFILE);

    await postTo(buildApp(), { from: '+1', body: 'más español de España' }, env);

    const executedSqls = (prepareMock.mock.calls as [string][]).map(([sql]) => sql);
    const updateSql = executedSqls.find((sql) => sql.startsWith('UPDATE profile'));
    expect(updateSql).toBeDefined();
    expect(updateSql).toContain("updated_at = datetime('now')");
  });

  it('merges no_list_additions into the existing no_list rather than replacing it', async () => {
    const profileWithEntries: Profile = { ...BASE_PROFILE, no_list: '["existing-id"]' };
    mockReflect.mockResolvedValue({ no_list_additions: ['new-id'] } as ReflectorProposal);

    const { env, bindMock } = buildMockEnv(profileWithEntries);
    await postTo(buildApp(), { from: '+1', body: 'disliked that one' }, env);

    // The only bind call with a no_list argument comes from the UPDATE profile SQL.
    // Its first argument is the JSON-serialised merged list.
    const noListArg = (bindMock.mock.calls[0] as unknown[])[0] as string;
    expect(JSON.parse(noListArg)).toEqual(['existing-id', 'new-id']);
  });
});
