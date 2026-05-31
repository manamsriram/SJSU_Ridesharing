import * as grpc from '@grpc/grpc-js';
import { UserServiceService } from './generated/user';
import { userImpl } from './grpc/user.impl';

export function startGrpcServer(port: number): grpc.Server {
  const server = new grpc.Server();
  server.addService(UserServiceService, userImpl);
  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error('[user-service] Failed to start gRPC server:', err);
        throw err;
      }
      console.log(`[user-service] gRPC server listening on port ${boundPort}`);
    }
  );
  return server;
}
