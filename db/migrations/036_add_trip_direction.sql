-- Add explicit direction column to trips table.
-- Records whether a trip heads TO SJSU (destination near campus) or FROM SJSU
-- (origin near campus), set at creation, so matching can verify directional
-- compatibility instead of re-deriving it from coordinates every time.

BEGIN;

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS direction VARCHAR(10);

ALTER TABLE trips
  ADD CONSTRAINT check_trip_direction
  CHECK (direction IS NULL OR direction IN ('TO_SJSU', 'FROM_SJSU'));

CREATE INDEX IF NOT EXISTS idx_trips_direction ON trips (direction);

COMMENT ON COLUMN trips.direction IS 'TO_SJSU if destination is SJSU, FROM_SJSU if origin is SJSU — set at creation, used by matching to verify directional compatibility';

COMMIT;
