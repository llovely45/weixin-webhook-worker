CREATE TABLE IF NOT EXISTS reminder_tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  next_run_at INTEGER NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('once', 'daily', 'monthly', 'yearly')),
  timezone TEXT NOT NULL,
  anchor_year INTEGER NOT NULL,
  anchor_month INTEGER NOT NULL,
  anchor_day INTEGER NOT NULL,
  local_hour INTEGER NOT NULL,
  local_minute INTEGER NOT NULL,
  value TEXT NOT NULL,
  last_error TEXT,
  lease_token TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS reminder_tasks_due_idx
  ON reminder_tasks (next_run_at, lease_until);

CREATE INDEX IF NOT EXISTS reminder_tasks_account_idx
  ON reminder_tasks (account_id, next_run_at);
