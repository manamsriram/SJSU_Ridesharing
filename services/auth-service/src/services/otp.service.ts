import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { SafeUser } from '@lessgo/shared';
import { config } from '../config';

const pool = new Pool({ connectionString: config.databaseUrl });

const OTP_EXPIRY_MINUTES = 15;
const OTP_RESEND_COOLDOWN_SECONDS = 60;

function createTransporter() {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: false,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });
}

function isEmailConfigured(): boolean {
  return !!(config.smtpUser && config.smtpPass);
}

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtpEmail(email: string, otp: string): Promise<void> {
  if (!isEmailConfigured()) {
    console.log(`[OTP STUB] Code for ${email}: ${otp}`);
    return;
  }
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
      <h2 style="color:#4F46E5">LessGo 🚗</h2>
      <p>Your SJSU email verification code is:</p>
      <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#1C1C1E;margin:24px 0">${otp}</div>
      <p style="color:#8E8E93;font-size:13px">Expires in ${OTP_EXPIRY_MINUTES} minutes. Do not share this code.</p>
    </div>`;
  await createTransporter().sendMail({
    from: config.fromEmail,
    to: email,
    subject: 'Your LessGo verification code',
    html,
  });
}

/**
 * Generate a 6-digit OTP, store its hash, and email it to the user.
 * Deletes any prior unused OTPs for this user first.
 */
export async function generateAndSendOtp(userId: string, email: string): Promise<void> {
  // Check resend cooldown
  const cooldownCheck = await pool.query(
    `SELECT created_at FROM email_verifications
     WHERE user_id = $1 AND used_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (cooldownCheck.rows.length > 0) {
    const secondsSinceLast =
      (Date.now() - new Date(cooldownCheck.rows[0].created_at).getTime()) / 1000;
    if (secondsSinceLast < OTP_RESEND_COOLDOWN_SECONDS) {
      throw Object.assign(new Error('RESEND_TOO_SOON'), {
        secondsRemaining: Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - secondsSinceLast),
      });
    }
  }

  // Delete prior unused OTPs for this user
  await pool.query(
    `DELETE FROM email_verifications WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );

  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await pool.query(
    `INSERT INTO email_verifications (user_id, otp_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, otpHash, expiresAt]
  );

  await sendOtpEmail(email, otp);
}

/**
 * Verify an OTP for the given email.
 * On success: marks the OTP used and sets sjsu_id_status = 'verified'.
 * Returns the updated SafeUser.
 */
export async function verifyOtp(email: string, otp: string): Promise<SafeUser> {
  // Find the user
  const userResult = await pool.query(
    `SELECT user_id FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );
  if (userResult.rows.length === 0) {
    throw Object.assign(new Error('OTP_INVALID'), {});
  }
  const userId = userResult.rows[0].user_id;

  // Find the most recent unused, unexpired OTP
  const otpResult = await pool.query(
    `SELECT id, otp_hash FROM email_verifications
     WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (otpResult.rows.length === 0) {
    throw Object.assign(new Error('OTP_EXPIRED'), {});
  }

  const { id: otpId, otp_hash } = otpResult.rows[0];
  const isValid = await bcrypt.compare(otp, otp_hash);
  if (!isValid) {
    throw Object.assign(new Error('OTP_INVALID'), {});
  }

  // Mark OTP used and verify the user in a single transaction
  await pool.query('BEGIN');
  try {
    await pool.query(
      `UPDATE email_verifications SET used_at = now() WHERE id = $1`,
      [otpId]
    );
    const updatedUser = await pool.query(
      `UPDATE users SET sjsu_id_status = 'verified', updated_at = now()
       WHERE user_id = $1
       RETURNING user_id, name, email, role, sjsu_id_status, rating,
                 vehicle_info, seats_available, license_plate, earnings,
                 profile_picture_url, stripe_connect_account_id, created_at, updated_at`,
      [userId]
    );
    await pool.query('COMMIT');
    return updatedUser.rows[0] as SafeUser;
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }
}
