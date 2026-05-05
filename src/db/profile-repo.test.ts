/**
 * Tests for ProfileRepo.
 *
 * These tests verify that the SQL emitted by each repo method is correct —
 * the right tables, column names, placeholders, and bindings. A mock D1Database
 * captures every `prepare()` call so we can assert on the SQL string and the
 * bound values without running against a real database.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Profile, ReflectorProposal } from '../types';
import { createProfileRepo } from './profile-repo';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_PROFILE: Profile = {
  id: 1,
  regional_preference: 'general',
  vulgarity_tolerance: 0,
  themes: '["work","food"]',
  common_vs_obscure: 2,
  no_list: '[]',
  updated_at: '2024-01-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// D1 mock factory
// ---------------------------------------------------------------------------

/**
 * Builds a minimal D1Database mock whose `prepare().first()` always returns
 * `firstRow`, and whose `prepare().bind().run()` is tracked for assertions.
 */
function buildD1Mock(firstRow: Profile | null = BASE_PROFILE) {
  const runMock  = vi.fn().mockResolvedValue({});
  const bindMock = vi.fn().mockReturnValue({ run: runMock });

  let firstCallIndex = 0;
  // Support multiple sequential first() calls (getCurrent is called inside
  // applyReflectorChanges for no_list merge and for the post-update read).
  const prepareMock = vi.fn().mockImplementation(() => ({
    first: vi.fn().mockImplementation(() => {
      firstCallIndex++;
      return Promise.resolve(firstRow);
    }),
    bind: bindMock,
    run:  runMock,
  }));

  const db = { prepare: prepareMock } as unknown as D1Database;
  return { db, prepareMock, bindMock, runMock };
}

// ---------------------------------------------------------------------------
// getCurrent
// ---------------------------------------------------------------------------

describe('ProfileRepo.getCurrent', () => {
  it('issues SELECT * FROM profile WHERE id = 1', async () => {
    const { db, prepareMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.getCurrent();

    expect(prepareMock).toHaveBeenCalledWith('SELECT * FROM profile WHERE id = 1');
  });

  it('returns the profile row returned by D1', async () => {
    const { db } = buildD1Mock(BASE_PROFILE);
    const repo = createProfileRepo(db);

    const result = await repo.getCurrent();

    expect(result).toEqual(BASE_PROFILE);
  });

  it('throws a descriptive error when the profile row is absent', async () => {
    const { db } = buildD1Mock(null);
    const repo = createProfileRepo(db);

    await expect(repo.getCurrent()).rejects.toThrow('profile row with id=1 not found in D1');
  });
});

// ---------------------------------------------------------------------------
// applyReflectorChanges
// ---------------------------------------------------------------------------

describe('ProfileRepo.applyReflectorChanges', () => {
  it('skips the UPDATE entirely when the proposal is empty', async () => {
    const { db, prepareMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({});

    const sqls = (prepareMock.mock.calls as unknown[][]).map((call) => call[0] as string);
    expect(sqls.some((sql) => sql.startsWith('UPDATE profile'))).toBe(false);
  });

  it('includes regional_preference = ? when the proposal sets it', async () => {
    const { db, prepareMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ regional_preference: 'Spain' });

    const sqls = (prepareMock.mock.calls as unknown[][]).map((call) => call[0] as string);
    const updateSql = sqls.find((sql) => sql.startsWith('UPDATE profile'));
    expect(updateSql).toContain('regional_preference = ?');
  });

  it('includes vulgarity_tolerance = ? when the proposal sets it', async () => {
    const { db, prepareMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ vulgarity_tolerance: 2 });

    const sqls = (prepareMock.mock.calls as unknown[][]).map((call) => call[0] as string);
    const updateSql = sqls.find((sql) => sql.startsWith('UPDATE profile'));
    expect(updateSql).toContain('vulgarity_tolerance = ?');
  });

  it('always appends updated_at = datetime("now") when any field is set', async () => {
    const { db, prepareMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ regional_preference: 'Mexico' });

    const sqls = (prepareMock.mock.calls as unknown[][]).map((call) => call[0] as string);
    const updateSql = sqls.find((sql) => sql.startsWith('UPDATE profile'));
    expect(updateSql).toContain("updated_at = datetime('now')");
  });

  it('binds the correct value for regional_preference', async () => {
    const { db, bindMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ regional_preference: 'Caribbean' });

    // First bound argument is the new regional_preference value.
    const boundArgs = bindMock.mock.calls[0] as unknown[];
    expect(boundArgs).toContain('Caribbean');
  });

  it('serialises themes as JSON when the proposal sets it', async () => {
    const { db, bindMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ themes: ['animals', 'food'] });

    const boundArgs = bindMock.mock.calls[0] as unknown[];
    expect(boundArgs).toContain(JSON.stringify(['animals', 'food']));
  });

  it('merges no_list_additions into the existing no_list rather than replacing it', async () => {
    const profileWithList: Profile = { ...BASE_PROFILE, no_list: '["existing-id"]' };
    const { db, bindMock } = buildD1Mock(profileWithList);
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ no_list_additions: ['new-id'] });

    const boundArgs = (bindMock.mock.calls[0] as unknown[]);
    const noListArg = boundArgs[0] as string;
    expect(JSON.parse(noListArg)).toEqual(['existing-id', 'new-id']);
  });

  it('does not include no_list in the SET clause when no_list_additions is absent', async () => {
    const { db, prepareMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ vulgarity_tolerance: 1 });

    const sqls = (prepareMock.mock.calls as unknown[][]).map((call) => call[0] as string);
    const updateSql = sqls.find((sql) => sql.startsWith('UPDATE profile'));
    expect(updateSql).not.toContain('no_list');
  });

  it('returns the updated profile after applying changes', async () => {
    const { db } = buildD1Mock(BASE_PROFILE);
    const repo = createProfileRepo(db);

    const result = await repo.applyReflectorChanges({ regional_preference: 'Spain' });

    // The post-update read returns the same mock row; the important thing
    // is that the returned value is a Profile, not void or undefined.
    expect(result).toMatchObject({ id: 1 });
  });
});
