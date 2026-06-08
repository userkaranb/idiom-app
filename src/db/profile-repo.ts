import type { Profile, ReflectorProposal } from '../types';

/**
 * All D1 access for the `profile` table.
 *
 * Profile state is tracked via soft-deletes: each call to
 * `applyReflectorChanges` inserts a new row with the merged values and marks
 * the previous row as deleted. The active profile is always the row where
 * `deleted_at IS NULL` — callers never compose SQL directly against this table.
 */
export interface ProfileRepo {
  /** Returns the active profile row. Throws if no active row exists (misconfigured DB). */
  getCurrent(): Promise<Profile>;

  /**
   * Applies a Reflector's proposed mutations and returns the new profile.
   *
   * Each call inserts a new row (merging proposed values with current defaults)
   * and soft-deletes the previous active row. When `changes` is empty the DB
   * is not touched and the current profile is returned unchanged.
   * `no_list_additions` are merged into the existing `no_list` array.
   */
  applyReflectorChanges(changes: ReflectorProposal): Promise<Profile>;
}

export function createProfileRepo(db: D1Database): ProfileRepo {
  async function getCurrent(): Promise<Profile> {
    const profile = await db
      .prepare('SELECT * FROM profile WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1')
      .first<Profile>();
    if (!profile) {
      throw new Error('ProfileRepo: no active profile row found in D1');
    }
    return profile;
  }

  async function applyReflectorChanges(changes: ReflectorProposal): Promise<Profile> {
    const hasChanges =
      changes.regional_preference !== undefined ||
      changes.vulgarity_tolerance !== undefined ||
      changes.common_vs_obscure   !== undefined ||
      changes.themes              !== undefined ||
      changes.no_list_additions   !== undefined;

    if (!hasChanges) {
      return getCurrent();
    }

    const current = await getCurrent();

    const mergedRegionalPreference = changes.regional_preference ?? current.regional_preference;
    const mergedVulgarityTolerance = changes.vulgarity_tolerance ?? current.vulgarity_tolerance;
    const mergedCommonVsObscure    = changes.common_vs_obscure   ?? current.common_vs_obscure;
    const mergedThemes = changes.themes !== undefined
      ? JSON.stringify(changes.themes)
      : current.themes;
    const mergedNoList = changes.no_list_additions !== undefined
      ? JSON.stringify([...JSON.parse(current.no_list), ...changes.no_list_additions])
      : current.no_list;

    await db
      .prepare(
        'INSERT INTO profile (regional_preference, vulgarity_tolerance, themes, common_vs_obscure, no_list, updated_at)' +
        " VALUES (?, ?, ?, ?, ?, datetime('now'))",
      )
      .bind(mergedRegionalPreference, mergedVulgarityTolerance, mergedThemes, mergedCommonVsObscure, mergedNoList)
      .run();

    await db
      .prepare("UPDATE profile SET deleted_at = datetime('now') WHERE id = ?")
      .bind(current.id)
      .run();

    return getCurrent();
  }

  return { getCurrent, applyReflectorChanges };
}
