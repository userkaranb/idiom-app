-- Drop profile.vulgarity_tolerance.
--
-- The column was never read: no query selected it and no prompt consumed it,
-- so removing it changes no behaviour. It is dropped so the schema stops
-- describing a taste dimension the app does not model.
--
-- Uses the table-rebuild pattern from migration 0001 rather than
-- ALTER TABLE ... DROP COLUMN, to match the existing migration style and stay
-- portable across SQLite versions.

CREATE TABLE profile_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  regional_preference TEXT    NOT NULL DEFAULT 'general',
  themes              TEXT    NOT NULL DEFAULT '["love","work","animals","food"]',
  common_vs_obscure   INTEGER NOT NULL DEFAULT 3,
  no_list             TEXT    NOT NULL DEFAULT '[]',
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at          TEXT
);

INSERT INTO profile_new (id, regional_preference, themes, common_vs_obscure, no_list, updated_at, deleted_at)
  SELECT id, regional_preference, themes, common_vs_obscure, no_list, updated_at, deleted_at
  FROM profile;

DROP TABLE profile;
ALTER TABLE profile_new RENAME TO profile;
