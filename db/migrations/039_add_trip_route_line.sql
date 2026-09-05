-- Add real-road route geometry to trips for carpool "on the way" matching.
-- Previously fetchCandidates() approximated a driver's route as a straight
-- line between origin_point and destination_point (ST_MakeLine), which
-- ignores highways/one-ways/terrain. route_line stores the actual Google
-- Directions polyline (decoded via ST_GeomFromEncodedPolyline), computed
-- once at trip creation. Nullable: legacy trips and trips where the
-- routing-service call failed at creation fall back to the old
-- straight-line behavior in matching.

BEGIN;

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS route_line geography(LineString, 4326);

CREATE INDEX IF NOT EXISTS idx_trips_route_line_gist
  ON trips USING GIST (route_line);

COMMENT ON COLUMN trips.route_line IS 'Actual road-network route geometry (decoded from Google Directions overview_polyline via ST_GeomFromEncodedPolyline), computed once at trip creation via routing-service. NULL for legacy trips or when the routing-service call failed — carpool matching falls back to a straight-line approximation in that case.';

COMMIT;
