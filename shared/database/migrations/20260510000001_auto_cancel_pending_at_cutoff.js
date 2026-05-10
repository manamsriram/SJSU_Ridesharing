/**
 * Migration: pg_cron job to auto-cancel pending bookings at T-1h
 * Pending bookings (driver never approved) are cancelled with reason 'driver_no_response'
 * when the trip departs within 1 hour. Seats are restored on the trip.
 * The existing 'cancel-unpaid-approved-bookings' job handles approved-but-unpaid riders.
 */

exports.up = (pgm) => {
  pgm.sql(`
    SELECT cron.schedule(
      'cancel-pending-bookings-at-cutoff',
      '*/5 * * * *',
      $$
      WITH expired AS (
        SELECT b.booking_id, b.trip_id, b.seats_booked
        FROM bookings b
        JOIN trips t ON b.trip_id = t.trip_id
        WHERE b.booking_state = 'pending'
          AND t.departure_time <= NOW() + INTERVAL '1 hour'
          AND t.departure_time > NOW()
          AND b.deleted_at IS NULL
      ),
      cancelled AS (
        UPDATE bookings
        SET booking_state             = 'cancelled',
            cancellation_reason       = 'driver_no_response',
            route_updated_after_cancel = FALSE,
            updated_at                = NOW()
        FROM expired
        WHERE bookings.booking_id = expired.booking_id
        RETURNING expired.trip_id, expired.seats_booked
      )
      UPDATE trips
      SET seats_available = seats_available + cancelled.seats_booked
      FROM cancelled
      WHERE trips.trip_id = cancelled.trip_id;
      $$
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`SELECT cron.unschedule('cancel-pending-bookings-at-cutoff');`);
};
