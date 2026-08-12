import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../src/types';

// vi.hoisted runs before any imports so mock functions are available inside
// the vi.mock factory closures below.
const { mockRunDailyFlow } = vi.hoisted(() => ({
  mockRunDailyFlow: vi.fn(),
}));

// Mock runDailyFlow so we can control success/failure without touching D1 or
// the real LLM agents. createRepositories is still called but the repos it
// returns are never used because runDailyFlow is mocked.
vi.mock('../src/orchestrator', () => ({ runDailyFlow: mockRunDailyFlow }));

// Mock the webhook handler to prevent loading any modules that import
// @anthropic-ai/sdk — a Node.js module not available in the Workers V8 sandbox.
// The scheduled() handler under test never calls handleTelegramWebhook; this
// mock is purely to allow the import of src/index.ts to succeed.
vi.mock('../src/webhook', () => ({ handleTelegramWebhook: vi.fn() }));

import handler from '../src/index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function makeEvent(): ScheduledEvent {
  return { scheduledTime: 0, cron: '0 13 * * *', type: 'scheduled' } as unknown as ScheduledEvent;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Invokes the scheduled handler and returns the inner promise passed to
 * ctx.waitUntil(). The scheduled handler calls ctx.waitUntil() synchronously
 * before returning, so we can capture the promise without awaiting anything.
 *
 * The mock ctx.waitUntil attaches a no-op .catch() to the captured promise
 * immediately, which prevents an "unhandled rejection" diagnostic from firing
 * in the Workers V8 sandbox before the test's own assertion handles it.
 *
 * NOTE: This function must remain a plain (non-async) function. An `async`
 * wrapper would cause the returned Promise<void> to be automatically unwrapped
 * by the JavaScript runtime when the caller does `await runScheduled(...)`,
 * turning `innerPromise` into `undefined` for the success case.
 */
function runScheduled(env: Env): Promise<void> {
  let innerPromise!: Promise<void>;

  const ctx = {
    waitUntil: vi.fn((p: Promise<void>) => {
      innerPromise = p;
      // Attach a no-op catch synchronously so the Workers runtime does not
      // report this as an unhandled rejection before the test assertion runs.
      p.catch(() => {});
    }),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  // handler.scheduled() calls ctx.waitUntil() synchronously before it returns
  // (no await precedes the ctx.waitUntil call in the implementation), so
  // innerPromise is populated by the time this line executes.
  handler.scheduled(makeEvent(), env, ctx);

  return innerPromise;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scheduled() handler — alert on failure', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRunDailyFlow.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // -- Dedup retry exhaustion -----------------------------------------------

  it('sends the generic failure alert when dedup retry limit is exhausted', async () => {
    mockRunDailyFlow.mockRejectedValue(
      new Error('Generator: dedup retry limit reached — could not generate non-duplicate phrases after 3 attempts'),
    );

    const innerPromise = runScheduled(makeEnv());

    await expect(innerPromise).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTEST-TOKEN/sendMessage');
    const body = JSON.parse(init.body as string) as { chat_id: string; text: string };
    expect(body.text).toContain('⚠️ Daily flow failed:');
    expect(body.text).toContain('dedup retry limit reached');
  });

  // -- Generic crash ---------------------------------------------------------

  it('sends a generic failure alert containing the error message for non-exhaustion errors', async () => {
    mockRunDailyFlow.mockRejectedValue(new Error('something exploded'));

    const innerPromise = runScheduled(makeEnv());

    await expect(innerPromise).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toContain('⚠️ Daily flow failed:');
    expect(body.text).toContain('something exploded');
  });

  // -- Alert fetch failure is silent ----------------------------------------

  it('propagates the original error even when the alert fetch throws, and calls console.error', async () => {
    const originalError = new Error('runDailyFlow crashed');
    mockRunDailyFlow.mockRejectedValue(originalError);
    fetchMock.mockRejectedValue(new Error('network failure'));

    const innerPromise = runScheduled(makeEnv());

    // The original error — not the fetch error — must propagate
    await expect(innerPromise).rejects.toThrow('runDailyFlow crashed');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  // -- No alert on success ---------------------------------------------------

  it('does NOT call Telegram when runDailyFlow succeeds', async () => {
    mockRunDailyFlow.mockResolvedValue(undefined);

    const innerPromise = runScheduled(makeEnv());

    await expect(innerPromise).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // -- Original error still propagates after alerting -----------------------

  it('re-throws the original error after alerting so Cloudflare marks the invocation as failed', async () => {
    mockRunDailyFlow.mockRejectedValue(new Error('daily flow boom'));

    const innerPromise = runScheduled(makeEnv());

    await expect(innerPromise).rejects.toThrow('daily flow boom');
  });
});
