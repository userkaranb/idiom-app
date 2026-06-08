-- Recreate profile without the CHECK(id=1) singleton constraint, with AUTOINCREMENT id and a deleted_at column.
CREATE TABLE profile_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  regional_preference TEXT    NOT NULL DEFAULT 'general',
  vulgarity_tolerance INTEGER NOT NULL DEFAULT 1,
  themes              TEXT    NOT NULL DEFAULT '["love","work","animals","food"]',
  common_vs_obscure   INTEGER NOT NULL DEFAULT 3,
  no_list             TEXT    NOT NULL DEFAULT '[]',
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at          TEXT
);

INSERT INTO profile_new (id, regional_preference, vulgarity_tolerance, themes, common_vs_obscure, no_list, updated_at, deleted_at)
  SELECT id, regional_preference, vulgarity_tolerance, themes, common_vs_obscure, no_list, updated_at, NULL
  FROM profile;

DROP TABLE profile;
ALTER TABLE profile_new RENAME TO profile;
