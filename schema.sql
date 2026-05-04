CREATE TABLE IF NOT EXISTS profile (
  id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK(id = 1),
  regional_preference TEXT    NOT NULL DEFAULT 'general',
  vulgarity_tolerance INTEGER NOT NULL DEFAULT 1,
  themes              TEXT    NOT NULL DEFAULT '["love","work","animals","food"]',
  common_vs_obscure   INTEGER NOT NULL DEFAULT 3,
  no_list             TEXT    NOT NULL DEFAULT '[]',
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Guarantee the single profile row always exists.
INSERT OR IGNORE INTO profile (id) VALUES (1);

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
