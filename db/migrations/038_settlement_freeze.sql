-- T-1h multi-rider discount freeze: one hour before departure the rider list is
-- final (pg_cron has pruned unpaid/unapproved bookings; booking, cancellation and
-- approval are all locked). At that point the optimized multi-stop route is computed
-- once and each rider's discounted per-rider fare is frozen on the booking row
-- (settled_amount / settled_breakdown / settled_at, reusing the drop-off freeze
-- columns from 037). Drop-off and trip completion then read frozen rows unchanged.
--
-- settlement_frozen_at marks the trip as frozen so the polling job is idempotent
-- and never re-freezes. optimized_route_mi caches the computed optimized distance
-- for audit/debugging.

BEGIN;

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS settlement_frozen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS optimized_route_mi   NUMERIC(10,2);

-- Polling job scans for trips approaching departure that are not yet frozen.
CREATE INDEX IF NOT EXISTS idx_trips_unfrozen_departing
  ON trips (departure_time)
  WHERE settlement_frozen_at IS NULL;

COMMENT ON COLUMN trips.settlement_frozen_at IS 'When the T-1h per-rider discount freeze completed for this trip; NULL means not yet frozen. Idempotency guard for the freeze job.';
COMMENT ON COLUMN trips.optimized_route_mi   IS 'Cached Google-optimized multi-stop route distance (miles) used to redistribute multi-rider detour savings at freeze time; audit only.';

COMMIT;
