import axios from 'axios';
import { Pool } from 'pg';
import { config } from '../config';
import { internalServiceHeaders } from '@lessgo/shared';

const pool = new Pool({ connectionString: config.databaseUrl });
const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes, same cadence as the prune cron

/**
 * Freeze one trip's discounted per-rider settlements.
 *
 * Runs at T-1h once the rider list is final: asks the cost service for the
 * optimized-route discount, writes the discounted amounts onto the bookings, then
 * marks the trip frozen. Idempotent — the trips.settlement_frozen_at guard and the
 * booking-side settled_at guard make a repeat call a no-op. Throws on failure so
 * the caller (poller or endpoint) leaves the trip unfrozen for the next attempt;
 * NOTHING is frozen undiscounted.
 */
export async function freezeTripNow(tripId: string): Promise<{ frozen: number; optimized_route_mi: number; total_savings: number }> {
  // Optimized-route discount for the (now final) rider list. 502 => defer.
  const freezeResp = await axios.get(`${config.costServiceUrl}/cost/freeze/${tripId}`);
  const data = freezeResp.data?.data ?? freezeResp.data;
  const riders: any[] = Array.isArray(data?.riders) ? data.riders : [];

  // Persist discounted amounts on the bookings (idempotent).
  let frozen = 0;
  if (riders.length > 0) {
    const writeResp = await axios.post(
      `${config.bookingServiceUrl}/bookings/trip/${tripId}/freeze-settlements`,
      {
        riders: riders.map((r: any) => ({
          booking_id: r.booking_id,
          settled_amount: r.settled_amount,
          settled_breakdown: r.settled_breakdown,
        })),
      },
      { headers: internalServiceHeaders('trip-service') }
    );
    frozen = writeResp.data?.data?.frozen ?? 0;
  }

  // Mark the trip frozen only after the bookings are written.
  await pool.query(
    `UPDATE trips
     SET settlement_frozen_at = NOW(),
         optimized_route_mi   = $2,
         updated_at           = current_timestamp
     WHERE trip_id = $1 AND settlement_frozen_at IS NULL`,
    [tripId, data?.optimized_route_mi ?? null]
  );

  return {
    frozen,
    optimized_route_mi: data?.optimized_route_mi ?? 0,
    total_savings: data?.total_savings ?? 0,
  };
}

/**
 * Poll for trips that have crossed the T-1h lock window but are not yet frozen,
 * and freeze each. The poll itself is the retry mechanism: a trip stays unfrozen
 * until freezeTripNow succeeds, so a transient routing/Maps failure is simply
 * retried on the next tick — never frozen at an undiscounted amount.
 */
export function startDiscountFreezeJob(): void {
  setInterval(runFreezeSweep, INTERVAL_MS);
  console.log('[DISCOUNT_FREEZE] Freeze job started (every 5 min)');
}

async function runFreezeSweep(): Promise<void> {
  let rows: Array<{ trip_id: string }> = [];
  try {
    const res = await pool.query<{ trip_id: string }>(
      `SELECT trip_id FROM trips
       WHERE settlement_frozen_at IS NULL
         AND deleted_at IS NULL
         AND status NOT IN ('cancelled', 'completed')
         AND departure_time <= NOW() + INTERVAL '1 hour'
       ORDER BY departure_time ASC
       LIMIT 50`
    );
    rows = res.rows;
  } catch (err: any) {
    console.error('[DISCOUNT_FREEZE] Sweep query failed:', err?.message ?? err);
    return;
  }

  if (rows.length === 0) return;
  console.log(`[DISCOUNT_FREEZE] Freezing ${rows.length} trip(s)`);

  for (const { trip_id } of rows) {
    try {
      const r = await freezeTripNow(trip_id);
      console.log(`[DISCOUNT_FREEZE] ✅ Trip ${trip_id} frozen (${r.frozen} riders, $${r.total_savings} savings)`);
    } catch (err: any) {
      // Left unfrozen on purpose — retried next tick. Never freeze undiscounted.
      console.warn(`[DISCOUNT_FREEZE] Deferred trip ${trip_id}: ${err?.message ?? err}`);
    }
  }
}
