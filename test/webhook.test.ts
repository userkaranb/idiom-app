import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, Profile, IdiomHistory, FeedbackResult, ReflectorProposal } from '../src/types';

// ---------------------------------------------------------------------------
// Mock agent modules before any imports that pull them in transitively.
// vi.hoisted ensures these mock fns exist before the vi.mock() factory runs.
// ---------------------------------------------------------------------------

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

const mockProfile: Profile = {
  id: 1,
  regional_preference: 'general',
  vulgarity_tolerance: 1,
  themes: '["work","food"]',
  common_vs_obscure: 3,
  no_list: '["already-banned"]',
  updated_at: '2024-01-01T00:00:00Z',
};

const mockHistory: IdiomHistory = {
  id: 42,
  sent_at: '2024-01-01T13:00:00Z',
  idiom_id: 'el-que-no-llora',
  idiom_text: 'El que no llora no mama',
  colloquialism_id: 'chido',
  colloquialism_text: 'chido',
  curator_justification: 'common work idiom',
  user_rating: null,
  user_feedback: null,
};

const mockFeedback: FeedbackResult = {
  sentiment: 'positive',
  wants_more_colloquial: true,
  wants_more_formal: null,
  wants_more_vulgar: null,
  wants_less_vulgar: null,
  theme_mentions: ['animals'],
  raw: 'more slangy',
};

const emptyProposal: ReflectorProposal = {};

const fullProposal: ReflectorProposal = {
  themes: ['work', 'food', 'animals'],
  common_vs_obscure: 4,
};

// ---------------------------------------------------------------------------
// D1 mock factory
//
// Returns a fake D1Database and individual mock handles so tests can assert
// on which SQL was executed and what was bound.
// ---------------------------------------------------------------------------

function makeD1Mock({
  profileRows = [mockProfile] as unknown[],
  historyRows = [mockHistory] as unknown[],
} = {}) {
  const profileUpdateRun = vi.fn().mockResolvedValue(undefined);
  const profileUpdateBind = vi.fn().mockReturnValue({ run: profileUpdateRun });

  const historyUpdateRun = vi.fn().mockResolvedValue(undefined);
  const historyUpdateBind = vi.fn().mockReturnValue({ run: historyUpdateRun });

  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.startsWith('SELECT * FROM profile WHERE id = 1')) {
        return { all: vi.fn().mockResolvedValue({ results: profileRows }) };
      }
      if (sql.startsWith('SELECT * FROM idiom_history ORDER BY id DESC LIMIT 1')) {
        return { all: vi.fn().mockResolvedValue({ results: historyRows }) };
      }
      if (sql.startsWith('UPDATE profile SET')) {
        return { bind: profileUpdateBind };
      }
      if (sql.startsWith('UPDATE idiom_history SET user_feedback')) {
        return { bind: historyUpdateBind };
      }
      throw new Error(`Unexpected SQL in webhook test mock: ${sql}`);
    }),
  } as unknown as D1Database;

  return { db, profileUpdateBind, profileUpdateRun, historyUpdateBind, historyUpdateRun };
}

function makeEnv(db: D1Database): Env {
  return { DB: db, ANTHROPIC_API_KEY: 'test-key' };
}

// ---------------------------------------------------------------------------
// Test app
//
// Wrap handleWebhook in a minimal Hono app so tests exercise the full
// request-parsing path rather than constructing a Hono Context by hand.
// ---------------------------------------------------------------------------

function makeApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/webhook', handleWebhook);
  return { fetch: (req: Request) => app.fetch(req, env) };
}

function postWebhook(env: Env, body: unknown) {
  const { fetch } = makeApp(env);
  return fetch(
    new Request('http://localhost/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function postWebhookRaw(env: Env, rawBody: string) {
  const { fetch } = makeApp(env);
  return fetch(
    new Request('http://localhost/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleWebhook', () => {
  beforeEach(() => {
    mockParseFeedback.mockReset();
    mockReflect.mockReset();
    mockParseFeedback.mockResolvedValue(mockFeedback);
    mockReflect.mockResolvedValue(emptyProposal);
  });

  // ---- Input validation ---------------------------------------------------

  it('returns 400 with { error: "invalid payload" } when JSON is unparseable', async () => {
    const { db } = makeD1Mock();
    const response = await postWebhookRaw(makeEnv(db), 'not-json');
    expect(response.status).toBe(400);
    const json = await response.json() as Record<string, unknown>;
    expect(json.error).toBe('invalid payload');
  });

  it('returns 400 when "from" field is absent', async () => {
    const { db } = makeD1Mock();
    const response = await postWebhook(makeEnv(db), { body: 'great!' });
    expect(response.status).toBe(400);
    const json = await response.json() as Record<string, unknown>;
    expect(json.error).toBe('invalid payload');
  });

  it('returns 400 when "body" field is absent', async () => {
    const { db } = makeD1Mock();
    const response = await postWebhook(makeEnv(db), { from: '+14155551234' });
    expect(response.status).toBe(400);
    const json = await response.json() as Record<string, unknown>;
    expect(json.error).toBe('invalid payload');
  });

  it('returns 400 when "body" is an empty string', async () => {
    const { db } = makeD1Mock();
    const response = await postWebhook(makeEnv(db), { from: '+14155551234', body: '' });
    expect(response.status).toBe(400);
    const json = await response.json() as Record<string, unknown>;
    expect(json.error).toBe('invalid payload');
  });

  it('returns 400 when "from" is not a string', async () => {
    const { db } = makeD1Mock();
    const response = await postWebhook(makeEnv(db), { from: 123, body: 'great!' });
    expect(response.status).toBe(400);
    const json = await response.json() as Record<string, unknown>;
    expect(json.error).toBe('invalid payload');
  });

  // ---- Happy path ---------------------------------------------------------

  it('returns 200 with { ok: true } for a valid payload', async () => {
    const { db } = makeD1Mock();
    const response = await postWebhook(makeEnv(db), { from: '+14155551234', body: 'more slangy' });
    expect(response.status).toBe(200);
    const json = await response.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
  });

  // ---- Profile UPDATE skipped when proposal is empty ----------------------

  it('does not run an UPDATE when the reflector proposal has no fields', async () => {
    mockReflect.mockResolvedValue({});
    const { db, profileUpdateRun } = makeD1Mock();
    await postWebhook(makeEnv(db), { from: '+1', body: 'fine' });
    expect(profileUpdateRun).not.toHaveBeenCalled();
  });

  // ---- Profile UPDATE runs when the proposal has fields -------------------

  it('runs the profile UPDATE when the proposal contains at least one field', async () => {
    mockReflect.mockResolvedValue(fullProposal);
    const { db, profileUpdateRun } = makeD1Mock();
    await postWebhook(makeEnv(db), { from: '+1', body: 'loved it' });
    expect(profileUpdateRun).toHaveBeenCalledOnce();
  });

  it('includes updated_at = datetime("now") in the UPDATE SQL', async () => {
    mockReflect.mockResolvedValue({ regional_preference: 'Mexico' });
    const { db } = makeD1Mock();
    const prepare = db.prepare as ReturnType<typeof vi.fn>;
    await postWebhook(makeEnv(db), { from: '+1', body: 'great' });
    const updateCalls = prepare.mock.calls.filter((args: unknown[]) =>
      typeof args[0] === 'string' && (args[0] as string).startsWith('UPDATE profile SET'),
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][0]).toContain("updated_at = datetime('now')");
  });

  // ---- no_list merging ----------------------------------------------------

  it('merges no_list_additions into the existing no_list rather than replacing it', async () => {
    mockReflect.mockResolvedValue({ no_list_additions: ['new-bad-id'] });
    const { db, profileUpdateBind } = makeD1Mock();
    await postWebhook(makeEnv(db), { from: '+1', body: 'hated it' });

    // The binding for no_list should include BOTH the pre-existing id AND the new one.
    const boundArgs: unknown[] = profileUpdateBind.mock.calls[0] as unknown[];
    const mergedNoList = boundArgs.find(
      (arg) => typeof arg === 'string' && arg.startsWith('['),
    );
    expect(mergedNoList).toBeDefined();
    const parsed = JSON.parse(mergedNoList as string) as string[];
    expect(parsed).toContain('already-banned');
    expect(parsed).toContain('new-bad-id');
  });

  it('does not add a no_list clause when no_list_additions is undefined', async () => {
    mockReflect.mockResolvedValue({ regional_preference: 'Spain' });
    const { db, profileUpdateBind } = makeD1Mock();
    await postWebhook(makeEnv(db), { from: '+1', body: 'ok' });

    const boundArgs: unknown[] = profileUpdateBind.mock.calls[0] as unknown[];
    // None of the bound values should be a JSON array (no_list update)
    const hasArrayBinding = boundArgs.some(
      (arg) => typeof arg === 'string' && arg.startsWith('['),
    );
    expect(hasArrayBinding).toBe(false);
  });

  it('does not add a no_list clause when no_list_additions is an empty array', async () => {
    mockReflect.mockResolvedValue({ regional_preference: 'Spain', no_list_additions: [] });
    const { db, profileUpdateBind } = makeD1Mock();
    await postWebhook(makeEnv(db), { from: '+1', body: 'ok' });

    const boundArgs: unknown[] = profileUpdateBind.mock.calls[0] as unknown[];
    const hasArrayBinding = boundArgs.some(
      (arg) => typeof arg === 'string' && arg.startsWith('['),
    );
    expect(hasArrayBinding).toBe(false);
  });

  // ---- idiom_history update -----------------------------------------------

  it('updates idiom_history user_feedback with the raw feedback text when a recent row exists', async () => {
    const { db, historyUpdateBind, historyUpdateRun } = makeD1Mock({
      historyRows: [mockHistory],
    });
    await postWebhook(makeEnv(db), { from: '+1', body: 'more slangy' });

    expect(historyUpdateRun).toHaveBeenCalledOnce();
    expect(historyUpdateBind).toHaveBeenCalledWith(mockFeedback.raw, mockHistory.id);
  });

  it('skips the idiom_history update when no recent row exists', async () => {
    const { db, historyUpdateRun } = makeD1Mock({ historyRows: [] });
    await postWebhook(makeEnv(db), { from: '+1', body: 'more slangy' });
    expect(historyUpdateRun).not.toHaveBeenCalled();
  });
});
