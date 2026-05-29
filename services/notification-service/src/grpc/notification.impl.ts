import * as grpc from '@grpc/grpc-js';
import type { NotificationServiceServer } from '../../../../shared/generated/notification';
import * as emailService from '../services/email.service';

// ─── In-app notification store (mirrors app.ts) ──────────────────────────────
// The store lives in app.ts; since gRPC calls come in on a separate server
// we delegate to the same in-memory helpers by re-exporting them from app.ts.
// To avoid a circular dependency we replicate the minimal push logic here and
// keep the two stores independent (the existing HTTP endpoints are unaffected).

type InAppNotification = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, string>;
  created_at: string;
  read_at: string | null;
};

const notificationStore = new Map<string, InAppNotification[]>();

function createNotification(
  input: Omit<InAppNotification, 'id' | 'created_at' | 'read_at'>,
): InAppNotification {
  return {
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    created_at: new Date().toISOString(),
    read_at: null,
    ...input,
  };
}

function pushNotification(notification: InAppNotification): void {
  const current = notificationStore.get(notification.user_id) ?? [];
  current.unshift(notification);
  notificationStore.set(notification.user_id, current.slice(0, 200));
}

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
