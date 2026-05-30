import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const searchLatency = new Trend('trip_search_latency_http');
const errorRate = new Rate('errors');

export const options = {
  stages: [
    { duration: '15s', target: 20 },
    { duration: '60s', target: 20 },
    { duration: '5s',  target: 0  },
  ],
  thresholds: {
    trip_search_latency_http: ['p(95)<5000'],
    errors: ['rate<0.05'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://api-gateway:3000';
const SEARCH_URL = `${BASE_URL}/api/trips/search` +
  '?origin_lat=37.3351874&origin_lng=-121.8810715' +
  '&destination_lat=37.4118779&destination_lng=-121.900762' +
  '&limit=10';

export default function () {
  const res = http.get(SEARCH_URL);

  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has trips': (r) => {
      try { return Array.isArray(r.json('data.trips')); }
      catch { return false; }
    },
  });
  errorRate.add(!ok);
  searchLatency.add(res.timings.duration);
  sleep(0.5);
}
