-- Create pending_settlements table for settlement retry job in trip-service
CREATE TABLE IF NOT EXISTS pending_settlements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id           UUID NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  last_attempted_at TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique index required for ON CONFLICT (trip_id) WHERE resolved_at IS NULL
CREATE UNIQUE INDEX IF NOT EXISTS pending_settlements_trip_id_unresolved
  ON pending_settlements (trip_id)
  WHERE resolved_at IS NULL;
