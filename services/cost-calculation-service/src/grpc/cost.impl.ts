import * as grpc from '@grpc/grpc-js';
import type { CostServiceServer } from '../generated/cost';
import { calculateCost, settleTrip } from '../cost.service';

export const costImpl: CostServiceServer = {
  async calculateCost(call, callback) {
    try {
      const { origin, destination, numRiders } = call.request;
      const originStr = origin ? `${origin.lat},${origin.lng}` : '';
      const destStr   = destination ? `${destination.lat},${destination.lng}` : '';
      const result = await calculateCost(originStr, destStr, numRiders);
      callback(null, {
        maxPrice: result.max_price,
        breakdown: {
          basePrice:     result.breakdown.irs_mileage_rate,
          distanceMiles: result.breakdown.distance_miles,
          pricePerMile:  result.breakdown.irs_mileage_rate,
          totalTripCost: result.breakdown.total_trip_cost,
          pricePerRider: result.breakdown.price_per_rider,
        },
      });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  },

  async settleTrip(call, callback) {
    try {
      const result = await settleTrip(call.request.tripId);
      callback(null, {
        tripId:         result.trip_id,
        totalCost:      result.total_cost,
        driverEarnings: result.driver_earnings,
        riders: result.riders.map((r) => ({
          riderId:   r.rider_id,
          bookingId: '',
          amount:    r.amount_paid,
        })),
      });
    } catch (err: any) {
      const code = err?.status === 404 ? grpc.status.NOT_FOUND : grpc.status.INTERNAL;
      callback({ code, message: String(err) });
    }
  },
};
