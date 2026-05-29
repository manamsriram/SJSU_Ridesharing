import * as grpc from '@grpc/grpc-js';
import type { PaymentServiceServer } from '../../../../shared/generated/payment';
import {
  createPaymentIntent,
  capturePayment,
  cancelPayment,
  refundPayment,
  cancelPaymentIntentsByTripId,
} from '../services/payment.service';

export const paymentImpl: PaymentServiceServer = {
  async createPaymentIntent(call, callback) {
    try {
      const payment = await createPaymentIntent(
        call.request.bookingId,
        call.request.amount,
      );
      callback(null, {
        paymentId: payment.payment_id,
        clientSecret: payment.client_secret ?? '',
      });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  },

  async capturePayment(call, callback) {
    try {
      await capturePayment(call.request.paymentId);
      callback(null, { success: true });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  },

  async cancelPayment(call, callback) {
    try {
      await cancelPayment(call.request.paymentId);
      callback(null, { success: true });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  },

  async refundPayment(call, callback) {
    try {
      await refundPayment(call.request.paymentId);
      callback(null, { success: true });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  },

  async cancelTripIntents(call, callback) {
    try {
      const { cancelled } = await cancelPaymentIntentsByTripId(call.request.tripId);
      callback(null, { success: true, cancelledCount: cancelled });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  },
};
