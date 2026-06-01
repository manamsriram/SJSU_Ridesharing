import dotenv from 'dotenv';
import { getSecretValue } from '@lessgo/shared';

dotenv.config();

export const config = {
  port: process.env.BOOKING_SERVICE_PORT || 3004,
  grpcPort: parseInt(process.env.GRPC_PORT ?? '4004', 10),
  env: process.env.NODE_ENV || 'development',

  // Database
  databaseUrl: getSecretValue('DATABASE_URL'),

  // JWT
  jwtSecret: getSecretValue('JWT_SECRET', 'default-secret-change-in-production'),

  // Service URLs
  tripServiceUrl: process.env.TRIP_SERVICE_URL || 'http://127.0.0.1:3003',
  paymentServiceUrl: process.env.PAYMENT_SERVICE_URL || 'http://127.0.0.1:3005',
  costServiceUrl: process.env.COST_SERVICE_URL || 'http://127.0.0.1:3009',
  notificationServiceUrl: process.env.NOTIFICATION_SERVICE_URL || 'http://127.0.0.1:3006',

  costGrpcHost:         process.env.COST_GRPC_HOST         || '127.0.0.1:4009',
  paymentGrpcHost:      process.env.PAYMENT_GRPC_HOST      || '127.0.0.1:4005',
  notificationGrpcHost: process.env.NOTIFICATION_GRPC_HOST || '127.0.0.1:4006',
  tripGrpcHost:         process.env.TRIP_GRPC_HOST         || '127.0.0.1:4003',
};

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}
