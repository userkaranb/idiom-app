import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, IdiomHistory } from '../src/types';
import type { Repos } from '../src/db';
import { signCookie } from '../src/auth';

// ---------------------------------------------------------------------------
// Hoist mock factories before any module imports so vi.mock picks them up.
// ---------------------------------------------------------------------------

const { mockRunDailyFlow } = vi.hoisted(() => ({
  mockRunDailyFlow: vi.fn(),
}));

// Mock the Writer agent first so that importOriginal on orchestrator below
// does not transitively load @anthropic-ai/sdk (which has node:fs deps that
// are unavailable in the Workers V8 sandbox).
vi.mock('../src/agents/writer', () => ({ generate: vi.fn() }));

// Partially mock orchestrator: preserve real exports (formatPhraseFromRow,
// regionNote, formatPhrase) and replace only runDailyFlow.
vi.mock('../src/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orchestrator')>();
  return { ...actual, runDailyFlow: mockRunDailyFlow };
});

import { requireAuth, handleLoginGet, handleLoginPost } from '../src/auth';
import { handleGetHistory, handlePostSend, handlePostFeedback } from '../src/api';
import { renderPage } from '../src/ui';
import { formatPhraseFromRow } from '../src/orchestrator';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_PASSWORD    = 'test-password';
const TEST_COOKIE_SECRET = 'test-cookie-secret';

function buildEnv(): Env {
  return {
    DB: {} as D1Database,
    ANTHROPIC_API_KEY: 'test-key',
    TELEGRAM_BOT_TOKEN: 'TEST-TOKEN',
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
    TRIGGER_SECRET: 'test-trigger-secret',
    WEB_PASSWORD: TEST_PASSWORD,
    COOKIE_SECRET: TEST_COOKIE_SECRET,
  };
}

const sampleHistoryRow: IdiomHistory = {
  id: 1,
  sent_at: '2025-01-15T13:00:00Z',
  idiom_id: 'echar-agua-al-mar',
  idiom_text: 'Echar agua al mar',
  idiom_meaning: 'to do something pointless',
  idiom_example: 'Intentar convencerlo es echar agua al mar.',
  idiom_region: 'general',
  colloquialism_id: 'no-hay-mal',
  colloquialism_text: 'No hay mal que por bien no venga',
  colloquialism_meaning: 'every cloud has a silver lining',
  colloquialism_example: 'Perdí el trabajo pero encontré algo mejor. No hay mal que por bien no venga.',
  colloquialism_region: 'Mexico',
  curator_justification: 'idiom: distinct from history | colloquialism: distinct from history',
  user_rating: null,
  user_feedback: null,
};

function makeFakeRepos(history: IdiomHistory[] = []): Repos {
  return {
    idiomHistory: {
      listAllSentHistory: vi.fn().mockResolvedValue(history),
      getMostRecent:      vi.fn().mockResolvedValue(null),
      recordSent:         vi.fn().mockResolvedValue(undefined),
      recordFeedback:     vi.fn().mockResolvedValue(undefined),
    },
  };
}

function buildApp(repos: Repos) {
  const app = new Hono<{ Bindings: Env }>();

  // Unprotected auth routes
  app.get('/login', () => handleLoginGet());
  app.post('/login', (c) => handleLoginPost(c));

  // Session middleware applied to page and API routes
  app.use('/', async (c, next) => requireAuth(c.env.COOKIE_SECRET)(c, next));
  app.use('/api/*', async (c, next) => requireAuth(c.env.COOKIE_SECRET)(c, next));

  // Protected routes
  app.get('/', () => renderPage());
  app.get('/api/history', (c) => handleGetHistory(c, repos));
  app.post('/api/send', (c) => handlePostSend(c, repos));
  app.post('/api/feedback', (c) => handlePostFeedback(c, repos));

  return app;
}

// ---------------------------------------------------------------------------
// Session cookie — computed once before all tests (same secret across tests).
// ---------------------------------------------------------------------------

let validSessionCookie: string;

beforeAll(async () => {
  validSessionCookie = await signCookie(TEST_COOKIE_SECRET, 'authenticated');
});

function authHeaders(): Record<string, string> {
  return { Cookie: `session=${validSessionCookie}` };
}

// ---------------------------------------------------------------------------
// formatPhraseFromRow — unit-level contract (real implementation via mock spread)
// ---------------------------------------------------------------------------

describe('formatPhraseFromRow', () => {
  it('returns the phrase text and label with no occurrence of the string "null" when all optional fields are null', () => {
    const result = formatPhraseFromRow('echar agua al mar', null, null, null, 'Idiom');
    expect(result).toContain('echar agua al mar');
    expect(result).not.toContain('null');
  });

  it('includes meaning and example when they are non-null', () => {
    const result = formatPhraseFromRow('some phrase', 'the meaning', 'the example', null, 'Idiom');
    expect(result).toContain('the meaning');
    expect(result).toContain('the example');
  });

  it('skips the region note when region is "general"', () => {
    const result = formatPhraseFromRow('some phrase', null, null, 'general', 'Idiom');
    expect(result).not.toContain('general');
  });

  it('includes the region note when region is a known non-general region', () => {
    const result = formatPhraseFromRow('some phrase', null, null, 'Mexico', 'Idiom');
    expect(result).toContain('Mexico');
  });
});

// ---------------------------------------------------------------------------
// Auth middleware — unauthenticated requests
// ---------------------------------------------------------------------------

describe('Auth middleware — unauthenticated', () => {
  it('GET / without cookie → 302 redirect to /login', async () => {
    const res = await buildApp(makeFakeRepos()).request(
      'http://localhost/',
      { method: 'GET' },
      buildEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
  });

  it('GET /api/history without cookie → 401 JSON', async () => {
    const res = await buildApp(makeFakeRepos()).request(
      'http://localhost/api/history',
      { method: 'GET' },
      buildEnv(),
    );
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('POST /api/send without cookie → 401 JSON', async () => {
    const res = await buildApp(makeFakeRepos()).request(
      'http://localhost/api/send',
      { method: 'POST' },
      buildEnv(),
    );
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

describe('Login page', () => {
  it('GET /login → 200 with HTML containing a <form', async () => {
    const res = await buildApp(makeFakeRepos()).request(
      'http://localhost/login',
      { method: 'GET' },
      buildEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<form');
  });

  it('POST /login with wrong password → 401 with body containing "Incorrect"', async () => {
    const res = await buildApp(makeFakeRepos()).request(
      'http://localhost/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'password=wrong-password',
      },
      buildEnv(),
    );
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain('Incorrect');
  });

  it('POST /login with correct password → 302 to / with Set-Cookie containing session=', async () => {
    const res = await buildApp(makeFakeRepos()).request(
      'http://localhost/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `password=${TEST_PASSWORD}`,
      },
      buildEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');
    expect(res.headers.get('Set-Cookie')).toContain('session=');
  });

  it('sets HttpOnly and SameSite but omits Secure over plain HTTP (wrangler dev)', async () => {
    const res = await buildApp(makeFakeRepos()).request(
      'http://localhost/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `password=${TEST_PASSWORD}`,
      },
      buildEnv(),
    );
    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });

  it('marks the session cookie Secure when the request arrives over HTTPS', async () => {
    const res = await buildApp(makeFakeRepos()).request(
      'https://idiom-app.example.com/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `password=${TEST_PASSWORD}`,
      },
      buildEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Set-Cookie')).toContain('Secure');
  });
});

// ---------------------------------------------------------------------------
// Authenticated API routes
// ---------------------------------------------------------------------------

// A history row that pre-dates migration 0002: all optional phrase columns are null.
const nullFieldHistoryRow: IdiomHistory = {
  id: 99,
  sent_at: '2024-06-01T13:00:00Z',
  idiom_id: 'old-idiom',
  idiom_text: 'una vieja frase',
  idiom_meaning: null,
  idiom_example: null,
  idiom_region: null,
  colloquialism_id: 'old-coll',
  colloquialism_text: 'un viejo dicho',
  colloquialism_meaning: null,
  colloquialism_example: null,
  colloquialism_region: null,
  curator_justification: '',
  user_rating: null,
  user_feedback: null,
};

describe('GET /api/history (authenticated)', () => {
  it('returns 200 with a JSON array from listAllSentHistory', async () => {
    const repos = makeFakeRepos([sampleHistoryRow]);
    const res = await buildApp(repos).request(
      'http://localhost/api/history',
      { method: 'GET', headers: authHeaders() },
      buildEnv(),
    );
    expect(res.status).toBe(200);
    const rows = await res.json() as Array<IdiomHistory & { message_text: string }>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it('includes a non-empty message_text field on each row that never contains the string "null"', async () => {
    // Use a row with all-null optional fields to prove formatPhraseFromRow handles them.
    const repos = makeFakeRepos([nullFieldHistoryRow]);
    const res = await buildApp(repos).request(
      'http://localhost/api/history',
      { method: 'GET', headers: authHeaders() },
      buildEnv(),
    );
    const rows = await res.json() as Array<{ message_text: string; idiom_text: string }>;
    expect(typeof rows[0].message_text).toBe('string');
    expect(rows[0].message_text.length).toBeGreaterThan(0);
    expect(rows[0].message_text).toContain(nullFieldHistoryRow.idiom_text);
    expect(rows[0].message_text).not.toContain('null');
  });

  it('computes region notes server-side so the page never duplicates the wording', async () => {
    const repos = makeFakeRepos([sampleHistoryRow]);
    const res = await buildApp(repos).request(
      'http://localhost/api/history',
      { method: 'GET', headers: authHeaders() },
      buildEnv(),
    );
    const rows = await res.json() as Array<Record<string, unknown>>;

    // "general" carries no note — there is nothing regional to say about it.
    expect(rows[0].idiom_region_note).toBeNull();
    // A named region resolves to the same phrasing the Telegram message uses.
    expect(rows[0].colloquialism_region_note).toBe('very common in Mexico');
  });

  it('returns null region notes for rows predating migration 0002', async () => {
    const repos = makeFakeRepos([nullFieldHistoryRow]);
    const res = await buildApp(repos).request(
      'http://localhost/api/history',
      { method: 'GET', headers: authHeaders() },
      buildEnv(),
    );
    const rows = await res.json() as Array<Record<string, unknown>>;
    expect(rows[0].idiom_region_note).toBeNull();
    expect(rows[0].colloquialism_region_note).toBeNull();
  });
});

describe('POST /api/send (authenticated)', () => {
  beforeEach(() => {
    mockRunDailyFlow.mockReset();
  });

  it('returns 200 { ok: true } when runDailyFlow succeeds', async () => {
    mockRunDailyFlow.mockResolvedValue(undefined);
    const res = await buildApp(makeFakeRepos()).request(
      'http://localhost/api/send',
      { method: 'POST', headers: authHeaders() },
      buildEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockRunDailyFlow).toHaveBeenCalledOnce();
  });

  it('returns 500 { ok: false, error } when runDailyFlow throws', async () => {
    mockRunDailyFlow.mockRejectedValue(new Error('LLM timeout'));
    const res = await buildApp(makeFakeRepos()).request(
      'http://localhost/api/send',
      { method: 'POST', headers: authHeaders() },
      buildEnv(),
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('LLM timeout');
  });
});

describe('POST /api/feedback (authenticated)', () => {
  it('returns 200 and calls recordFeedback with the verbatim text', async () => {
    const repos = makeFakeRepos();
    const verbatimText = '  loved the phrase!  '; // leading/trailing spaces intentional
    const res = await buildApp(repos).request(
      'http://localhost/api/feedback',
      {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowId: 42, text: verbatimText }),
      },
      buildEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(repos.idiomHistory.recordFeedback).toHaveBeenCalledWith(42, verbatimText);
  });

  it('returns 400 when text is missing', async () => {
    const res = await buildApp(makeFakeRepos()).request(
      'http://localhost/api/feedback',
      {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowId: 42 }),
      },
      buildEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when rowId is missing', async () => {
    const res = await buildApp(makeFakeRepos()).request(
      'http://localhost/api/feedback',
      {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'some feedback' }),
      },
      buildEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when text is an empty string', async () => {
    const res = await buildApp(makeFakeRepos()).request(
      'http://localhost/api/feedback',
      {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowId: 1, text: '' }),
      },
      buildEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when rowId is not a positive integer', async () => {
    const res = await buildApp(makeFakeRepos()).request(
      'http://localhost/api/feedback',
      {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowId: -5, text: 'feedback' }),
      },
      buildEnv(),
    );
    expect(res.status).toBe(400);
  });
});
