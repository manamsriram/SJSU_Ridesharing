import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const detailLatency = new Trend('trip_detail_latency_http');
const errorRate = new Rate('errors');

// Chain tested: GET /api/trips/:id/bookings
//   trip-service → GET /bookings/trip/:id → booking-service
// 2 synchronous hops, pure DB reads, no computation.
// Read-only — no cleanup needed, supports higher VU count than booking-creation.

export const options = {
  stages: [
    { duration: '10s', target: 10 },
    { duration: '60s', target: 20 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    trip_detail_latency_http: ['p(95)<1000'],
    errors: ['rate<0.02'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://api-gateway:3000';

export function setup() {
  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({
      email: __ENV.DRIVER_EMAIL || 'benchmark-driver@sjsu.edu',
      password: __ENV.DRIVER_PASSWORD || 'benchmarkpass123',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (loginRes.status !== 200) {
    console.error(`Auth failed: ${loginRes.status} ${loginRes.body}`);
    return { token: null, tripId: __ENV.TRIP_ID || null };
  }

  const token = loginRes.json('data.accessToken');
  const driverUserId = loginRes.json('data.user.user_id');

  if (__ENV.TRIP_ID) {
    return { token, tripId: __ENV.TRIP_ID };
  }

  const tripsRes = http.get(`${BASE_URL}/api/trips`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const allTrips = tripsRes.json('data.trips') || tripsRes.json('data') || [];
  // Filter to only trips owned by the authenticated driver — /api/trips returns all trips
  const ownTrips = Array.isArray(allTrips)
    ? allTrips.filter((t) => t.driver_id === driverUserId)
    : [];
  const tripId = ownTrips.length > 0
    ? ownTrips[0].trip_id || ownTrips[0].id
    : null;

  if (!tripId) {
    console.error(`No trips found for driver ${driverUserId} — run benchmark:setup first`);
  }

  return { token, tripId };
}

export default function ({ token, tripId }) {
  if (!token || !tripId) {
    errorRate.add(1);
    sleep(0.5);
    return;
  }

  const res = http.get(`${BASE_URL}/api/trips/${tripId}/bookings`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'bookings array present': (r) => {
      try {
        return Array.isArray(r.json('data.bookings'));
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!ok);
  detailLatency.add(res.timings.duration);

  sleep(0.5);
}
