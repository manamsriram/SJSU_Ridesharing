import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getSecretValue } from '../utils/secrets';
import { JWTPayload } from '../types';
import { errorResponse } from '../utils/response';

const INTERNAL_TOKEN_HEADER = 'x-internal-token';
const INTERNAL_SERVICE_HEADER = 'x-internal-service';

/** Constant-time string compare; false on length mismatch (never throws). */
const safeEqual = (a: string, b: string): boolean => {
  // Buffer.from() uses UTF-8 encoding by default. This comparison is correct
  // for typical shared secrets (hex strings, base64, alphanumeric tokens).
  // Multi-byte UTF-8 characters (e.g. emoji) can produce different byte lengths
  // for strings of equal character length, causing a false length mismatch.
  // Keep INTERNAL_SERVICE_TOKEN to ASCII-safe characters.
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Authenticate a service-to-service call with a shared secret instead of a
 * spoofable identity header. The caller must present INTERNAL_SERVICE_TOKEN in
 * the x-internal-token header. The x-internal-service header is advisory only
 * (logging/routing) and is NOT trusted for authorization.
 *
 * Fail-closed in production: if the token is not configured the call is rejected
 * with 503. In non-production the call is allowed (with a warning) so local dev
 * and tests work without provisioning the secret.
 */
export const requireInternalService = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const expected = getSecretValue('INTERNAL_SERVICE_TOKEN');

  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      errorResponse(res, 'Internal service authentication not configured', 503);
      return;
    }
    console.warn(
      '[requireInternalService] INTERNAL_SERVICE_TOKEN not set — allowing internal call (non-production only)'
    );
    next();
    return;
  }

  const provided = req.headers[INTERNAL_TOKEN_HEADER];
  if (typeof provided !== 'string' || !safeEqual(provided, expected)) {
    errorResponse(res, 'Forbidden', 403);
    return;
  }

  next();
};

/**
 * Build headers for an outbound internal service-to-service request. Sets the
 * advisory service name and, when INTERNAL_SERVICE_TOKEN is configured, the
 * shared-secret token consumed by requireInternalService on the callee.
 *
 * @param serviceName Name of the calling service (advisory; e.g. 'trip-service')
 */
export const internalServiceHeaders = (serviceName: string): Record<string, string> => {
  const headers: Record<string, string> = { [INTERNAL_SERVICE_HEADER]: serviceName };
  const token = getSecretValue('INTERNAL_SERVICE_TOKEN');
  if (!token) {
    console.warn('[internalServiceHeaders] INTERNAL_SERVICE_TOKEN not set — outbound request will lack auth token');
  } else {
    headers[INTERNAL_TOKEN_HEADER] = token;
  }
  return headers;
};

/**
 * Extended Express Request interface with user data from JWT
 */
export interface AuthRequest extends Request {
  user?: {
    userId: string;
    email: string;
    role: 'Driver' | 'Rider';
    sjsuIdStatus?: 'pending' | 'verified' | 'rejected';
  };
}

/**
 * Middleware to authenticate JWT token
 * Verifies the token and attaches user data to the request object
 * @param req Express request object with AuthRequest extension
 * @param res Express response object
 * @param next Express next function
 */
export const authenticateToken = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    errorResponse(res, 'Access token required', 401);
    return;
  }

  try {
    const jwtSecret = getSecretValue('JWT_SECRET');
    if (!jwtSecret) {
      throw new Error('JWT_SECRET not configured');
    }

    const decoded = jwt.verify(token, jwtSecret) as JWTPayload;

    // Check if token is access token (not refresh token)
    if (decoded.type !== 'access') {
      errorResponse(res, 'Invalid token type. Access token required', 403);
      return;
    }

    // Attach user data to request
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      sjsuIdStatus: decoded.sjsuIdStatus,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      errorResponse(res, 'Token expired', 401);
      return;
    }

    if (error instanceof jwt.JsonWebTokenError) {
      errorResponse(res, 'Invalid token', 403);
      return;
    }

    errorResponse(res, 'Internal server error during authentication', 500);
  }
};

/**
 * Middleware to verify user has verified SJSU ID
 * Must be used after authenticateToken
 *
 * DEV BYPASS: In non-production environments, accounts whose email starts with
 * "sim-" or "devtools-" skip this check so simulation/devtools flows work
 * without real SJSU credentials.
 *
 * @param req Express request object with AuthRequest extension
 * @param res Express response object
 * @param next Express next function
 */
export const requireVerifiedStudent = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  // Dev-only bypass for simulation accounts (sim-* and devtools-* prefixes).
  // Never active in production.
  const isDevSimAccount =
    process.env.NODE_ENV !== 'production' &&
    (req.user.email.startsWith('sim-') || req.user.email.startsWith('devtools-'));

  if (isDevSimAccount) {
    next();
    return;
  }

  if (req.user.sjsuIdStatus !== 'verified') {
    errorResponse(
      res,
      'SJSU ID verification required to access this resource',
      403,
      { sjsuIdStatus: req.user.sjsuIdStatus || 'unverified' }
    );
    return;
  }

  next();
};

/**
 * Middleware to verify user is a driver
 * Must be used after authenticateToken
 * @param req Express request object with AuthRequest extension
 * @param res Express response object
 * @param next Express next function
 */
export const requireDriver = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  if (req.user.role !== 'Driver') {
    errorResponse(res, 'Driver role required to access this resource', 403);
    return;
  }

  next();
};
