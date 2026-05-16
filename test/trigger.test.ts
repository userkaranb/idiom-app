import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/types';
import type { Repos } from '../src/db';

// Hoisted so the mock factory below can reference it.
const { mockRunDailyFlow } = vi.hoisted(() => ({
  mockRunDailyFlow: vi.fn(),
}));

vi.mock('../src/orchestrator', () => ({ runDailyFlow: mockRunDailyFlow }));

import { handleTrigger } from '../src/trigger';

const TEST_SECRET = 'test-trigger-secret';
const TRIGGER_URL = 'http://localhost/trigger';

function buildEnv(): Env {
  return {
    DB: {} as D1Database,
    ANTHROPIC_API_KEY: 'test-key',
    TWILIO_ACCOUNT_SID: 'AC-test',
    TWILIO_AUTH_TOKEN: 'test-auth-token',
    TWILIO_FROM_NUMBER: '+15702184457',
    TWILIO_TO_NUMBER: '+15551234567',
    TRIGGER_SECRET: TEST_SECRET,
  };
}

// runDailyFlow is mocked at the module level, so the repos argument is never
// actually used inside the handler under test. An empty object satisfies the
// type and keeps the test focused on auth + status-code behaviour.
const unusedRepos = {} as Repos;

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/trigger', (c) => handleTrigger(c, unusedRepos));
  return app;
}

describe('POST /trigger', () => {
  beforeEach(() => {
    mockRunDailyFlow.mockReset();
    mockRunDailyFlow.mockResolvedValue(undefined);
  });

  // -- Auth -----------------------------------------------------------------

  it('returns 403 when the Authorization header is missing', async () => {
    const res = await buildApp().request(TRIGGER_URL, { method: 'POST' }, buildEnv());
    expect(res.status).toBe(403);
    expect(mockRunDailyFlow).not.toHaveBeenCalled();
  });

  it('returns 403 when the Authorization header is the wrong token', async () => {
    const res = await buildApp().request(
      TRIGGER_URL,
      { method: 'POST', headers: { Authorization: 'Bearer wrong-secret' } },
      buildEnv(),
    );
    expect(res.status).toBe(403);
    expect(mockRunDailyFlow).not.toHaveBeenCalled();
  });

  it('returns 403 when the Authorization header lacks the Bearer prefix', async () => {
    const res = await buildApp().request(
      TRIGGER_URL,
      { method: 'POST', headers: { Authorization: TEST_SECRET } },
      buildEnv(),
    );
    expect(res.status).toBe(403);
    expect(mockRunDailyFlow).not.toHaveBeenCalled();
  });

  // -- Happy path -----------------------------------------------------------

  it('returns 200 with {ok:true} and invokes runDailyFlow on a valid token', async () => {
    const res = await buildApp().request(
      TRIGGER_URL,
      { method: 'POST', headers: { Authorization: `Bearer ${TEST_SECRET}` } },
      buildEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockRunDailyFlow).toHaveBeenCalledOnce();
  });

  // -- Error surfacing ------------------------------------------------------

  it('returns 500 with the error message when runDailyFlow throws', async () => {
    mockRunDailyFlow.mockRejectedValue(new Error('Scout: no remaining idioms'));
    const res = await buildApp().request(
      TRIGGER_URL,
      { method: 'POST', headers: { Authorization: `Bearer ${TEST_SECRET}` } },
      buildEnv(),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'Scout: no remaining idioms',
    });
  });
});
