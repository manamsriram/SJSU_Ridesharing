import * as grpc from '@grpc/grpc-js';
import { CostServiceService } from './generated/cost';
import { costImpl } from './grpc/cost.impl';

export function startGrpcServer(port: number): grpc.Server {
  const server = new grpc.Server();
  server.addService(CostServiceService, costImpl);
  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error('[cost-calculation-service] Failed to start gRPC server:', err);
        throw err;
      }
      console.log(`[cost-calculation-service] gRPC server listening on port ${boundPort}`);
    },
  );
  return server;
}
