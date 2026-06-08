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

import { handleTelegramWebhook, buildConfirmationMessage } from '../src/webhook';

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
// buildConfirmationMessage — pure function tests
// ---------------------------------------------------------------------------

describe('buildConfirmationMessage', () => {
  it('includes the sentiment in the "What I understood" section', () => {
    const feedback: FeedbackResult = {
      sentiment: 'negative',
      wants_more_colloquial: null,
      wants_more_formal: null,
      wants_more_vulgar: null,
      wants_less_vulgar: null,
      theme_mentions: [],
      raw: 'meh',
    };
    const proposal: ReflectorProposal = {};
    const text = buildConfirmationMessage(feedback, proposal);
    expect(text).toContain('Sentiment: negative');
  });

  it('includes boolean flags that are true and skips those that are null or false', () => {
    const feedback: FeedbackResult = {
      sentiment: 'mixed',
      wants_more_colloquial: true,
      wants_more_formal: false,
      wants_more_vulgar: null,
      wants_less_vulgar: true,
      theme_mentions: [],
      raw: 'mixed feelings',
    };
    const proposal: ReflectorProposal = {};
    const text = buildConfirmationMessage(feedback, proposal);
    expect(text).toContain('colloquial');
    expect(text).toContain('less vulgar');
    expect(text).not.toContain('formal');
    expect(text).not.toContain('more vulgar');
  });

  it('includes theme_mentions when the array is non-empty', () => {
    const feedback: FeedbackResult = {
      sentiment: 'positive',
      wants_more_colloquial: null,
      wants_more_formal: null,
      wants_more_vulgar: null,
      wants_less_vulgar: null,
      theme_mentions: ['food', 'travel'],
      raw: 'food and travel themes',
    };
    const proposal: ReflectorProposal = {};
    const text = buildConfirmationMessage(feedback, proposal);
    expect(text).toContain('food');
    expect(text).toContain('travel');
  });

  it('omits the theme_mentions line when the array is empty', () => {
    const feedback: FeedbackResult = {
      sentiment: 'neutral',
      wants_more_colloquial: null,
      wants_more_formal: null,
      wants_more_vulgar: null,
      wants_less_vulgar: null,
      theme_mentions: [],
      raw: 'ok',
    };
    const proposal: ReflectorProposal = {};
    const text = buildConfirmationMessage(feedback, proposal);
    expect(text).not.toContain('Themes mentioned');
  });

  it('lists proposal fields that are present', () => {
    const feedback: FeedbackResult = {
      sentiment: 'positive',
      wants_more_colloquial: null,
      wants_more_formal: null,
      wants_more_vulgar: null,
      wants_less_vulgar: null,
      theme_mentions: [],
      raw: 'good',
    };
    const proposal: ReflectorProposal = {
      themes: ['food', 'travel', 'love'],
      vulgarity_tolerance: 1,
    };
    const text = buildConfirmationMessage(feedback, proposal);
    expect(text).toContain('food');
    expect(text).toContain('Vulgarity tolerance');
    expect(text).toContain('1');
  });

  it('shows "No profile changes needed." when proposal has no fields', () => {
    const feedback: FeedbackResult = {
      sentiment: 'neutral',
      wants_more_colloquial: null,
      wants_more_formal: null,
      wants_more_vulgar: null,
      wants_less_vulgar: null,
      theme_mentions: [],
      raw: 'fine',
    };
    const proposal: ReflectorProposal = {};
    const text = buildConfirmationMessage(feedback, proposal);
    expect(text).toContain('No profile changes needed');
  });

  it('lists all proposal fields when every optional field is provided', () => {
    const feedback: FeedbackResult = {
      sentiment: 'positive',
      wants_more_colloquial: null,
      wants_more_formal: null,
      wants_more_vulgar: null,
      wants_less_vulgar: null,
      theme_mentions: [],
      raw: 'great',
    };
    const proposal: ReflectorProposal = {
      regional_preference: 'Mexico',
      vulgarity_tolerance: 2,
      themes: ['food'],
      common_vs_obscure: 7,
      no_list_additions: ['bad-phrase'],
    };
    const text = buildConfirmationMessage(feedback, proposal);
    expect(text).toContain('Mexico');
    expect(text).toContain('2');
    expect(text).toContain('food');
    expect(text).toContain('7');
    expect(text).toContain('bad-phrase');
  });
});

// ---------------------------------------------------------------------------
// POST /webhook — integration tests
// ---------------------------------------------------------------------------

describe('POST /webhook', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockParseFeedback.mockResolvedValue(mockFeedbackResult);
    mockReflect.mockResolvedValue(mockProposal);
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

  // -- Telegram confirmation reply -----------------------------------------

  it('POSTs a confirmation to the Telegram sendMessage URL with chat_id and text', async () => {
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
    expect(body.text).toContain('Got your feedback');
    expect(body.text).toContain('Sentiment');
  });

  it('confirmation text includes true boolean flags from the feedback result', async () => {
    const repos = makeFakeRepos();
    await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret(buildValidUpdate()),
      buildEnv(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const { text } = JSON.parse(init.body as string) as { chat_id: string; text: string };
    // mockFeedbackResult has wants_more_colloquial: true
    expect(text).toContain('colloquial');
  });

  it('confirmation text lists proposal fields that are present', async () => {
    const repos = makeFakeRepos();
    await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret(buildValidUpdate()),
      buildEnv(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const { text } = JSON.parse(init.body as string) as { chat_id: string; text: string };
    // mockProposal has themes and common_vs_obscure
    expect(text).toContain('work');  // themes includes 'work'
    expect(text).toContain('food');  // themes includes 'food'
  });

  it('returns HTTP 200 ok:true even when the Telegram confirmation fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    const repos = makeFakeRepos();
    const res = await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret(buildValidUpdate()),
      buildEnv(),
    );

    // The feedback was already processed and stored. Telegram delivery failure
    // must not propagate — Telegram would retry the webhook endlessly if we 500.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('applies DB changes before sending the Telegram confirmation', async () => {
    const callOrder: string[] = [];
    const repos = makeFakeRepos(mockRecentRow);
    (repos.profile.applyReflectorChanges as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('applyReflectorChanges');
    });
    (repos.idiomHistory.recordFeedback as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('recordFeedback');
    });
    fetchMock.mockImplementation(async () => {
      callOrder.push('fetch');
      return new Response('', { status: 200 });
    });

    await buildApp(repos).request(
      WEBHOOK_URL,
      postWithSecret(buildValidUpdate()),
      buildEnv(),
    );

    expect(callOrder.indexOf('applyReflectorChanges')).toBeLessThan(callOrder.indexOf('fetch'));
    expect(callOrder.indexOf('recordFeedback')).toBeLessThan(callOrder.indexOf('fetch'));
  });
});
