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
  colloquialism_id: 'chido',
  colloquialism_text: 'chido',
  curator_justification: 'good fit',
  user_rating: null,
  user_feedback: null,
};

const BASE_INSERT: IdiomHistoryInsert = {
  idiom_id:              'el-que-no-llora',
  idiom_text:            'El que no llora no mama',
  colloquialism_id:      'chido',
  colloquialism_text:    'chido',
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
// listRecent
// ---------------------------------------------------------------------------

describe('IdiomHistoryRepo.listRecent', () => {
  it('queries with ORDER BY id DESC LIMIT ? and binds the limit argument', async () => {
    const { db, prepareMock, bindMock } = buildD1Mock();
    const repo = createIdiomHistoryRepo(db);

    await repo.listRecent(10);

    const sql = prepareMock.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY id DESC LIMIT ?');
    expect(bindMock).toHaveBeenCalledWith(10);
  });

  it('returns the rows from the D1 result', async () => {
    const { db } = buildD1Mock({ allRows: [BASE_ROW] });
    const repo = createIdiomHistoryRepo(db);

    const result = await repo.listRecent(5);

    expect(result).toEqual([BASE_ROW]);
  });
});

// ---------------------------------------------------------------------------
// containsPhrase
// ---------------------------------------------------------------------------

describe('IdiomHistoryRepo.containsPhrase', () => {
  it('checks both idiom_id and colloquialism_id columns in a single query', async () => {
    const { db, prepareMock } = buildD1Mock({ firstRow: null });
    const repo = createIdiomHistoryRepo(db);

    await repo.containsPhrase('some-phrase');

    const sql = prepareMock.mock.calls[0][0] as string;
    expect(sql).toContain('idiom_id');
    expect(sql).toContain('colloquialism_id');
  });

  it('binds the phrase value for both column checks', async () => {
    const { db, bindMock } = buildD1Mock({ firstRow: null });
    const repo = createIdiomHistoryRepo(db);

    await repo.containsPhrase('target-phrase');

    expect(bindMock).toHaveBeenCalledWith('target-phrase', 'target-phrase');
  });

  it('returns true when a matching row exists', async () => {
    const { db } = buildD1Mock({ firstRow: { 1: 1 } });
    const repo = createIdiomHistoryRepo(db);

    const result = await repo.containsPhrase('known-phrase');

    expect(result).toBe(true);
  });

  it('returns false when no matching row exists', async () => {
    const { db } = buildD1Mock({ firstRow: null });
    const repo = createIdiomHistoryRepo(db);

    const result = await repo.containsPhrase('unknown-phrase');

    expect(result).toBe(false);
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
    expect(sql).toContain('colloquialism_id');
    expect(sql).toContain('colloquialism_text');
    expect(sql).toContain('curator_justification');
    // sent_at is defaulted by the DB expression, not a bound placeholder
    expect(sql).toContain("datetime('now')");
  });

  it('binds all five entry fields in declaration order', async () => {
    const { db, bindMock } = buildD1Mock();
    const repo = createIdiomHistoryRepo(db);

    await repo.recordSent(BASE_INSERT);

    expect(bindMock).toHaveBeenCalledWith(
      BASE_INSERT.idiom_id,
      BASE_INSERT.idiom_text,
      BASE_INSERT.colloquialism_id,
      BASE_INSERT.colloquialism_text,
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
