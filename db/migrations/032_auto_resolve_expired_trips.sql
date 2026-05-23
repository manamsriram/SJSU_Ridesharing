-- pg_cron job: auto-cancel trips that were never started 2+ hours past departure.
-- Stripe PaymentIntent cancellation is handled separately via POST /trips/release-expired-holds
-- because pg_cron cannot make HTTP calls to the Stripe API.
SELECT cron.schedule(
  'auto-cancel-expired-trips',
  '*/15 * * * *',
  $$
  WITH expired_trips AS (
    UPDATE trips
    SET status = 'cancelled', updated_at = current_timestamp
    WHERE status = 'pending'
      AND departure_time < NOW() - INTERVAL '2 hours'
      AND deleted_at IS NULL
    RETURNING trip_id
  ),
  cancelled_bookings AS (
    UPDATE bookings
    SET booking_state = 'cancelled',
        cancellation_reason = 'trip_expired',
        updated_at = current_timestamp
    FROM expired_trips
    WHERE bookings.trip_id = expired_trips.trip_id
      AND bookings.booking_state IN ('pending', 'approved')
    RETURNING bookings.trip_id, bookings.seats_booked
  )
  UPDATE trips
  SET seats_available = seats_available + cb.total_seats
  FROM (
    SELECT trip_id, SUM(seats_booked) AS total_seats
    FROM cancelled_bookings
    GROUP BY trip_id
  ) cb
  WHERE trips.trip_id = cb.trip_id;
  $$
);
