import * as grpc from '@grpc/grpc-js';
import type { NotificationServiceServer } from '../generated/notification';
import * as emailService from '../services/email.service';
import { createNotification, pushNotification } from '../store/notifications.store';

// ─── gRPC implementation ─────────────────────────────────────────────────────

export const notificationImpl: NotificationServiceServer = {
  sendNotification(call, callback) {
    try {
      const { userId, type, title, message, data } = call.request;

      if (!userId || !type || !title || !message) {
        callback({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'userId, type, title, and message are required',
        } as grpc.ServiceError);
        return;
      }

      const dataFields: Record<string, string> = data?.fields ?? {};

      const notification = createNotification({
        user_id: userId,
        type,
        title,
        message,
        data: Object.keys(dataFields).length > 0 ? dataFields : undefined,
      });
      pushNotification(notification);

      console.log(
        `[gRPC NOTIFICATION] type=${type} user=${userId} title="${title}"`,
      );

      callback(null, { success: true });
    } catch (err) {
      console.error('[gRPC NOTIFICATION] sendNotification error:', err);
      callback({
        code: grpc.status.INTERNAL,
        message: String(err),
      } as grpc.ServiceError);
    }
  },

  sendAdminAlert(call, callback) {
    const { message, level } = call.request;

    emailService
      .sendAdminAlert({ subject: `[${level ?? 'ALERT'}] Admin Alert`, message })
      .then(() => {
        console.log(`[gRPC NOTIFICATION] sendAdminAlert level=${level}`);
        callback(null, { success: true });
      })
      .catch((err: unknown) => {
        console.error('[gRPC NOTIFICATION] sendAdminAlert error:', err);
        callback({
          code: grpc.status.INTERNAL,
          message: String(err),
        } as grpc.ServiceError);
      });
  },

  sendDriverRequest(call, callback) {
    try {
      const { driverId, tripId, riderName, pickupAddress } = call.request;

      if (!driverId) {
        callback({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'driverId is required',
        } as grpc.ServiceError);
        return;
      }

      const notification = createNotification({
        user_id: driverId,
        type: 'incoming_ride_request',
        title: `Ride request from ${riderName || 'Rider'}`,
        message: pickupAddress || 'Pickup requested',
        data: {
          trip_id: tripId,
          rider_name: riderName,
          pickup_address: pickupAddress,
          expires_in_seconds: '15',
        },
      });
      pushNotification(notification);

      console.log(
        `[gRPC NOTIFICATION] sendDriverRequest driver=${driverId} trip=${tripId} rider="${riderName}"`,
      );

      callback(null, { success: true });
    } catch (err) {
      console.error('[gRPC NOTIFICATION] sendDriverRequest error:', err);
      callback({
        code: grpc.status.INTERNAL,
        message: String(err),
      } as grpc.ServiceError);
    }
  },
};
