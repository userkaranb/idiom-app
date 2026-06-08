/**
 * Tests for ProfileRepo.
 *
 * These tests verify that the SQL emitted by each repo method is correct —
 * the right tables, column names, placeholders, and bindings. A mock D1Database
 * captures every `prepare()` call so we can assert on the SQL string and the
 * bound values without running against a real database.
 */
import { vi, describe, it, expect } from 'vitest';
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
  deleted_at: null,
};

// ---------------------------------------------------------------------------
// D1 mock factory
// ---------------------------------------------------------------------------

/**
 * Builds a minimal D1Database mock whose `prepare().first()` always returns
 * `firstRow`, and whose `prepare().bind().run()` is tracked for assertions.
 *
 * `bindMock` is called once per write statement (INSERT or UPDATE). When
 * `applyReflectorChanges` processes a non-empty proposal it issues exactly two
 * writes:
 *   - bindMock.mock.calls[0]: the INSERT bindings (5 positional values)
 *   - bindMock.mock.calls[1]: the soft-delete UPDATE binding ([current.id])
 */
function buildD1Mock(firstRow: Profile | null = BASE_PROFILE) {
  const runMock  = vi.fn().mockResolvedValue({});
  const bindMock = vi.fn().mockReturnValue({ run: runMock });

  const prepareMock = vi.fn().mockImplementation(() => ({
    first: vi.fn().mockResolvedValue(firstRow),
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
  it('issues SELECT * FROM profile WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1', async () => {
    const { db, prepareMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.getCurrent();

    expect(prepareMock).toHaveBeenCalledWith(
      'SELECT * FROM profile WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1',
    );
  });

  it('returns the profile row returned by D1', async () => {
    const { db } = buildD1Mock(BASE_PROFILE);
    const repo = createProfileRepo(db);

    const result = await repo.getCurrent();

    expect(result).toEqual(BASE_PROFILE);
  });

  it('throws a descriptive error when no active profile row exists', async () => {
    const { db } = buildD1Mock(null);
    const repo = createProfileRepo(db);

    await expect(repo.getCurrent()).rejects.toThrow('ProfileRepo');
  });
});

// ---------------------------------------------------------------------------
// applyReflectorChanges
// ---------------------------------------------------------------------------

describe('ProfileRepo.applyReflectorChanges', () => {
  it('skips any write when the proposal is empty', async () => {
    const { db, prepareMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({});

    const sqls = (prepareMock.mock.calls as unknown[][]).map((call) => call[0] as string);
    expect(sqls.some((sql) => sql.startsWith('INSERT INTO profile'))).toBe(false);
    expect(sqls.some((sql) => sql.startsWith('UPDATE profile SET deleted_at'))).toBe(false);
  });

  it('issues an INSERT when regional_preference is in the proposal', async () => {
    const { db, prepareMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ regional_preference: 'Spain' });

    const sqls = (prepareMock.mock.calls as unknown[][]).map((call) => call[0] as string);
    expect(sqls.some((sql) => sql.startsWith('INSERT INTO profile'))).toBe(true);
  });

  it('issues an INSERT when vulgarity_tolerance is in the proposal', async () => {
    const { db, prepareMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ vulgarity_tolerance: 2 });

    const sqls = (prepareMock.mock.calls as unknown[][]).map((call) => call[0] as string);
    expect(sqls.some((sql) => sql.startsWith('INSERT INTO profile'))).toBe(true);
  });

  it('binds the correct value for regional_preference in the INSERT', async () => {
    const { db, bindMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ regional_preference: 'Caribbean' });

    // bindMock.mock.calls[0] is the INSERT binding (5 positional args)
    const insertBindArgs = bindMock.mock.calls[0] as unknown[];
    expect(insertBindArgs).toContain('Caribbean');
  });

  it('serialises themes as JSON in the INSERT bindings', async () => {
    const { db, bindMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ themes: ['animals', 'food'] });

    const insertBindArgs = bindMock.mock.calls[0] as unknown[];
    expect(insertBindArgs).toContain(JSON.stringify(['animals', 'food']));
  });

  it('merges no_list_additions into the existing no_list in the INSERT bindings', async () => {
    const profileWithList: Profile = { ...BASE_PROFILE, no_list: '["existing-id"]' };
    const { db, bindMock } = buildD1Mock(profileWithList);
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ no_list_additions: ['new-id'] });

    // INSERT binds 5 positional args: [regional_preference, vulgarity_tolerance, themes, common_vs_obscure, no_list]
    const insertBindArgs = bindMock.mock.calls[0] as unknown[];
    const noListArg = insertBindArgs[4] as string;
    expect(JSON.parse(noListArg)).toEqual(['existing-id', 'new-id']);
  });

  it('issues a soft-delete UPDATE with the current profile id', async () => {
    const { db, prepareMock, bindMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ regional_preference: 'Spain' });

    const sqls = (prepareMock.mock.calls as unknown[][]).map((call) => call[0] as string);
    expect(
      sqls.some((sql) => sql === "UPDATE profile SET deleted_at = datetime('now') WHERE id = ?"),
    ).toBe(true);
    // bindMock.mock.calls[1] is the soft-delete UPDATE binding ([current.id])
    const softDeleteBindArgs = bindMock.mock.calls[1] as unknown[];
    expect(softDeleteBindArgs).toContain(BASE_PROFILE.id);
  });

  it('defaults absent fields to current values in the INSERT', async () => {
    const { db, bindMock } = buildD1Mock();
    const repo = createProfileRepo(db);

    await repo.applyReflectorChanges({ vulgarity_tolerance: 1 });

    // no_list is at index 4; should carry the current value since no_list_additions was absent
    const insertBindArgs = bindMock.mock.calls[0] as unknown[];
    expect(insertBindArgs[4]).toBe(BASE_PROFILE.no_list);
  });

  it('returns the updated profile after applying changes', async () => {
    const { db } = buildD1Mock(BASE_PROFILE);
    const repo = createProfileRepo(db);

    const result = await repo.applyReflectorChanges({ regional_preference: 'Spain' });

    expect(result).toMatchObject({ id: 1 });
  });
});
