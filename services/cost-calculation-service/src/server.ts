import app from './app';
import { startGrpcServer } from './grpc-server';

const PORT = process.env.COST_SERVICE_PORT || 3009;
const GRPC_PORT = parseInt(process.env.GRPC_PORT ?? '4009', 10);

const server = app.listen(PORT, () => {
  console.log(`
  ========================================
  Cost Calculation Service is running
  ========================================
  Port: ${PORT}
  URL: http://localhost:${PORT}
  Health Check: http://localhost:${PORT}/health
  ========================================
  `);
});

startGrpcServer(GRPC_PORT);

process.on('SIGTERM', () => {
  console.log('SIGTERM received: closing server');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('SIGINT received: closing server');
  server.close(() => process.exit(0));
});

export default server;
