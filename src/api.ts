import { Context } from 'hono';
import type { Env, IdiomHistory } from './types';
import type { Repos } from './db';
import { runDailyFlow, formatPhraseFromRow } from './orchestrator';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Assembles the same message body that was sent to Telegram for a history row.
 *
 * Uses `formatPhraseFromRow` so old rows with NULL columns render gracefully
 * (null fields are omitted; the string "null" is never produced).
 */
function buildMessageText(row: IdiomHistory): string {
  return (
    `Today's two:\n\n` +
    formatPhraseFromRow(row.idiom_text, row.idiom_meaning, row.idiom_example, row.idiom_region, 'Idiom') +
    `\n\n` +
    formatPhraseFromRow(row.colloquialism_text, row.colloquialism_meaning, row.colloquialism_example, row.colloquialism_region, 'Colloquialism')
  );
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * Returns all sent history rows, most-recent first, with an added
 * `message_text` field showing the formatted text delivered to Telegram.
 */
export async function handleGetHistory(
  c: Context<{ Bindings: Env }>,
  repos: Repos,
): Promise<Response> {
  const history = await repos.idiomHistory.listAllSentHistory();
  const rows = history.map(row => ({ ...row, message_text: buildMessageText(row) }));
  return c.json(rows);
}

/**
 * Runs the full daily flow immediately, identical to the cron path.
 *
 * The caller is already authenticated by the session cookie — TRIGGER_SECRET
 * is never exposed to the browser. Errors surface as a 500 JSON body so the
 * page JS can display them without a full reload.
 */
export async function handlePostSend(
  c: Context<{ Bindings: Env }>,
  repos: Repos,
): Promise<Response> {
  try {
    await runDailyFlow(c.env, repos);
    return c.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, 500);
  }
}

/**
 * Stores verbatim user feedback against a specific history row.
 *
 * INVARIANT: the feedback text is stored exactly as received — no trimming,
 * no summarization, no classification. Any mutation here breaks the feedback
 * loop that passes raw text to the generator on the next daily run.
 */
export async function handlePostFeedback(
  c: Context<{ Bindings: Env }>,
  repos: Repos,
): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  if (typeof body !== 'object' || body === null) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const { rowId, text } = body as Record<string, unknown>;

  if (typeof rowId !== 'number' || !Number.isInteger(rowId) || rowId <= 0) {
    return c.json({ error: 'rowId must be a positive integer' }, 400);
  }

  if (typeof text !== 'string' || text.length === 0) {
    return c.json({ error: 'text must be a non-empty string' }, 400);
  }

  // Verbatim storage — no mutation of `text` before this call.
  await repos.idiomHistory.recordFeedback(rowId, text);
  return c.json({ ok: true });
}
