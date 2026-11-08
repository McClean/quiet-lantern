-- Library + campaigns, contract v1. Applied verbatim to plugin_db("emulator-catalog", "library.db").
-- User files are never written; this DB only records what was read.
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS roots (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,          -- absolute, as the user gave it
  kind        TEXT NOT NULL CHECK (kind IN ('folder','steam')),
  added_at    TEXT NOT NULL,
  scanned_at  TEXT
);

CREATE TABLE IF NOT EXISTS titles (
  id          TEXT PRIMARY KEY,              -- first 16 hex of SHA-1 of the game bytes (inner file for zips)
  root_id     INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,                 -- file on disk (the zip, if zipped)
  inner       TEXT,                          -- member name inside the zip, else NULL
  name        TEXT NOT NULL,                 -- display name (file stem)
  system      TEXT NOT NULL,                 -- manifest systems[].id
  adapter     TEXT NOT NULL,                 -- manifest id
  code        TEXT,                          -- header game code (GBA: BPRE) or NULL
  header_title TEXT,
  pack        TEXT,                          -- matched pack id or NULL (basic mode)
  size        INTEGER NOT NULL,
  seen_at     TEXT NOT NULL,                 -- last scan that saw it
  missing     INTEGER NOT NULL DEFAULT 0     -- 1 when a rescan no longer finds the file (campaigns are kept)
);
CREATE INDEX IF NOT EXISTS titles_system ON titles(system);

CREATE TABLE IF NOT EXISTS unsupported (     -- files in roots with no adapter: counted, never listed or served
  root_id     INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  ext         TEXT NOT NULL,
  count       INTEGER NOT NULL,
  PRIMARY KEY (root_id, ext)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id            TEXT PRIMARY KEY,            -- 'c_' + 8-32 [0-9a-z]
  title_id      TEXT NOT NULL REFERENCES titles(id),
  name          TEXT NOT NULL,
  slot          INTEGER,                     -- in-game save file index if the pack can read it
  created_at    TEXT NOT NULL,
  last_played_at TEXT,
  resume_json   TEXT NOT NULL DEFAULT '{}',  -- game-context.schema.json `resume` object
  archived      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS campaigns_title ON campaigns(title_id);

CREATE TABLE IF NOT EXISTS saves (            -- files live in plugin_data_dir/campaigns/<campaign_id>/<file>
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('battery','state')),
  name        TEXT NOT NULL,                 -- 'battery' or a state name, e.g. 'auto', 'before-gym-3'
  file        TEXT NOT NULL,
  frame       INTEGER,
  created_at  TEXT NOT NULL,
  imported_from TEXT,                        -- user .sav path if imported by copy, else NULL
  PRIMARY KEY (campaign_id, kind, name)
);
