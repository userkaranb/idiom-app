import { Hono } from 'hono';
import type { Env } from './types';
import { handleWebhook } from './webhook';
import { runDailyFlow } from './orchestrator';

const app = new Hono<{ Bindings: Env }>();

// Liveness probe. Called by Cloudflare's health-check infrastructure (and
// useful during local development via `wrangler dev`) to verify the Worker
// deployed and is reachable before any real traffic hits it.
app.get('/health', (c) => c.json({ ok: true }));

// POST /webhook — Twilio posts application/x-www-form-urlencoded here when the
// user replies on WhatsApp. The handler verifies the X-Twilio-Signature header
// before processing, then runs Feedback agent → Reflector agent and persists
// the resulting Profile changes to D1.
app.post('/webhook', handleWebhook);

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
   *   1. Read D1 — fetch the current Profile and recent IdiomHistory rows.
   *   2. Scout — filter seed phrases against history for deduplication.
   *   3. Curator — LLM picks one idiom + one colloquialism from candidates.
   *   4. Writer — LLM composes the user-facing WhatsApp message body.
   *   5. console.log + Twilio WhatsApp send to TWILIO_TO_NUMBER.
   *   6. INSERT one row into idiom_history.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailyFlow(env));
  },
};
