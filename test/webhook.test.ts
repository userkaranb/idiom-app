import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, Profile, FeedbackResult, IdiomHistory, ReflectorProposal } from '../src/types';
import type { Repos } from '../src/db';

// vi.hoisted runs before any imports so these mock functions are available
// inside the vi.mock factory closures below.
const { mockParseFeedback, mockReflect } = vi.hoisted(() => ({
  mockParseFeedback: vi.fn(),
  mockReflect: vi.fn(),
}));

vi.mock('../src/agents/feedback',  () => ({ parseFeedback: mockParseFeedback }));
vi.mock('../src/agents/reflector', () => ({ reflect: mockReflect }));

import { handleTelegramWebhook } from '../src/webhook';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_BOT_TOKEN      = 'TEST-TOKEN';
const TEST_CHAT_ID        = '123456789';
const TEST_WEBHOOK_SECRET = 'test-webhook-secret';
const WEBHOOK_URL         = 'http://localhost/webhook';

function buildEnv(): Env {
  return {
    DB: {} as D1Database,
    ANTHROPIC_API_KEY: 'test-key',
    TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN,
    TELEGRAM_CHAT_ID: TEST_CHAT_ID,
    TELEGRAM_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    TRIGGER_SECRET: 'test-trigger-secret',
  };
}

const mockProfile: Profile = {
  id: 1,
  regional_preference: 'general',
  vulgarity_tolerance: 1,
  themes: '["work","misc"]',
  common_vs_obscure: 3,
  no_list: '[]',
  updated_at: '2024-01-01T00:00:00Z',
};

const mockFeedbackResult: FeedbackResult = {
  sentiment: 'positive',
  wants_more_colloquial: true,
  wants_more_formal: null,
  wants_more_vulgar: null,
  wants_less_vulgar: null,
  theme_mentions: ['food'],
  raw: 'loved it!',
};

const mockProposal: ReflectorProposal = {
  themes: ['work', 'food'],
  common_vs_obscure: 4,
};

const mockRecentRow: IdiomHistory = {
  id: 42,
  sent_at: '2024-01-01T13:00:00Z',
  idiom_id: 'some-idiom',
  idiom_text: 'some text',
  colloquialism_id: 'some-coll',
  colloquialism_text: 'some coll text',
  curator_justification: 'good pick',
  user_rating: null,
  user_feedback: null,
};

// ---------------------------------------------------------------------------
// Fake repository factory
// ---------------------------------------------------------------------------

function makeFakeRepos(recentRow: IdiomHistory | null = null): Repos {
  return {
    profile: {
      getCurrent: vi.fn().mockResolvedValue(mockProfile),
      applyReflectorChanges: vi.fn().mockResolvedValue(mockProfile),
    },
    idiomHistory: {
      listAllSentHistory: vi.fn().mockResolvedValue([]),
      getMostRecent: vi.fn().mockResolvedValue(recentRow),
      recordSent: vi.fn().mockResolvedValue(undefined),
      recordFeedback: vi.fn().mockResolvedValue(undefined),
      listRecent: vi.fn().mockResolvedValue([]),
      containsPhrase: vi.fn().mockResolvedValue(false),
    },
  };
}

function buildApp(repos: Repos) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/webhook', (c) => handleTelegramWebhook(c, repos));
  return app;
}

/** Returns a well-formed Telegram update payload for the configured owner. */
function buildValidUpdate(messageOverrides: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 100,
      from: { id: parseInt(TEST_CHAT_ID, 10) },
      chat: { id: parseInt(TEST_CHAT_ID, 10) },
      date: 1_700_000_000,
      text: 'loved it!',
      ...messageOverrides,
    },
  };
}

function postWithSecret(body: unknown, secret = TEST_WEBHOOK_SECRET) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /webhook', () => {
  beforeEach(() => {
    mockParseFeedback.mockResolvedValue(mockFeedbackResult);
    mockReflect.mockResolvedValue(mockProposal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- Secret header auth checks --------------------------------------------

  it('returns 403 when X-Telegram-Bot-Api-Secret-Token header is missing', async () => {
    const repos = makeFakeRepos();
    const res = await buildApp(repos).request(
      WEBHOOK_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildValidUpdate()),
      },
      buildEnv(),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when X-Telegram-Bot-Api-Secret-Token does not match TELEGRAM_WEBHOOK_SECRET', async () => {
    const repos = makeFakeRepos();
    const res = await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret(buildValidUpdate(), 'wrong-secret'),
      buildEnv(),
    );
    expect(res.status).toBe(403);
  });

  // -- Chat-ID ownership check ---------------------------------------------

  it('returns 403 when message.chat.id does not match TELEGRAM_CHAT_ID', async () => {
    const repos = makeFakeRepos();
    const res = await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret({
        update_id: 1,
        message: {
          message_id: 100,
          from: { id: 9999 },
          chat: { id: 9999 },
          date: 1_700_000_000,
          text: 'hello',
        },
      }),
      buildEnv(),
    );
    expect(res.status).toBe(403);
  });

  // -- Non-text messages (stickers, images, etc.) ---------------------------

  it('returns 200 with skipped:true when message has no text field', async () => {
    const repos = makeFakeRepos();
    const res = await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret(buildValidUpdate({ text: undefined })),
      buildEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(mockParseFeedback).not.toHaveBeenCalled();
  });

  // -- Happy path: valid signed request, correct chat, with text -----------

  it('returns 200 and calls parseFeedback, reflect, and applyReflectorChanges', async () => {
    const repos = makeFakeRepos();
    const res = await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret(buildValidUpdate()),
      buildEnv(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(mockParseFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN }),
      'loved it!',
    );
    expect(mockReflect).toHaveBeenCalledWith(
      expect.objectContaining({ TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN }),
      mockProfile,
      mockFeedbackResult,
    );
    expect(repos.profile.applyReflectorChanges).toHaveBeenCalledWith(mockProposal);
  });

  // -- recordFeedback when a recent history row exists ----------------------

  it('calls recordFeedback with the recent row id and raw feedback text', async () => {
    const repos = makeFakeRepos(mockRecentRow);
    await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret(buildValidUpdate()),
      buildEnv(),
    );

    expect(repos.idiomHistory.recordFeedback).toHaveBeenCalledWith(
      mockRecentRow.id,
      mockFeedbackResult.raw,
    );
  });

  // -- recordFeedback NOT called when history is empty ----------------------

  it('does not call recordFeedback when no recent row exists', async () => {
    const repos = makeFakeRepos(null);
    await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret(buildValidUpdate()),
      buildEnv(),
    );

    expect(repos.idiomHistory.recordFeedback).not.toHaveBeenCalled();
  });
});
