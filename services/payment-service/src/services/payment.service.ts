import { Pool } from 'pg';
import Stripe from 'stripe';
import { config } from '../config';
import { Payment, PaymentStatus } from '@lessgo/shared';

const pool = new Pool({ connectionString: config.databaseUrl });
const stripe = new Stripe(config.stripeSecretKey!);

/**
 * Create Stripe Payment Intent
 * Uses manual capture so the iOS app can confirm, then we capture server-side.
 */
export const createPaymentIntent = async (
  bookingId: string,
  amount: number
): Promise<Payment & { client_secret: string | null }> => {
  // Check if payment already exists for booking
  const existing = await pool.query('SELECT * FROM payments WHERE booking_id = $1', [bookingId]);
  if (existing.rows.length > 0) {
    const existingPayment = existing.rows[0];
    console.error(`[PAYMENT] Payment already exists for booking ${bookingId}: payment_id=${existingPayment.payment_id}, status=${existingPayment.status}`);
    throw new Error('Payment already exists for this booking');
  }

  console.log(`[PAYMENT] Creating Stripe PaymentIntent for booking ${bookingId}, amount: $${amount}`);

  // Create Stripe Payment Intent
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100), // Convert to cents
    currency: 'usd',
    capture_method: 'manual',
    metadata: { booking_id: bookingId },
  });

  console.log(`[PAYMENT] Stripe PaymentIntent created: ${paymentIntent.id}`);

  // Store payment record
  const query = `
    INSERT INTO payments (booking_id, stripe_payment_intent_id, amount, status)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `;
  const result = await pool.query(query, [
    bookingId,
    paymentIntent.id,
    amount,
    PaymentStatus.Pending,
  ]);

  console.log(`[PAYMENT] Payment record created: payment_id=${result.rows[0].payment_id}`);

  return { ...result.rows[0], client_secret: paymentIntent.client_secret };
};

/**
 * Capture payment
 * In production: the iOS app confirms the PaymentIntent first, then this captures it.
 * In test mode: capture/refund require manual confirmation which isn't available server-side.
 */
export const capturePayment = async (paymentId: string): Promise<Payment> => {
  const payment = await pool.query('SELECT * FROM payments WHERE payment_id = $1', [paymentId]);
  if (payment.rows.length === 0) throw new Error('Payment not found');

  const paymentData = payment.rows[0];

  if (paymentData.status === PaymentStatus.Captured) {
    return paymentData;
  }

  const stripeIntentId = paymentData.stripe_payment_intent_id;
  const paymentIntent = await stripe.paymentIntents.retrieve(stripeIntentId);

  if (paymentIntent.status === 'requires_capture') {
    await stripe.paymentIntents.capture(stripeIntentId);
  } else if (paymentIntent.status === 'succeeded') {
    // Already captured on Stripe side
  } else {
    throw new Error(`Cannot capture payment in state: ${paymentIntent.status}. Client must confirm the PaymentIntent first.`);
  }

  // Update status
  const updateQuery = `
    UPDATE payments SET status = $1, updated_at = current_timestamp
    WHERE payment_id = $2 RETURNING *
  `;
  const result = await pool.query(updateQuery, [PaymentStatus.Captured, paymentId]);

  // Update driver earnings after successful capture
  try {
    const bookingQuery = `
      SELECT b.*, t.driver_id
      FROM bookings b
      JOIN trips t ON b.trip_id = t.trip_id
      WHERE b.booking_id = $1
    `;
    const bookingResult = await pool.query(bookingQuery, [paymentData.booking_id]);

    if (bookingResult.rows.length > 0) {
      const driverId = bookingResult.rows[0].driver_id;
      const amount = paymentData.amount;

      await pool.query(
        `UPDATE users SET earnings = earnings + $1, updated_at = current_timestamp WHERE user_id = $2`,
        [amount, driverId]
      );

      console.log(`✅ Updated driver ${driverId} earnings by $${amount}`);
    }
  } catch (error) {
    console.error('❌ Failed to update driver earnings:', error);
    // Don't throw - payment capture succeeded even if earnings update failed
  }

  return result.rows[0];
};

/**
 * Refund payment
 */
export const refundPayment = async (paymentId: string): Promise<Payment> => {
  const payment = await pool.query('SELECT * FROM payments WHERE payment_id = $1', [paymentId]);
  if (payment.rows.length === 0) throw new Error('Payment not found');

  const paymentData = payment.rows[0];

  if (paymentData.status !== PaymentStatus.Captured) {
    throw new Error('Can only refund captured payments');
  }

  // Create refund with Stripe
  await stripe.refunds.create({ payment_intent: paymentData.stripe_payment_intent_id });

  // Update status
  const updateQuery = `
    UPDATE payments SET status = $1, updated_at = current_timestamp
    WHERE payment_id = $2 RETURNING *
  `;
  const result = await pool.query(updateQuery, [PaymentStatus.Refunded, paymentId]);

  // Reverse driver earnings credited on capture
  try {
    const bookingQuery = `
      SELECT t.driver_id
      FROM bookings b
      JOIN trips t ON b.trip_id = t.trip_id
      WHERE b.booking_id = $1
    `;
    const bookingResult = await pool.query(bookingQuery, [paymentData.booking_id]);

    if (bookingResult.rows.length > 0) {
      const driverId = bookingResult.rows[0].driver_id;
      const amount = paymentData.amount;

      await pool.query(
        `UPDATE users
         SET earnings = GREATEST(COALESCE(earnings, 0) - $1, 0),
             updated_at = current_timestamp
         WHERE user_id = $2`,
        [amount, driverId]
      );

      console.log(`✅ Reversed driver ${driverId} earnings by $${amount}`);
    }
  } catch (error) {
    console.error('❌ Failed to reverse driver earnings after refund:', error);
    // Refund succeeded; do not mask it
  }

  return result.rows[0];
};

/**
 * Cancel a pending payment (cancels the Stripe PaymentIntent)
 */
export const cancelPayment = async (paymentId: string): Promise<Payment> => {
  const payment = await pool.query('SELECT * FROM payments WHERE payment_id = $1', [paymentId]);
  if (payment.rows.length === 0) throw new Error('Payment not found');

  const paymentData = payment.rows[0];

  if (paymentData.status !== PaymentStatus.Pending) {
    throw new Error('Can only cancel pending payments');
  }

  // Cancel PaymentIntent with Stripe
  await stripe.paymentIntents.cancel(paymentData.stripe_payment_intent_id);

  // Update status
  const updateQuery = `
    UPDATE payments SET status = $1, updated_at = current_timestamp
    WHERE payment_id = $2 RETURNING *
  `;
  const result = await pool.query(updateQuery, [PaymentStatus.Failed, paymentId]);
  return result.rows[0];
};

/**
 * Get payment by booking ID
 */
export const getPaymentByBooking = async (bookingId: string): Promise<Payment | null> => {
  const result = await pool.query('SELECT * FROM payments WHERE booking_id = $1', [bookingId]);
  return result.rows.length > 0 ? result.rows[0] : null;
};

/**
 * Cancel all pending Stripe PaymentIntents for active bookings on a trip.
 * Called when a driver cancels a trip.
 */
export const cancelPaymentIntentsByTripId = async (tripId: string): Promise<{ cancelled: number }> => {
  const result = await pool.query<{ payment_id: string; stripe_payment_intent_id: string }>(
    `SELECT p.payment_id, p.stripe_payment_intent_id
     FROM payments p
     JOIN bookings b ON p.booking_id = b.booking_id
     WHERE b.trip_id = $1
       AND p.status = $2
       AND b.deleted_at IS NULL`,
    [tripId, PaymentStatus.Pending]
  );

  let cancelled = 0;
  for (const row of result.rows) {
    try {
      await stripe.paymentIntents.cancel(row.stripe_payment_intent_id);
      await pool.query(
        `UPDATE payments SET status = $1, updated_at = NOW() WHERE payment_id = $2`,
        [PaymentStatus.Failed, row.payment_id]
      );
      cancelled++;
    } catch (err: any) {
      console.warn(`[cancelPaymentIntentsByTripId] Failed to cancel ${row.stripe_payment_intent_id}:`, err.message);
    }
  }

  return { cancelled };
};

export default { createPaymentIntent, capturePayment, refundPayment, cancelPayment, getPaymentByBooking, cancelPaymentIntentsByTripId };
