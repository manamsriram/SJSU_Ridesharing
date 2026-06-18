// Types and enums
export * from './types';

// Middleware
export {
  authenticateToken,
  requireVerifiedStudent,
  requireDriver,
  requireInternalService,
  internalServiceHeaders,
} from './middleware/auth';
export type { AuthRequest } from './middleware/auth';
export { AppError, errorHandler, notFoundHandler, asyncHandler } from './middleware/errorHandler';
export { requestLogger, devLogger } from './middleware/logger';
export { corsMiddleware, devCorsMiddleware } from './middleware/cors';
export { validateRequest } from './middleware/validateRequest';

// Utilities
export { successResponse, errorResponse, paginatedResponse } from './utils/response';
export { getSecretValue } from './utils/secrets';
export { haversineMeters } from './utils/geo';
export {
  IRS_MILEAGE_RATE,
  DRIVER_HOURLY,
  DETOUR_SURCHARGE,
  computeDetourPricing,
} from './utils/detourPricing';
export type { DetourPricingArgs, DetourPricingResult } from './utils/detourPricing';
export {
  SJSU_COORDS,
  SJSU_RADIUS_METERS,
  inferTripDirection,
} from './utils/sjsuDirection';
export type { TripDirection } from './utils/sjsuDirection';
export {
  isValidEmail,
  isValidSJSUEmail,
  isValidUUID,
  validatePassword,
  isValidLatitude,
  isValidLongitude,
  isValidPhone,
  sanitizeString,
  isValidRating,
  isPositiveInteger,
  isFutureDate,
} from './utils/validation';

// Database
export { query, getClient, transaction, closePool } from './database/connection';
export { default as pool } from './database/connection';
