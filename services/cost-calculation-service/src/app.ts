import express, { Application, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { AppError, errorHandler } from '@lessgo/shared';
import { calculateCost, settleTrip, settleRider, freezeTripSettlement } from './cost.service';

const app: Application = express();
app.use(express.json());
app.use(cors());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'success',
    message: 'Cost Calculation Service is running',
    service: 'cost-calculation-service',
    timestamp: new Date().toISOString(),
  });
});

// ── POST /cost/calculate ──────────────────────────────────────────────────────
app.post('/cost/calculate', async (req, res) => {
  try {
    const { origin, destination, num_riders } = req.body;
    if (!origin || !destination || !num_riders) {
      res.status(400).json({ status: 'error', message: 'origin, destination, and num_riders are required' });
      return;
    }
    const result = await calculateCost(origin, destination, num_riders);
    res.json({ status: 'success', message: 'Cost calculated successfully', data: result });
  } catch (error) {
    console.error('Cost calculation error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to calculate cost' });
  }
});

// ── GET /cost/settle/:trip_id ─────────────────────────────────────────────────
app.get('/cost/settle/:trip_id', async (req: Request, res: Response, next: NextFunction) => {
  const { trip_id } = req.params;
  try {
    const result = await settleTrip(trip_id);
    res.json({ status: 'success', message: 'Settlement calculated successfully (IRS mileage rate)', data: result });
  } catch (error: any) {
    if (error?.status === 404 || error?.response?.status === 404) {
      return next(new AppError(error.message ?? `Trip ${trip_id} not found`, 404));
    }
    console.error('[settle] Error for trip %s:', trip_id, error?.message ?? error);
    res.status(500).json({ status: 'error', message: `Failed to calculate trip settlement: ${error?.message ?? 'Unknown error'}` });
  }
});

// ── GET /cost/settle-rider/:trip_id/:booking_id ───────────────────────────────
// Per-rider drop-off freeze: routes only this rider's legs (3-4 calls) so the
// booking-service can freeze the result on the booking row at drop-off time.
app.get('/cost/settle-rider/:trip_id/:booking_id', async (req: Request, res: Response, next: NextFunction) => {
  const { trip_id, booking_id } = req.params;
  try {
    const result = await settleRider(trip_id, booking_id);
    res.json({ status: 'success', message: 'Rider settlement calculated successfully', data: result });
  } catch (error: any) {
    if (error?.status === 404 || error?.response?.status === 404) {
      return next(new AppError(error.message ?? `Trip ${trip_id} / booking ${booking_id} not found`, 404));
    }
    console.error('[settle-rider] Error for trip %s booking %s:', trip_id, booking_id, error?.message ?? error);
    return next(new AppError('Failed to calculate rider settlement', 500));
  }
});

// ── GET /cost/freeze/:trip_id ─────────────────────────────────────────────────
// T-1h multi-rider discount freeze: computes the optimized multi-stop route once
// and returns each rider's discounted settlement for the booking-service to persist.
// Returns 502 (defer, do not freeze) when the optimized route is unavailable.
app.get('/cost/freeze/:trip_id', async (req: Request, res: Response, next: NextFunction) => {
  const { trip_id } = req.params;
  try {
    const result = await freezeTripSettlement(trip_id);
    res.json({ status: 'success', message: 'Discount freeze calculated successfully', data: result });
  } catch (error: any) {
    if (error?.status === 404 || error?.response?.status === 404) {
      return next(new AppError(error.message ?? `Trip ${trip_id} not found`, 404));
    }
    if (error?.status === 502) {
      // Optimized route unavailable — caller must defer and retry, never freeze undiscounted.
      return next(new AppError('Optimized route unavailable; retry later', 502));
    }
    console.error('[freeze] Error for trip %s:', trip_id, error?.message ?? error);
    return next(new AppError('Failed to freeze trip settlement', 500));
  }
});

app.use(errorHandler);

export default app;
