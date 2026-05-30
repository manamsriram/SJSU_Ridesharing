import * as grpc from '@grpc/grpc-js';
import { NotificationServiceService } from './generated/notification';
import { notificationImpl } from './grpc/notification.impl';

export function startGrpcServer(port: number): grpc.Server {
  const server = new grpc.Server();
  server.addService(NotificationServiceService, notificationImpl);
  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error('[notification-service] Failed to start gRPC server:', err);
        throw err;
      }
      console.log(`[notification-service] gRPC server listening on port ${boundPort}`);
    },
  );
  return server;
}
