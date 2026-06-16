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

describe('services/cost-calculation-service > GET /cost/settle/:trip_id', () => {
  it('returns 404 when the trip service says the trip does not exist', async () => {
    axiosGet.mockRejectedValueOnce({ response: { status: 404 } });

    const { default: app } = await import('../../services/cost-calculation-service/src/app');
    const server = await startTestServer(app);
    closeServer = server.close;

    const res = await requestJson<{ status: string; message: string }>({
      baseUrl: server.baseUrl, method: 'GET', path: '/cost/settle/nonexistent-trip',
    });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
    expect(res.body.message).toContain('nonexistent-trip');
  });

  it('returns a complete IRS-rate settlement when all services respond', async () => {
    const tripData = {
      trip_id: 'trip-123', driver_id: 'driver-001',
      origin: 'SJSU', destination: 'Caltrain',
      origin_point: { lat: 37.3352, lng: -121.8811 },
      destination_point: { lat: 37.3305, lng: -121.8869 },
    };
    const bookingsData = [
      { rider_id: 'rider-a', rider_name: 'Alice', seats_booked: 1, booking_state: 'approved', fare: 10 },
      { rider_id: 'rider-b', rider_name: 'Bob',   seats_booked: 1, booking_state: 'approved', fare: 10 },
    ];

    // GET 1: trip, GET 2: bookings
    axiosGet
      .mockResolvedValueOnce({ data: { data: tripData } })
      .mockResolvedValueOnce({ data: { data: { bookings: bookingsData } } });

    // POST: direct route (5 miles, 600s)
    axiosPost.mockResolvedValueOnce({ data: { distance_miles: 5, duration_seconds: 600 } });

    const { default: app } = await import('../../services/cost-calculation-service/src/app');
    const server = await startTestServer(app);
    closeServer = server.close;

    const res = await requestJson<{
      status: string;
      data: {
        trip_id: string;
        irs_mileage_rate: number;
        driver_hourly: number;
        rider_count: number;
        cost_per_rider: number;
        riders: Array<{ rider_id: string; amount_paid: number }>;
      };
    }>({ baseUrl: server.baseUrl, method: 'GET', path: '/cost/settle/trip-123' });

    // 5mi × 0.67 + (600/3600)h × 15 = 3.35 + 2.50 = 5.85 total, 5.85/2 = 2.925 → 2.92/rider
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.trip_id).toBe('trip-123');
    expect(res.body.data.irs_mileage_rate).toBe(0.67);
    expect(res.body.data.driver_hourly).toBe(15);
    expect(res.body.data.rider_count).toBe(2);
    expect(res.body.data.cost_per_rider).toBe(2.92);
    expect(res.body.data.riders).toHaveLength(2);
    expect(res.body.data.riders[0].rider_id).toBe('rider-a');
  });

  it('excludes cancelled/rejected bookings from rider count', async () => {
    const tripData = { trip_id: 'trip-789', driver_id: 'drv-3', origin: 'A', destination: 'B' };
    const bookingsData = [
      { rider_id: 'r1', rider_name: 'Alice', seats_booked: 1, booking_state: 'approved', fare: 10 },
      { rider_id: 'r2', rider_name: 'Bob',   seats_booked: 1, booking_state: 'cancelled', fare: 10 },
      { rider_id: 'r3', rider_name: 'Carol', seats_booked: 1, booking_state: 'rejected',  fare: 10 },
    ];

    axiosGet
      .mockResolvedValueOnce({ data: { data: tripData } })
      .mockResolvedValueOnce({ data: { data: { bookings: bookingsData } } });
    axiosPost.mockResolvedValueOnce({ data: { distance_miles: 3, duration_seconds: 0 } });

    const { default: app } = await import('../../services/cost-calculation-service/src/app');
    const server = await startTestServer(app);
    closeServer = server.close;

    const res = await requestJson<{ status: string; data: { rider_count: number; riders: unknown[] } }>({
      baseUrl: server.baseUrl, method: 'GET', path: '/cost/settle/trip-789',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.rider_count).toBe(1);
    expect(res.body.data.riders).toHaveLength(1);
  });

  it('prices the drop-off-side detour against the rider\'s own dropoff_location, not the driver\'s full destination', async () => {
    const tripData = {
      trip_id: 'trip-dropoff', driver_id: 'driver-001',
      origin: 'A', destination: 'D',
      origin_point: { lat: 37.3352, lng: -121.8811 },
      destination_point: { lat: 37.30, lng: -121.90 },
    };
    const bookingsData = [
      {
        rider_id: 'rider-a', rider_name: 'Alice', seats_booked: 1, booking_state: 'approved', fare: 10,
        pickup_location: { lat: 37.34, lng: -121.88, address: 'P' },
        dropoff_location: { lat: 37.31, lng: -121.89, address: 'Q' },
      },
    ];

    axiosGet
      .mockResolvedValueOnce({ data: { data: tripData } })
      .mockResolvedValueOnce({ data: { data: { bookings: bookingsData } } });

    // POST 1: direct route (driver origin -> driver dest): 10mi
    // POST 2: leg_pickup (driver origin -> rider pickup): 1mi
    // POST 3: leg_ride (rider pickup -> rider dropoff): 5mi
    // POST 4: leg_resume (rider dropoff -> driver dest): 5mi
    axiosPost
      .mockResolvedValueOnce({ data: { distance_miles: 10, duration_seconds: 0 } })
      .mockResolvedValueOnce({ data: { distance_miles: 1, duration_seconds: 0 } })
      .mockResolvedValueOnce({ data: { distance_miles: 5, duration_seconds: 0 } })
      .mockResolvedValueOnce({ data: { distance_miles: 5, duration_seconds: 0 } });

    const { default: app } = await import('../../services/cost-calculation-service/src/app');
    const server = await startTestServer(app);
    closeServer = server.close;

    const res = await requestJson<{
      status: string;
      data: { riders: Array<{ rider_id: string; amount_paid: number; detour_miles: number }> };
    }>({ baseUrl: server.baseUrl, method: 'GET', path: '/cost/settle/trip-dropoff' });

    // ride leg (5mi) * 0.67 = 3.35 base fare; total routed (1+5+5=11) - direct (10) = 1mi detour
    // detour_cost = 1 * 0.67 * 1.25 = 0.8375; amount_paid = 3.35 + 0.8375 = 4.19 (capped well under fare=10)
    expect(res.status).toBe(200);
    expect(res.body.data.riders[0].detour_miles).toBe(1);
    expect(res.body.data.riders[0].amount_paid).toBe(4.19);
  });

  it('falls back to pickup-only detour against the driver\'s destination when dropoff_location is absent (legacy bookings)', async () => {
    const tripData = {
      trip_id: 'trip-legacy', driver_id: 'driver-001',
      origin: 'A', destination: 'D',
      origin_point: { lat: 37.3352, lng: -121.8811 },
      destination_point: { lat: 37.30, lng: -121.90 },
    };
    const bookingsData = [
      {
        rider_id: 'rider-a', rider_name: 'Alice', seats_booked: 1, booking_state: 'approved', fare: 10,
        pickup_location: { lat: 37.34, lng: -121.88, address: 'P' },
      },
    ];

    axiosGet
      .mockResolvedValueOnce({ data: { data: tripData } })
      .mockResolvedValueOnce({ data: { data: { bookings: bookingsData } } });

    // POST 1: direct route: 10mi. POST 2/3: leg1 (origin->pickup) + leg2 (pickup->dest), run in parallel.
    axiosPost
      .mockResolvedValueOnce({ data: { distance_miles: 10, duration_seconds: 0 } })
      .mockResolvedValueOnce({ data: { distance_miles: 1, duration_seconds: 0 } })
      .mockResolvedValueOnce({ data: { distance_miles: 9.5, duration_seconds: 0 } });

    const { default: app } = await import('../../services/cost-calculation-service/src/app');
    const server = await startTestServer(app);
    closeServer = server.close;

    const res = await requestJson<{
      status: string;
      data: { riders: Array<{ rider_id: string; amount_paid: number; detour_miles: number }> };
    }>({ baseUrl: server.baseUrl, method: 'GET', path: '/cost/settle/trip-legacy' });

    // direct=10mi -> trip_cost=6.7, shared_per_rider=6.7; detour = (1+9.5)-10=0.5mi -> detour_cost=0.5*0.67*1.25=0.41875
    // amount_paid = min(6.7+0.42, 10) = 7.12
    expect(res.status).toBe(200);
    expect(res.body.data.riders[0].detour_miles).toBe(0.5);
    expect(res.body.data.riders[0].amount_paid).toBe(7.12);
  });

  it('uses 10-mile default when the routing service is unavailable', async () => {
    const tripData = { trip_id: 'trip-def', driver_id: 'drv-4', origin: 'X', destination: 'Y' };

    axiosGet
      .mockResolvedValueOnce({ data: { data: tripData } })
      .mockResolvedValueOnce({ data: [] });
    axiosPost.mockRejectedValueOnce(new Error('routing unavailable'));

    const { default: app } = await import('../../services/cost-calculation-service/src/app');
    const server = await startTestServer(app);
    closeServer = server.close;

    const res = await requestJson<{ status: string; data: { breakdown: { direct_distance_miles: number } } }>({
      baseUrl: server.baseUrl, method: 'GET', path: '/cost/settle/trip-def',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.breakdown.direct_distance_miles).toBe(10);
  });
});
