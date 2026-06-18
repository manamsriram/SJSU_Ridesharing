import app from './app';
import { config } from './config';
import { startSettlementRetryJob } from './services/settlement.retry';
import { startDiscountFreezeJob } from './services/discount-freeze.job';

const PORT = config.port;

/**
 * Start the Trip Service server
 */
const server = app.listen(PORT, () => {
  console.log(`
  ========================================
  🚗 Trip Service is running
  ========================================
  Environment: ${config.env}
  Port: ${PORT}
  URL: http://localhost:${PORT}
  Health Check: http://localhost:${PORT}/health
  PostGIS Enabled: Yes
  Google Maps API: ${config.googleMapsApiKey ? 'Configured' : 'Not Configured'}
  ========================================
  `);
  startSettlementRetryJob();
  startDiscountFreezeJob();
});

/**
 * Graceful shutdown
 */
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  server.close(() => {
    process.exit(1);
  });
});

export default server;
