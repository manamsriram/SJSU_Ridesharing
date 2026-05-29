import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const bookingLatency = new Trend('booking_creation_latency_grpc');
const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    booking_creation: {
      executor: 'constant-vus',
      vus: 20,
      duration: '60s',
      tags: { scenario: 'booking_creation' },
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    errors: ['rate<0.01'],
  },
};

export function setup() {
  if (!__ENV.AUTH_TOKEN) {
    throw new Error('AUTH_TOKEN environment variable is required');
  }
  if (!__ENV.TEST_TRIP_ID) {
    throw new Error('TEST_TRIP_ID environment variable is required');
  }
}

const BASE_URL = __ENV.BASE_URL || 'http://136.109.119.177';
const AUTH_TOKEN = __ENV.AUTH_TOKEN;
const TEST_TRIP_ID = __ENV.TEST_TRIP_ID;

export default function () {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${AUTH_TOKEN}`,
  };

  const res = http.post(
    `${BASE_URL}/api/bookings`,
    JSON.stringify({ trip_id: TEST_TRIP_ID, seats_requested: 1 }),
    { headers }
  );

  const ok = check(res, {
    'status 2xx': (r) => r.status >= 200 && r.status < 300,
    'has booking id': (r) => {
      try { return r.json('data.id') !== undefined || r.json('id') !== undefined; }
      catch { return false; }
    },
  });
  errorRate.add(!ok);
  bookingLatency.add(res.timings.duration);
  sleep(0.5);
}
