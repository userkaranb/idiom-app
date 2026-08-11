import { Hono } from 'hono';
import type { Env } from './types';
import { createRepositories } from './db';
import { runDailyFlow } from './orchestrator';
import { handleTrigger } from './trigger';
import { handleTelegramWebhook } from './webhook';
import { sendTelegramAlert } from './telegram';
import { requireAuth, handleLoginGet, handleLoginPost } from './auth';
import { handleGetHistory, handlePostSend, handlePostFeedback } from './api';
import { renderPage } from './ui';

const app = new Hono<{ Bindings: Env }>();

// Liveness probe. Called by Cloudflare's health-check infrastructure (and
// useful during local development via `wrangler dev`) to verify the Worker
// deployed and is reachable before any real traffic hits it.
app.get('/health', (c) => c.json({ ok: true }));

// POST /trigger — ad-hoc invocation of the daily flow for terminal testing.
// Gated on TRIGGER_SECRET via `Authorization: Bearer <secret>`. Same code
// path as the cron, but awaits the run and surfaces errors as HTTP 500.
app.post('/trigger', (c) => handleTrigger(c, createRepositories(c.env)));

// POST /webhook — receives Telegram updates (user replies to the bot).
// Telegram calls this URL for every message; the handler verifies the
// X-Telegram-Bot-Api-Secret-Token header and runs the Feedback → Reflector
// pipeline to evolve the user's taste profile.
app.post('/webhook', (c) => handleTelegramWebhook(c, createRepositories(c.env)));

// Auth routes — not behind the session middleware. /webhook and /trigger keep
// their own independent auth schemes so Telegram and curl callers are unaffected.
app.get('/login', () => handleLoginGet());
app.post('/login', (c) => handleLoginPost(c));

// Session middleware for the web UI and its backing API. The factory receives
// the COOKIE_SECRET at request time (not at app-init time) so the env binding
// is available. /webhook, /trigger, and /health are registered above and are
// never reached by these middleware entries.
app.use('/', async (c, next) => requireAuth(c.env.COOKIE_SECRET)(c, next));
app.use('/api/*', async (c, next) => requireAuth(c.env.COOKIE_SECRET)(c, next));

// Protected pages and API routes.
app.get('/', () => renderPage());
app.get('/api/history', (c) => handleGetHistory(c, createRepositories(c.env)));
app.post('/api/send', (c) => handlePostSend(c, createRepositories(c.env)));
app.post('/api/feedback', (c) => handlePostFeedback(c, createRepositories(c.env)));

export default {
  /**
   * WHO CALLS THIS: Cloudflare invokes `fetch()` for every inbound HTTP
   * request to the Worker URL (both production and `wrangler dev`).
   *
   *   GET  /health        — liveness probe
   *   GET  /login         — login form
   *   POST /login         — login form submission
   *   GET  /              — history feed (session-gated)
   *   GET  /api/history   — history JSON (session-gated)
   *   POST /api/send      — ad-hoc daily flow (session-gated)
   *   POST /api/feedback  — store per-row feedback (session-gated)
   *   POST /trigger       — Bearer-gated ad-hoc invocation of the daily flow.
   *   POST /webhook       — Telegram update webhook (secret-token gated).
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /**
   * WHO CALLS THIS: Cloudflare's Cron Trigger, once a day at 13:00 UTC as
   * declared by `crons = ["0 13 * * *"]` in `wrangler.toml`. Trigger it
   * locally on demand with `wrangler dev --test-scheduled`.
   *
   * Repos are constructed once at the top of the scheduled event and passed
   * into the orchestrator — the raw D1 binding never leaks past this boundary.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const repos = createRepositories(env);
    ctx.waitUntil(
      runDailyFlow(env, repos).catch(async (err: unknown) => {
        await sendTelegramAlert(env, err);
        throw err; // re-throw so Cloudflare marks the cron invocation as failed
      }),
    );
  },
};
