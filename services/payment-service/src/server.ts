import app from './app';
import { config } from './config';
import { startGrpcServer } from './grpc-server';

const server = app.listen(config.port, () => {
  console.log(`💳 Payment Service running on port ${config.port}`);
});

startGrpcServer(config.grpcPort);

process.on('SIGTERM', () => server.close(() => process.exit(0)));
export default server;
