import * as grpc from '@grpc/grpc-js';
import type { TripServiceServer } from '../../../../shared/generated/trip';
import { getTripById } from '../services/trip.service';

export const tripImpl: TripServiceServer = {
  async getTrip(call, callback) {
    try {
      const trip = await getTripById(call.request.tripId);
      if (!trip) {
        callback({ code: grpc.status.NOT_FOUND, message: `Trip ${call.request.tripId} not found` });
        return;
      }
      callback(null, {
        tripId: trip.trip_id,
        driverId: trip.driver_id,
        status: trip.status,
        availableSeats: trip.seats_available,
        rawJson: JSON.stringify(trip),
      });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  },
};
