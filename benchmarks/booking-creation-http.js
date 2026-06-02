import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const bookingLatency = new Trend('booking_creation_latency_http');
const errorRate = new Rate('errors');
const bookingsCreated = new Counter('bookings_created');

// Chain tested: POST /api/bookings
//   booking-service → POST /cost/calculate → cost-service
//                   → POST /route/calculate → routing-service
// 3 synchronous hops, pure computation, no ML inference.

export const options = {
  stages: [
    { duration: '10s', target: 10 },
    { duration: '60s', target: 20 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    booking_creation_latency_http: ['p(95)<3000'],
    errors: ['rate<0.05'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://api-gateway:3000';
const PASSWORD = __ENV.RIDER_PASSWORD || 'Password123';

export function setup() {
  const tripId = __ENV.TRIP_ID || null;

  // Login up to 20 benchmark riders created by benchmark-setup.js.
  const tokens = [];
  for (let i = 1; i <= 20 && tokens.length < 20; i++) {
    const email = `benchmark-rider-${String(i).padStart(2, '0')}@sjsu.edu`;
    const res = http.post(
      `${BASE_URL}/api/auth/login`,
      JSON.stringify({ email, password: PASSWORD }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    if (res.status !== 200) continue;
    const role = res.json('data.user.role');
    if (role !== 'Rider') continue;
    const token = res.json('data.accessToken');
    if (token) tokens.push(token);
  }

  if (tokens.length === 0) {
    // Fallback to env-supplied single user
    const fallback = http.post(
      `${BASE_URL}/api/auth/login`,
      JSON.stringify({
        email: __ENV.RIDER_EMAIL || 'benchmark-rider@sjsu.edu',
        password: PASSWORD,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    if (fallback.status === 200) {
      const t = fallback.json('data.accessToken');
      if (t) tokens.push(t);
    }
  }

  if (tokens.length === 0) {
    console.error('No rider tokens acquired — all logins failed');
    return { tokens: [], tripId };
  }

  if (!tripId) {
    // Require departure at least 2 hours out so the 1-hour lock never triggers during the run.
    const departureAfter = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const searchRes = http.get(
      `${BASE_URL}/api/trips/search` +
        '?origin_lat=37.3351874&origin_lng=-121.8810715' +
        '&destination_lat=37.4118779&destination_lng=-121.900762' +
        `&departure_after=${encodeURIComponent(departureAfter)}` +
        '&limit=20',
      { headers: { Authorization: `Bearer ${tokens[0]}` } }
    );
    const trips = searchRes.json('data.trips');
    if (!Array.isArray(trips) || trips.length === 0) {
      console.error('No available trips found — re-seed the DB or set TRIP_ID env var');
      return { tokens, tripIds: [] };
    }
    // Collect up to 10 distinct trip IDs so VUs can spread load across trips
    // and avoid seat exhaustion on a single trip.
    const tripIds = trips.slice(0, 10).map((t) => t.trip_id || t.id).filter(Boolean);
    return { tokens, tripIds };
  }

  return { tokens, tripIds: [tripId] };
}

export default function (data) {
  const { tokens, tripIds } = data;
  const token = tokens[(__VU - 1) % tokens.length];
  // Spread VUs across available trips to avoid seat exhaustion on a single trip
  const tripId = tripIds && tripIds.length > 0 ? tripIds[(__VU - 1) % tripIds.length] : null;

  if (!token || !tripId) {
    errorRate.add(1);
    sleep(1);
    return;
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const createRes = http.post(
    `${BASE_URL}/api/bookings`,
    JSON.stringify({ trip_id: tripId, seats_booked: 1 }),
    { headers }
  );

  const ok = check(createRes, {
    'status 201': (r) => r.status === 201,
    'quote returned': (r) => {
      try {
        return r.json('data.quote') !== null;
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!ok);
  bookingLatency.add(createRes.timings.duration);

  if (createRes.status === 201) {
    bookingsCreated.add(1);
    const bookingId =
      createRes.json('data.booking.booking_id') || createRes.json('data.booking.id');
    if (bookingId) {
      http.put(`${BASE_URL}/api/bookings/${bookingId}/cancel`, null, { headers });
    }
  }

  sleep(1);
}
