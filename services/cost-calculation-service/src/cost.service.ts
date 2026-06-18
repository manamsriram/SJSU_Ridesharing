import axios from 'axios';
import { IRS_MILEAGE_RATE, DRIVER_HOURLY, DETOUR_SURCHARGE, computeDetourPricing, AppError } from '@lessgo/shared';

const ROUTING_SERVICE_URL = process.env.ROUTING_SERVICE_URL || 'http://127.0.0.1:8002';
const TRIP_SERVICE_URL    = process.env.TRIP_SERVICE_URL    || 'http://127.0.0.1:3003';
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://127.0.0.1:3004';

export interface CostBreakdown {
  distance_miles: number;
  duration_hours: number;
  irs_mileage_rate: number;
  driver_hourly: number;
  total_trip_cost: number;
  price_per_rider: number;
}

export interface CostCalculateResult {
  max_price: number;
  breakdown: CostBreakdown;
}

export async function calculateCost(
  origin: string,
  destination: string,
  numRiders: number,
): Promise<CostCalculateResult> {
  let distance_miles = 10;
  let duration_seconds = 0;

  try {
    const routeResponse = await axios.post(`${ROUTING_SERVICE_URL}/route/calculate`, {
      origin,
      destination,
    });
    distance_miles   = routeResponse.data?.distance_miles  || 10;
    duration_seconds = routeResponse.data?.duration_seconds || 0;
  } catch {
    console.warn('Routing service unavailable, using default distance of 10 miles');
  }

  const duration_hours  = duration_seconds / 3600;
  const total_trip_cost = distance_miles * IRS_MILEAGE_RATE + duration_hours * DRIVER_HOURLY;
  const price_per_rider = total_trip_cost / numRiders;

  return {
    max_price: parseFloat(price_per_rider.toFixed(2)),
    breakdown: {
      distance_miles:   parseFloat(distance_miles.toFixed(2)),
      duration_hours:   parseFloat(duration_hours.toFixed(4)),
      irs_mileage_rate: IRS_MILEAGE_RATE,
      driver_hourly:    DRIVER_HOURLY,
      total_trip_cost:  parseFloat(total_trip_cost.toFixed(2)),
      price_per_rider:  parseFloat(price_per_rider.toFixed(2)),
    },
  };
}

export interface RiderSettlement {
  rider_id: string;
  rider_name: string;
  amount_paid: number;
  status: string;
  detour_miles: number;
  breakdown: string;
}

export interface SettleTripResult {
  trip_id: string;
  irs_mileage_rate: number;
  driver_hourly: number;
  total_cost: number;
  driver_earnings: number;
  rider_count: number;
  cost_per_rider: number;
  breakdown: {
    direct_distance_miles: number;
    direct_duration_hours: number;
    trip_cost: number;
    detour_surcharge: number;
  };
  riders: RiderSettlement[];
}

/** Frozen leg metrics persisted on the booking row at drop-off (settled_breakdown JSONB). */
export interface SettledBreakdown {
  label: string;
  direct_mi: number;
  detour_mi: number;
  rider_base_cost: number;
  detour_cost: number;
  leg_pickup_mi?: number;
  leg_ride_mi?: number;
  leg_ride_hr?: number;
  leg_resume_mi?: number;
}

/** Per-rider compute result — amount_paid is the TOTAL, post-clamp value (per-seat x seats). */
export interface RiderSettleResult {
  rider_id: string;
  rider_name: string;
  amount_paid: number;
  status: string;
  detour_miles: number;
  breakdown: string;
  settled_breakdown: SettledBreakdown;
}

/** Trip-level routing/pricing context shared across every rider in a settlement. */
interface SettleContext {
  originCoord: string;
  destCoord: string;
  directDistanceMiles: number;
  directDurationHours: number;
  sharedPerRider: number;
}

interface ParsedLocation {
  lat?: number;
  lng?: number;
  address?: string;
}

function parseLocation(raw: unknown): ParsedLocation | null {
  if (!raw) return null;
  let loc: any = raw;
  try {
    loc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    const parts = String(raw).split(',');
    if (parts.length === 2) {
      loc = { lat: parseFloat(parts[0]), lng: parseFloat(parts[1]) };
    }
  }
  if (loc && (loc.address || (loc.lat != null && loc.lng != null))) {
    return loc;
  }
  return null;
}

/** STEP 1 — Fetch trip; throws a 404-tagged error if missing. */
async function fetchTripForSettle(tripId: string): Promise<any> {
  const tripResp = await axios.get(`${TRIP_SERVICE_URL}/trips/${tripId}`);
  const trip = tripResp.data?.data ?? tripResp.data;
  if (!trip || !trip.trip_id) {
    throw new AppError(`Trip ${tripId} not found`, 404);
  }
  return trip;
}

/** STEP 2 — Fetch the trip's settle-list bookings, filtered to non-terminal states. */
async function fetchConfirmedBookings(tripId: string): Promise<any[]> {
  let bookings: any[] = [];
  const bookingsResp = await axios.get(`${BOOKING_SERVICE_URL}/bookings/trip/${tripId}/settle`);
  const raw = bookingsResp.data?.data ?? bookingsResp.data;
  bookings = Array.isArray(raw) ? raw
           : Array.isArray(raw?.bookings) ? raw.bookings
           : [];
  return bookings.filter(
    (b: any) => !['cancelled', 'canceled', 'rejected'].includes(b.booking_state)
  );
}

/** STEP 3/4 — Route the driver's direct leg once and derive the even per-rider split. */
async function buildSettleContext(trip: any, confirmedBookings: any[]): Promise<SettleContext> {
  const originCoord = (trip.origin_point?.lat != null && trip.origin_point?.lng != null)
    ? `${trip.origin_point.lat},${trip.origin_point.lng}` : trip.origin;
  const destCoord = (trip.destination_point?.lat != null && trip.destination_point?.lng != null)
    ? `${trip.destination_point.lat},${trip.destination_point.lng}` : trip.destination;

  const riderCount = confirmedBookings.reduce(
    (sum: number, b: any) => sum + (parseInt(b.seats_booked, 10) || 1), 0
  );

  let direct_distance_miles = 10;
  let direct_duration_seconds = 0;
  try {
    const routeResp = await axios.post(`${ROUTING_SERVICE_URL}/route/calculate`, {
      origin: originCoord,
      destination: destCoord,
    });
    direct_distance_miles   = routeResp.data?.distance_miles   ?? 10;
    direct_duration_seconds = routeResp.data?.duration_seconds ?? 0;
  } catch {
    console.warn('[settle] Routing unavailable, using 10 mi / 0s defaults');
  }

  const directDurationHours = direct_duration_seconds / 3600;
  const trip_cost = direct_distance_miles * IRS_MILEAGE_RATE + directDurationHours * DRIVER_HOURLY;
  return {
    originCoord,
    destCoord,
    directDistanceMiles: direct_distance_miles,
    directDurationHours,
    sharedPerRider: riderCount > 0 ? trip_cost / riderCount : trip_cost,
  };
}

/** Re-hydrate a frozen settled_breakdown that may arrive as a JSON string or object. */
function parseSettledBreakdown(raw: unknown): SettledBreakdown | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as SettledBreakdown; } catch { return null; }
  }
  if (typeof raw === 'object') return raw as SettledBreakdown;
  return null;
}

/**
 * Compute one rider's settlement against a shared trip context.
 * Preserves BOTH pricing paths: the drop-off-aware 3-leg path and the legacy
 * 2-call path for bookings that predate dropoff_location (obs 2807). Returns the
 * TOTAL, post-clamp amount_paid (per-seat fare x seats_booked).
 */
export async function computeRiderSettlement(
  booking: any,
  ctx: SettleContext,
): Promise<RiderSettleResult> {
  const { originCoord, destCoord, directDistanceMiles, sharedPerRider } = ctx;
  const riderId     = booking.rider_id;
  const riderName   = booking.rider_name ?? booking.rider?.name ?? 'Rider';
  const seatsBooked = parseInt(booking.seats_booked, 10) || 1;

  let detour_miles = 0;
  let detour_cost  = 0;
  let rider_base_cost = sharedPerRider;
  let breakdown    = `Base share: $${sharedPerRider.toFixed(2)}`;
  let legs: Partial<SettledBreakdown> = {};

  const pickupLoc  = parseLocation(booking.pickup_location);
  const dropoffLoc = parseLocation(booking.dropoff_location);

  if (pickupLoc && dropoffLoc) {
    // Drop-off-aware path: bill the rider for their own pickup->dropoff leg,
    // and price detour as the extra distance the driver covers reaching the
    // rider's pickup plus resuming from the rider's actual dropoff to the
    // driver's posted destination — mirrors the search-time formula instead
    // of always routing the rider's leg all the way to the driver's destination.
    const pickupAddr  = pickupLoc.address ?? `${pickupLoc.lat},${pickupLoc.lng}`;
    const dropoffAddr = dropoffLoc.address ?? `${dropoffLoc.lat},${dropoffLoc.lng}`;
    try {
      const [legPickupResp, legRideResp, legResumeResp] = await Promise.all([
        axios.post(`${ROUTING_SERVICE_URL}/route/calculate`, { origin: originCoord, destination: pickupAddr }),
        axios.post(`${ROUTING_SERVICE_URL}/route/calculate`, { origin: pickupAddr, destination: dropoffAddr }),
        axios.post(`${ROUTING_SERVICE_URL}/route/calculate`, { origin: dropoffAddr, destination: destCoord }),
      ]);
      const legPickupDist = legPickupResp.data?.distance_miles ?? 0;
      const legRideDist   = legRideResp.data?.distance_miles ?? 0;
      const legRideHours  = (legRideResp.data?.duration_seconds ?? 0) / 3600;
      const legResumeDist = legResumeResp.data?.distance_miles ?? 0;

      // Shared single-source-of-truth pricing — identical to the search-time quote.
      const pricing = computeDetourPricing({
        legPickupDistMiles:   legPickupDist,
        legRideDistMiles:     legRideDist,
        legRideDurationHours: legRideHours,
        legResumeDistMiles:   legResumeDist,
        directDistanceMiles:  directDistanceMiles,
      });
      rider_base_cost = pricing.riderBaseCost;
      detour_miles    = pricing.detourMiles;
      detour_cost     = pricing.detourCost;
      breakdown = `Ride leg: $${rider_base_cost.toFixed(2)}`;
      if (detour_cost > 0) {
        breakdown += ` + ${detour_miles.toFixed(2)} mi detour surcharge`;
      }
      legs = {
        leg_pickup_mi: parseFloat(legPickupDist.toFixed(2)),
        leg_ride_mi:   parseFloat(legRideDist.toFixed(2)),
        leg_ride_hr:   parseFloat(legRideHours.toFixed(4)),
        leg_resume_mi: parseFloat(legResumeDist.toFixed(2)),
      };
    } catch {
      console.warn(`[settle] Routing failed for rider ${riderId} drop-off-aware detour calc`);
    }
  } else if (pickupLoc) {
    // Legacy path (no dropoff_location on file): detour priced against the
    // driver's full destination, base cost stays the even trip-cost split.
    const pickupAddr = pickupLoc.address ?? `${pickupLoc.lat},${pickupLoc.lng}`;
    try {
      const [leg1Resp, leg2Resp] = await Promise.all([
        axios.post(`${ROUTING_SERVICE_URL}/route/calculate`, { origin: originCoord, destination: pickupAddr }),
        axios.post(`${ROUTING_SERVICE_URL}/route/calculate`, { origin: pickupAddr, destination: destCoord }),
      ]);
      const toPickupDist   = leg1Resp.data?.distance_miles ?? 0;
      const fromPickupDist = leg2Resp.data?.distance_miles ?? 0;
      detour_miles = Math.max(0, (toPickupDist + fromPickupDist) - directDistanceMiles);
      if (detour_miles > 0.1) {
        detour_cost = detour_miles * IRS_MILEAGE_RATE * DETOUR_SURCHARGE;
        breakdown += ` + ${detour_miles.toFixed(2)} mi detour surcharge`;
      }
    } catch {
      console.warn(`[settle] Routing failed for rider ${riderId} detour calc`);
    }
  }

  const holdAmount  = booking.fare != null ? parseFloat(booking.fare) : (rider_base_cost + detour_cost);
  const raw_amount  = (rider_base_cost + detour_cost) * seatsBooked;
  const amount_paid = parseFloat(Math.min(raw_amount, holdAmount * seatsBooked).toFixed(2));

  return {
    rider_id:     riderId,
    rider_name:   riderName,
    amount_paid,
    status:       booking.status,
    detour_miles: parseFloat(detour_miles.toFixed(2)),
    breakdown,
    settled_breakdown: {
      label:           breakdown,
      direct_mi:       parseFloat(directDistanceMiles.toFixed(2)),
      detour_mi:       parseFloat(detour_miles.toFixed(2)),
      rider_base_cost: parseFloat(rider_base_cost.toFixed(2)),
      detour_cost:     parseFloat(detour_cost.toFixed(2)),
      ...legs,
    },
  };
}

export async function settleTrip(tripId: string): Promise<SettleTripResult> {
  const trip = await fetchTripForSettle(tripId);
  const confirmedBookings = await fetchConfirmedBookings(tripId);
  const ctx = await buildSettleContext(trip, confirmedBookings);
  const riderCount = confirmedBookings.reduce(
    (sum: number, b: any) => sum + (parseInt(b.seats_booked, 10) || 1), 0
  );

  const riderSettlements: RiderSettlement[] = [];

  for (const booking of confirmedBookings) {
    // Prefer the frozen row written at drop-off — zero routing calls. The frozen
    // settled_amount is already the TOTAL, post-clamp value (per-seat x seats).
    if (booking.settled_amount != null && booking.settled_at) {
      const fb = parseSettledBreakdown(booking.settled_breakdown);
      const frozenAmount = parseFloat(parseFloat(booking.settled_amount).toFixed(2));
      riderSettlements.push({
        rider_id:     booking.rider_id,
        rider_name:   booking.rider_name ?? booking.rider?.name ?? 'Rider',
        amount_paid:  frozenAmount,
        status:       booking.status,
        detour_miles: fb?.detour_mi ?? 0,
        breakdown:    fb?.label ?? `Frozen at drop-off: $${frozenAmount.toFixed(2)}`,
      });
      continue;
    }
    // Unfrozen (drop-off not confirmed, or settlement routing failed at drop-off):
    // compute live, exactly as the old batch path did.
    riderSettlements.push(await computeRiderSettlement(booking, ctx));
  }

  const totalDriverEarnings = parseFloat(
    riderSettlements.reduce((sum, r) => sum + r.amount_paid, 0).toFixed(2)
  );

  return {
    trip_id:          tripId,
    irs_mileage_rate: IRS_MILEAGE_RATE,
    driver_hourly:    DRIVER_HOURLY,
    total_cost:       totalDriverEarnings,
    driver_earnings:  totalDriverEarnings,
    rider_count:      riderCount > 0 ? riderCount : 1,
    cost_per_rider:   parseFloat(ctx.sharedPerRider.toFixed(2)),
    breakdown: {
      direct_distance_miles: parseFloat(ctx.directDistanceMiles.toFixed(2)),
      direct_duration_hours: parseFloat(ctx.directDurationHours.toFixed(4)),
      trip_cost:             parseFloat((ctx.directDistanceMiles * IRS_MILEAGE_RATE + ctx.directDurationHours * DRIVER_HOURLY).toFixed(2)),
      detour_surcharge:      DETOUR_SURCHARGE,
    },
    riders: riderSettlements,
  };
}

/**
 * Settle ONE rider for the per-rider drop-off freeze flow. Routes only that
 * rider's legs (plus the shared direct leg) — 3-4 routing calls instead of the
 * batch path's 3N. Booking is located within the trip's settle-list so the even
 * split (used by the legacy fallback path) stays correct.
 */
export async function settleRider(tripId: string, bookingId: string): Promise<RiderSettleResult> {
  const trip = await fetchTripForSettle(tripId);
  const confirmedBookings = await fetchConfirmedBookings(tripId);
  const target = confirmedBookings.find(
    (b: any) => b.id === bookingId || b.booking_id === bookingId
  );
  if (!target) {
    throw new AppError(`Booking ${bookingId} not settleable for trip ${tripId}`, 404);
  }
  const ctx = await buildSettleContext(trip, confirmedBookings);
  return computeRiderSettlement(target, ctx);
}

/** One rider's frozen, discounted settlement returned by the T-1h freeze. */
export interface FrozenRider {
  booking_id: string;
  rider_id: string;
  settled_amount: number;
  settled_breakdown: SettledBreakdown & {
    pre_discount_amount: number;
    discount_amount: number;
    optimized_route_mi: number;
  };
}

export interface FreezeTripResult {
  trip_id: string;
  optimized_route_mi: number;
  total_savings: number;
  riders: FrozenRider[];
}

/**
 * T-1h multi-rider discount freeze. With the rider list final, compute every
 * rider's INDEPENDENT detour settlement (as if they were the only passenger),
 * then ask routing for the single optimized multi-stop route. The difference
 * between the summed independent detours and the one optimized detour is a
 * savings pool, redistributed across riders by their billed detour share and
 * clamped so no rider drops below their own ride-leg cost.
 *
 * Savings-pool redistribution is used instead of per-stop marginal attribution
 * because Google's optimize_waypoints cannot enforce pickup-before-dropoff
 * ordering, so a per-stop marginal split is not well defined (obs 2924).
 *
 * Throws a 502-tagged error if the optimized route is unavailable so the caller
 * DEFERS — a trip is never frozen at an undiscounted amount.
 */
export async function freezeTripSettlement(tripId: string): Promise<FreezeTripResult> {
  const trip = await fetchTripForSettle(tripId);
  const confirmedBookings = await fetchConfirmedBookings(tripId);
  const ctx = await buildSettleContext(trip, confirmedBookings);

  // 1. Independent per-rider settlement (pre-discount) for every rider.
  const base = await Promise.all(
    confirmedBookings.map(async (booking: any) => ({
      booking,
      result: await computeRiderSettlement(booking, ctx),
    }))
  );

  const multiRider = base.length >= 2;

  // 2. Collect each rider's pickup + dropoff as waypoints for the optimized route.
  const waypoints: string[] = [];
  for (const { booking } of base) {
    const p = parseLocation(booking.pickup_location);
    const d = parseLocation(booking.dropoff_location);
    if (!p || !d) {
      throw new AppError(
        `Could not parse pickup/dropoff location for booking ${booking.booking_id}`,
        422
      );
    }
    waypoints.push(p.address ?? `${p.lat},${p.lng}`);
    waypoints.push(d.address ?? `${d.lat},${d.lng}`);
  }

  // 3. Optimized multi-stop distance — only worth computing with >=2 riders and
  //    real waypoints. A Maps failure here is fatal (502) so the caller defers.
  let optimizedRouteMi = 0;
  if (multiRider && waypoints.length > 0) {
    try {
      const optResp = await axios.post(`${ROUTING_SERVICE_URL}/route/optimize`, {
        origin: ctx.originCoord,
        destination: ctx.destCoord,
        waypoints,
      });
      const distMi = optResp.data?.distance_miles;
      if (typeof distMi !== 'number' || !isFinite(distMi)) {
        throw Object.assign(
          new Error(`Optimizer returned invalid distance_miles for trip ${tripId}`),
          { status: 502 }
        );
      }
      // Validate pickup-before-dropoff ordering in the returned waypoint order.
      const returnedOrder: number[] | undefined = optResp.data?.waypoint_order;
      if (Array.isArray(returnedOrder)) {
        // waypoints array is [p0,d0, p1,d1, ...]; pickup index i*2, dropoff i*2+1.
        for (let i = 0; i < base.length; i++) {
          const pickupPos  = returnedOrder.indexOf(i * 2);
          const dropoffPos = returnedOrder.indexOf(i * 2 + 1);
          if (pickupPos === -1 || dropoffPos === -1 || pickupPos >= dropoffPos) {
            throw Object.assign(
              new Error(`Optimizer violated pickup-before-dropoff constraint for rider ${i} on trip ${tripId}`),
              { status: 502 }
            );
          }
        }
      }
      optimizedRouteMi = distMi;
    } catch (err: any) {
      throw Object.assign(
        new Error(`Optimized route unavailable for trip ${tripId}: ${err?.message ?? 'routing error'}`),
        { status: 502 }
      );
    }
  }

  // 4. Savings pool: summed independent detours minus the single optimized detour.
  const expectedDetourMi = base.reduce((s, { result }) => s + (result.settled_breakdown.detour_mi ?? 0), 0);
  const actualDetourMi   = Math.max(0, optimizedRouteMi - ctx.directDistanceMiles);
  const savingsPoolMi    = multiRider ? Math.max(0, expectedDetourMi - actualDetourMi) : 0;
  const savingsDollars   = savingsPoolMi * IRS_MILEAGE_RATE * DETOUR_SURCHARGE;
  const totalDetourCost  = base.reduce((s, { result }) => s + (result.settled_breakdown.detour_cost ?? 0), 0);

  // 5. Distribute the pool by each rider's billed detour share; clamp at their
  //    own ride-leg floor (per-seat base x seats) so none is discounted below cost.
  let appliedSavings = 0;
  const riders: FrozenRider[] = base.map(({ booking, result }) => {
    const seats        = parseInt(booking.seats_booked, 10) || 1;
    const preDiscount  = result.amount_paid;
    const riderDetour  = result.settled_breakdown.detour_cost ?? 0;
    const floor        = parseFloat((result.settled_breakdown.rider_base_cost * seats).toFixed(2));

    let discount = 0;
    if (savingsDollars > 0 && totalDetourCost > 0) {
      const raw        = savingsDollars * (riderDetour / totalDetourCost);
      const settledRaw = Math.max(floor, preDiscount - raw);
      discount         = parseFloat((preDiscount - settledRaw).toFixed(2));
    }
    const settledAmount = parseFloat((preDiscount - discount).toFixed(2));
    appliedSavings += discount;

    return {
      booking_id: booking.booking_id ?? booking.id,
      rider_id:   result.rider_id,
      settled_amount: settledAmount,
      settled_breakdown: {
        ...result.settled_breakdown,
        pre_discount_amount: parseFloat(preDiscount.toFixed(2)),
        discount_amount:     discount,
        optimized_route_mi:  parseFloat(optimizedRouteMi.toFixed(2)),
      },
    };
  });

  return {
    trip_id:            tripId,
    optimized_route_mi: parseFloat(optimizedRouteMi.toFixed(2)),
    total_savings:      parseFloat(appliedSavings.toFixed(2)),
    riders,
  };
}
