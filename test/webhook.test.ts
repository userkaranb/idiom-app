import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, IdiomHistory } from '../src/types';
import type { Repos } from '../src/db';

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
    WEB_PASSWORD: 'test-password',
    COOKIE_SECRET: 'test-cookie-secret',
  };
}

const mockRecentRow: IdiomHistory = {
  id: 42,
  sent_at: '2024-01-01T13:00:00Z',
  idiom_id: 'some-idiom',
  idiom_text: 'some text',
  idiom_meaning: null,
  idiom_example: null,
  idiom_region: null,
  colloquialism_id: 'some-coll',
  colloquialism_text: 'some coll text',
  colloquialism_meaning: null,
  colloquialism_example: null,
  colloquialism_region: null,
  curator_justification: 'good pick',
  user_rating: null,
  user_feedback: null,
};

// ---------------------------------------------------------------------------
// Fake repository factory
// ---------------------------------------------------------------------------

function makeFakeRepos(recentRow: IdiomHistory | null = null): Repos {
  return {
    idiomHistory: {
      listAllSentHistory: vi.fn().mockResolvedValue([]),
      getMostRecent:      vi.fn().mockResolvedValue(recentRow),
      recordSent:         vi.fn().mockResolvedValue(undefined),
      recordFeedback:     vi.fn().mockResolvedValue(undefined),
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
// POST /webhook — integration tests
// ---------------------------------------------------------------------------

describe('POST /webhook', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    expect(repos.idiomHistory.recordFeedback).not.toHaveBeenCalled();
  });

  // -- Happy path: valid signed request, correct chat, with text -----------

  it('returns 200 ok:true for a valid signed text message', async () => {
    const repos = makeFakeRepos();
    const res = await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret(buildValidUpdate()),
      buildEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  // -- recordFeedback stores raw message text --------------------------------

  it('calls recordFeedback with the recent row id and raw message text', async () => {
    const repos = makeFakeRepos(mockRecentRow);
    await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret(buildValidUpdate({ text: 'loved it!' })),
      buildEnv(),
    );
    expect(repos.idiomHistory.recordFeedback).toHaveBeenCalledWith(
      mockRecentRow.id,
      'loved it!',
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

  // -- Telegram confirmation reply -----------------------------------------

  it('POSTs a confirmation to the Telegram sendMessage URL with chat_id and text containing "Got it"', async () => {
    const repos = makeFakeRepos();
    await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret(buildValidUpdate()),
      buildEnv(),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as { chat_id: string; text: string };
    expect(body.chat_id).toBe(TEST_CHAT_ID);
    expect(body.text).toContain('Got it');
  });

  // -- 200 even when Telegram confirmation fails ----------------------------

  it('returns HTTP 200 ok:true even when the Telegram confirmation fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    const repos = makeFakeRepos();
    const res = await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret(buildValidUpdate()),
      buildEnv(),
    );
    // Feedback was already stored; Telegram delivery failure must not propagate
    // or Telegram would retry the webhook indefinitely.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
