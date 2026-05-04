import { Hono } from 'hono';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

// Liveness probe. Called by Cloudflare's health-check infrastructure (and
// useful during local development via `wrangler dev`) to verify the Worker
// deployed and is reachable before any real traffic hits it.
app.get('/health', (c) => c.json({ ok: true }));

// POST /webhook — wired in a later task. In v1 it accepts a fake Twilio-shaped
// JSON body `{ from: string, body: string }` so the feedback loop can be
// exercised without WhatsApp Business API approval. In v2 Twilio posts here
// directly when the user replies on WhatsApp. The handler runs the Feedback
// agent → Reflector agent pipeline and persists the resulting Profile changes.

export default {
  /**
   * Called by Cloudflare for every inbound HTTP request to the Worker.
   *
   * Delegates to the Hono router, which in a later task will handle:
   *   GET  /health  — liveness probe (already wired above)
   *   POST /webhook — inbound WhatsApp reply → Feedback → Reflector → Profile update
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /**
   * Called by Cloudflare's Cron Trigger once a day (schedule: `0 13 * * *`
   * as declared in `wrangler.toml`). In production this fires at 13:00 UTC;
   * locally it can be triggered on demand with `wrangler dev --test-scheduled`.
   *
   * When the Orchestrator is wired in a later task, this handler will:
   *   1. Read Profile + IdiomHistory from D1.
   *   2. Scout — filter seed-phrases.json down to unseen candidates that match
   *      the user's region / theme / vulgarity preferences.
   *   3. Curator — pick one idiom + one colloquialism via forced Anthropic tool
   *      use, returning a typed CuratorVerdict.
   *   4. Writer — compose the user-facing WhatsApp message body.
   *   5. Log the message body via console.log (visible in `wrangler tail`).
   *   6. Append one row to idiom_history in D1.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('scheduled() stub — orchestrator not wired yet');
  },
};
