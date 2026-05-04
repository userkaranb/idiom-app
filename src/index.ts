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
   * WHO CALLS THIS: Cloudflare invokes `fetch()` for every inbound HTTP
   * request to the Worker URL (both production and `wrangler dev`).
   *
   * WHAT IT WILL DO (wired in a later task):
   *   GET  /health  — liveness probe (already live)
   *   POST /webhook — receives a user reply (WhatsApp in v2; plain JSON POST
   *                   in v1 for local testing), runs Feedback agent →
   *                   Reflector agent, and persists the resulting Profile
   *                   changes to D1.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /**
   * WHO CALLS THIS: Cloudflare's Cron Trigger, once a day at 13:00 UTC as
   * declared by `crons = ["0 13 * * *"]` in `wrangler.toml`. Trigger it
   * locally on demand with `wrangler dev --test-scheduled`.
   *
   * WHAT IT WILL DO (wired in a later task — the Orchestrator):
   *   1. Read D1 — fetch the current Profile and recent IdiomHistory rows.
   *   2. Scout — call the LLM with Profile constraints (region, theme,
   *      vulgarity_tolerance, common_vs_obscure) to generate fresh candidate
   *      phrases; instruct it to exclude any id already in IdiomHistory.
   *   3. Curator — second LLM call with forced tool use; receives Scout's
   *      candidates + Profile and picks exactly one idiom + one colloquialism,
   *      returning a typed CuratorVerdict.
   *   4. Writer — third LLM call; turns the CuratorVerdict into the final
   *      user-facing WhatsApp message body.
   *   5. console.log(messageBody) — visible via `wrangler tail` in v1.
   *   6. INSERT one row into idiom_history (sent_at, ids, texts,
   *      curator_justification; user_rating and user_feedback start null).
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('scheduled() stub — orchestrator not wired yet');
  },
};
