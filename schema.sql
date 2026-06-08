CREATE TABLE IF NOT EXISTS profile (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  regional_preference TEXT    NOT NULL DEFAULT 'general',
  vulgarity_tolerance INTEGER NOT NULL DEFAULT 1,
  themes              TEXT    NOT NULL DEFAULT '["love","work","animals","food"]',
  common_vs_obscure   INTEGER NOT NULL DEFAULT 3,
  no_list             TEXT    NOT NULL DEFAULT '[]',
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at          TEXT
);

-- Seed one active profile row if none exists yet.
INSERT INTO profile (regional_preference)
  SELECT 'general' WHERE NOT EXISTS (SELECT 1 FROM profile WHERE deleted_at IS NULL);

CREATE TABLE IF NOT EXISTS idiom_history (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at                 TEXT    NOT NULL DEFAULT (datetime('now')),
  idiom_id                TEXT    NOT NULL,
  idiom_text              TEXT    NOT NULL,
  colloquialism_id        TEXT    NOT NULL,
  colloquialism_text      TEXT    NOT NULL,
  curator_justification   TEXT    NOT NULL,
  user_rating             INTEGER,
  user_feedback           TEXT
);
