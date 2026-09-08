PRAGMA foreign_keys = ON;

CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0f6cbd',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX calendars_owner_name_idx
  ON calendars(owner_email, name COLLATE NOCASE)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX calendars_owner_default_idx
  ON calendars(owner_email)
  WHERE is_default = 1 AND deleted_at IS NULL;

CREATE INDEX calendars_owner_updated_idx
  ON calendars(owner_email, deleted_at, updated_at DESC);

CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  owner_email TEXT NOT NULL COLLATE NOCASE,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL DEFAULT 'busy'
    CHECK (availability IN ('free', 'busy', 'tentative', 'out_of_office')),
  recurrence_frequency TEXT NOT NULL DEFAULT 'none'
    CHECK (recurrence_frequency IN ('none', 'daily', 'weekly', 'monthly', 'yearly')),
  recurrence_interval INTEGER NOT NULL DEFAULT 1
    CHECK (recurrence_interval BETWEEN 1 AND 365),
  recurrence_until TEXT,
  reminder_minutes INTEGER
    CHECK (reminder_minutes IS NULL OR reminder_minutes BETWEEN 0 AND 40320),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (end_at > start_at),
  CHECK (recurrence_until IS NULL OR recurrence_until >= start_at)
);

CREATE INDEX calendar_events_owner_start_idx
  ON calendar_events(owner_email, deleted_at, start_at, end_at);

CREATE INDEX calendar_events_calendar_start_idx
  ON calendar_events(calendar_id, deleted_at, start_at);

CREATE INDEX calendar_events_owner_recurrence_idx
  ON calendar_events(owner_email, recurrence_frequency, recurrence_until, start_at)
  WHERE deleted_at IS NULL AND recurrence_frequency != 'none';

PRAGMA foreign_key_check;
