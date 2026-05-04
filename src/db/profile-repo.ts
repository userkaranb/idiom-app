import type { Profile, ReflectorProposal } from '../types';

/**
 * All D1 access for the `profile` table.
 *
 * The app maintains exactly one profile row (id = 1). Every method operates on
 * that singleton. Callers receive a typed `Profile` value and never compose SQL
 * directly — schema details (column names, JSON serialisation of `themes` and
 * `no_list`, the `updated_at` refresh) are fully encapsulated here.
 */
export interface ProfileRepo {
  /** Returns the single profile row. Throws if the row is absent (misconfigured DB). */
  getCurrent(): Promise<Profile>;

  /**
   * Applies a Reflector's proposed mutations atomically and returns the new profile.
   *
   * Only fields present in `changes` are included in the UPDATE clause. When
   * `changes` is empty the update is skipped entirely (an empty SET clause would
   * be a SQL error, and there is nothing to persist). `no_list_additions` are
   * merged into the existing `no_list` rather than replacing it.
   */
  applyReflectorChanges(changes: ReflectorProposal): Promise<Profile>;
}

export function createProfileRepo(db: D1Database): ProfileRepo {
  async function getCurrent(): Promise<Profile> {
    const profile = await db
      .prepare('SELECT * FROM profile WHERE id = 1')
      .first<Profile>();
    if (!profile) {
      throw new Error('ProfileRepo: profile row with id=1 not found in D1');
    }
    return profile;
  }

  async function applyReflectorChanges(changes: ReflectorProposal): Promise<Profile> {
    const setClauses: string[] = [];
    const bindings: (string | number)[] = [];

    if (changes.regional_preference !== undefined) {
      setClauses.push('regional_preference = ?');
      bindings.push(changes.regional_preference);
    }
    if (changes.vulgarity_tolerance !== undefined) {
      setClauses.push('vulgarity_tolerance = ?');
      bindings.push(changes.vulgarity_tolerance);
    }
    if (changes.common_vs_obscure !== undefined) {
      setClauses.push('common_vs_obscure = ?');
      bindings.push(changes.common_vs_obscure);
    }
    if (changes.themes !== undefined) {
      setClauses.push('themes = ?');
      bindings.push(JSON.stringify(changes.themes));
    }
    if (changes.no_list_additions !== undefined) {
      // Read the current no_list before building the merged value.
      const current = await getCurrent();
      const existingIds: string[] = JSON.parse(current.no_list);
      const mergedIds = [...existingIds, ...changes.no_list_additions];
      setClauses.push('no_list = ?');
      bindings.push(JSON.stringify(mergedIds));
    }

    // Nothing to persist — skip rather than run `UPDATE profile SET WHERE id = 1`.
    if (setClauses.length === 0) {
      return getCurrent();
    }

    // The Reflector decided something changed: always record when that happened.
    setClauses.push("updated_at = datetime('now')");

    const sql = `UPDATE profile SET ${setClauses.join(', ')} WHERE id = 1`;
    await db.prepare(sql).bind(...bindings).run();

    return getCurrent();
  }

  return { getCurrent, applyReflectorChanges };
}
