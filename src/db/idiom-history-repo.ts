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
   * The Orchestrator passes this result to Scout for lifetime deduplication:
   * Scout excludes any phrase whose id already appears in history.
   */
  listAllSentHistory(): Promise<IdiomHistory[]>;

  /**
   * Returns the `limit` most-recent history rows, for Curator taste-input.
   *
   * Ordered most-recent first so callers can slice from the front.
   */
  listRecent(limit: number): Promise<IdiomHistory[]>;

  /**
   * Returns true if `phrase` exactly matches the `idiom_id` or
   * `colloquialism_id` column of any history row.
   *
   * Executes a single SQL query — O(1) regardless of history size.
   */
  containsPhrase(phrase: string): Promise<boolean>;

  /** Returns the single most-recent history row, or null if history is empty. */
  getMostRecent(): Promise<IdiomHistory | null>;

  /** Appends one row recording what was sent today. */
  recordSent(entry: IdiomHistoryInsert): Promise<void>;

  /**
   * Stores the user's freeform reply text against the history row identified
   * by `rowId`. Called by the webhook after the Feedback agent parses the reply.
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

  async function listRecent(limit: number): Promise<IdiomHistory[]> {
    const result = await db
      .prepare('SELECT * FROM idiom_history ORDER BY id DESC LIMIT ?')
      .bind(limit)
      .all<IdiomHistory>();
    return result.results;
  }

  async function containsPhrase(phrase: string): Promise<boolean> {
    const row = await db
      .prepare(
        'SELECT 1 FROM idiom_history WHERE idiom_id = ? OR colloquialism_id = ? LIMIT 1',
      )
      .bind(phrase, phrase)
      .first<{ 1: number }>();
    return row !== null;
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
           (sent_at, idiom_id, idiom_text, colloquialism_id, colloquialism_text, curator_justification)
         VALUES
           (datetime('now'), ?, ?, ?, ?, ?)`,
      )
      .bind(
        entry.idiom_id,
        entry.idiom_text,
        entry.colloquialism_id,
        entry.colloquialism_text,
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
    listRecent,
    containsPhrase,
    getMostRecent,
    recordSent,
    recordFeedback,
  };
}
