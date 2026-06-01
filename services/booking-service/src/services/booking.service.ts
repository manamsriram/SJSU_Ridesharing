import { Pool } from 'pg';
import axios from 'axios';
import Stripe from 'stripe';
import { config } from '../config';
import { getCostClient, getPaymentClient, getNotificationClient, unary } from '../grpc-clients';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-04-10' as any });
import {
  Booking,
  BookingWithDetails,
  BookingStatus,
  Quote,
  Rating,
  CreateBookingRequest,
  CreateRatingRequest,
  AppError,
} from '@lessgo/shared';

const pool = new Pool({
  connectionString: config.databaseUrl,
});

/** Returns true if the departure is within 1 hour from now (the lock window). */
const isWithinOneHour = (departureTime: Date): boolean =>
  departureTime.getTime() - Date.now() <= 60 * 60 * 1000;

const getTripById = async (tripId: string) => {
  const result = await pool.query(
    `SELECT trip_id, driver_id, origin, destination, seats_available, status, departure_time,
  ST_Y(origin_point::geometry)      AS origin_lat,
  ST_X(origin_point::geometry)      AS origin_lng,
  ST_Y(destination_point::geometry) AS destination_lat,
  ST_X(destination_point::geometry) AS destination_lng
 FROM trips WHERE trip_id = $1`,
    [tripId]
  );
  return result.rows[0] ?? null;
};

/**
 * Create a new booking
 * @param riderId Rider's UUID
 * @param bookingData Booking creation data
 * @returns Created booking with quote
 */
export const createBooking = async (
  riderId: string,
  bookingData: CreateBookingRequest
): Promise<{ booking: Booking; quote: Quote }> => {
  const { trip_id, seats_booked, scost_breakdown } = bookingData;
  // pickup_location and fare are not in CreateBookingRequest type but may be sent by clients.
  const pickupLocation = (bookingData as any).pickup_location ?? null;
  const clientFare: number | null = (bookingData as any).fare ?? null;

  // Check trip availability
  const tripQuery = `
    SELECT trip_id, driver_id, origin, destination, seats_available, status, departure_time
    FROM trips
    WHERE trip_id = $1
  `;
  const tripResult = await pool.query(tripQuery, [trip_id]);

  if (tripResult.rows.length === 0) {
    throw new Error('Trip not found');
  }

  const trip = tripResult.rows[0];

  if (trip.status !== 'pending') {
    throw new Error('Trip is not available for booking');
  }

  if (trip.seats_available < seats_booked) {
    throw new Error('Not enough seats available');
  }

  // Defense-in-depth: Reject bookings within 1 hour of departure.
  // (Trip search SQL also filters these out, but we validate again here to be safe.)
  // pg_cron cleans up expired holds at this boundary.
  const departureTime = new Date(trip.departure_time);
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
  if (departureTime <= oneHourFromNow) {
    throw new AppError('Cannot book trips departing within 1 hour', 400);
  }

  // Prevent driver from booking own trip
  if (trip.driver_id === riderId) {
    throw new Error('Drivers cannot book their own trips');
  }

  // Idempotency: return existing active booking if one already exists
  const existingQuery = await pool.query(
    `SELECT booking_id FROM bookings
     WHERE trip_id = $1 AND rider_id = $2
       AND booking_state NOT IN ('cancelled', 'rejected')`,
    [trip_id, riderId]
  );
  if (existingQuery.rows.length > 0) {
    const existingBooking = await getBookingById(existingQuery.rows[0].booking_id);
    const existingQuote = await pool.query(
      `SELECT * FROM quotes WHERE booking_id = $1`,
      [existingQuery.rows[0].booking_id]
    );
    return { booking: existingBooking as any, quote: existingQuote.rows[0] };
  }

  // Atomically decrement seats and insert booking in a transaction
  const client = await pool.connect();
  let booking: any;
  try {
    await client.query('BEGIN');

    // Decrement seats atomically with capacity guard
    const seatUpdate = await client.query(
      `UPDATE trips
       SET seats_available = seats_available - $1, updated_at = current_timestamp
       WHERE trip_id = $2
         AND status = 'pending'
         AND seats_available >= $1`,
      [seats_booked, trip_id]
    );
    if (seatUpdate.rowCount === 0) {
      throw new Error('Not enough seats available');
    }

    // Compute hold expiry: MIN(NOW() + 2h, departure_time - 1h)
    const holdExpiresAt = `LEAST(NOW() + INTERVAL '2 hours', $8::timestamptz - INTERVAL '1 hour')`;

    // Create booking (store pickup_location if provided for detour-aware settlement)
    const bookingQuery = `
      INSERT INTO bookings (trip_id, rider_id, seats_booked, status, booking_state, pickup_location, scost_breakdown, hold_expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, ${holdExpiresAt})
      RETURNING *
    `;
    const bookingResult = await client.query(bookingQuery, [
      trip_id,
      riderId,
      seats_booked,
      BookingStatus.Pending,
      'pending',  // booking_state for driver approval flow
      pickupLocation ? JSON.stringify(pickupLocation) : null,
      scost_breakdown ? JSON.stringify(scost_breakdown) : null,
      trip.departure_time,
    ]);
    booking = bookingResult.rows[0];

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // Generate quote via Cost Calculation Service (with fallback).
  // If the client provided a fare (from the search-results quote), prefer it for consistency.
  let maxPrice: number;

  if (clientFare !== null && clientFare > 0) {
    maxPrice = clientFare;
  } else {
    try {
      const costRes = await unary(
        (req, cb) => getCostClient().calculateCost(req, cb),
        {
          origin:      { lat: trip.origin_lat,      lng: trip.origin_lng },
          destination: { lat: trip.destination_lat, lng: trip.destination_lng },
          numRiders: seats_booked,
          tripId: trip_id,
        },
      );
      maxPrice = costRes.maxPrice;
    } catch (error) {
      // Fallback: calculate price locally if cost service is unavailable
      console.warn('Cost service unavailable, using fallback pricing');
      const basePricePerRider = 5.0;
      const estimatedDistanceMiles = 10;
      const pricePerMile = 0.5;
      const totalTripCost = basePricePerRider + estimatedDistanceMiles * pricePerMile;
      maxPrice = parseFloat((totalTripCost / seats_booked).toFixed(2));
    }
  }

  try {
    const quoteQuery = `
      INSERT INTO quotes (booking_id, max_price)
      VALUES ($1, $2)
      RETURNING *
    `;
    const quoteResult = await pool.query(quoteQuery, [booking.booking_id, maxPrice]);
    const quote = quoteResult.rows[0];

    return { booking, quote };
  } catch (error) {
    await pool.query('DELETE FROM bookings WHERE booking_id = $1', [booking.booking_id]);
    console.error('Quote creation failed:', error);
    throw new Error('Unable to calculate price. Please try again.');
  }
};

/**
 * Get booking by ID with details
 * @param bookingId Booking's UUID
 * @returns Booking with trip, rider, quote, and payment details
 */
export const getBookingById = async (bookingId: string): Promise<BookingWithDetails | null> => {
  const query = `
    SELECT
      b.*,
      t.trip_id, t.driver_id, t.origin, t.destination,
      ST_X(t.origin_point::geometry) as origin_lng,
      ST_Y(t.origin_point::geometry) as origin_lat,
      ST_X(t.destination_point::geometry) as destination_lng,
      ST_Y(t.destination_point::geometry) as destination_lat,
      t.departure_time, t.seats_available as trip_seats_available, t.max_riders, t.recurrence, t.status as trip_status,
      t.created_at as trip_created_at, t.updated_at as trip_updated_at,
      d.user_id as driver_user_id, d.name as driver_name, d.email as driver_email,
      d.role as driver_role, d.sjsu_id_status as driver_sjsu_id_status, d.rating as driver_rating,
      d.vehicle_info as driver_vehicle_info, d.license_plate as driver_license_plate,
      d.profile_picture_url as driver_profile_picture,
      d.stripe_connect_account_id as driver_stripe_connect_account_id,
      d.created_at as driver_created_at, d.updated_at as driver_updated_at,
      r.user_id as rider_user_id, r.name as rider_name, r.email as rider_email,
      r.role as rider_role, r.sjsu_id_status as rider_sjsu_id_status, r.rating as rider_rating,
      r.profile_picture_url as rider_profile_picture,
      r.stripe_connect_account_id as rider_stripe_connect_account_id,
      r.created_at as rider_created_at, r.updated_at as rider_updated_at,
      q.quote_id, q.max_price, COALESCE(q.final_price, q.max_price) AS fare, q.final_price, q.created_at as quote_created_at,
      p.payment_id, p.stripe_payment_intent_id, p.amount, p.status as payment_status,
      p.created_at as payment_created_at, p.updated_at as payment_updated_at
    FROM bookings b
    JOIN trips t ON b.trip_id = t.trip_id
    JOIN users d ON t.driver_id = d.user_id
    JOIN users r ON b.rider_id = r.user_id
    LEFT JOIN quotes q ON b.booking_id = q.booking_id
    LEFT JOIN payments p ON b.booking_id = p.booking_id
    WHERE b.booking_id = $1 AND b.deleted_at IS NULL
  `;

  const result = await pool.query(query, [bookingId]);

  if (result.rows.length === 0) {
    return null;
  }

  let row = result.rows[0];

  // Lazy expiry: if booking is pending and hold has expired, expire it now
  if (
    row.booking_state === 'pending' &&
    row.hold_expires_at &&
    new Date(row.hold_expires_at) < new Date()
  ) {
    const expireClient = await pool.connect();
    try {
      await expireClient.query('BEGIN');
      const expireResult = await expireClient.query(
        `UPDATE bookings
         SET booking_state = 'cancelled', updated_at = current_timestamp
         WHERE booking_id = $1 AND booking_state = 'pending'
         RETURNING booking_state`,
        [bookingId]
      );
      if (expireResult.rowCount && expireResult.rowCount > 0) {
        // Restore seats on the trip atomically
        await expireClient.query(
          `UPDATE trips
           SET seats_available = seats_available + $1, updated_at = current_timestamp
           WHERE trip_id = $2`,
          [row.seats_booked, row.trip_id]
        );
        row = { ...row, booking_state: 'cancelled' };

        // Notify the rider that their request expired (fire-and-forget)
        unary(
          (req, cb) => getNotificationClient().sendNotification(req, cb),
          {
            userId: row.rider_id,
            type: 'booking_expired',
            title: 'Request Expired',
            message: "Driver didn't respond — your request expired. Browse other rides.",
            data: { fields: { booking_id: bookingId } },
          },
        ).catch((notifErr: unknown) => {
          console.warn(`[LAZY_EXPIRY] Failed to send expiry notification for booking ${bookingId}:`, notifErr);
        });
      }
      await expireClient.query('COMMIT');
    } catch (expireErr) {
      await expireClient.query('ROLLBACK');
      console.error(`[LAZY_EXPIRY] Failed to expire booking ${bookingId}:`, expireErr);
    } finally {
      expireClient.release();
    }
  }

  // Lazy expiry: approved booking whose payment deadline passed without payment
  if (
    row.booking_state === 'approved' &&
    !row.payment_intent_id &&
    row.payment_deadline_at &&
    new Date(row.payment_deadline_at) < new Date()
  ) {
    const expireClient = await pool.connect();
    try {
      await expireClient.query('BEGIN');
      const expireResult = await expireClient.query(
        `UPDATE bookings
         SET booking_state = 'cancelled',
             cancellation_reason = 'payment_not_completed',
             updated_at = current_timestamp
         WHERE booking_id = $1 AND booking_state = 'approved' AND payment_intent_id IS NULL
         RETURNING booking_state`,
        [bookingId]
      );
      if (expireResult.rowCount && expireResult.rowCount > 0) {
        await expireClient.query(
          `UPDATE trips
           SET seats_available = seats_available + $1, updated_at = current_timestamp
           WHERE trip_id = $2`,
          [row.seats_booked, row.trip_id]
        );
        row = { ...row, booking_state: 'cancelled', cancellation_reason: 'payment_not_completed' };

        unary(
          (req, cb) => getNotificationClient().sendNotification(req, cb),
          {
            userId: row.rider_id,
            type: 'booking_payment_expired',
            title: 'Booking Cancelled',
            message: 'Your booking was cancelled because payment was not completed before the deadline.',
            data: { fields: { booking_id: bookingId } },
          },
        ).catch((notifErr: unknown) => {
          console.warn(`[LAZY_PAYMENT_EXPIRY] Failed to send notification for booking ${bookingId}:`, notifErr);
        });
      }
      await expireClient.query('COMMIT');
    } catch (expireErr) {
      await expireClient.query('ROLLBACK');
      console.error(`[LAZY_PAYMENT_EXPIRY] Failed to expire booking ${bookingId}:`, expireErr);
    } finally {
      expireClient.release();
    }
  }

  return {
    booking_id: row.booking_id,
    trip_id: row.trip_id,
    rider_id: row.rider_id,
    status: row.status,
    booking_state: row.booking_state || 'pending',
    seats_booked: row.seats_booked,
    fare: row.fare != null ? parseFloat(row.fare) : undefined,
    payment_intent_id: row.payment_intent_id || null,
    hold_expires_at: row.hold_expires_at || null,
    payment_deadline_at: row.payment_deadline_at || null,
    cancellation_reason: row.cancellation_reason || null,
    pickup_location: row.pickup_location || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    trip: {
      trip_id: row.trip_id,
      driver_id: row.driver_id,
      origin: row.origin,
      destination: row.destination,
      origin_point: { lat: row.origin_lat, lng: row.origin_lng },
      destination_point: { lat: row.destination_lat, lng: row.destination_lng },
      departure_time: row.departure_time,
      seats_available: row.trip_seats_available,
      max_riders: row.max_riders,
      recurrence: row.recurrence,
      status: row.trip_status,
      created_at: row.trip_created_at,
      updated_at: row.trip_updated_at,
      driver: {
        user_id: row.driver_user_id,
        name: row.driver_name,
        email: row.driver_email,
        role: row.driver_role,
        sjsu_id_status: row.driver_sjsu_id_status,
        rating: row.driver_rating,
        vehicle_info: row.driver_vehicle_info,
        license_plate: row.driver_license_plate,
        profile_picture_url: row.driver_profile_picture,
        stripe_connect_account_id: row.driver_stripe_connect_account_id,
        created_at: row.driver_created_at,
        updated_at: row.driver_updated_at,
      },
    },
    rider: {
      user_id: row.rider_user_id,
      name: row.rider_name,
      email: row.rider_email,
      role: row.rider_role,
      sjsu_id_status: row.rider_sjsu_id_status,
      rating: row.rider_rating,
      profile_picture_url: row.rider_profile_picture,
      stripe_connect_account_id: row.rider_stripe_connect_account_id,
      created_at: row.rider_created_at,
      updated_at: row.rider_updated_at,
    },
    quote: row.quote_id ? {
      quote_id: row.quote_id,
      booking_id: row.booking_id,
      max_price: parseFloat(row.max_price),
      final_price: row.final_price ? parseFloat(row.final_price) : undefined,
      created_at: row.quote_created_at,
    } : undefined,
    payment: row.payment_id ? {
      payment_id: row.payment_id,
      booking_id: row.booking_id,
      stripe_payment_intent_id: row.stripe_payment_intent_id,
      amount: parseFloat(row.amount),
      status: row.payment_status,
      created_at: row.payment_created_at,
      updated_at: row.payment_updated_at,
    } : undefined,
  };
};

/**
 * List user's bookings (as rider or driver)
 * @param userId User's UUID
 * @param asDriver Whether to list as driver
 * @returns Array of bookings
 */
export const listUserBookings = async (
  userId: string,
  asDriver: boolean = false
): Promise<BookingWithDetails[]> => {
  const query = asDriver
    ? `SELECT b.booking_id FROM bookings b JOIN trips t ON b.trip_id = t.trip_id WHERE t.driver_id = $1 AND b.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY b.created_at DESC`
    : `SELECT booking_id, booking_state FROM bookings WHERE rider_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`;

  const result = await pool.query(query, [userId]);

  const bookings = await Promise.all(
    result.rows.map((row) => getBookingById(row.booking_id))
  );

  return bookings.filter((b) => b !== null) as BookingWithDetails[];
};

/**
 * Confirm booking with payment
 * @param bookingId Booking's UUID
 * @param userId User's UUID (for authorization)
 * @returns Updated booking with payment
 */
export const confirmBooking = async (
  bookingId: string,
  userId: string
): Promise<BookingWithDetails> => {
  const client = await pool.connect();
  let createdPaymentId: string | null = null;

  try {
    await client.query('BEGIN');

    // Get booking
    const bookingData = await getBookingById(bookingId);
    if (!bookingData) {
      throw new Error('Booking not found');
    }

    // Verify user is the rider
    if (bookingData.rider_id !== userId) {
      throw new Error('Unauthorized');
    }

    if (bookingData.status !== BookingStatus.Pending) {
      throw new Error('Booking is not pending');
    }

    if (!bookingData.quote) {
      throw new Error('Quote not found');
    }

    // Check if payment already exists for this booking
    let payment = bookingData.payment;

    if (!payment) {
      // No payment exists - create one via Payment Service
      console.log(`[CONFIRM] Creating payment for booking ${bookingId}`);
      try {
        const paymentRes = await unary(
          (req, cb) => getPaymentClient().createPaymentIntent(req, cb),
          { bookingId, amount: bookingData.quote.max_price },
        );
        payment = { payment_id: paymentRes.paymentId, client_secret: paymentRes.clientSecret, status: 'pending' } as any;
        createdPaymentId = paymentRes.paymentId || null;
      } catch (error: any) {
        console.error(`[CONFIRM] Payment creation failed for booking ${bookingId}:`, error.response?.data || error.message);
        throw new Error('Failed to create payment intent');
      }
    } else {
      // Payment already exists - verify it's pending
      console.log(`[CONFIRM] Payment already exists for booking ${bookingId} with status: ${payment.status}`);
      if (payment.status !== 'pending') {
        throw new Error(`Cannot confirm booking - payment status is ${payment.status}`);
      }
    }

    // Update booking status only if still pending (prevents double-confirm race)
    // Note: seat decrement already happened at createBooking time
    const bookingUpdate = await client.query(
      `UPDATE bookings
       SET status = $1, updated_at = current_timestamp
       WHERE booking_id = $2 AND status = $3`,
      [BookingStatus.Confirmed, bookingId, BookingStatus.Pending]
    );
    if (bookingUpdate.rowCount === 0) {
      throw new Error('Booking is not pending');
    }

    await client.query('COMMIT');

    console.log(`[CONFIRM] Booking ${bookingId} confirmed successfully`);

    // Return updated booking
    const updatedBooking = await getBookingById(bookingId);
    return updatedBooking!;
  } catch (error) {
    await client.query('ROLLBACK');
    if (createdPaymentId) {
      try {
        await unary((req, cb) => getPaymentClient().cancelPayment(req, cb), { paymentId: createdPaymentId! });
      } catch (cancelErr) {
        console.error(`[CONFIRM] Failed to cancel orphaned payment ${createdPaymentId}:`, cancelErr);
      }
    }
    console.error(`[CONFIRM] Failed to confirm booking ${bookingId}:`, error);
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Cancel booking (with refund if confirmed)
 * @param bookingId Booking's UUID
 * @param userId User's UUID (for authorization)
 * @returns Updated booking
 */
export const cancelBooking = async (
  bookingId: string,
  userId: string
): Promise<BookingWithDetails> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const bookingData = await getBookingById(bookingId);
    if (!bookingData) {
      throw new Error('Booking not found');
    }

    // Verify user is the rider
    if (bookingData.rider_id !== userId) {
      throw new Error('Unauthorized');
    }

    if (bookingData.status === BookingStatus.Cancelled || bookingData.booking_state === 'cancelled') {
      // Heal any status/booking_state mismatch before throwing
      if (bookingData.status !== BookingStatus.Cancelled || bookingData.booking_state !== 'cancelled') {
        await client.query(
          `UPDATE bookings SET status = 'cancelled', booking_state = 'cancelled', updated_at = current_timestamp WHERE booking_id = $1`,
          [bookingId]
        );
        await client.query('COMMIT');
        const healed = await getBookingById(bookingId);
        return healed!;
      }
      throw new Error('Booking already cancelled');
    }

    if (bookingData.status === BookingStatus.Completed) {
      throw new Error('Cannot cancel completed booking');
    }

    if (isWithinOneHour(new Date(bookingData.trip.departure_time))) {
      throw new AppError('Cannot cancel within 1 hour of departure', 423);
    }

    const wasConfirmed = bookingData.status === BookingStatus.Confirmed;
    const wasPending = bookingData.status === BookingStatus.Pending;

    // If a Stripe PaymentIntent hold exists on the booking, cancel it to release the hold
    const paymentIntentIdResult = await client.query(
      'SELECT payment_intent_id FROM bookings WHERE booking_id = $1',
      [bookingId]
    );
    const paymentIntentId = paymentIntentIdResult.rows[0]?.payment_intent_id;
    if (paymentIntentId) {
      try {
        await stripe.paymentIntents.cancel(paymentIntentId);
        console.log(`[CANCEL] Released Stripe hold for PaymentIntent ${paymentIntentId}`);
      } catch (stripeErr: any) {
        // Only swallow error if intent is already cancelled or succeeded
        const safeStatuses = ['canceled', 'succeeded'];
        if (stripeErr.payment_intent && safeStatuses.includes(stripeErr.payment_intent.status)) {
          console.warn(`[CANCEL] Stripe intent ${paymentIntentId} already ${stripeErr.payment_intent.status}`);
        } else {
          console.error(`[CANCEL] Failed to release Stripe hold for ${paymentIntentId}:`, stripeErr.message);
          throw new AppError('Failed to release payment hold. Please contact support.', 500);
        }
      }
    }

    // If confirmed with a payment, handle based on payment status
    if (wasConfirmed && bookingData.payment) {
      if (bookingData.payment.status === 'captured') {
        // Refund captured payments
        await unary((req, cb) => getPaymentClient().refundPayment(req, cb), { paymentId: bookingData.payment.payment_id });
      } else if (bookingData.payment.status === 'pending') {
        // Cancel pending payment intents
        await unary((req, cb) => getPaymentClient().cancelPayment(req, cb), { paymentId: bookingData.payment.payment_id });
      }
    }

    // Update booking status
    await client.query(
      'UPDATE bookings SET status = $1, booking_state = $2, hold_expires_at = NULL, updated_at = current_timestamp WHERE booking_id = $3',
      [BookingStatus.Cancelled, BookingStatus.Cancelled, bookingId]
    );

    // Restore trip seats if they were previously deducted (pending or confirmed bookings)
    if (wasConfirmed || wasPending) {
      await client.query(
        'UPDATE trips SET seats_available = seats_available + $1, updated_at = current_timestamp WHERE trip_id = $2',
        [bookingData.seats_booked, bookingData.trip_id]
      );
    }

    await client.query('COMMIT');

    const updatedBooking = await getBookingById(bookingId);
    return updatedBooking!;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Create rating for completed booking
 * @param bookingId Booking's UUID
 * @param raterId Rater's UUID
 * @param ratingData Rating data
 * @returns Created rating
 */
export const createRating = async (
  bookingId: string,
  raterId: string,
  ratingData: CreateRatingRequest
): Promise<Rating> => {
  // Get booking
  const bookingData = await getBookingById(bookingId);
  if (!bookingData) {
    throw new Error('Booking not found');
  }

  if (bookingData.booking_state !== 'completed') {
    throw new Error('Can only rate completed bookings');
  }

  // Determine ratee (if rider rates, ratee is driver; if driver rates, ratee is rider)
  let rateeId: string;
  if (raterId === bookingData.rider_id) {
    rateeId = bookingData.trip.driver_id;
  } else if (raterId === bookingData.trip.driver_id) {
    rateeId = bookingData.rider_id;
  } else {
    throw new Error('Unauthorized');
  }

  // Check if rating already exists
  const existingRating = await pool.query(
    'SELECT * FROM ratings WHERE booking_id = $1 AND rater_id = $2',
    [bookingId, raterId]
  );

  if (existingRating.rows.length > 0) {
    throw new Error('Rating already exists');
  }

  // Create rating
  const query = `
    INSERT INTO ratings (booking_id, rater_id, ratee_id, score, comment)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `;

  const result = await pool.query(query, [
    bookingId,
    raterId,
    rateeId,
    ratingData.score,
    ratingData.comment || null,
  ]);

  // Update ratee's average rating
  const avgQuery = `
    UPDATE users
    SET rating = (SELECT COALESCE(AVG(score), 0) FROM ratings WHERE ratee_id = $1),
        updated_at = current_timestamp
    WHERE user_id = $1
  `;
  await pool.query(avgQuery, [rateeId]);

  return result.rows[0];
};

/**
 * Update pickup location for booking
 * @param bookingId Booking's UUID
 * @param userId User's UUID (for authorization)
 * @param pickupLocation Pickup location {lat, lng, address}
 * @returns Updated booking
 */
export const updatePickupLocation = async (
  bookingId: string,
  userId: string,
  pickupLocation: { lat: number; lng: number; address?: string }
): Promise<BookingWithDetails> => {
  // Get booking
  const bookingData = await getBookingById(bookingId);
  if (!bookingData) {
    throw new Error('Booking not found');
  }

  // Verify user is the rider
  if (bookingData.rider_id !== userId) {
    throw new Error('Unauthorized');
  }

  // Update pickup location
  const query = `
    UPDATE bookings
    SET pickup_location = $1, updated_at = current_timestamp
    WHERE booking_id = $2
  `;

  await pool.query(query, [JSON.stringify(pickupLocation), bookingId]);

  // Return updated booking
  const updatedBooking = await getBookingById(bookingId);
  return updatedBooking!;
};

/**
 * Get all bookings for a specific trip
 * @param tripId Trip UUID
 * @returns Object with bookings array (including fare) and totalFare for approved/confirmed bookings
 */
export const getBookingsByTripId = async (tripId: string): Promise<{ bookings: any[]; totalFare: number }> => {
  const query = `
    SELECT
      b.booking_id as id,
      b.trip_id,
      b.rider_id,
      b.seats_booked,
      b.status,
      b.booking_state,
      b.pickup_location,
      b.scost_breakdown,
      b.hold_expires_at,
      b.created_at,
      u.name as rider_name,
      u.email as rider_email,
      u.rating as rider_rating,
      u.profile_picture_url as rider_picture,
      b.payment_intent_id,
      b.payment_deadline_at,
      b.payment_confirmed_at,
      b.cancellation_reason,
      b.rider_pickup_confirmed_at,
      COALESCE(q.final_price, q.max_price) AS fare
    FROM bookings b
    JOIN users u ON b.rider_id = u.user_id
    LEFT JOIN quotes q ON q.booking_id = b.booking_id
    WHERE b.trip_id = $1
      AND b.booking_state IS NOT NULL
      AND b.deleted_at IS NULL
    ORDER BY b.created_at DESC
  `;

  const result = await pool.query(query, [tripId]);
  const bookings = result.rows.map((row) => ({
    ...row,
    fare: row.fare !== null && row.fare !== undefined ? parseFloat(row.fare) : undefined,
    rider_pickup_confirmed_at: row.rider_pickup_confirmed_at || null,
  }));

  const totalFare = bookings
    .filter((b) => b.booking_state === 'approved' || b.status === 'confirmed')
    .reduce((sum, b) => sum + (b.fare ?? 0), 0);

  return { bookings, totalFare: parseFloat(totalFare.toFixed(2)) };
};

/**
 * Approve a booking (driver only)
 * @param bookingId Booking's UUID
 * @param driverId Driver's UUID (for authorization)
 * @returns Updated booking
 */
export const approveBooking = async (
  bookingId: string,
  driverId: string
): Promise<BookingWithDetails> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get booking with trip details
    const bookingData = await getBookingById(bookingId);
    if (!bookingData) {
      throw new Error('Booking not found');
    }

    // Verify user is the driver of the trip
    if (bookingData.trip.driver_id !== driverId) {
      throw new Error('Unauthorized: You must be the driver of this trip');
    }

    if (bookingData.booking_state === 'approved') {
      throw new Error('Booking is already approved');
    }

    if (bookingData.booking_state === 'rejected' || bookingData.booking_state === 'cancelled') {
      throw new Error('Cannot approve a rejected or cancelled booking');
    }

    if (isWithinOneHour(new Date(bookingData.trip.departure_time))) {
      throw new AppError('Trip is locked 1 hour before departure', 423);
    }

    // Update booking state, clear hold_expires_at, and set payment_deadline_at
    // (trip.departure_time - 1 hour) so the rider knows when to complete payment.
    await client.query(
      `UPDATE bookings b
       SET booking_state        = 'approved',
           hold_expires_at      = NULL,
           payment_deadline_at  = (
             SELECT departure_time - INTERVAL '1 hour'
             FROM trips
             WHERE trip_id = b.trip_id
           ),
           updated_at           = current_timestamp
       WHERE b.booking_id = $1`,
      [bookingId]
    );

    await client.query('COMMIT');

    const updatedBooking = await getBookingById(bookingId);
    return updatedBooking!;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Reject a booking (driver only)
 * @param bookingId Booking's UUID
 * @param driverId Driver's UUID (for authorization)
 * @returns Updated booking
 */
export const rejectBooking = async (
  bookingId: string,
  driverId: string
): Promise<BookingWithDetails> => {
  // Get booking with trip details
  const bookingData = await getBookingById(bookingId);
  if (!bookingData) {
    throw new Error('Booking not found');
  }

  // Verify user is the driver of the trip
  if (bookingData.trip.driver_id !== driverId) {
    throw new Error('Unauthorized: You must be the driver of this trip');
  }

  if (bookingData.booking_state === 'rejected') {
    throw new Error('Booking is already rejected');
  }

  if (bookingData.booking_state === 'approved') {
    throw new Error('Cannot reject an approved booking');
  }

  if (isWithinOneHour(new Date(bookingData.trip.departure_time))) {
    throw new AppError('Trip is locked 1 hour before departure', 423);
  }

  // Update booking state and restore seats atomically
  const rejectClient = await pool.connect();
  try {
    await rejectClient.query('BEGIN');

    await rejectClient.query(
      `UPDATE bookings
       SET booking_state = $1, updated_at = current_timestamp
       WHERE booking_id = $2`,
      ['rejected', bookingId]
    );

    // Restore seats since they were decremented at createBooking time
    await rejectClient.query(
      `UPDATE trips
       SET seats_available = seats_available + $1, updated_at = current_timestamp
       WHERE trip_id = $2`,
      [bookingData.seats_booked, bookingData.trip_id]
    );

    await rejectClient.query('COMMIT');
  } catch (error) {
    await rejectClient.query('ROLLBACK');
    throw error;
  } finally {
    rejectClient.release();
  }

  const updatedBooking = await getBookingById(bookingId);
  return updatedBooking!;
};

/**
 * Soft delete a booking (set deleted_at = NOW())
 * Only allowed if booking_state IN ('cancelled', 'rejected') and requester is the rider
 * @param bookingId Booking's UUID
 * @param userId Requesting user's UUID
 */
export const deleteBooking = async (bookingId: string, userId: string): Promise<void> => {
  const bookingData = await getBookingById(bookingId);
  if (!bookingData) {
    throw new Error('Booking not found');
  }

  // Fix: also allow the trip's driver
  const tripData = await getTripById(bookingData.trip_id);
  if (bookingData.rider_id !== userId && tripData?.driver_id !== userId) {
      throw new AppError('Forbidden', 403);
  }

  if (!['cancelled', 'rejected'].includes(bookingData.booking_state || '')) {
    throw new AppError('Booking can only be deleted when cancelled or rejected', 400);
  }

  await pool.query(
    'UPDATE bookings SET deleted_at = NOW() WHERE booking_id = $1',
    [bookingId]
  );
};

/**
 * Authorize payment for an approved booking (rider only)
 * Creates a Stripe PaymentIntent with capture_method: 'manual' (card hold)
 * @param bookingId Booking's UUID
 * @param riderId Rider's UUID (for authorization)
 * @returns { clientSecret, paymentIntentId }
 */
export const authorizePayment = async (
  bookingId: string,
  riderId: string
): Promise<{ clientSecret: string; paymentIntentId: string }> => {
  const bookingData = await getBookingById(bookingId);
  if (!bookingData) {
    throw new AppError('Booking not found', 404);
  }

  if (bookingData.rider_id !== riderId) {
    throw new AppError('Unauthorized', 403);
  }

  if (bookingData.booking_state !== 'approved') {
    throw new AppError('Booking must be approved before payment can be authorized', 400);
  }

  // Don't create a duplicate PaymentIntent — but only reuse if it's still usable
  const existingResult = await pool.query(
    'SELECT payment_intent_id FROM bookings WHERE booking_id = $1',
    [bookingId]
  );
  if (existingResult.rows[0]?.payment_intent_id) {
    const existing = await stripe.paymentIntents.retrieve(existingResult.rows[0].payment_intent_id);
    // Reuse only if the intent can still accept a payment method
    if (existing.status === 'requires_payment_method' || existing.status === 'requires_confirmation') {
      return {
        clientSecret: existing.client_secret!,
        paymentIntentId: existing.id,
      };
    }
    // Otherwise fall through to create a fresh PaymentIntent
  }

  // Determine fare amount in cents
  const fareUsd = bookingData.fare ?? bookingData.quote?.max_price ?? 0;
  const amountCents = Math.round(fareUsd * 100);

  if (amountCents <= 0) {
    throw new AppError('Cannot authorize payment: fare amount is zero or unknown', 400);
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    capture_method: 'manual',
    automatic_payment_methods: { enabled: true },
    metadata: {
      booking_id: bookingId,
      rider_id: riderId,
    },
  });

  // Persist PaymentIntent on the booking row
  await pool.query(
    `UPDATE bookings
     SET payment_intent_id = $1, payment_authorized_at = NOW(), updated_at = current_timestamp
     WHERE booking_id = $2`,
    [paymentIntent.id, bookingId]
  );

  // Merge rider pickup into trip route (non-fatal)
  if (bookingData.pickup_location) {
    const pl = bookingData.pickup_location as { lat: number; lng: number };
    try {
      const tripResult = await pool.query(
        `SELECT ST_Y(destination_point::geometry) as dest_lat,
                ST_X(destination_point::geometry) as dest_lng
         FROM trips WHERE trip_id = $1`,
        [bookingData.trip_id]
      );
      if (tripResult.rows.length > 0) {
        const { dest_lat, dest_lng } = tripResult.rows[0];
        await axios.post(
          `${config.tripServiceUrl}/trips/${bookingData.trip_id}/merge-route`,
          {
            rider_id: bookingData.rider_id,
            pickup_lat: pl.lat,
            pickup_lng: pl.lng,
            dropoff_lat: dest_lat,
            dropoff_lng: dest_lng,
          },
          { headers: { 'x-internal-service': 'booking-service' } }
        );
      }
    } catch (mergeErr) {
      console.warn('[authorizePayment] Route merge failed (non-fatal):', mergeErr);
    }
  }

  // Notify all active riders on the trip that the route was updated
  try {
    const allRiders = await pool.query(
      `SELECT rider_id FROM bookings
       WHERE trip_id = $1
         AND booking_state IN ('pending', 'approved')
         AND rider_id != $2
         AND deleted_at IS NULL`,
      [bookingData.trip_id, bookingData.rider_id]
    );
    for (const row of allRiders.rows) {
      unary(
        (req, cb) => getNotificationClient().sendNotification(req, cb),
        {
          userId: row.rider_id,
          type: 'route_updated',
          title: 'Route Updated',
          message: 'The pickup route has been updated. Check your ride details.',
          data: { fields: { trip_id: bookingData.trip_id } },
        },
      ).catch(() => {});
    }
  } catch { /* non-fatal */ }

  return {
    clientSecret: paymentIntent.client_secret!,
    paymentIntentId: paymentIntent.id,
  };
};

/**
 * Confirm a PaymentIntent server-side (rider calls after authorize-payment)
 * This attaches a payment method and confirms the intent so it moves to
 * requires_capture, ready for driver-triggered capture.
 * @param bookingId Booking's UUID
 * @param riderId  Rider's UUID (for authorization)
 * @returns Updated booking
 */
export const confirmPayment = async (
  bookingId: string,
  riderId: string
): Promise<BookingWithDetails> => {
  const bookingData = await getBookingById(bookingId);
  if (!bookingData) {
    throw new AppError('Booking not found', 404);
  }

  if (bookingData.rider_id !== riderId) {
    throw new AppError('Unauthorized', 403);
  }

  const intentIdResult = await pool.query(
    'SELECT payment_intent_id FROM bookings WHERE booking_id = $1',
    [bookingId]
  );
  const paymentIntentId = intentIdResult.rows[0]?.payment_intent_id;

  if (!paymentIntentId) {
    throw new AppError('No authorized payment found — call authorize-payment first', 400);
  }

  // Retrieve current state; skip confirm if already confirmed
  const existing = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (existing.status !== 'requires_payment_method' && existing.status !== 'requires_confirmation') {
    // Already confirmed (requires_capture) or in another terminal state — return booking as-is
    const updatedBooking = await getBookingById(bookingId);
    return updatedBooking!;
  }

  // Confirm the PaymentIntent; use test card only outside production
  const confirmParams: Stripe.PaymentIntentConfirmParams = {};
  if (process.env.NODE_ENV !== 'production') {
    confirmParams.payment_method = 'pm_card_visa';
  }
  await stripe.paymentIntents.confirm(paymentIntentId, confirmParams);

  // Record that Stripe has confirmed the hold (requires_capture state — funds actually held).
  // This is the source of truth for "payment held" in the driver's passenger list.
  await pool.query(
    `UPDATE bookings SET payment_confirmed_at = NOW(), updated_at = current_timestamp WHERE booking_id = $1`,
    [bookingId]
  );

  const updatedBooking = await getBookingById(bookingId);
  return updatedBooking!;
};

/**
 * Cancel an unconfirmed PaymentIntent when a rider backs out of the payment sheet.
 * Clears payment_intent_id so the driver does not see a false "payment held" state.
 */
export const cancelPaymentIntent = async (
  bookingId: string,
  riderId: string
): Promise<void> => {
  const intentResult = await pool.query(
    'SELECT payment_intent_id, rider_id FROM bookings WHERE booking_id = $1',
    [bookingId]
  );
  const row = intentResult.rows[0];
  if (!row) throw new AppError('Booking not found', 404);
  if (row.rider_id !== riderId) throw new AppError('Unauthorized', 403);

  const intentId: string | null = row.payment_intent_id;
  if (intentId) {
    try {
      const intent = await stripe.paymentIntents.retrieve(intentId);
      const cancellable = ['requires_payment_method', 'requires_confirmation', 'requires_action'];
      if (cancellable.includes(intent.status)) {
        await stripe.paymentIntents.cancel(intentId);
      }
    } catch (err: any) {
      console.warn(`[CANCEL_INTENT] Stripe cancel skipped for ${intentId}: ${err?.message}`);
    }
  }

  await pool.query(
    `UPDATE bookings
     SET payment_intent_id = NULL, payment_authorized_at = NULL, updated_at = current_timestamp
     WHERE booking_id = $1`,
    [bookingId]
  );
};

/**
 * Capture authorized payment when trip completes (driver or server-side)
 * @param bookingId Booking's UUID
 * @param driverId Driver's UUID (for authorization) — pass undefined for server-side calls
 * @returns Updated booking
 */
export const capturePayment = async (
  bookingId: string,
  driverId: string
): Promise<BookingWithDetails> => {
  const bookingData = await getBookingById(bookingId);
  if (!bookingData) {
    throw new AppError('Booking not found', 404);
  }

  if (bookingData.trip.driver_id !== driverId) {
    throw new AppError('Unauthorized: Only the driver can capture payment', 403);
  }

  const intentIdResult = await pool.query(
    'SELECT payment_intent_id FROM bookings WHERE booking_id = $1',
    [bookingId]
  );
  const paymentIntentId = intentIdResult.rows[0]?.payment_intent_id;

  if (!paymentIntentId) {
    // No payment on file — still mark booking completed so earnings queries work
    await pool.query(
      `UPDATE bookings SET booking_state = 'completed', updated_at = current_timestamp WHERE booking_id = $1`,
      [bookingId]
    );
    const updatedBooking = await getBookingById(bookingId);
    return updatedBooking!;
  }

  // Partial capture: use final_price if written, otherwise capture full hold
  const quoteResult = await pool.query(
    'SELECT final_price, max_price FROM quotes WHERE booking_id = $1',
    [bookingId]
  );
  const finalPrice = quoteResult.rows[0]?.final_price
    ? parseFloat(quoteResult.rows[0].final_price)
    : undefined;
  const holdAmount = quoteResult.rows[0]?.max_price
    ? parseFloat(quoteResult.rows[0].max_price)
    : undefined;

  const captureOptions = finalPrice
    ? { amount_to_capture: Math.round(finalPrice * 100) }
    : undefined;

  let captureSucceeded = false;
  try {
    await stripe.paymentIntents.capture(paymentIntentId, captureOptions);
    captureSucceeded = true;
  } catch (stripeErr) {
    console.error(`[CAPTURE] Stripe capture failed for booking ${bookingId}:`, stripeErr);
  }

  // Credit driver earnings and mark payment — only when Stripe succeeded
  const capturedAmount = finalPrice ?? holdAmount;
  if (capturedAmount && captureSucceeded) {
    await pool.query(
      `UPDATE users
       SET earnings = COALESCE(earnings, 0) + $1, updated_at = current_timestamp
       WHERE user_id = $2`,
      [capturedAmount, driverId]
    ).catch(() => {});

    await pool.query(
      `INSERT INTO payments (booking_id, stripe_payment_intent_id, amount, status)
       VALUES ($1, $2, $3, 'captured')
       ON CONFLICT (stripe_payment_intent_id) DO UPDATE
         SET status = 'captured', amount = $3, updated_at = current_timestamp`,
      [bookingId, paymentIntentId, capturedAmount]
    ).catch(() => {});
  }

  // Always mark the booking completed — the trip is done regardless of Stripe state
  await pool.query(
    `UPDATE bookings
     SET booking_state = 'completed', updated_at = current_timestamp
     WHERE booking_id = $1`,
    [bookingId]
  );

  const updatedBooking = await getBookingById(bookingId);
  return updatedBooking!;
};

/**
 * Write final_price to the quotes row for a booking (called by trip-service on completion)
 */
export const writeFinalPrice = async (bookingId: string, finalPrice: number): Promise<void> => {
  await pool.query(
    `UPDATE quotes SET final_price = $1 WHERE booking_id = $2`,
    [finalPrice, bookingId]
  );
};

/**
 * Confirm that a rider is in the car (rider only)
 * Idempotent: repeated calls preserve the original timestamp
 * @param bookingId Booking's UUID
 * @param riderId Rider's UUID (for authorization)
 * @returns Updated booking row
 */
export const confirmRiderPickup = async (
  bookingId: string,
  riderId: string
): Promise<object> => {
  // Fetch booking to validate ownership and state
  const check = await pool.query(
    `SELECT booking_id, rider_id, booking_state, rider_pickup_confirmed_at
     FROM bookings
     WHERE booking_id = $1 AND deleted_at IS NULL`,
    [bookingId]
  );
  if (check.rowCount === 0) {
    throw new AppError('Booking not found', 404);
  }
  const row = check.rows[0];
  if (row.rider_id !== riderId) {
    throw new AppError('Unauthorized', 403);
  }
  if (row.booking_state !== 'approved') {
    throw new AppError('Booking is not in an approved state', 409);
  }

  // Idempotent: COALESCE preserves existing timestamp on repeated calls
  const result = await pool.query(
    `UPDATE bookings
     SET rider_pickup_confirmed_at = COALESCE(rider_pickup_confirmed_at, NOW()),
         updated_at = current_timestamp
     WHERE booking_id = $1
     RETURNING booking_id, trip_id, rider_id, booking_state, rider_pickup_confirmed_at, updated_at`,
    [bookingId]
  );
  return result.rows[0];
};

export default {
  createBooking,
  getBookingById,
  listUserBookings,
  confirmBooking,
  cancelBooking,
  createRating,
  updatePickupLocation,
  getBookingsByTripId,
  approveBooking,
  rejectBooking,
  deleteBooking,
  authorizePayment,
  confirmPayment,
  capturePayment,
  cancelPaymentIntent,
  writeFinalPrice,
  confirmRiderPickup,
};
