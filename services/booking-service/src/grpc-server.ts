import * as grpc from '@grpc/grpc-js';
import { BookingServiceService } from './generated/booking';
import { bookingImpl } from './grpc/booking.impl';

export function startGrpcServer(port: number): grpc.Server {
  const server = new grpc.Server();
  server.addService(BookingServiceService, bookingImpl);
  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error('[booking-service] Failed to start gRPC server:', err);
        throw err;
      }
      console.log(`[booking-service] gRPC server listening on port ${boundPort}`);
    },
  );
  return server;
}
