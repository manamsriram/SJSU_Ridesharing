import axios from 'axios';

const IRS_MILEAGE_RATE = 0.67;
const DRIVER_HOURLY    = 15.00;
const DETOUR_SURCHARGE = 1.25;

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

export async function settleTrip(tripId: string): Promise<SettleTripResult> {
  // STEP 1 — Fetch trip details
  const tripResp = await axios.get(`${TRIP_SERVICE_URL}/trips/${tripId}`);
  const trip = tripResp.data?.data ?? tripResp.data;

  if (!trip || !trip.trip_id) {
    throw Object.assign(new Error(`Trip ${tripId} not found`), { status: 404 });
  }

  const originCoord = (trip.origin_point?.lat != null && trip.origin_point?.lng != null)
    ? `${trip.origin_point.lat},${trip.origin_point.lng}` : trip.origin;
  const destCoord = (trip.destination_point?.lat != null && trip.destination_point?.lng != null)
    ? `${trip.destination_point.lat},${trip.destination_point.lng}` : trip.destination;

  // STEP 2 — Fetch bookings
  let bookings: any[] = [];
  try {
    const bookingsResp = await axios.get(`${BOOKING_SERVICE_URL}/bookings/trip/${tripId}/settle`);
    const raw = bookingsResp.data?.data ?? bookingsResp.data;
    bookings = Array.isArray(raw) ? raw
             : Array.isArray(raw?.bookings) ? raw.bookings
             : [];
  } catch (err: any) {
    console.warn(`[settle] Could not fetch bookings for trip ${tripId}: ${err?.message}`);
  }

  const confirmedBookings = bookings.filter(
    (b: any) => !['cancelled', 'canceled', 'rejected'].includes(b.booking_state)
  );

  const riderCount = confirmedBookings.reduce(
    (sum: number, b: any) => sum + (parseInt(b.seats_booked, 10) || 1), 0
  );

  // STEP 3 — Direct trip distance + duration
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

  // STEP 4 — Per-rider settlement
  const direct_duration_hours = direct_duration_seconds / 3600;
  const trip_cost       = direct_distance_miles * IRS_MILEAGE_RATE + direct_duration_hours * DRIVER_HOURLY;
  const shared_per_rider = riderCount > 0 ? trip_cost / riderCount : trip_cost;

  const riderSettlements: RiderSettlement[] = [];

  for (const booking of confirmedBookings) {
    const riderId     = booking.rider_id;
    const riderName   = booking.rider_name ?? booking.rider?.name ?? 'Rider';
    const seatsBooked = parseInt(booking.seats_booked, 10) || 1;

    let detour_miles = 0;
    let detour_cost  = 0;
    let breakdown    = `Base share: $${shared_per_rider.toFixed(2)}`;

    let loc: any = null;
    if (booking.pickup_location) {
      try {
        loc = typeof booking.pickup_location === 'string'
          ? JSON.parse(booking.pickup_location)
          : booking.pickup_location;
      } catch {
        const parts = String(booking.pickup_location).split(',');
        if (parts.length === 2) {
          loc = { lat: parseFloat(parts[0]), lng: parseFloat(parts[1]) };
        }
      }
    }

    if (loc && (loc.address || (loc.lat != null && loc.lng != null))) {
      const pickupAddr = loc.address ?? `${loc.lat},${loc.lng}`;
      try {
        const [leg1Resp, leg2Resp] = await Promise.all([
          axios.post(`${ROUTING_SERVICE_URL}/route/calculate`, { origin: originCoord, destination: pickupAddr }),
          axios.post(`${ROUTING_SERVICE_URL}/route/calculate`, { origin: pickupAddr, destination: destCoord }),
        ]);
        const toPickupDist   = leg1Resp.data?.distance_miles ?? 0;
        const fromPickupDist = leg2Resp.data?.distance_miles ?? 0;
        detour_miles = Math.max(0, (toPickupDist + fromPickupDist) - direct_distance_miles);
        if (detour_miles > 0.1) {
          detour_cost = detour_miles * IRS_MILEAGE_RATE * DETOUR_SURCHARGE;
          breakdown += ` + ${detour_miles.toFixed(2)} mi detour surcharge`;
        }
      } catch {
        console.warn(`[settle] Routing failed for rider ${riderId} detour calc`);
      }
    }

    const holdAmount = booking.fare != null ? parseFloat(booking.fare) : (shared_per_rider + detour_cost);
    const raw_amount  = (shared_per_rider + detour_cost) * seatsBooked;
    const amount_paid = parseFloat(Math.min(raw_amount, holdAmount * seatsBooked).toFixed(2));

    riderSettlements.push({
      rider_id:     riderId,
      rider_name:   riderName,
      amount_paid,
      status:       booking.status,
      detour_miles: parseFloat(detour_miles.toFixed(2)),
      breakdown,
    });
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
    cost_per_rider:   parseFloat(shared_per_rider.toFixed(2)),
    breakdown: {
      direct_distance_miles: parseFloat(direct_distance_miles.toFixed(2)),
      direct_duration_hours: parseFloat(direct_duration_hours.toFixed(4)),
      trip_cost:             parseFloat(trip_cost.toFixed(2)),
      detour_surcharge:      DETOUR_SURCHARGE,
    },
    riders: riderSettlements,
  };
}
