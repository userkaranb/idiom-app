import { Hono } from 'hono';
import type { Env } from './types';
import { createRepositories } from './db';
import { runDailyFlow } from './orchestrator';
import { handleTrigger } from './trigger';
import { handleTelegramWebhook } from './webhook';

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

export default {
  /**
   * WHO CALLS THIS: Cloudflare invokes `fetch()` for every inbound HTTP
   * request to the Worker URL (both production and `wrangler dev`).
   *
   *   GET  /health  — liveness probe
   *   POST /trigger — Bearer-gated ad-hoc invocation of the daily flow.
   *   POST /webhook — Telegram update webhook (secret-token gated).
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
    ctx.waitUntil(runDailyFlow(env, repos));
  },
};
