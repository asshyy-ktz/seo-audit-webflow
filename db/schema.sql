PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS installations (
  site_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  scopes TEXT,
  thin_content_words INTEGER NOT NULL DEFAULT 300,
  installed_at TEXT NOT NULL,
  uninstalled_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES installations(site_id),
  kind TEXT NOT NULL DEFAULT 'full',            -- full | incremental
  trigger_source TEXT NOT NULL DEFAULT 'manual', -- manual | schedule | webhook
  status TEXT NOT NULL DEFAULT 'running',       -- running | complete | failed
  started_at TEXT NOT NULL,
  finished_at TEXT,
  site_score REAL,
  pages_scanned INTEGER NOT NULL DEFAULT 0,
  items_scanned INTEGER NOT NULL DEFAULT 0,
  subjects_total INTEGER NOT NULL DEFAULT 0,
  critical_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  info_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_site ON audit_runs(site_id, id);

-- Every page / CMS item that has been audited (used as the scoring denominator).
CREATE TABLE IF NOT EXISTS audit_subjects (
  site_id TEXT NOT NULL REFERENCES installations(site_id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  PRIMARY KEY (site_id, subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES installations(site_id),
  run_id INTEGER NOT NULL REFERENCES audit_runs(id),
  subject_type TEXT NOT NULL,                   -- page | cms_item | site
  subject_id TEXT NOT NULL,
  subject_label TEXT NOT NULL,
  collection_id TEXT,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,                       -- critical | warning | info
  message TEXT NOT NULL,
  current_value TEXT,
  suggested_value TEXT,
  fix_kind TEXT NOT NULL DEFAULT 'manual',      -- api_patch | manual
  fix_field TEXT,
  fix_patch TEXT,                               -- JSON fieldData for PATCH
  manual_steps TEXT,
  element_id TEXT,
  detail_key TEXT,
  status TEXT NOT NULL DEFAULT 'open',          -- open | resolved
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_site ON findings(site_id, status);
CREATE INDEX IF NOT EXISTS idx_findings_subject ON findings(site_id, subject_type, subject_id);

CREATE TABLE IF NOT EXISTS ignore_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES installations(site_id),
  scope TEXT NOT NULL,                          -- rule | item | finding
  rule_id TEXT,
  subject_id TEXT,
  subject_label TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ignore_site ON ignore_rules(site_id);
