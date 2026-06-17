-- Per-rider settlement freeze: when the driver drops a rider off, that rider's
-- routed fare is computed once and frozen on the booking row. Trip completion
-- then sums the frozen rows with zero additional routing calls, staggering
-- routing load across drop-off events instead of one batch burst.

BEGIN;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS dropoff_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settled_amount       NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS settled_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settled_breakdown    JSONB;

-- Completion sums only frozen rows for a trip.
CREATE INDEX IF NOT EXISTS idx_bookings_settled
  ON bookings (trip_id)
  WHERE settled_at IS NOT NULL;

COMMENT ON COLUMN bookings.dropoff_confirmed_at IS 'When the driver confirmed dropping this rider off; set even if settlement routing failed';
COMMENT ON COLUMN bookings.settled_amount       IS 'Frozen per-rider total fare (per-seat x seats_booked, post-clamp) captured at drop-off';
COMMENT ON COLUMN bookings.settled_at           IS 'When the frozen settled_amount was written; NULL means fall back to trip-end batch settlement';
COMMENT ON COLUMN bookings.settled_breakdown    IS 'Frozen leg metrics {leg_pickup_mi, leg_ride_mi, leg_ride_hr, leg_resume_mi, direct_mi, rider_base_cost, detour_cost} for audit';

COMMIT;
