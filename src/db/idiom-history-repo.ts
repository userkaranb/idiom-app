import type { IdiomHistory, IdiomHistoryInsert } from '../types';

/**
 * All D1 access for the `idiom_history` table.
 *
 * Callers (the Orchestrator and webhook handler) never write SQL directly.
 * Every method name expresses a domain action — `recordSent`, `recordFeedback` —
 * not the underlying SQL mechanism.
 */
export interface IdiomHistoryRepo {
  /**
   * Returns all history rows, most-recent first.
   *
   * The Orchestrator passes this result to the dedup gate (in-memory fuzzy
   * match) and extracts verbatim user feedback to pass to the generator.
   */
  listAllSentHistory(): Promise<IdiomHistory[]>;

  /** Returns the single most-recent history row, or null if history is empty. */
  getMostRecent(): Promise<IdiomHistory | null>;

  /** Appends one row recording what was sent today. */
  recordSent(entry: IdiomHistoryInsert): Promise<void>;

  /**
   * Stores the user's freeform reply text against the history row identified
   * by `rowId`. Called by the webhook when the user replies to the bot.
   */
  recordFeedback(rowId: number, freeform: string): Promise<void>;
}

export function createIdiomHistoryRepo(db: D1Database): IdiomHistoryRepo {
  async function listAllSentHistory(): Promise<IdiomHistory[]> {
    const result = await db
      .prepare('SELECT * FROM idiom_history ORDER BY id DESC')
      .all<IdiomHistory>();
    return result.results;
  }

  async function getMostRecent(): Promise<IdiomHistory | null> {
    return db
      .prepare('SELECT * FROM idiom_history ORDER BY id DESC LIMIT 1')
      .first<IdiomHistory>();
  }

  async function recordSent(entry: IdiomHistoryInsert): Promise<void> {
    await db
      .prepare(
        `INSERT INTO idiom_history
           (sent_at, idiom_id, idiom_text, idiom_meaning, idiom_example, idiom_region,
            colloquialism_id, colloquialism_text, colloquialism_meaning, colloquialism_example, colloquialism_region,
            curator_justification)
         VALUES
           (datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entry.idiom_id,
        entry.idiom_text,
        entry.idiom_meaning,
        entry.idiom_example,
        entry.idiom_region,
        entry.colloquialism_id,
        entry.colloquialism_text,
        entry.colloquialism_meaning,
        entry.colloquialism_example,
        entry.colloquialism_region,
        entry.curator_justification,
      )
      .run();
  }

  async function recordFeedback(rowId: number, freeform: string): Promise<void> {
    await db
      .prepare('UPDATE idiom_history SET user_feedback = ? WHERE id = ?')
      .bind(freeform, rowId)
      .run();
  }

  return {
    listAllSentHistory,
    getMostRecent,
    recordSent,
    recordFeedback,
  };
}
