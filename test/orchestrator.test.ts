import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env, IdiomHistory, IdiomHistoryInsert, WriterOutput } from '../src/types';
import type { Repos } from '../src/db';

// vi.hoisted runs before any imports so these mock functions are available
// inside the vi.mock factory closures below.
const { mockGenerate, mockFindCollision } = vi.hoisted(() => ({
  mockGenerate:      vi.fn(),
  mockFindCollision: vi.fn(),
}));

vi.mock('../src/agents/writer', () => ({ generate: mockGenerate }));
vi.mock('../src/dedup', () => ({
  findCollision: mockFindCollision,
  // normalizePhrase is used by slugify in the orchestrator — provide a working
  // implementation so slug computation works in tests without the real module.
  normalizePhrase: (text: string) =>
    text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim(),
}));

import { runDailyFlow } from '../src/orchestrator';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockWriterOutput: WriterOutput = {
  idiom: {
    phrase:           'echar la casa por la ventana',
    region:           'general',
    meaning:          'to spare no expense',
    example:          'Para la fiesta echaron la casa por la ventana.',
    nearest_existing: 'none',
    why_different:    'Unique meaning about lavish spending.',
  },
  colloquialism: {
    phrase:           'mola mazo',
    region:           'Spain',
    meaning:          'it rocks / it is very cool',
    example:          'Esa pelicula mola mazo.',
    nearest_existing: 'none',
    why_different:    'Distinct Spanish slang term.',
  },
};

function makeHistoryRow(overrides: Partial<IdiomHistory> = {}): IdiomHistory {
  return {
    id: 1,
    sent_at: '2024-01-01T13:00:00Z',
    idiom_id: 'some-idiom',
    idiom_text: 'some idiom text',
    idiom_meaning: null,
    idiom_example: null,
    idiom_region: null,
    colloquialism_id: 'some-coll',
    colloquialism_text: 'some coll text',
    colloquialism_meaning: null,
    colloquialism_example: null,
    colloquialism_region: null,
    curator_justification: '',
    user_rating: null,
    user_feedback: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake repository factory
// ---------------------------------------------------------------------------

function makeFakeRepos({ historyRows = [] as IdiomHistory[] } = {}): Repos {
  return {
    idiomHistory: {
      listAllSentHistory: vi.fn().mockResolvedValue(historyRows),
      getMostRecent:      vi.fn().mockResolvedValue(null),
      recordSent:         vi.fn().mockResolvedValue(undefined),
      recordFeedback:     vi.fn().mockResolvedValue(undefined),
    },
  };
}

function makeEnv(): Env {
  return {
    DB: {} as D1Database,
    ANTHROPIC_API_KEY: 'test-key',
    TELEGRAM_BOT_TOKEN: 'TEST-TOKEN',
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
    TRIGGER_SECRET: 'test-trigger-secret',
    WEB_PASSWORD: 'test-password',
    COOKIE_SECRET: 'test-cookie-secret',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDailyFlow', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Default: generate succeeds, dedup finds no collisions
    mockGenerate.mockResolvedValue(mockWriterOutput);
    mockFindCollision.mockReturnValue(null);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // --- History is read before generate ----------------------------------------

  it('reads idiom history before calling generate', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    expect(repos.idiomHistory.listAllSentHistory).toHaveBeenCalledOnce();
    expect(mockGenerate).toHaveBeenCalledOnce();
  });

  // --- Feedback items extracted and forwarded --------------------------------

  it('extracts non-null user_feedback strings from history and passes them to generate', async () => {
    const historyRows = [
      makeHistoryRow({ user_feedback: 'loved it!' }),
      makeHistoryRow({ user_feedback: null }),
      makeHistoryRow({ user_feedback: 'more Puerto Rico please' }),
    ];
    const repos = makeFakeRepos({ historyRows });

    await runDailyFlow(makeEnv(), repos);

    const [, , , feedbackItems] = mockGenerate.mock.calls[0] as Parameters<typeof mockGenerate>;
    expect(feedbackItems).toEqual(['loved it!', 'more Puerto Rico please']);
  });

  it('passes an empty feedback array when no history row has user_feedback', async () => {
    const repos = makeFakeRepos({ historyRows: [makeHistoryRow()] });

    await runDailyFlow(makeEnv(), repos);

    const [, , , feedbackItems] = mockGenerate.mock.calls[0] as Parameters<typeof mockGenerate>;
    expect(feedbackItems).toEqual([]);
  });

  // --- Seed exemplars are sampled -------------------------------------------

  it('passes an array of seed exemplars to generate', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    const [, exemplars] = mockGenerate.mock.calls[0] as Parameters<typeof mockGenerate>;
    // EXEMPLAR_SAMPLE_SIZE = 15, seed file has 38 entries → exactly 15 exemplars
    expect(Array.isArray(exemplars)).toBe(true);
    expect((exemplars as unknown[]).length).toBe(15);
  });

  // --- Clean output: recordSent and Telegram called once -------------------

  it('calls recordSent once with the generated fields on a clean run', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    expect(repos.idiomHistory.recordSent).toHaveBeenCalledOnce();
    expect(repos.idiomHistory.recordSent).toHaveBeenCalledWith(
      expect.objectContaining({
        idiom_text:              mockWriterOutput.idiom.phrase,
        idiom_meaning:           mockWriterOutput.idiom.meaning,
        idiom_region:            mockWriterOutput.idiom.region,
        colloquialism_text:      mockWriterOutput.colloquialism.phrase,
        colloquialism_meaning:   mockWriterOutput.colloquialism.meaning,
        colloquialism_region:    mockWriterOutput.colloquialism.region,
        curator_justification:   `idiom: ${mockWriterOutput.idiom.why_different} | colloquialism: ${mockWriterOutput.colloquialism.why_different}`,
      }),
    );
  });

  it('POSTs to the Telegram sendMessage URL once on a clean run', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTEST-TOKEN/sendMessage');
  });

  // --- Log line emitted exactly once ----------------------------------------

  it('emits the [idiom-app] Daily message log line exactly once', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    const appLogCalls = consoleLogSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && (msg as string).startsWith('[idiom-app]'),
    );
    expect(appLogCalls).toHaveLength(1);
  });

  // --- Message body includes both phrases -----------------------------------

  it('assembles a message body that includes the idiom phrase', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    void url;
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toContain(mockWriterOutput.idiom.phrase);
  });

  it('assembles a message body that includes the colloquialism phrase', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toContain(mockWriterOutput.colloquialism.phrase);
  });

  // --- Regional note for non-general region ---------------------------------

  it('includes a natural regional note for a phrase with a non-general region', async () => {
    // mockWriterOutput.colloquialism.region is 'Spain' → "common in Spain"
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toContain('common in Spain');
  });

  it('omits a regional note when region is "general"', async () => {
    // mockWriterOutput.idiom.region is 'general' — no note expected
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { text: string };
    // The general region label itself should not appear as a note
    expect(body.text).not.toContain('(general)');
  });

  // --- Collision triggers a second generate call ---------------------------

  it('calls generate a second time with collisionHint when the first attempt collides', async () => {
    const collidingPhrase = 'echarle un vistazo';
    mockFindCollision
      .mockReturnValueOnce(collidingPhrase) // idiom collision on attempt 0
      .mockReturnValueOnce(null)            // no coll collision on attempt 0
      .mockReturnValueOnce(null)            // no idiom collision on attempt 1
      .mockReturnValueOnce(null);           // no coll collision on attempt 1

    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    expect(mockGenerate).toHaveBeenCalledTimes(2);
    const secondCallArgs = mockGenerate.mock.calls[1] as Parameters<typeof mockGenerate>;
    // collisionHint is the 5th argument
    expect(secondCallArgs[4]).toBe(collidingPhrase);
  });

  it('generates without a collisionHint on the first attempt', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    const firstCallArgs = mockGenerate.mock.calls[0] as Parameters<typeof mockGenerate>;
    expect(firstCallArgs[4]).toBeUndefined();
  });

  // --- Retry exhaustion throws ----------------------------------------------

  it('throws with a message containing "dedup retry limit reached" when all retries collide', async () => {
    mockFindCollision.mockReturnValue('some existing phrase');

    const repos = makeFakeRepos();
    await expect(runDailyFlow(makeEnv(), repos)).rejects.toThrow('dedup retry limit reached');
  });

  it('does not call recordSent when retry limit is exhausted', async () => {
    mockFindCollision.mockReturnValue('some existing phrase');

    const repos = makeFakeRepos();
    await expect(runDailyFlow(makeEnv(), repos)).rejects.toThrow();
    expect(repos.idiomHistory.recordSent).not.toHaveBeenCalled();
  });

  // --- Telegram 429 throws; recordSent NOT called -------------------------

  it('throws when Telegram returns a non-2xx status', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }));
    const repos = makeFakeRepos();

    await expect(runDailyFlow(makeEnv(), repos)).rejects.toThrow(
      'Telegram sendMessage failed: 429: rate limited',
    );
  });

  it('does not call recordSent when the Telegram POST fails', async () => {
    fetchMock.mockResolvedValue(new Response('server error', { status: 500 }));
    const repos = makeFakeRepos();

    await expect(runDailyFlow(makeEnv(), repos)).rejects.toThrow();
    expect(repos.idiomHistory.recordSent).not.toHaveBeenCalled();
  });
});
