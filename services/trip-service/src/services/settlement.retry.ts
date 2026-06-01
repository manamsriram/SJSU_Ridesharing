import axios from 'axios';
import { Pool } from 'pg';
import { config } from '../config';
import { getBookingClient, getCostClient, unary } from '../grpc-clients';

const pool = new Pool({ connectionString: config.databaseUrl });
const MAX_ATTEMPTS = 5;
const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

export function startSettlementRetryJob(): void {
  setInterval(runRetry, INTERVAL_MS);
  console.log('[SETTLE_RETRY] Retry job started (every 5 min)');
}

async function runRetry(): Promise<void> {
  const { rows } = await pool.query<{ id: string; trip_id: string; attempts: number }>(
    `SELECT id, trip_id, attempts FROM pending_settlements
     WHERE resolved_at IS NULL AND attempts < $1
     ORDER BY created_at ASC`,
    [MAX_ATTEMPTS]
  );

  if (rows.length === 0) return;
  console.log(`[SETTLE_RETRY] Retrying ${rows.length} pending settlement(s)`);

  for (const row of rows) {
    try {
      // Re-run settlement
      const settlement = await unary(
        (req, cb) => getCostClient().settleTrip(req, cb),
        { tripId: row.trip_id },
      );

      // Fetch bookings for capture
      const bookingRes = await unary(
        (req, cb) => getBookingClient().getBookingsForSettlement(req, cb),
        { tripId: row.trip_id },
      );
      const bookings = bookingRes.bookings;

      // Write final prices
      if (Array.isArray(settlement.riders ?? [])) {
        await Promise.all(
          (settlement.riders ?? []).map(async (rider: any) => {
            const booking = bookings.find((b: any) => b.riderId === rider.riderId);
            if (!booking) return;
            const bookingId = booking.bookingId;
            await unary(
              (req, cb) => getBookingClient().updateFinalPrice(req, cb),
              { bookingId, finalPrice: rider.amount },
            ).catch((e: any) => console.error(`[SETTLE_RETRY] final-price failed for ${bookingId}:`, e.message));
          })
        );
      }

      // Capture payments
      const toCapture = bookings.filter(
        (b: any) => b.paymentId && ['approved', 'completed'].includes(b.status)
      );
      for (const booking of toCapture) {
        const bookingId = booking.bookingId;
        await axios.post(
          `${config.bookingServiceUrl}/bookings/${bookingId}/capture-payment`,
          {},
          { headers: { 'x-internal-service': 'trip-service' } }
        ).catch((e: any) => console.error(`[SETTLE_RETRY] capture failed for ${bookingId}:`, e.message));
      }

      // Mark resolved
      await pool.query(
        `UPDATE pending_settlements SET resolved_at = now() WHERE id = $1`,
        [row.id]
      );
      console.log(`[SETTLE_RETRY] ✅ Resolved trip ${row.trip_id}`);

    } catch (err: any) {
      const newAttempts = row.attempts + 1;
      await pool.query(
        `UPDATE pending_settlements
         SET attempts = $1, last_error = $2, last_attempted_at = now()
         WHERE id = $3`,
        [newAttempts, err?.message ?? String(err), row.id]
      );

      if (newAttempts >= MAX_ATTEMPTS) {
        // Final failure — alert admin
        axios.post(`${config.notificationServiceUrl}/notifications/admin-alert`, {
          subject: `🚨 Settlement permanently failed for trip ${row.trip_id}`,
          message: `Trip ${row.trip_id} failed settlement after ${MAX_ATTEMPTS} attempts.\nLast error: ${err?.message ?? err}\nManual intervention required.`,
        }).catch(() => {});
        console.error(`[SETTLE_RETRY] ❌ Giving up on trip ${row.trip_id} after ${MAX_ATTEMPTS} attempts`);
      }
    }
  }
}
