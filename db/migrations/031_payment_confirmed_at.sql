-- Add payment_confirmed_at to bookings to track when Stripe actually confirmed the hold
-- (requires_capture state). Distinct from payment_authorized_at which is set when the
-- PaymentIntent is first created (requires_payment_method — no funds held yet).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;
