import { Pool } from 'pg';
import axios from 'axios';
import { config } from '../config';
import { Trip, TripWithDriver, CreateTripRequest, TripStatus, GeoPoint, AppError } from '@lessgo/shared';
import { geocodeTripLocations } from '../utils/geocoding';
import { mineFrequentRouteFromTrip } from './frequent_route.service';
import {
  rankWithEmbedding,
  computeScost,
  haversineMeters,
  TripRequestRow,
  CandidateTrip,
} from './matching.service';

/** Returns true if the departure is within 1 hour from now (the lock window). */
const isWithinOneHour = (departureTime: Date): boolean =>
  departureTime.getTime() - Date.now() <= 60 * 60 * 1000;

const pool = new Pool({
  connectionString: config.databaseUrl,
});

/**
 * Check if a driver has overlapping trips
 * @param driverId Driver's UUID
 * @param originPoint Origin coordinates
 * @param destinationPoint Destination coordinates
 * @param departureTime Trip departure time
 * @throws Error if overlap detected
 */
const checkTripOverlap = async (
  driverId: string,
  originPoint: GeoPoint,
  destinationPoint: GeoPoint,
  departureTime: Date,
  originAddress?: string,
  destinationAddress?: string
): Promise<void> => {
  // Calculate distance using Haversine formula
  const R = 3959; // Earth radius in miles
  const lat1 = (originPoint.lat * Math.PI) / 180;
  const lat2 = (destinationPoint.lat * Math.PI) / 180;
  const deltaLat = ((destinationPoint.lat - originPoint.lat) * Math.PI) / 180;
  const deltaLng = ((destinationPoint.lng - originPoint.lng) * Math.PI) / 180;

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceMiles = R * c;

  // Estimate duration: 2.5 min/mile (conservative estimate for Bay Area traffic)
  const estimatedDurationMinutes = Math.ceil(distanceMiles * 2.5);

  // Query for overlapping pending trips
  const overlapQuery = `
    SELECT trip_id, origin, destination, departure_time
    FROM trips
    WHERE driver_id = $1
      AND status = 'pending'
      AND deleted_at IS NULL
      AND (
        (departure_time BETWEEN $2 AND ($2 + INTERVAL '${estimatedDurationMinutes} minutes'))
        OR
        ($2 BETWEEN departure_time AND (departure_time + INTERVAL '2 hours'))
      )
  `;

  const result = await pool.query(overlapQuery, [driverId, departureTime]);

  if (result.rows.length > 0) {
    const existingTrip = result.rows[0];
    const existingTime = new Date(existingTrip.departure_time).toLocaleString('en-US', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
    throw new Error(
      `You already have a trip scheduled at ${existingTime}. Please choose a different time.`
    );
  }

  // Check for exact duplicate: same origin address, destination address, and departure_time
  if (originAddress && destinationAddress) {
    const exactDuplicateQuery = `
      SELECT trip_id
      FROM trips
      WHERE driver_id = $1
        AND origin = $2
        AND destination = $3
        AND departure_time = $4
        AND status NOT IN ('cancelled')
        AND deleted_at IS NULL
      LIMIT 1
    `;

    const exactResult = await pool.query(exactDuplicateQuery, [
      driverId,
      originAddress,
      destinationAddress,
      departureTime,
    ]);

    if (exactResult.rows.length > 0) {
      throw new AppError('A trip with this exact route and time already exists.', 409);
    }
  }
};

/**
 * Create a new trip
 * @param driverId Driver's UUID
 * @param tripData Trip creation data
 * @returns Created trip
 */
export const createTrip = async (
  driverId: string,
  tripData: CreateTripRequest
): Promise<Trip> => {
  const { origin, destination, departure_time, seats_available, recurrence } = tripData;

  // Geocode origin and destination
  const { originPoint, destinationPoint } = await geocodeTripLocations(origin, destination);

  // Check for overlapping trips (and exact duplicates)
  await checkTripOverlap(driverId, originPoint, destinationPoint, new Date(departure_time), origin, destination);

  const query = `
    INSERT INTO trips (
      driver_id, origin, destination, origin_point, destination_point,
      departure_time, seats_available, recurrence, status
    )
    VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), ST_SetSRID(ST_MakePoint($6, $7), 4326), $8, $9, $10, $11)
    RETURNING
      trip_id, driver_id, origin, destination,
      ST_X(origin_point::geometry) as origin_lng,
      ST_Y(origin_point::geometry) as origin_lat,
      ST_X(destination_point::geometry) as destination_lng,
      ST_Y(destination_point::geometry) as destination_lat,
      departure_time, seats_available, recurrence, status, created_at, updated_at
  `;

  const values = [
    driverId,
    origin,
    destination,
    originPoint.lng,
    originPoint.lat,
    destinationPoint.lng,
    destinationPoint.lat,
    departure_time,
    seats_available,
    recurrence || null,
    TripStatus.Pending,
  ];

  const result = await pool.query(query, values);
  const trip = result.rows[0];

  return {
    ...trip,
    origin_point: { lat: trip.origin_lat, lng: trip.origin_lng },
    destination_point: { lat: trip.destination_lat, lng: trip.destination_lng },
  };
};

/**
 * Get trip by ID
 * @param tripId Trip's UUID
 * @returns Trip if found, null otherwise
 */
export const getTripById = async (tripId: string): Promise<TripWithDriver | null> => {
  const query = `
    SELECT
      t.trip_id, t.driver_id, t.origin, t.destination,
      ST_X(t.origin_point::geometry) as origin_lng,
      ST_Y(t.origin_point::geometry) as origin_lat,
      ST_X(t.destination_point::geometry) as destination_lng,
      ST_Y(t.destination_point::geometry) as destination_lat,
      t.departure_time, t.seats_available, t.recurrence, t.status,
      t.created_at, t.updated_at,
      COALESCE((
        SELECT SUM(COALESCE(q.final_price, q.max_price))
        FROM quotes q
        JOIN bookings b ON q.booking_id = b.booking_id
        WHERE b.trip_id = t.trip_id
          AND b.booking_state = 'completed'
      ), 0) AS total_payout,
      u.user_id as driver_user_id,
      u.name as driver_name,
      u.email as driver_email,
      u.role as driver_role,
      u.sjsu_id_status as driver_sjsu_id_status,
      u.rating as driver_rating,
      u.vehicle_info as driver_vehicle_info,
      u.seats_available as driver_seats_available,
      u.profile_picture_url as driver_profile_picture_url,
      u.created_at as driver_created_at,
      u.updated_at as driver_updated_at
    FROM trips t
    JOIN users u ON t.driver_id = u.user_id
    WHERE t.trip_id = $1 AND t.deleted_at IS NULL
  `;

  const result = await pool.query(query, [tripId]);

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  return {
    trip_id: row.trip_id,
    driver_id: row.driver_id,
    origin: row.origin,
    destination: row.destination,
    origin_point: { lat: row.origin_lat, lng: row.origin_lng },
    destination_point: { lat: row.destination_lat, lng: row.destination_lng },
    departure_time: row.departure_time,
    seats_available: row.seats_available,
    recurrence: row.recurrence,
    status: row.status,
    total_payout: parseFloat(row.total_payout || '0'),
    created_at: row.created_at,
    updated_at: row.updated_at,
    driver: {
      user_id: row.driver_user_id,
      name: row.driver_name,
      email: row.driver_email,
      role: row.driver_role,
      sjsu_id_status: row.driver_sjsu_id_status,
      rating: row.driver_rating,
      vehicle_info: row.driver_vehicle_info,
      seats_available: row.driver_seats_available,
      profile_picture_url: row.driver_profile_picture_url,
      created_at: row.driver_created_at,
      updated_at: row.driver_updated_at,
    },
  };
};

/**
 * Search for trips near a location with geospatial query
 * @param originLat Origin latitude
 * @param originLng Origin longitude
 * @param radiusMeters Search radius in meters
 * @param filters Additional filters
 * @param limit Number of results to return
 * @param offset Number of results to skip
 * @returns Array of matching trips
 */
export const searchTripsNearby = async (
  originLat: number,
  originLng: number,
  radiusMeters: number = config.defaultSearchRadius,
  filters?: {
    minSeats?: number;
    departureAfter?: Date;
    departureBefore?: Date;
    status?: TripStatus;
  },
  limit: number = 10,
  offset: number = 0
): Promise<TripWithDriver[]> => {
  let query = `
    SELECT
      t.trip_id, t.driver_id, t.origin, t.destination,
      ST_X(t.origin_point::geometry) as origin_lng,
      ST_Y(t.origin_point::geometry) as origin_lat,
      ST_X(t.destination_point::geometry) as destination_lng,
      ST_Y(t.destination_point::geometry) as destination_lat,
      t.departure_time, t.seats_available, t.recurrence, t.status,
      t.featured, t.created_at, t.updated_at,
      ST_Distance(
        t.origin_point::geography,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
      ) as distance_meters,
      u.user_id as driver_user_id,
      u.name as driver_name,
      u.email as driver_email,
      u.role as driver_role,
      u.sjsu_id_status as driver_sjsu_id_status,
      u.rating as driver_rating,
      u.vehicle_info as driver_vehicle_info,
      u.profile_picture_url as driver_profile_picture_url,
      u.created_at as driver_created_at,
      u.updated_at as driver_updated_at
    FROM trips t
    JOIN users u ON t.driver_id = u.user_id
    WHERE t.deleted_at IS NULL AND (
      ST_DWithin(
        t.origin_point::geography,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )
      OR
      ST_DWithin(
        t.destination_point::geography,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )
    )
  `;

  const values: (string | number | Date | TripStatus)[] = [originLng, originLat, radiusMeters];
  let paramIndex = 4;

  // Add filters
  if (filters?.status) {
    query += ` AND t.status = $${paramIndex}`;
    values.push(filters.status);
    paramIndex++;
  } else {
    query += ` AND t.status = $${paramIndex}`;
    values.push(TripStatus.Pending);
    paramIndex++;
  }

  if (filters?.minSeats) {
    query += ` AND t.seats_available >= $${paramIndex}`;
    values.push(filters.minSeats);
    paramIndex++;
  }

  if (filters?.departureAfter) {
    query += ` AND t.departure_time >= $${paramIndex}`;
    values.push(filters.departureAfter);
    paramIndex++;
  }

  if (filters?.departureBefore) {
    query += ` AND t.departure_time <= $${paramIndex}`;
    values.push(filters.departureBefore);
    paramIndex++;
  }

  // Exclude trips departing within 1 hour (pg_cron removes unpaid/unapproved riders at that point)
  query += ` AND t.departure_time > NOW() + INTERVAL '1 hour'`;

  query += ` ORDER BY distance_meters ASC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
  values.push(limit);
  values.push(offset);

  const result = await pool.query(query, values);

  return result.rows.map((row) => ({
    trip_id: row.trip_id,
    driver_id: row.driver_id,
    origin: row.origin,
    destination: row.destination,
    origin_point: { lat: row.origin_lat, lng: row.origin_lng },
    destination_point: { lat: row.destination_lat, lng: row.destination_lng },
    departure_time: row.departure_time,
    seats_available: row.seats_available,
    recurrence: row.recurrence,
    status: row.status,
    featured: row.featured ?? false,
    created_at: row.created_at,
    updated_at: row.updated_at,
    driver: {
      user_id: row.driver_user_id,
      name: row.driver_name,
      email: row.driver_email,
      role: row.driver_role,
      sjsu_id_status: row.driver_sjsu_id_status,
      rating: row.driver_rating,
      vehicle_info: row.driver_vehicle_info,
      profile_picture_url: row.driver_profile_picture_url,
      created_at: row.driver_created_at,
      updated_at: row.driver_updated_at,
    },
  }));
};

/**
 * List trips with filters
 * @param filters Query filters
 * @returns Array of trips
 */
export const listTrips = async (filters?: {
  driverId?: string;
  status?: TripStatus;
  departureAfter?: Date;
  limit?: number;
}): Promise<TripWithDriver[]> => {
  let query = `
    SELECT
      t.trip_id, t.driver_id, t.origin, t.destination,
      ST_X(t.origin_point::geometry) as origin_lng,
      ST_Y(t.origin_point::geometry) as origin_lat,
      ST_X(t.destination_point::geometry) as destination_lng,
      ST_Y(t.destination_point::geometry) as destination_lat,
      t.departure_time, t.seats_available, t.max_riders, t.recurrence, t.status,
      t.created_at, t.updated_at,
      (SELECT COUNT(*) FROM bookings b WHERE b.trip_id = t.trip_id AND b.booking_state = 'pending') AS pending_booking_count,
      COALESCE((
        SELECT SUM(COALESCE(q.final_price, q.max_price))
        FROM quotes q
        JOIN bookings b ON q.booking_id = b.booking_id
        WHERE b.trip_id = t.trip_id
          AND b.booking_state = 'completed'
      ), 0) AS total_payout,
      COALESCE((
        SELECT SUM(q.max_price)
        FROM quotes q
        JOIN bookings b ON q.booking_id = b.booking_id
        WHERE b.trip_id = t.trip_id
          AND b.booking_state = 'approved'
          AND NOT EXISTS (
            SELECT 1 FROM payments p2
            WHERE p2.booking_id = b.booking_id AND p2.status = 'captured'
          )
      ), 0) AS total_quoted,
      u.user_id as driver_user_id,
      u.name as driver_name,
      u.email as driver_email,
      u.role as driver_role,
      u.sjsu_id_status as driver_sjsu_id_status,
      u.rating as driver_rating,
      u.vehicle_info as driver_vehicle_info,
      u.profile_picture_url as driver_profile_picture_url,
      u.created_at as driver_created_at,
      u.updated_at as driver_updated_at
    FROM trips t
    JOIN users u ON t.driver_id = u.user_id
    WHERE t.deleted_at IS NULL
  `;

  const values: any[] = [];
  let paramIndex = 1;

  if (filters?.driverId) {
    query += ` AND t.driver_id = $${paramIndex}`;
    values.push(filters.driverId);
    paramIndex++;
  }

  if (filters?.status) {
    query += ` AND t.status = $${paramIndex}`;
    values.push(filters.status);
    paramIndex++;
  }

  if (filters?.departureAfter) {
    query += ` AND t.departure_time >= $${paramIndex}`;
    values.push(filters.departureAfter);
    paramIndex++;
  }

  query += ` ORDER BY t.departure_time ASC`;

  if (filters?.limit) {
    query += ` LIMIT $${paramIndex}`;
    values.push(filters.limit);
  } else {
    query += ` LIMIT 100`;
  }

  const result = await pool.query(query, values);

  return result.rows.map((row) => ({
    trip_id: row.trip_id,
    driver_id: row.driver_id,
    origin: row.origin,
    destination: row.destination,
    origin_point: { lat: row.origin_lat, lng: row.origin_lng },
    destination_point: { lat: row.destination_lat, lng: row.destination_lng },
    departure_time: row.departure_time,
    seats_available: row.seats_available,
    max_riders: row.max_riders ? parseInt(row.max_riders, 10) : undefined,
    recurrence: row.recurrence,
    status: row.status,
    pending_booking_count: parseInt(row.pending_booking_count, 10),
    total_payout: parseFloat(row.total_payout || '0'),
    total_quoted: parseFloat(row.total_quoted || '0'),
    created_at: row.created_at,
    updated_at: row.updated_at,
    driver: {
      user_id: row.driver_user_id,
      name: row.driver_name,
      email: row.driver_email,
      role: row.driver_role,
      sjsu_id_status: row.driver_sjsu_id_status,
      rating: row.driver_rating,
      vehicle_info: row.driver_vehicle_info,
      profile_picture_url: row.driver_profile_picture_url,
      created_at: row.driver_created_at,
      updated_at: row.driver_updated_at,
    },
  }));
};

/**
 * Update trip
 * @param tripId Trip's UUID
 * @param driverId Driver's UUID (for authorization)
 * @param updates Trip updates
 * @returns Updated trip
 */
export const updateTrip = async (
  tripId: string,
  driverId: string,
  updates: Partial<CreateTripRequest>
): Promise<Trip> => {
  // Verify trip belongs to driver
  const trip = await getTripById(tripId);
  if (!trip) {
    throw new Error('Trip not found');
  }
  if (trip.driver_id !== driverId) {
    throw new Error('Unauthorized');
  }

  const fields: string[] = [];
  const values: (string | number | Date | TripStatus | undefined)[] = [];
  let paramIndex = 1;

  if (updates.departure_time) {
    fields.push(`departure_time = $${paramIndex}`);
    values.push(updates.departure_time);
    paramIndex++;
  }

  if (updates.seats_available !== undefined) {
    fields.push(`seats_available = $${paramIndex}`);
    values.push(updates.seats_available);
    paramIndex++;
  }

  if (updates.recurrence !== undefined) {
    fields.push(`recurrence = $${paramIndex}`);
    values.push(updates.recurrence);
    paramIndex++;
  }

  if (fields.length === 0) {
    throw new Error('No fields to update');
  }

  fields.push(`updated_at = current_timestamp`);
  values.push(tripId);

  const query = `
    UPDATE trips
    SET ${fields.join(', ')}
    WHERE trip_id = $${paramIndex}
    RETURNING
      trip_id, driver_id, origin, destination,
      ST_X(origin_point::geometry) as origin_lng,
      ST_Y(origin_point::geometry) as origin_lat,
      ST_X(destination_point::geometry) as destination_lng,
      ST_Y(destination_point::geometry) as destination_lat,
      departure_time, seats_available, recurrence, status, created_at, updated_at
  `;

  const result = await pool.query(query, values);
  const updatedTrip = result.rows[0];

  return {
    ...updatedTrip,
    origin_point: { lat: updatedTrip.origin_lat, lng: updatedTrip.origin_lng },
    destination_point: { lat: updatedTrip.destination_lat, lng: updatedTrip.destination_lng },
  };
};

/**
 * Cancel trip (set status to cancelled)
 * Blocked within 1 hour of departure.
 * Cancels all active bookings and releases Stripe holds for paid riders.
 */
export const cancelTrip = async (tripId: string, driverId: string): Promise<Trip> => {
  const trip = await getTripById(tripId);
  if (!trip) throw new Error('Trip not found');
  if (trip.driver_id !== driverId) throw new Error('Unauthorized');

  if (isWithinOneHour(new Date(trip.departure_time))) {
    throw new AppError('Cannot cancel trip within 1 hour of departure', 423);
  }

  // Fetch all active bookings for this trip
  const bookingsResult = await pool.query<{
    booking_id: string;
    rider_id: string;
    seats_booked: number;
  }>(
    `SELECT booking_id, rider_id, seats_booked
     FROM bookings
     WHERE trip_id = $1
       AND booking_state NOT IN ('cancelled', 'rejected', 'completed')
       AND deleted_at IS NULL`,
    [tripId]
  );

  // Release Stripe holds via payment-service (fire-and-forget)
  axios.post(`${config.paymentServiceUrl}/payments/trip/${tripId}/cancel-intents`)
    .catch((err: any) => console.warn(`[cancelTrip] payment-service cancel-intents failed:`, err.message));

  // Bulk-cancel all active bookings
  if (bookingsResult.rows.length > 0) {
    await pool.query(
      `UPDATE bookings
       SET booking_state = 'cancelled',
           cancellation_reason = 'trip_cancelled_by_driver',
           updated_at = NOW()
       WHERE trip_id = $1
         AND booking_state NOT IN ('cancelled', 'rejected', 'completed')`,
      [tripId]
    );

    // Notify each affected rider (fire-and-forget)
    for (const b of bookingsResult.rows) {
      axios.post(`${config.notificationServiceUrl}/notifications/send`, {
        user_id: b.rider_id,
        type: 'trip_cancelled_by_driver',
        title: 'Trip Cancelled',
        message: `Your driver cancelled the trip from ${trip.origin} to ${trip.destination}. Any payment hold has been released.`,
        data: { trip_id: tripId },
      }).catch(() => {});
    }
  }

  const result = await pool.query(
    `UPDATE trips
     SET status = $1, updated_at = current_timestamp
     WHERE trip_id = $2
     RETURNING
       trip_id, driver_id, origin, destination,
       ST_X(origin_point::geometry) as origin_lng,
       ST_Y(origin_point::geometry) as origin_lat,
       ST_X(destination_point::geometry) as destination_lng,
       ST_Y(destination_point::geometry) as destination_lat,
       departure_time, seats_available, recurrence, status, created_at, updated_at`,
    [TripStatus.Cancelled, tripId]
  );
  const cancelledTrip = result.rows[0];

  return {
    ...cancelledTrip,
    origin_point: { lat: cancelledTrip.origin_lat, lng: cancelledTrip.origin_lng },
    destination_point: { lat: cancelledTrip.destination_lat, lng: cancelledTrip.destination_lng },
  };
};

/**
 * Check that all nearby approved riders have confirmed pickup before advancing the trip.
 * Throws AppError(409) if any rider within 50 m has not yet confirmed.
 */
const checkRiderConfirmations = async (tripId: string): Promise<void> => {
  // Get latest driver location (PostGIS geometry → lat/lng)
  const locResult = await pool.query(
    `SELECT ST_Y(location::geometry) as latitude,
            ST_X(location::geometry) as longitude
     FROM trip_locations
     WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [tripId]
  );
  if (locResult.rowCount === 0) return; // no location recorded yet — don't block

  const { latitude, longitude } = locResult.rows[0];

  // Get approved bookings that have shared a pickup location
  const bookingsResult = await pool.query(
    `SELECT booking_id, pickup_location, rider_pickup_confirmed_at
     FROM bookings
     WHERE trip_id = $1
       AND booking_state = 'approved'
       AND pickup_location IS NOT NULL
       AND deleted_at IS NULL`,
    [tripId]
  );

  const nearbyUnconfirmed = bookingsResult.rows.filter((b: any) => {
    const pickup = b.pickup_location;
    const dist = haversineMeters(latitude, longitude, pickup.lat, pickup.lng);
    return dist <= 50 && b.rider_pickup_confirmed_at == null;
  });

  if (nearbyUnconfirmed.length > 0) {
    throw new AppError('Waiting for rider confirmation before advancing', 409);
  }
};

/**
 * Core trip state update — performs the DB write without any confirmation gate.
 * Private helper; callers are updateTripState and updateTripStateForce.
 */
const _performTripStateUpdate = async (tripId: string, newStatus: TripStatus): Promise<any> => {
  // Determine which timestamp to update based on state
  let timestampField = '';

  switch (newStatus) {
    case TripStatus.EnRoute:
      timestampField = 'started_at = current_timestamp,';
      break;
    case TripStatus.Arrived:
      timestampField = 'arrived_at = current_timestamp,';
      break;
    case TripStatus.InProgress:
      timestampField = 'pickup_completed_at = current_timestamp,';
      break;
    case TripStatus.Completed:
      timestampField = 'completed_at = current_timestamp,';
      // Fire GPS trajectory mining in the background (non-blocking)
      setImmediate(() => mineFrequentRouteFromTrip(tripId).catch(console.error));
      break;
  }

  const query = `
    UPDATE trips
    SET status = $1,
        ${timestampField}
        updated_at = current_timestamp
    WHERE trip_id = $2
    RETURNING trip_id, driver_id, origin, destination,
      ST_X(origin_point::geometry) as origin_lng,
      ST_Y(origin_point::geometry) as origin_lat,
      ST_X(destination_point::geometry) as destination_lng,
      ST_Y(destination_point::geometry) as destination_lat,
      departure_time, seats_available, recurrence, status,
      started_at, arrived_at, pickup_completed_at, completed_at,
      created_at, updated_at
  `;

  const result = await pool.query(query, [newStatus, tripId]);
  const updatedTrip = result.rows[0];

  return {
    ...updatedTrip,
    origin_point: { lat: updatedTrip.origin_lat, lng: updatedTrip.origin_lng },
    destination_point: { lat: updatedTrip.destination_lat, lng: updatedTrip.destination_lng },
  };
};

/**
 * Update trip state (for real-time ride tracking)
 * Gates arrived → en_route and arrived → in_progress on rider pickup confirmation.
 * @param tripId Trip UUID
 * @param newStatus New trip status
 * @returns Updated trip
 */
export const updateTripState = async (tripId: string, newStatus: TripStatus): Promise<any> => {
  // Gate arrived → en_route and arrived → in_progress on rider confirmation
  if (newStatus === TripStatus.EnRoute || newStatus === TripStatus.InProgress) {
    const currentResult = await pool.query(
      `SELECT status FROM trips WHERE trip_id = $1`, [tripId]
    );
    const currentStatus = currentResult.rows[0]?.status;
    if (currentStatus === 'arrived') {
      await checkRiderConfirmations(tripId);
    }
  }

  return _performTripStateUpdate(tripId, newStatus);
};

/**
 * Force-update trip state without rider confirmation gate — debug/testing use only.
 * @param tripId Trip UUID
 * @param newStatus New trip status
 * @returns Updated trip
 */
export const updateTripStateForce = async (tripId: string, newStatus: TripStatus): Promise<any> => {
  return _performTripStateUpdate(tripId, newStatus);
};

/**
 * Update driver location for active trip
 * @param tripId Trip UUID
 * @param driverId Driver UUID
 * @param locationData Location data
 */
export const updateTripLocation = async (
  tripId: string,
  driverId: string,
  locationData: {
    latitude: number;
    longitude: number;
    heading?: number;
    speed?: number;
    accuracy?: number;
  }
): Promise<void> => {
  const query = `
    INSERT INTO trip_locations (trip_id, driver_id, location, heading, speed, accuracy)
    VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $6, $7)
  `;

  await pool.query(query, [
    tripId,
    driverId,
    locationData.longitude,
    locationData.latitude,
    locationData.heading || null,
    locationData.speed || null,
    locationData.accuracy || null,
  ]);

  console.log(`📍 Location updated for trip ${tripId}: (${locationData.latitude}, ${locationData.longitude})`);
};

/**
 * Get latest driver location for trip
 * @param tripId Trip UUID
 * @returns Latest location data
 */
export const getTripLocation = async (tripId: string): Promise<any> => {
  const query = `
    SELECT
      location_id,
      trip_id,
      driver_id,
      ST_Y(location::geometry) as latitude,
      ST_X(location::geometry) as longitude,
      heading,
      speed,
      accuracy,
      created_at
    FROM trip_locations
    WHERE trip_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const result = await pool.query(query, [tripId]);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
};

/**
 * Send a message in trip chat
 * @param tripId Trip UUID
 * @param senderId Sender UUID
 * @param messageText Message content
 * @returns Created message
 */
export const sendMessage = async (
  tripId: string,
  senderId: string,
  messageText: string,
  riderId?: string
): Promise<any> => {
  const query = `
    INSERT INTO messages (trip_id, sender_id, message_text, rider_id)
    VALUES ($1, $2, $3, $4)
    RETURNING message_id, trip_id, sender_id, message_text, created_at, read_at, rider_id
  `;

  const result = await pool.query(query, [tripId, senderId, messageText, riderId ?? null]);
  return result.rows[0];
};

/**
 * Get messages for a trip
 * @param tripId Trip UUID
 * @param limit Maximum number of messages to return
 * @returns Array of messages
 */
export const getTripMessages = async (tripId: string, riderId?: string, limit: number = 100): Promise<any[]> => {
  const query = `
    SELECT
      m.message_id,
      m.trip_id,
      m.sender_id,
      m.message_text,
      m.created_at,
      m.read_at,
      m.rider_id,
      u.name as sender_name,
      u.role as sender_role
    FROM messages m
    JOIN users u ON m.sender_id = u.user_id
    WHERE m.trip_id = $1
      AND ($2::uuid IS NULL OR m.rider_id = $2)
    ORDER BY m.created_at ASC
    LIMIT $3
  `;

  const result = await pool.query(query, [tripId, riderId ?? null, limit]);
  return result.rows;
};

/**
 * Mark messages as read
 * @param tripId Trip UUID
 * @param userId User ID (marks all messages NOT sent by this user as read)
 */
export const markMessagesAsRead = async (tripId: string, userId: string, riderId?: string): Promise<void> => {
  const query = `
    UPDATE messages
    SET read_at = current_timestamp
    WHERE trip_id = $1
      AND sender_id != $2
      AND ($3::uuid IS NULL OR rider_id = $3)
      AND read_at IS NULL
  `;

  await pool.query(query, [tripId, userId, riderId ?? null]);
};

/**
 * Check if a location is near SJSU
 * @param location Location address string
 * @param sjsuLat SJSU latitude
 * @param sjsuLng SJSU longitude
 * @param radiusMeters Search radius in meters
 * @returns True if location is within radius of SJSU
 */
export const isLocationNearSJSU = async (
  location: string,
  sjsuLat: number,
  sjsuLng: number,
  radiusMeters: number
): Promise<boolean> => {
  try {
    const { originPoint } = await geocodeTripLocations(location, location);

    // Calculate distance using Haversine formula
    const R = 3959; // Earth radius in miles
    const lat1 = (originPoint.lat * Math.PI) / 180;
    const lat2 = (sjsuLat * Math.PI) / 180;
    const deltaLat = ((sjsuLat - originPoint.lat) * Math.PI) / 180;
    const deltaLng = ((sjsuLng - originPoint.lng) * Math.PI) / 180;

    const a =
      Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distanceMiles = R * c;
    const distanceMeters = distanceMiles * 1609.34;

    return distanceMeters <= radiusMeters;
  } catch (error) {
    console.error('Error checking SJSU proximity:', error);
    return false;
  }
};

// ── ML-ranked search for posted rides with rerouting ────────────────────────

export interface CostBreakdown {
  trip_cost:       number;
  duration_hours:  number;
  detour_fee:      number;
  per_rider_split: number;
}

export interface EnrichedTripWithDriver extends TripWithDriver {
  origin_lat?: number;
  origin_lng?: number;
  detour_miles?: number;
  adjusted_eta_minutes?: number;
  original_eta_minutes?: number;
  detour_time_minutes?: number;
  cost_breakdown?: CostBreakdown;
}

export const searchTripsWithRerouting = async (
  originLat: number,
  originLng: number,
  destinationLat: number,
  destinationLng: number,
  departureTime: Date,
  filters?: {
    minSeats?: number;
    departureAfter?: Date;
    departureBefore?: Date;
  },
  limit: number = 10,
  offset: number = 0
): Promise<EnrichedTripWithDriver[]> => {
  // Stage 1: PostGIS proximity — reuse searchTripsNearby (top 20, 5km radius)
  const stage1 = await searchTripsNearby(
    originLat,
    originLng,
    5000,
    filters,
    20,
    0
  );

  if (stage1.length === 0) return [];

  // Build synthetic TripRequestRow for embedding + Scost stages
  const syntheticReq: TripRequestRow = {
    request_id: 'search',
    rider_id:   'search',
    origin_lat:       originLat,
    origin_lng:       originLng,
    destination_lat:  destinationLat,
    destination_lng:  destinationLng,
    departure_time:   departureTime,
    max_scost:        null,
  };

  // Map TripWithDriver → CandidateTrip shape expected by matching utilities
  const candidates: CandidateTrip[] = stage1.map(t => ({
    trip_id:           t.trip_id,
    driver_id:         t.driver_id,
    origin_lat:        t.origin_point.lat,
    origin_lng:        t.origin_point.lng,
    destination_lat:   t.destination_point.lat,
    destination_lng:   t.destination_point.lng,
    departure_time:    new Date(t.departure_time),
    seats_available:   t.seats_available,
    distance_to_rider_m: haversineMeters(originLat, originLng, t.origin_point.lat, t.origin_point.lng),
    route_score:       0,
  }));

  // Stage 2: embedding ranking
  const ranked = await rankWithEmbedding(syntheticReq, candidates);

  // Stage 3: Scost filter + sort
  const scored: Array<{ trip: TripWithDriver; candidate: CandidateTrip; scostTotal: number }> = [];

  for (const candidate of ranked) {
    const bd = computeScost(syntheticReq, candidate, 0, false);
    if (bd.total === Infinity) continue;

    const original = stage1.find(t => t.trip_id === candidate.trip_id);
    if (!original) continue;

    scored.push({ trip: original, candidate, scostTotal: bd.total });
  }

  scored.sort((a, b) => a.scostTotal - b.scostTotal);

  // Apply pagination after ML ranking
  const page = scored.slice(offset, offset + limit);

  // Enrich each result with detour_miles, adjusted_eta_minutes, cost_breakdown
  const enriched: EnrichedTripWithDriver[] = await Promise.all(
    page.map(async ({ trip, candidate }) => {
      const detourMeters = haversineMeters(originLat, originLng, candidate.origin_lat, candidate.origin_lng);
      const detourMiles = detourMeters / 1609.34;

      let adjustedEtaMinutes: number | undefined;
      let originalEtaMinutes: number | undefined;
      let detourTimeMinutes: number | undefined;
      let leg1DurationSec = 0;
      let leg2DurationSec = 0;
      let leg2DistanceMiles = 0;
      try {
        // Two-leg ETA: driver_origin → rider_pickup + rider_pickup → destination
        const [leg1, leg2] = await Promise.all([
          axios.post(`${config.routingServiceUrl}/route/calculate`, {
            origin:      `${candidate.origin_lat},${candidate.origin_lng}`,
            destination: `${originLat},${originLng}`,
          }, { timeout: 4000 }),
          axios.post(`${config.routingServiceUrl}/route/calculate`, {
            origin:      `${originLat},${originLng}`,
            destination: `${destinationLat},${destinationLng}`,
          }, { timeout: 4000 }),
        ]);
        leg1DurationSec   = leg1.data?.duration_seconds ?? 0;
        leg2DurationSec   = leg2.data?.duration_seconds ?? 0;
        leg2DistanceMiles = leg2.data?.distance_miles   ?? 0;
        detourTimeMinutes   = Math.round(leg1DurationSec / 60);
        originalEtaMinutes  = Math.round(leg2DurationSec / 60);
        adjustedEtaMinutes  = detourTimeMinutes + originalEtaMinutes;
      } catch {
        // Routing service unavailable — omit ETA
      }

      const durationHours       = (leg1DurationSec + leg2DurationSec) / 3600;
      const directDistanceMiles = leg2DistanceMiles > 0 ? leg2DistanceMiles : detourMiles;
      const tripCost            = parseFloat((directDistanceMiles * 0.67 + durationHours * 15.00).toFixed(2));
      const detourFee           = parseFloat((detourMiles * 0.67 * 1.25).toFixed(2));
      const perRiderSplit        = parseFloat((tripCost + detourFee).toFixed(2));

      return {
        ...trip,
        driver_name: trip.driver.name,
        driver_rating: trip.driver.rating,
        vehicle_info: trip.driver.vehicle_info,
        driver_photo_url: trip.driver.profile_picture_url,
        estimated_cost: perRiderSplit,
        origin_lat: candidate.origin_lat,
        origin_lng: candidate.origin_lng,
        detour_miles: parseFloat(detourMiles.toFixed(2)),
        adjusted_eta_minutes: adjustedEtaMinutes,
        original_eta_minutes: originalEtaMinutes,
        detour_time_minutes: detourTimeMinutes,
        cost_breakdown: {
          trip_cost:       tripCost,
          duration_hours:  parseFloat(durationHours.toFixed(4)),
          detour_fee:      detourFee,
          per_rider_split: perRiderSplit,
        },
      };
    })
  );

  return enriched;
};

/**
 * Soft delete a trip (set deleted_at = NOW())
 * Only allowed if status = 'cancelled' and requester is the driver
 * @param tripId Trip's UUID
 * @param driverId Requesting user's UUID
 */
export const deleteTrip = async (tripId: string, driverId: string): Promise<void> => {
  const trip = await getTripById(tripId);
  if (!trip) {
    throw new Error('Trip not found');
  }

  if (trip.driver_id !== driverId) {
    throw new AppError('Forbidden: You are not the driver of this trip', 403);
  }

  if (trip.status !== TripStatus.Cancelled && trip.status !== TripStatus.Completed) {
    throw new AppError('Trip can only be deleted when cancelled or completed', 400);
  }

  await pool.query(
    'UPDATE trips SET deleted_at = NOW() WHERE trip_id = $1',
    [tripId]
  );
};

/**
 * Remove all anchor points that belong to a specific rider from a trip's route.
 * Called after a payment-deadline cancellation so the route no longer includes
 * the removed rider's pickup/dropoff stops.
 *
 * @param tripId  Trip UUID
 * @param riderId Rider UUID to remove from the route
 */
export const removeRiderFromRoute = async (tripId: string, riderId: string): Promise<void> => {
  // Fetch current anchor_points
  const result = await pool.query<{ anchor_points: any[] }>(
    `SELECT COALESCE(anchor_points, '[]'::jsonb) AS anchor_points FROM trips WHERE trip_id = $1`,
    [tripId]
  );
  if (result.rows.length === 0) return;

  const currentAnchors: any[] = Array.isArray(result.rows[0].anchor_points)
    ? result.rows[0].anchor_points
    : [];

  const updatedAnchors = currentAnchors.filter((ap: any) => ap.rider_id !== riderId);

  // Only update if something was actually removed
  if (updatedAnchors.length < currentAnchors.length) {
    await pool.query(
      `UPDATE trips SET anchor_points = $1::jsonb, updated_at = NOW() WHERE trip_id = $2`,
      [JSON.stringify(updatedAnchors), tripId]
    );
    console.log(
      `[removeRiderFromRoute] Removed rider ${riderId} from trip ${tripId} route (${currentAnchors.length} → ${updatedAnchors.length} anchors)`
    );
  }
};

/**
 * Detect bookings cancelled by pg_cron jobs (payment_not_completed or driver_no_response),
 * update the trip route by removing the rider, and send appropriate notifications.
 *
 * Exposed as POST /trips/internal/process-deadline-cancellations.
 */
export const processDeadlineCancellations = async (): Promise<{ processed: number }> => {
  const query = `
    SELECT b.booking_id, b.trip_id, b.rider_id, b.seats_booked, b.cancellation_reason,
           u.email AS rider_email, u.name AS rider_name,
           t.origin, t.destination, t.departure_time, t.driver_id
    FROM bookings b
    JOIN users u ON b.rider_id = u.user_id
    JOIN trips  t ON b.trip_id = t.trip_id
    WHERE b.booking_state           = 'cancelled'
      AND b.cancellation_reason     IN ('payment_not_completed', 'driver_no_response')
      AND b.route_updated_after_cancel = FALSE
      AND b.deleted_at IS NULL
  `;

  const result = await pool.query(query);
  if (result.rows.length === 0) return { processed: 0 };

  for (const row of result.rows) {
    try {
      await removeRiderFromRoute(row.trip_id, row.rider_id);

      await pool.query(
        `UPDATE bookings SET route_updated_after_cancel = TRUE, updated_at = NOW() WHERE booking_id = $1`,
        [row.booking_id]
      );

      const otherRidersResult = await pool.query(
        `SELECT rider_id FROM bookings
         WHERE trip_id = $1
           AND booking_state IN ('pending', 'approved')
           AND rider_id != $2
           AND deleted_at IS NULL`,
        [row.trip_id, row.rider_id]
      );
      const otherPassengerIds: string[] = otherRidersResult.rows.map((r: any) => r.rider_id);

      const notifPayload = row.cancellation_reason === 'driver_no_response'
        ? {
            rider_id: row.rider_id,
            rider_email: row.rider_email,
            driver_id: row.driver_id,
            other_passenger_ids: otherPassengerIds,
            trip_origin: row.origin,
            trip_destination: row.destination,
            departure_time: row.departure_time,
            reason: 'driver_no_response',
            message: "Your ride request wasn't approved in time and has been automatically cancelled.",
          }
        : {
            rider_id: row.rider_id,
            rider_email: row.rider_email,
            driver_id: row.driver_id,
            other_passenger_ids: otherPassengerIds,
            trip_origin: row.origin,
            trip_destination: row.destination,
            departure_time: row.departure_time,
            reason: 'payment_not_completed',
          };

      axios.post(`${config.notificationServiceUrl}/notifications/send/payment-deadline-cancelled`, notifPayload)
        .catch((err: unknown) => {
          console.warn(`[processDeadlineCancellations] Notification failed for booking ${row.booking_id}:`, err);
        });

      console.log(`[processDeadlineCancellations] Processed booking ${row.booking_id} (reason: ${row.cancellation_reason})`);
    } catch (err) {
      console.error(`[processDeadlineCancellations] Error processing booking ${row.booking_id}:`, err);
    }
  }

  return { processed: result.rows.length };
};

export default {
  updateTripLocation,
  getTripLocation,
  createTrip,
  getTripById,
  searchTripsNearby,
  searchTripsWithRerouting,
  listTrips,
  updateTrip,
  cancelTrip,
  deleteTrip,
  updateTripState,
  sendMessage,
  getTripMessages,
  markMessagesAsRead,
  isLocationNearSJSU,
  removeRiderFromRoute,
  processDeadlineCancellations,
};
