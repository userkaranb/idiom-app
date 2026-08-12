/**
 * Tests for IdiomHistoryRepo.
 *
 * Each test verifies the SQL emitted by the repo method (correct table,
 * columns, placeholders, ORDER BY, LIMIT) and the values bound to each
 * placeholder. A mock D1Database captures every `prepare()` call so we can
 * assert on SQL and bindings without a running database.
 */
import { vi, describe, it, expect } from 'vitest';
import type { IdiomHistory, IdiomHistoryInsert } from '../types';
import { createIdiomHistoryRepo } from './idiom-history-repo';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_ROW: IdiomHistory = {
  id: 7,
  sent_at: '2024-01-01T13:00:00Z',
  idiom_id: 'el-que-no-llora',
  idiom_text: 'El que no llora no mama',
  idiom_meaning: null,
  idiom_example: null,
  idiom_region: null,
  colloquialism_id: 'chido',
  colloquialism_text: 'chido',
  colloquialism_meaning: null,
  colloquialism_example: null,
  colloquialism_region: null,
  curator_justification: 'good fit',
  user_rating: null,
  user_feedback: null,
};

const BASE_INSERT: IdiomHistoryInsert = {
  idiom_id:              'el-que-no-llora',
  idiom_text:            'El que no llora no mama',
  idiom_meaning:         "if you don't speak up, you don't get what you want",
  idiom_example:         'Pídele un aumento — el que no llora no mama.',
  idiom_region:          'general',
  colloquialism_id:      'chido',
  colloquialism_text:    'chido',
  colloquialism_meaning: 'cool',
  colloquialism_example: '¡Qué chido!',
  colloquialism_region:  'Mexico',
  curator_justification: 'idiom: Common. | colloquialism: Casual.',
};

// ---------------------------------------------------------------------------
// D1 mock helpers
// ---------------------------------------------------------------------------

/**
 * Builds a D1Database mock whose `prepare().all()` returns `allRows`,
 * `.first()` returns `firstRow`, and `.bind().run()` is tracked.
 */
function buildD1Mock({
  allRows   = [] as IdiomHistory[],
  firstRow  = null as IdiomHistory | null | { 1: number },
} = {}) {
  const runMock  = vi.fn().mockResolvedValue({});
  const bindMock = vi.fn().mockReturnValue({
    all:  vi.fn().mockResolvedValue({ results: allRows }),
    run:  runMock,
    first: vi.fn().mockResolvedValue(firstRow),
  });

  const prepareMock = vi.fn().mockReturnValue({
    all:   vi.fn().mockResolvedValue({ results: allRows }),
    first: vi.fn().mockResolvedValue(firstRow),
    bind:  bindMock,
    run:   runMock,
  });

  const db = { prepare: prepareMock } as unknown as D1Database;
  return { db, prepareMock, bindMock, runMock };
}

// ---------------------------------------------------------------------------
// listAllSentHistory
// ---------------------------------------------------------------------------

describe('IdiomHistoryRepo.listAllSentHistory', () => {
  it('queries the idiom_history table ordered by id DESC', async () => {
    const { db, prepareMock } = buildD1Mock();
    const repo = createIdiomHistoryRepo(db);

    await repo.listAllSentHistory();

    const sql = prepareMock.mock.calls[0][0] as string;
    expect(sql).toContain('FROM idiom_history');
    expect(sql).toContain('ORDER BY id DESC');
  });

  it('returns the rows from the D1 result', async () => {
    const { db } = buildD1Mock({ allRows: [BASE_ROW] });
    const repo = createIdiomHistoryRepo(db);

    const result = await repo.listAllSentHistory();

    expect(result).toEqual([BASE_ROW]);
  });

  it('returns an empty array when history is empty', async () => {
    const { db } = buildD1Mock({ allRows: [] });
    const repo = createIdiomHistoryRepo(db);

    const result = await repo.listAllSentHistory();

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getMostRecent
// ---------------------------------------------------------------------------

describe('IdiomHistoryRepo.getMostRecent', () => {
  it('queries idiom_history ORDER BY id DESC LIMIT 1', async () => {
    const { db, prepareMock } = buildD1Mock({ firstRow: BASE_ROW });
    const repo = createIdiomHistoryRepo(db);

    await repo.getMostRecent();

    const sql = prepareMock.mock.calls[0][0] as string;
    expect(sql).toContain('FROM idiom_history');
    expect(sql).toContain('ORDER BY id DESC LIMIT 1');
  });

  it('returns the most recent row when history is non-empty', async () => {
    const { db } = buildD1Mock({ firstRow: BASE_ROW });
    const repo = createIdiomHistoryRepo(db);

    const result = await repo.getMostRecent();

    expect(result).toEqual(BASE_ROW);
  });

  it('returns null when history is empty', async () => {
    const { db } = buildD1Mock({ firstRow: null });
    const repo = createIdiomHistoryRepo(db);

    const result = await repo.getMostRecent();

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordSent
// ---------------------------------------------------------------------------

describe('IdiomHistoryRepo.recordSent', () => {
  it('inserts into idiom_history with the correct column list', async () => {
    const { db, prepareMock } = buildD1Mock();
    const repo = createIdiomHistoryRepo(db);

    await repo.recordSent(BASE_INSERT);

    const sql = prepareMock.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO idiom_history');
    expect(sql).toContain('idiom_id');
    expect(sql).toContain('idiom_text');
    expect(sql).toContain('idiom_meaning');
    expect(sql).toContain('idiom_example');
    expect(sql).toContain('idiom_region');
    expect(sql).toContain('colloquialism_id');
    expect(sql).toContain('colloquialism_text');
    expect(sql).toContain('colloquialism_meaning');
    expect(sql).toContain('colloquialism_example');
    expect(sql).toContain('colloquialism_region');
    expect(sql).toContain('curator_justification');
    // sent_at is defaulted by the DB expression, not a bound placeholder
    expect(sql).toContain("datetime('now')");
  });

  it('binds all eleven entry fields in declaration order', async () => {
    const { db, bindMock } = buildD1Mock();
    const repo = createIdiomHistoryRepo(db);

    await repo.recordSent(BASE_INSERT);

    expect(bindMock).toHaveBeenCalledWith(
      BASE_INSERT.idiom_id,
      BASE_INSERT.idiom_text,
      BASE_INSERT.idiom_meaning,
      BASE_INSERT.idiom_example,
      BASE_INSERT.idiom_region,
      BASE_INSERT.colloquialism_id,
      BASE_INSERT.colloquialism_text,
      BASE_INSERT.colloquialism_meaning,
      BASE_INSERT.colloquialism_example,
      BASE_INSERT.colloquialism_region,
      BASE_INSERT.curator_justification,
    );
  });
});

// ---------------------------------------------------------------------------
// recordFeedback
// ---------------------------------------------------------------------------

describe('IdiomHistoryRepo.recordFeedback', () => {
  it('updates the user_feedback column on the identified row', async () => {
    const { db, prepareMock } = buildD1Mock();
    const repo = createIdiomHistoryRepo(db);

    await repo.recordFeedback(42, 'great phrase!');

    const sql = prepareMock.mock.calls[0][0] as string;
    expect(sql).toContain('UPDATE idiom_history');
    expect(sql).toContain('user_feedback = ?');
    expect(sql).toContain('WHERE id = ?');
  });

  it('binds freeform text and row id in that order', async () => {
    const { db, bindMock } = buildD1Mock();
    const repo = createIdiomHistoryRepo(db);

    await repo.recordFeedback(42, 'loved it');

    expect(bindMock).toHaveBeenCalledWith('loved it', 42);
  });
});

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

describe('IdiomHistoryRepo.getById', () => {
  it('queries idiom_history WHERE id = ? and binds the id', async () => {
    const { db, prepareMock, bindMock } = buildD1Mock({ firstRow: BASE_ROW });
    const repo = createIdiomHistoryRepo(db);

    await repo.getById(7);

    const sql = prepareMock.mock.calls[0][0] as string;
    expect(sql).toContain('FROM idiom_history');
    expect(sql).toContain('WHERE id = ?');
    expect(bindMock).toHaveBeenCalledWith(7);
  });

  it('returns the row when found', async () => {
    const { db } = buildD1Mock({ firstRow: BASE_ROW });
    const repo = createIdiomHistoryRepo(db);

    const result = await repo.getById(7);

    expect(result).toEqual(BASE_ROW);
  });

  it('returns null when not found', async () => {
    const { db } = buildD1Mock({ firstRow: null });
    const repo = createIdiomHistoryRepo(db);

    const result = await repo.getById(999);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// appendFeedback — null existing
// ---------------------------------------------------------------------------

describe('IdiomHistoryRepo.appendFeedback — null existing', () => {
  it('updates user_feedback with just the new text when existing feedback is null', async () => {
    const { db, prepareMock, bindMock } = buildD1Mock({
      firstRow: { user_feedback: null } as unknown as IdiomHistory,
    });
    const repo = createIdiomHistoryRepo(db);

    const result = await repo.appendFeedback(7, 'new note');

    // SELECT comes first, UPDATE second
    const selectSql = prepareMock.mock.calls[0][0] as string;
    const updateSql = prepareMock.mock.calls[1][0] as string;
    expect(selectSql).toContain('SELECT');
    expect(selectSql).toContain('user_feedback');
    expect(selectSql).toContain('WHERE id = ?');
    expect(updateSql).toContain('UPDATE idiom_history');
    expect(updateSql).toContain('user_feedback = ?');

    // UPDATE is bound with just the new text (no merge separator)
    expect(bindMock).toHaveBeenLastCalledWith('new note', 7);
    expect(result).toBe('new note');
  });
});

// ---------------------------------------------------------------------------
// appendFeedback — non-null existing
// ---------------------------------------------------------------------------

describe('IdiomHistoryRepo.appendFeedback — non-null existing', () => {
  it('merges existing feedback with new text using separator and returns the merged string', async () => {
    const { db, prepareMock, bindMock } = buildD1Mock({
      firstRow: { user_feedback: 'old note' } as unknown as IdiomHistory,
    });
    const repo = createIdiomHistoryRepo(db);

    const result = await repo.appendFeedback(7, 'new note');

    const updateSql = prepareMock.mock.calls[1][0] as string;
    expect(updateSql).toContain('UPDATE idiom_history');

    // UPDATE is bound with the merged string
    expect(bindMock).toHaveBeenLastCalledWith('old note\n---\nnew note', 7);
    expect(result).toBe('old note\n---\nnew note');
  });
});
