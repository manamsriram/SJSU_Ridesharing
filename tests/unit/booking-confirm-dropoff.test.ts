import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock pg so the service's module-level `new Pool()` returns a controllable query fn.
const pgMocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: pgMocks.query, connect: vi.fn(), on: vi.fn(), end: vi.fn() })),
}));

const axiosMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: axiosMocks, ...axiosMocks }));

const loadService = async () => {
  vi.resetModules();
  process.env.DATABASE_URL = 'postgres://test';
  process.env.COST_SERVICE_URL = 'http://cost-test';
  return import('../../services/booking-service/src/services/booking.service');
};

const baseRow = {
  booking_id: 'bk-1',
  trip_id: 'trip-1',
  booking_state: 'approved',
  rider_pickup_confirmed_at: '2026-06-16T19:00:00Z',
  settled_at: null,
  driver_id: 'driver-1',
};

beforeEach(() => {
  pgMocks.query.mockReset();
  axiosMocks.get.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('booking-service > confirmRiderDropoff', () => {
  it('rejects with 404 when the booking does not exist', async () => {
    pgMocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const svc = await loadService();
    await expect(svc.confirmRiderDropoff('bk-x', 'driver-1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects with 403 when the caller is not the trip driver', async () => {
    pgMocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...baseRow, driver_id: 'someone-else' }] });
    const svc = await loadService();
    await expect(svc.confirmRiderDropoff('bk-1', 'driver-1')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects with 409 when pickup has not been confirmed', async () => {
    pgMocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...baseRow, rider_pickup_confirmed_at: null }] });
    const svc = await loadService();
    await expect(svc.confirmRiderDropoff('bk-1', 'driver-1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('is idempotent: an already-frozen booking returns without re-routing', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ...baseRow, settled_at: '2026-06-16T20:00:00Z' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ booking_id: 'bk-1', settled_amount: '4.19', settled_at: '2026-06-16T20:00:00Z' }] });

    const svc = await loadService();
    const result = await svc.confirmRiderDropoff('bk-1', 'driver-1') as any;

    expect(result.settled_amount).toBe('4.19');
    // No settle-rider call on the idempotent path.
    expect(axiosMocks.get).not.toHaveBeenCalled();
    // SELECT check + SELECT existing only — no UPDATE.
    expect(pgMocks.query).toHaveBeenCalledTimes(2);
  });

  it('freezes settled_amount from settle-rider without changing booking_state', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [baseRow] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ booking_id: 'bk-1', booking_state: 'approved', settled_amount: '4.19', settled_at: '2026-06-16T20:05:00Z' }],
      });
    axiosMocks.get.mockResolvedValueOnce({
      data: { data: { amount_paid: 4.19, settled_breakdown: { label: 'Ride leg: $3.35', detour_mi: 1 } } },
    });

    const svc = await loadService();
    const result = await svc.confirmRiderDropoff('bk-1', 'driver-1') as any;

    expect(axiosMocks.get).toHaveBeenCalledWith('http://cost-test/cost/settle-rider/trip-1/bk-1');
    // booking_state untouched (stays 'approved' so capturePayment still settles at trip end).
    expect(result.booking_state).toBe('approved');
    // UPDATE invoked with the frozen amount; no booking_state column set in the UPDATE.
    const updateCall = pgMocks.query.mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE bookings');
    expect(updateCall[0]).not.toContain('booking_state =');
    expect(updateCall[1]).toEqual(['bk-1', 4.19, JSON.stringify({ label: 'Ride leg: $3.35', detour_mi: 1 })]);
  });

  it('defers to batch settlement when settle-rider fails (settled_amount stays NULL)', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [baseRow] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ booking_id: 'bk-1', settled_amount: null, settled_at: null }] });
    axiosMocks.get.mockRejectedValueOnce(new Error('cost service down'));

    const svc = await loadService();
    const result = await svc.confirmRiderDropoff('bk-1', 'driver-1') as any;

    // UPDATE still runs (marks dropoff_confirmed_at) but settled_amount param is null.
    const updateCall = pgMocks.query.mock.calls[1];
    expect(updateCall[1]).toEqual(['bk-1', null, null]);
    expect(result.settled_at).toBeNull();
  });
});
