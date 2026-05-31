import * as grpc from '@grpc/grpc-js';
import { TripServiceService } from './generated/trip';
import { tripImpl } from './grpc/trip.impl';

export function startGrpcServer(port: number): grpc.Server {
  const server = new grpc.Server();
  server.addService(TripServiceService, tripImpl);
  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error('[trip-service] Failed to start gRPC server:', err);
        throw err;
      }
      console.log(`[trip-service] gRPC server listening on port ${boundPort}`);
    },
  );
  return server;
}
