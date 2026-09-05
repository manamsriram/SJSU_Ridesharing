-- Composite partial index for the primary trip search filter.
-- Queries always filter status='pending' AND deleted_at IS NULL AND departure_time >= threshold.
-- A partial index scoped to those conditions is smaller and faster than separate btree indexes.
CREATE INDEX IF NOT EXISTS idx_trips_pending_departure
  ON trips(departure_time, seats_available)
  WHERE status = 'pending' AND deleted_at IS NULL;
