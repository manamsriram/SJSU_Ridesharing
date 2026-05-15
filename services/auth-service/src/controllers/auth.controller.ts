import { Request, Response } from 'express';
import * as authService from '../services/auth.service';
import * as jwtService from '../services/jwt.service';
import * as otpService from '../services/otp.service';
import { RegisterRequest, LoginRequest, AuthResponse, AppError, successResponse, errorResponse, SJSUIdStatus } from '@lessgo/shared';

/**
 * Register a new user
 * POST /auth/register
 */
export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const userData: RegisterRequest = req.body;
    const sjsuIdImagePath = req.file ? req.file.path : undefined;
    const user = await authService.createUser(userData, sjsuIdImagePath);

    // Send OTP — do not issue tokens until email is verified
    await otpService.generateAndSendOtp(user.user_id, user.email);

    successResponse(res, { user_id: user.user_id }, 'Verification code sent to your SJSU email', 201);
  } catch (error) {
    console.error('Registration error:', error);
    if (error instanceof Error && error.message === 'An account with this email already exists') {
      errorResponse(res, 'An account with this email already exists', 400);
      return;
    }
    if (error instanceof Error && error.message === 'Only @sjsu.edu email addresses are allowed') {
      errorResponse(res, 'Only @sjsu.edu email addresses are allowed', 400);
      return;
    }
    if (error instanceof AppError) throw error;
    throw new AppError('Registration failed', 500);
  }
};

/**
 * Login user
 * POST /auth/login
 */
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password }: LoginRequest = req.body;

    // Validate credentials
    const user = await authService.validateCredentials(email, password);

    if (!user) {
      errorResponse(res, 'Invalid email or password', 401);
      return;
    }

    // Generate tokens
    const { accessToken, refreshToken } = jwtService.generateTokenPair(
      user.user_id,
      user.email,
      user.role,
      user.sjsu_id_status
    );

    const response: AuthResponse = {
      user,
      accessToken,
      refreshToken,
    };

    successResponse(res, response, 'Login successful');
  } catch (error) {
    console.error('Login error:', error);
    if (error instanceof Error && error.message === 'EMAIL_NOT_VERIFIED') {
      errorResponse(res, 'Please verify your SJSU email before logging in', 403);
      return;
    }
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Login failed', 500);
  }
};

/**
 * Refresh access token
 * POST /auth/refresh
 */
export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body;

    // Verify refresh token
    const decoded = jwtService.verifyToken(refreshToken);

    if (decoded.type !== 'refresh') {
      errorResponse(res, 'Invalid token type', 403);
      return;
    }

    // Get user from database
    const user = await authService.findUserById(decoded.userId);

    if (!user) {
      errorResponse(res, 'User not found', 404);
      return;
    }

    // Generate new access token
    const newAccessToken = jwtService.generateAccessToken(
      user.user_id,
      user.email,
      user.role,
      user.sjsu_id_status
    );

    successResponse(
      res,
      { accessToken: newAccessToken },
      'Access token refreshed successfully'
    );
  } catch (error) {
    console.error('Refresh token error:', error);
    if (error instanceof Error && error.name === 'TokenExpiredError') {
      errorResponse(res, 'Refresh token expired. Please login again', 401);
      return;
    }
    if (error instanceof Error && error.name === 'JsonWebTokenError') {
      errorResponse(res, 'Invalid refresh token', 403);
      return;
    }
    throw new AppError('Token refresh failed', 500);
  }
};

/**
 * Verify token validity
 * GET /auth/verify
 */
export const verifyTokenEndpoint = async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      errorResponse(res, 'Token required', 401);
      return;
    }

    // Verify token
    const decoded = jwtService.verifyToken(token);

    // Get user from database
    const user = await authService.findUserById(decoded.userId);

    if (!user) {
      errorResponse(res, 'User not found', 404);
      return;
    }

    const safeUser = authService.toSafeUser(user);

    successResponse(res, { valid: true, user: safeUser }, 'Token is valid');
  } catch (error) {
    if (error instanceof Error && error.name === 'TokenExpiredError') {
      errorResponse(res, 'Token expired', 401);
      return;
    }
    if (error instanceof Error && error.name === 'JsonWebTokenError') {
      errorResponse(res, 'Invalid token', 403);
      return;
    }
    throw new AppError('Token verification failed', 500);
  }
};

/**
 * Logout user (client-side token deletion)
 * POST /auth/logout
 */
export const logout = async (req: Request, res: Response): Promise<void> => {
  // In a stateless JWT system, logout is typically handled client-side
  // by deleting the tokens. This endpoint is mainly for completeness.
  // For a more robust solution, implement token blacklisting with Redis.

  successResponse(
    res,
    null,
    'Logout successful. Please delete your tokens on the client side.'
  );
};

/**
 * Get current user (from token)
 * GET /auth/me
 */
export const getCurrentUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      errorResponse(res, 'Token required', 401);
      return;
    }

    const decoded = jwtService.verifyToken(token);
    const user = await authService.findUserById(decoded.userId);

    if (!user) {
      errorResponse(res, 'User not found', 404);
      return;
    }

    const safeUser = authService.toSafeUser(user);
    successResponse(res, safeUser, 'User retrieved successfully');
  } catch (error) {
    if (error instanceof Error && error.name === 'TokenExpiredError') {
      errorResponse(res, 'Token expired', 401);
      return;
    }
    if (error instanceof Error && error.name === 'JsonWebTokenError') {
      errorResponse(res, 'Invalid token', 403);
      return;
    }
    throw new AppError('Failed to get current user', 500);
  }
};

/**
 * Submit SJSU ID image for verification
 * POST /auth/verify-id
 * Accepts multipart/form-data with field "sjsuId"
 */
export const submitSJSUId = async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      errorResponse(res, 'Token required', 401);
      return;
    }

    const decoded = jwtService.verifyToken(token);
    const userId = decoded.userId;

    if (!req.file) {
      errorResponse(res, 'SJSU ID image is required', 400);
      return;
    }

    const updatedUser = await authService.submitSJSUIdImage(userId, req.file.path);
    successResponse(res, updatedUser, 'SJSU ID submitted for verification');
  } catch (error) {
    console.error('Verify ID error:', error);
    if (error instanceof Error && error.name === 'TokenExpiredError') {
      errorResponse(res, 'Token expired', 401);
      return;
    }
    if (error instanceof Error && error.name === 'JsonWebTokenError') {
      errorResponse(res, 'Invalid token', 403);
      return;
    }
    throw new AppError('Failed to submit SJSU ID', 500);
  }
};

/**
 * Change user's password
 * PUT /auth/change-password
 */
export const changePassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) { errorResponse(res, 'Token required', 401); return; }

    const decoded = jwtService.verifyToken(token);
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      errorResponse(res, 'currentPassword and newPassword are required', 400);
      return;
    }
    if (newPassword.length < 8) {
      errorResponse(res, 'New password must be at least 8 characters', 400);
      return;
    }

    await authService.changePassword(decoded.userId, currentPassword, newPassword);
    successResponse(res, null, 'Password changed successfully');
  } catch (error) {
    if (error instanceof Error && error.message === 'Current password is incorrect') {
      errorResponse(res, 'Current password is incorrect', 400);
      return;
    }
    if (error instanceof Error && error.name === 'TokenExpiredError') {
      errorResponse(res, 'Token expired', 401);
      return;
    }
    throw new AppError('Failed to change password', 500);
  }
};

/**
 * Test-only: Verify a user's SJSU ID status
 * POST /auth/test/verify/:userId
 * Only available in development mode
 */
export const testVerifyUser = async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;

  const user = await authService.findUserById(userId);
  if (!user) {
    errorResponse(res, 'User not found', 404);
    return;
  }

  const updatedUser = await authService.updateSJSUIdStatus(userId, SJSUIdStatus.Verified);
  successResponse(res, updatedUser, 'User SJSU ID verified (test only)');
};

/**
 * Verify SJSU email with OTP
 * POST /auth/verify-email
 */
export const verifyEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      errorResponse(res, 'email and otp are required', 400);
      return;
    }

    const user = await otpService.verifyOtp(email, otp);

    const { accessToken, refreshToken } = jwtService.generateTokenPair(
      user.user_id,
      user.email,
      user.role,
      user.sjsu_id_status
    );

    const response: AuthResponse = { user, accessToken, refreshToken };
    successResponse(res, response, 'Email verified successfully');
  } catch (error) {
    if (error instanceof Error && error.message === 'OTP_EXPIRED') {
      errorResponse(res, 'Verification code has expired. Please request a new one.', 403);
      return;
    }
    if (error instanceof Error && error.message === 'OTP_INVALID') {
      errorResponse(res, 'Invalid verification code', 403);
      return;
    }
    throw new AppError('Email verification failed', 500);
  }
};

/**
 * Resend OTP to user's SJSU email
 * POST /auth/resend-otp
 */
export const resendOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    if (!email) {
      errorResponse(res, 'email is required', 400);
      return;
    }

    const user = await authService.findUserByEmail(email);
    if (!user) {
      // Don't reveal whether the email exists
      successResponse(res, null, 'If that email is registered, a new code has been sent');
      return;
    }

    if (user.sjsu_id_status === SJSUIdStatus.Verified) {
      errorResponse(res, 'This account is already verified', 400);
      return;
    }

    await otpService.generateAndSendOtp(user.user_id, user.email);
    successResponse(res, null, 'Verification code resent');
  } catch (error) {
    if (error instanceof Error && error.message === 'RESEND_TOO_SOON') {
      const secondsRemaining = (error as any).secondsRemaining ?? 60;
      errorResponse(res, `Please wait ${secondsRemaining}s before requesting another code`, 429);
      return;
    }
    throw new AppError('Failed to resend verification code', 500);
  }
};
