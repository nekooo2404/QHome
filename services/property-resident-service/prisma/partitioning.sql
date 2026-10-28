-- Bootstrap SQL for a fresh database. Run this custom DDL instead of the
-- generated CREATE TABLE for ResidentChangeLog; Prisma models the logical
-- compound key while PostgreSQL owns the physical RANGE partitions.

CREATE TABLE IF NOT EXISTS resident_change_log (
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  resident_id uuid NOT NULL,
  change_type varchar(96) NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS resident_change_log_2026_10
  PARTITION OF resident_change_log
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');

CREATE INDEX IF NOT EXISTS resident_change_log_2026_10_project_time_idx
  ON resident_change_log_2026_10 (project_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS resident_change_log_2026_10_resident_time_idx
  ON resident_change_log_2026_10 (resident_id, occurred_at DESC);

-- Provision the next partition before the first write of each month.
-- Example for November 2026:
-- CREATE TABLE resident_change_log_2026_11
--   PARTITION OF resident_change_log
--   FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
