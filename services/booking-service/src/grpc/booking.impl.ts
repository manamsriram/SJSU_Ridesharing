import * as grpc from '@grpc/grpc-js';
import type { BookingServiceServer } from '../../../../shared/generated/booking';
import {
  getBookingsByTripId,
  writeFinalPrice,
  createBooking,
} from '../services/booking.service';

export const bookingImpl: BookingServiceServer = {
  async getBookingsForSettlement(call, callback) {
    try {
      const { bookings } = await getBookingsByTripId(call.request.tripId);
      callback(null, {
        bookings: bookings.map((b: any) => ({
          bookingId: b.id,
          riderId: b.rider_id,
          paymentId: b.payment_intent_id ?? '',
          amount: b.fare ?? 0,
        })),
      });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  },

  async updateFinalPrice(call, callback) {
    try {
      await writeFinalPrice(call.request.bookingId, call.request.finalPrice);
      callback(null, { success: true });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  },

  async createInternalBooking(call, callback) {
    try {
      const { tripId, riderId, seatsBooked, scostBreakdownJson, pickupLocation } = call.request;
      const bookingData: any = {
        trip_id: tripId,
        seats_booked: seatsBooked,
        scost_breakdown: scostBreakdownJson ? JSON.parse(scostBreakdownJson) : undefined,
        pickup_location: pickupLocation
          ? { lat: pickupLocation.lat, lng: pickupLocation.lng }
          : undefined,
      };
      const { booking } = await createBooking(riderId, bookingData);
      callback(null, { bookingId: booking.booking_id });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  },

  async getTripBookings(call, callback) {
    try {
      const { bookings } = await getBookingsByTripId(call.request.tripId);
      callback(null, {
        bookings: bookings.map((b: any) => ({
          bookingId: b.id,
          riderId: b.rider_id,
          status: b.status ?? '',
          seatsBooked: b.seats_booked ?? 1,
        })),
      });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  },
};
