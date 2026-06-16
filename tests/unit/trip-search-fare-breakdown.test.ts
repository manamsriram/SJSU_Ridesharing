import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

process.env.DATABASE_URL = 'postgres://fare-breakdown-test-db';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'fare-breakdown-test-secret';
process.env.NODE_ENV = 'test';

const queryMock = vi.hoisted(() => vi.fn());

vi.mock('pg', () => {
  class MockPool {
    query = queryMock;
    on = vi.fn();
  }
  return { Pool: MockPool };
});

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('../../services/trip-service/src/utils/redisClient', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/trip-service/src/services/matching.service', () => ({
  rankWithEmbedding: vi.fn(async (_req, candidates) => candidates),
  computeScost: vi.fn(() => ({ travel: 1, walk: 1, detour: 1, advance: 1, social: 1, total: 1 })),
  haversineMeters: vi.fn((lat1: number, lng1: number, lat2: number, lng2: number) => {
    const R = 6371000;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }),
}));

const SEARCH_ROW = {
  trip_id: 'trip-1',
  driver_id: 'driver-1',
  origin: 'San Francisco',
  destination: 'San Jose State University',
  origin_lat: 37.7749,
  origin_lng: -122.4194,
  destination_lat: 37.3352,
  destination_lng: -122.8811,
  departure_time: new Date(Date.now() + 2 * 60 * 60 * 1000),
  seats_available: 3,
  recurrence: null,
  status: 'pending',
  featured: false,
  created_at: new Date(),
  updated_at: new Date(),
  distance_meters: 100,
  driver_user_id: 'driver-1',
  driver_name: 'Test Driver',
  driver_email: 'driver@sjsu.edu',
  driver_role: 'Driver',
  driver_sjsu_id_status: 'verified',
  driver_rating: 4.8,
  driver_vehicle_info: 'Honda Civic',
  driver_profile_picture_url: null,
  driver_created_at: new Date(),
  driver_updated_at: new Date(),
};

describe('searchTripsWithRerouting fare breakdown', () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [SEARCH_ROW] });
    vi.mocked(axios.post).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('includes a populated cost_breakdown when routing succeeds', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { duration_seconds: 600, distance_miles: 5, distance_meters: 8000 },
    });

    const { searchTripsWithRerouting } = await import('../../services/trip-service/src/services/trip.service');

    const results = await searchTripsWithRerouting(
      37.7749, -122.4194,
      37.3352, -122.8811,
      new Date(),
    );

    expect(results).toHaveLength(1);
    expect(results[0].cost_breakdown).toBeDefined();
    expect(results[0].cost_breakdown!.duration_hours).toBeGreaterThan(0);
    expect(typeof results[0].estimated_cost).toBe('number');
  });

  it('retries once per leg, then falls back to a distance-based estimate — never a zero-duration or missing fare', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('routing service timeout'));

    const { searchTripsWithRerouting } = await import('../../services/trip-service/src/services/trip.service');

    const results = await searchTripsWithRerouting(
      37.7749, -122.4194,
      37.3352, -122.8811,
      new Date(),
    );

    expect(results).toHaveLength(1);
    // each of the 2 legs is retried once, so axios.post is called 4 times total
    expect(vi.mocked(axios.post).mock.calls.length).toBe(4);

    // fare breakdown must always be present and reflect a non-zero time component,
    // computed from the haversine-distance fallback rather than left at zero
    expect(results[0].cost_breakdown).toBeDefined();
    expect(results[0].cost_breakdown!.duration_hours).toBeGreaterThan(0);
    expect(results[0].adjusted_eta_minutes).toBeGreaterThan(0);
    expect(typeof results[0].estimated_cost).toBe('number');
    expect(Number.isNaN(results[0].estimated_cost)).toBe(false);
  });

  it('falls back per-leg independently — a failing leg does not blank out a succeeding one', async () => {
    vi.mocked(axios.post).mockImplementation(async (_url, body: any) => {
      // only the leg1 (driver_origin -> rider_pickup) call fails
      if (body.destination === '37.7749,-122.4194') {
        throw new Error('routing service timeout');
      }
      return { data: { duration_seconds: 900, distance_miles: 8, distance_meters: 12800 } };
    });

    const { searchTripsWithRerouting } = await import('../../services/trip-service/src/services/trip.service');

    const results = await searchTripsWithRerouting(
      37.7749, -122.4194,
      37.3352, -122.8811,
      new Date(),
    );

    expect(results).toHaveLength(1);
    expect(results[0].cost_breakdown).toBeDefined();
    // leg2's real 900s duration must still be reflected, not blown away by leg1's failure
    expect(results[0].original_eta_minutes).toBe(15);
  });

  it('includes drop-off-side deviation in detour_miles when the driver\'s posted destination differs from the rider\'s searched destination', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { duration_seconds: 600, distance_miles: 5, distance_meters: 8000 },
    });

    // Driver's posted destination (Palo Alto Caltrain) differs from the rider's
    // searched destination (California Ave Caltrain), ~2km apart.
    const rowWithMismatchedDestination = {
      ...SEARCH_ROW,
      destination_lat: 37.4432,
      destination_lng: -122.1643,
    };
    queryMock.mockResolvedValue({ rows: [rowWithMismatchedDestination] });

    const { searchTripsWithRerouting } = await import('../../services/trip-service/src/services/trip.service');

    // Rider searches for California Ave Caltrain as the destination
    const results = await searchTripsWithRerouting(
      37.7749, -122.4194,
      37.4290, -122.1428,
      new Date(),
    );

    expect(results).toHaveLength(1);
    // origin matches exactly (0 pickup detour), so all detour_miles comes from the
    // ~2km drop-off mismatch between rider's destination and driver's actual destination
    expect(results[0].detour_miles).toBeGreaterThan(1);
    expect(results[0].cost_breakdown!.detour_fee).toBeGreaterThan(0);
  });
});
