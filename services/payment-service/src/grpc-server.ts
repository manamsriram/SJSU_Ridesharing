import * as grpc from '@grpc/grpc-js';
import { PaymentServiceService } from './generated/payment';
import { paymentImpl } from './grpc/payment.impl';

export function startGrpcServer(port: number): grpc.Server {
  const server = new grpc.Server();
  server.addService(PaymentServiceService, paymentImpl);
  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error('[payment-service] Failed to start gRPC server:', err);
        throw err;
      }
      console.log(`[payment-service] gRPC server listening on port ${boundPort}`);
    },
  );
  return server;
}
