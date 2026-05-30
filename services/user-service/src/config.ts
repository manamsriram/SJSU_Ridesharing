import dotenv from 'dotenv';
import { getSecretValue } from '@lessgo/shared';

if (process.env.NODE_ENV !== 'test') dotenv.config();

export const config = {
  port: process.env.USER_SERVICE_PORT || 3002,
  grpcPort: parseInt(process.env.GRPC_PORT ?? '4002', 10),
  env: process.env.NODE_ENV || 'development',

  // Database
  databaseUrl: getSecretValue('DATABASE_URL'),

  // JWT (for authentication middleware)
  jwtSecret: getSecretValue('JWT_SECRET', 'default-secret-change-in-production'),
};

// Validate required config
if (!config.databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}
