-- Create email_verifications table for SJSU email OTP verification
-- OTP codes are bcrypt-hashed before storage.
-- Verifying a correct OTP sets sjsu_id_status = 'verified' on the user.

CREATE TABLE IF NOT EXISTS email_verifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  otp_hash    VARCHAR(60) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_lookup
  ON email_verifications (user_id, used_at, expires_at);

COMMENT ON TABLE email_verifications IS 'Stores bcrypt-hashed OTP codes for SJSU email verification';
