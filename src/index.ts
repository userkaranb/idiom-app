import { Hono } from 'hono';
import type { Env } from './types';
import { createRepositories } from './db';
import { runDailyFlow } from './orchestrator';
import { handleWebhook } from './webhook';

const app = new Hono<{ Bindings: Env }>();

// Liveness probe. Called by Cloudflare's health-check infrastructure (and
// useful during local development via `wrangler dev`) to verify the Worker
// deployed and is reachable before any real traffic hits it.
app.get('/health', (c) => c.json({ ok: true }));

// POST /webhook — Twilio posts application/x-www-form-urlencoded here when the
// user replies on WhatsApp. The handler verifies the X-Twilio-Signature header
// before processing, then runs Feedback agent → Reflector agent and persists
// the resulting Profile changes to D1.
//
// Repos are constructed per-request from `c.env` so each isolated Worker
// invocation gets its own D1 binding reference.
app.post('/webhook', (c) => handleWebhook(c, createRepositories(c.env)));

export default {
  /**
   * WHO CALLS THIS: Cloudflare invokes `fetch()` for every inbound HTTP
   * request to the Worker URL (both production and `wrangler dev`).
   *
   *   GET  /health  — liveness probe
   *   POST /webhook — signature-verified Twilio inbound; runs Feedback agent →
   *                   Reflector agent and persists resulting Profile changes to D1.
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
