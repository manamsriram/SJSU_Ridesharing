import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const bookingLatency = new Trend('booking_creation_latency_grpc');
const errorRate = new Rate('errors');
const bookingsCreated = new Counter('bookings_created');

// Chain tested: POST /api/bookings
//   booking-service → POST /cost/calculate → cost-service
//                   → POST /route/calculate → routing-service
// 3 synchronous hops, pure computation, no ML inference.
// On this branch, inter-service calls use gRPC instead of HTTP/REST.

export const options = {
  stages: [
    { duration: '10s', target: 5 },
    { duration: '60s', target: 10 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    booking_creation_latency_grpc: ['p(95)<3000'],
    errors: ['rate<0.05'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://api-gateway:3000';

export function setup() {
  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({
      email: __ENV.RIDER_EMAIL || 'benchmark-rider@sjsu.edu',
      password: __ENV.RIDER_PASSWORD || 'benchmarkpass123',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (loginRes.status !== 200) {
    console.error(`Auth failed: ${loginRes.status} ${loginRes.body}`);
    return { token: null, tripId: __ENV.TRIP_ID || null };
  }

  const token = loginRes.json('data.token');

  if (__ENV.TRIP_ID) {
    return { token, tripId: __ENV.TRIP_ID };
  }

  const searchRes = http.get(
    `${BASE_URL}/api/trips/search` +
      '?origin_lat=37.3351874&origin_lng=-121.8810715' +
      '&destination_lat=37.4118779&destination_lng=-121.900762' +
      '&limit=5',
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const trips = searchRes.json('data.trips');
  const tripId = Array.isArray(trips) && trips.length > 0 ? trips[0].trip_id || trips[0].id : null;

  if (!tripId) {
    console.error('No available trips found — set TRIP_ID env var');
  }

  return { token, tripId };
}

export default function ({ token, tripId }) {
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
