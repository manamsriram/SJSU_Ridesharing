import express, { Application } from 'express';
import cors from 'cors';
import { calculateCost, settleTrip } from './cost.service';

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
app.get('/cost/settle/:trip_id', async (req, res) => {
  const { trip_id } = req.params;
  try {
    const result = await settleTrip(trip_id);
    res.json({ status: 'success', message: 'Settlement calculated successfully (IRS mileage rate)', data: result });
  } catch (error: any) {
    if (error?.status === 404 || error?.response?.status === 404) {
      res.status(404).json({ status: 'error', message: error.message ?? `Trip ${trip_id} not found` });
      return;
    }
    console.error(`[settle] Error for trip ${trip_id}:`, error?.message ?? error);
    res.status(500).json({ status: 'error', message: `Failed to calculate trip settlement: ${error?.message ?? 'Unknown error'}` });
  }
});

export default app;
