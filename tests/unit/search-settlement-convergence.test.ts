import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { computeDetourPricing } from '@lessgo/shared';

process.env.DATABASE_URL = 'postgres://convergence-test-db';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'convergence-test-secret';
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
  destination_lng: -121.8811,
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

// Regression guard for Fix 1: the search-time quote and the settlement charge
// must price the detour identically when the routing service returns the same
// leg distances both times — i.e. both paths flow through computeDetourPricing.
describe('search quote / settlement detour convergence', () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [SEARCH_ROW] });
    vi.mocked(axios.post).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('search detour_fee equals settlement detour pricing for identical routed legs', async () => {
    // Every routed leg returns the same fixed distance/duration, so search and
    // settlement see identical inputs.
    const LEG_DISTANCE_MILES = 6;
    const LEG_DURATION_SECONDS = 720; // 0.2 h
    vi.mocked(axios.post).mockResolvedValue({
      data: {
        distance_miles: LEG_DISTANCE_MILES,
        duration_seconds: LEG_DURATION_SECONDS,
        distance_meters: LEG_DISTANCE_MILES * 1609.34,
      },
    });

    const { searchTripsWithRerouting } = await import('../../services/trip-service/src/services/trip.service');
    const results = await searchTripsWithRerouting(
      37.7749, -122.4194,
      37.3352, -121.8811,
      new Date(),
    );

    // Settlement consumes the same shared function with the same leg inputs.
    const settlement = computeDetourPricing({
      legPickupDistMiles:   LEG_DISTANCE_MILES,
      legRideDistMiles:     LEG_DISTANCE_MILES,
      legRideDurationHours: LEG_DURATION_SECONDS / 3600,
      legResumeDistMiles:   LEG_DISTANCE_MILES,
      directDistanceMiles:  LEG_DISTANCE_MILES,
    });

    expect(results).toHaveLength(1);
    expect(results[0].cost_breakdown!.detour_fee).toBeCloseTo(
      parseFloat(settlement.detourCost.toFixed(2)), 2
    );
    expect(results[0].detour_miles).toBeCloseTo(
      parseFloat(settlement.detourMiles.toFixed(2)), 2
    );
    // Per-rider quote = rider's own ride leg + detour, same as settlement's per-rider amount.
    expect(results[0].estimated_cost).toBeCloseTo(
      parseFloat((settlement.riderBaseCost + settlement.detourCost).toFixed(2)), 2
    );
  });
});
