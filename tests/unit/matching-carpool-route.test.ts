import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { geocodeTripLocations } from '../../services/trip-service/src/utils/geocoding';

process.env.DATABASE_URL = 'postgres://carpool-route-test-db';
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

vi.mock('../../services/trip-service/src/utils/geocoding', () => ({
  geocodeTripLocations: vi.fn(),
}));

vi.mock('../../services/trip-service/src/utils/redisClient', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

describe('createTrip: route_line population', () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    vi.mocked(axios.post).mockReset();
    vi.mocked(geocodeTripLocations).mockReset().mockResolvedValue({
      originPoint: { lat: 37.7749, lng: -122.4194 },
      destinationPoint: { lat: 37.3352, lng: -121.8811 },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes the routing-service polyline as the INSERT route_line param', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { polyline: 'abc123encoded' } });
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // overlap check
      .mockResolvedValueOnce({ rows: [] }) // exact duplicate check
      .mockResolvedValueOnce({
        rows: [{
          trip_id: 'trip-1', driver_id: 'driver-1', origin: 'SF', destination: 'SJSU',
          origin_lng: -122.4194, origin_lat: 37.7749,
          destination_lng: -121.8811, destination_lat: 37.3352,
          departure_time: new Date(), seats_available: 3, recurrence: null,
          status: 'pending', direction: 'TO_SJSU', created_at: new Date(), updated_at: new Date(),
        }],
      }); // insert

    const { createTrip } = await import('../../services/trip-service/src/services/trip.service');

    await createTrip('driver-1', {
      origin: 'SF',
      destination: 'SJSU',
      departure_time: new Date().toISOString(),
      seats_available: 3,
    } as any);

    const insertCall = queryMock.mock.calls[2];
    expect(insertCall[1][insertCall[1].length - 1]).toBe('abc123encoded');
  });

  it('falls back to a NULL route_line when routing-service fails after retry', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('routing-service unreachable'));
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          trip_id: 'trip-2', driver_id: 'driver-1', origin: 'SF', destination: 'SJSU',
          origin_lng: -122.4194, origin_lat: 37.7749,
          destination_lng: -121.8811, destination_lat: 37.3352,
          departure_time: new Date(), seats_available: 3, recurrence: null,
          status: 'pending', direction: 'TO_SJSU', created_at: new Date(), updated_at: new Date(),
        }],
      });

    const { createTrip } = await import('../../services/trip-service/src/services/trip.service');

    await createTrip('driver-1', {
      origin: 'SF',
      destination: 'SJSU',
      departure_time: new Date().toISOString(),
      seats_available: 3,
    } as any);

    expect(axios.post).toHaveBeenCalledTimes(2); // one retry
    const insertCall = queryMock.mock.calls[2];
    expect(insertCall[1][insertCall[1].length - 1]).toBeNull();
  });
});

describe('fetchCandidates: carpool route_line matching', () => {
  it('carpool query checks route_line first, falls back to the ST_MakeLine chord when NULL', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../services/trip-service/src/services/matching.service.ts'),
      'utf8'
    );
    expect(src).toContain('t.route_line IS NOT NULL AND ST_DWithin(t.route_line');
    expect(src).toContain('t.route_line IS NULL AND ST_DWithin(');
    expect(src).toContain('ST_MakeLine(t.origin_point::geometry, t.destination_point::geometry)');
  });
});
