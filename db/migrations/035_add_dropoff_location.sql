-- Add dropoff_location column to bookings table
-- Stores the rider's own drop-off point so settlement can price the
-- drop-off-side detour against where the rider actually got out, instead
-- of always routing to the driver's full posted destination.

BEGIN;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS dropoff_location JSONB;

ALTER TABLE bookings
  ADD CONSTRAINT check_dropoff_location_structure
  CHECK (
    dropoff_location IS NULL OR
    (
      jsonb_typeof(dropoff_location) = 'object' AND
      (dropoff_location ? 'lat') AND
      (dropoff_location ? 'lng') AND
      (dropoff_location ? 'address') AND
      jsonb_typeof(dropoff_location->'lat') = 'number' AND
      jsonb_typeof(dropoff_location->'lng') = 'number' AND
      jsonb_typeof(dropoff_location->'address') = 'string' AND
      (dropoff_location->>'lat')::numeric BETWEEN -90 AND 90 AND
      (dropoff_location->>'lng')::numeric BETWEEN -180 AND 180
    )
  );

CREATE INDEX IF NOT EXISTS idx_bookings_dropoff_location ON bookings USING GIN (dropoff_location);

COMMENT ON COLUMN bookings.dropoff_location IS 'Rider drop-off location with {lat, lng, address} - used by settlement to price drop-off-side detour';

COMMIT;
