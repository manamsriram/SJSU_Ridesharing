import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestJson, startTestServer } from './http-test-utils';

const axiosGet  = vi.fn();
const axiosPost = vi.fn();

vi.mock('axios', () => ({
  default: { get: axiosGet, post: axiosPost },
}));

let closeServer: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (closeServer) { await closeServer(); closeServer = null; }
});
beforeEach(() => { axiosGet.mockReset(); axiosPost.mockReset(); });

const tripData = {
  trip_id: 'trip-frz', driver_id: 'drv-1',
  origin: 'Origin', destination: 'Dest',
  origin_point: { lat: 37.3352, lng: -121.8811 },
  destination_point: { lat: 37.3, lng: -121.9 },
};

// Two riders, each with pickup + dropoff so the drop-off-aware pricing path runs.
const twoRiders = [
  {
    booking_id: 'bk-a', rider_id: 'rider-a', rider_name: 'Alice', seats_booked: 1,
    booking_state: 'approved', status: 'approved', fare: 100,
    pickup_location: { lat: 37.34, lng: -121.88 }, dropoff_location: { lat: 37.33, lng: -121.89 },
  },
  {
    booking_id: 'bk-b', rider_id: 'rider-b', rider_name: 'Bob', seats_booked: 1,
    booking_state: 'approved', status: 'approved', fare: 100,
    pickup_location: { lat: 37.35, lng: -121.87 }, dropoff_location: { lat: 37.32, lng: -121.90 },
  },
];

/** Routing mock: every point-to-point leg = 4 mi / 360 s; the optimized multi-stop route = 10 mi. */
function mockRouting(optimizedMi: number | 'fail') {
  axiosPost.mockImplementation((url: string) => {
    if (url.endsWith('/route/optimize')) {
      if (optimizedMi === 'fail') return Promise.reject(new Error('Maps unavailable'));
      return Promise.resolve({ data: { distance_miles: optimizedMi, duration_seconds: 1200, waypoint_order: [0, 1, 2, 3] } });
    }
    return Promise.resolve({ data: { distance_miles: 4, duration_seconds: 360 } });
  });
}

function mockTripAndBookings(bookings: any[]) {
  axiosGet.mockImplementation((url: string) => {
    if (url.includes('/settle')) return Promise.resolve({ data: { data: { bookings } } });
    return Promise.resolve({ data: { data: tripData } });
  });
}

async function callFreeze() {
  const { default: app } = await import('../../services/cost-calculation-service/src/app');
  const server = await startTestServer(app);
  closeServer = server.close;
  return requestJson<{ status: string; message: string; data: any }>({
    baseUrl: server.baseUrl, method: 'GET', path: '/cost/freeze/trip-frz',
  });
}

describe('services/cost-calculation-service > GET /cost/freeze/:trip_id', () => {
  it('redistributes route-optimization savings across multi-rider trips', async () => {
    mockTripAndBookings(twoRiders);
    mockRouting(10); // optimized 10 mi vs summed independent detours => real savings

    const res = await callFreeze();

    expect(res.status).toBe(200);
    expect(res.body.data.optimized_route_mi).toBe(10);
    expect(res.body.data.total_savings).toBeGreaterThan(0);
    expect(res.body.data.riders).toHaveLength(2);

    for (const r of res.body.data.riders) {
      // Every rider is discounted, never charged more, never below their own ride leg.
      expect(r.settled_breakdown.discount_amount).toBeGreaterThan(0);
      expect(r.settled_amount).toBeLessThan(r.settled_breakdown.pre_discount_amount);
      expect(r.settled_amount).toBeGreaterThanOrEqual(r.settled_breakdown.rider_base_cost);
      expect(r.settled_breakdown.optimized_route_mi).toBe(10);
    }
  });

  it('applies no discount for a single-rider trip', async () => {
    mockTripAndBookings([twoRiders[0]]);
    mockRouting(10);

    const res = await callFreeze();

    expect(res.status).toBe(200);
    expect(res.body.data.total_savings).toBe(0);
    expect(res.body.data.optimized_route_mi).toBe(0);
    expect(res.body.data.riders).toHaveLength(1);
    const r = res.body.data.riders[0];
    expect(r.settled_breakdown.discount_amount).toBe(0);
    expect(r.settled_amount).toBe(r.settled_breakdown.pre_discount_amount);
    // The optimizer must NOT be called when there is nothing to optimize.
    expect(axiosPost.mock.calls.some((c: any[]) => String(c[0]).endsWith('/route/optimize'))).toBe(false);
  });

  it('applies no discount when the optimized route is no shorter than the summed detours', async () => {
    mockTripAndBookings(twoRiders);
    mockRouting(100); // optimized longer than expected => savings clamp to 0

    const res = await callFreeze();

    expect(res.status).toBe(200);
    expect(res.body.data.total_savings).toBe(0);
    for (const r of res.body.data.riders) {
      expect(r.settled_breakdown.discount_amount).toBe(0);
      expect(r.settled_amount).toBe(r.settled_breakdown.pre_discount_amount);
    }
  });

  it('returns 502 (defer, do not freeze) when the optimized route is unavailable', async () => {
    mockTripAndBookings(twoRiders);
    mockRouting('fail');

    const res = await callFreeze();

    expect(res.status).toBe(502);
    expect(res.body.status).toBe('error');
  });
});
