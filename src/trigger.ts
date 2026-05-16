import { Context } from 'hono';
import type { Env } from './types';
import type { Repos } from './db';
import { runDailyFlow } from './orchestrator';

/**
 * Handles a manual invocation of the daily flow.
 *
 * Mirrors what the cron event does, but exposed as POST /trigger and gated on
 * a shared secret so the public Worker URL cannot be abused. Used for ad-hoc
 * testing from the terminal (curl) without waiting for the 13:00 UTC cron.
 *
 * Unlike the cron handler, this awaits runDailyFlow and surfaces failures as
 * an HTTP 500 with the error message — so curl output reflects success/failure
 * directly instead of always returning 200.
 */
export async function handleTrigger(
  c: Context<{ Bindings: Env }>,
  repos: Repos,
): Promise<Response> {
  const auth = c.req.header('authorization') ?? '';
  const expected = `Bearer ${c.env.TRIGGER_SECRET}`;
  if (auth !== expected) {
    return c.text('Forbidden', 403);
  }

  try {
    await runDailyFlow(c.env, repos);
    return c.json({ ok: true });
  } catch (error) {
    console.error('[idiom-app] /trigger run failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, 500);
  }
}
