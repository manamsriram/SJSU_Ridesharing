import Foundation

// MARK: - Booking Models

struct Booking: Codable, Identifiable {
    let id: String
    let tripId: String
    let riderId: String
    let seatsBooked: Int
    let status: BookingStatus
    let bookingState: BookingState
    let createdAt: Date
    let updatedAt: Date
    let holdExpiresAt: Date?
    let trip: Trip?
    let rider: User?
    let pickupLocation: PickupLocation?
    let quote: Quote?
    let payment: Payment?
    let fare: Double?
    let paymentIntentId: String?
    let paymentDeadlineAt: Date?
    let cancellationReason: String?
    let riderPickupConfirmedAt: Date?
    let paymentConfirmedAt: Date?

    var hasConfirmedPickup: Bool { riderPickupConfirmedAt != nil }

    enum CodingKeys: String, CodingKey {
        case id = "booking_id"
        case tripId = "trip_id"
        case riderId = "rider_id"
        case seatsBooked = "seats_booked"
        case status
        case bookingState = "booking_state"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case holdExpiresAt = "hold_expires_at"
        case trip, rider
        case pickupLocation = "pickup_location"
        case quote, payment, fare
        case paymentIntentId = "payment_intent_id"
        case paymentDeadlineAt = "payment_deadline_at"
        case cancellationReason = "cancellation_reason"
        case riderPickupConfirmedAt = "rider_pickup_confirmed_at"
        case paymentConfirmedAt = "payment_confirmed_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        tripId = try c.decode(String.self, forKey: .tripId)
        riderId = try c.decode(String.self, forKey: .riderId)
        seatsBooked = try c.decode(Int.self, forKey: .seatsBooked)
        status = try c.decode(BookingStatus.self, forKey: .status)
        // backend may omit booking_state for older endpoints — default to .pending
        bookingState = try c.decodeIfPresent(BookingState.self, forKey: .bookingState) ?? .pending
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        holdExpiresAt = try c.decodeIfPresent(Date.self, forKey: .holdExpiresAt)
        trip = try c.decodeIfPresent(Trip.self, forKey: .trip)
        rider = try c.decodeIfPresent(User.self, forKey: .rider)
        pickupLocation = try c.decodeIfPresent(PickupLocation.self, forKey: .pickupLocation)
        quote = try c.decodeIfPresent(Quote.self, forKey: .quote)
        payment = try c.decodeIfPresent(Payment.self, forKey: .payment)
        paymentIntentId = try c.decodeIfPresent(String.self, forKey: .paymentIntentId)
        paymentDeadlineAt = try c.decodeIfPresent(Date.self, forKey: .paymentDeadlineAt)
        cancellationReason = try c.decodeIfPresent(String.self, forKey: .cancellationReason)
        riderPickupConfirmedAt = try c.decodeIfPresent(Date.self, forKey: .riderPickupConfirmedAt)
        paymentConfirmedAt = try c.decodeIfPresent(Date.self, forKey: .paymentConfirmedAt)
        // fare = max_price from the quotes table, returned directly on the booking by some endpoints
        if let fareDouble = try? c.decode(Double.self, forKey: .fare) {
            fare = fareDouble
        } else if let fareString = try? c.decode(String.self, forKey: .fare), let parsed = Double(fareString) {
            fare = parsed
        } else {
            fare = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(tripId, forKey: .tripId)
        try c.encode(riderId, forKey: .riderId)
        try c.encode(seatsBooked, forKey: .seatsBooked)
        try c.encode(status, forKey: .status)
        try c.encode(bookingState, forKey: .bookingState)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encodeIfPresent(holdExpiresAt, forKey: .holdExpiresAt)
        try c.encodeIfPresent(trip, forKey: .trip)
        try c.encodeIfPresent(rider, forKey: .rider)
        try c.encodeIfPresent(pickupLocation, forKey: .pickupLocation)
        try c.encodeIfPresent(quote, forKey: .quote)
        try c.encodeIfPresent(payment, forKey: .payment)
        try c.encodeIfPresent(fare, forKey: .fare)
        try c.encodeIfPresent(paymentIntentId, forKey: .paymentIntentId)
        try c.encodeIfPresent(paymentDeadlineAt, forKey: .paymentDeadlineAt)
        try c.encodeIfPresent(cancellationReason, forKey: .cancellationReason)
        try c.encodeIfPresent(riderPickupConfirmedAt, forKey: .riderPickupConfirmedAt)
    }

    /// Returns a copy with status and bookingState forced to cancelled.
    func asCancelled() -> Booking {
        Booking(
            id: id, tripId: tripId, riderId: riderId, seatsBooked: seatsBooked,
            status: .cancelled, bookingState: .cancelled,
            createdAt: createdAt, updatedAt: Date(), holdExpiresAt: nil,
            trip: trip, rider: rider, pickupLocation: pickupLocation,
            quote: quote, payment: payment, fare: fare,
            paymentIntentId: paymentIntentId, paymentDeadlineAt: paymentDeadlineAt,
            cancellationReason: cancellationReason,
            riderPickupConfirmedAt: riderPickupConfirmedAt,
            paymentConfirmedAt: paymentConfirmedAt
        )
    }

    /// Returns a copy with updated mutable fields, preserving nested objects from the original.
    func merging(_ updated: Booking) -> Booking {
        Booking(
            id: id, tripId: tripId, riderId: riderId, seatsBooked: seatsBooked,
            status: updated.status,
            bookingState: updated.bookingState,
            createdAt: createdAt,
            updatedAt: updated.updatedAt,
            holdExpiresAt: updated.holdExpiresAt,
            trip: updated.trip ?? trip,
            rider: updated.rider ?? rider,
            pickupLocation: updated.pickupLocation ?? pickupLocation,
            quote: updated.quote ?? quote,
            payment: updated.payment ?? payment,
            fare: updated.fare ?? fare,
            paymentIntentId: updated.paymentIntentId ?? paymentIntentId,
            paymentDeadlineAt: updated.paymentDeadlineAt ?? paymentDeadlineAt,
            cancellationReason: updated.cancellationReason ?? cancellationReason,
            riderPickupConfirmedAt: updated.riderPickupConfirmedAt ?? riderPickupConfirmedAt,
            paymentConfirmedAt: updated.paymentConfirmedAt ?? paymentConfirmedAt
        )
    }

    private init(
        id: String, tripId: String, riderId: String, seatsBooked: Int,
        status: BookingStatus, bookingState: BookingState,
        createdAt: Date, updatedAt: Date, holdExpiresAt: Date?,
        trip: Trip?, rider: User?, pickupLocation: PickupLocation?,
        quote: Quote?, payment: Payment?, fare: Double?,
        paymentIntentId: String?, paymentDeadlineAt: Date?,
        cancellationReason: String?,
        riderPickupConfirmedAt: Date? = nil,
        paymentConfirmedAt: Date? = nil
    ) {
        self.id = id; self.tripId = tripId; self.riderId = riderId
        self.seatsBooked = seatsBooked; self.status = status
        self.bookingState = bookingState; self.createdAt = createdAt
        self.updatedAt = updatedAt; self.holdExpiresAt = holdExpiresAt
        self.trip = trip; self.rider = rider; self.pickupLocation = pickupLocation
        self.quote = quote; self.payment = payment; self.fare = fare
        self.paymentIntentId = paymentIntentId; self.paymentDeadlineAt = paymentDeadlineAt
        self.cancellationReason = cancellationReason
        self.riderPickupConfirmedAt = riderPickupConfirmedAt
        self.paymentConfirmedAt = paymentConfirmedAt
    }
}

enum BookingStatus: String, Codable {
    case pending
    case confirmed
    case cancelled
    case completed
}

// MARK: - Booking State (for driver approval flow)

enum BookingState: String, Codable {
    case pending = "pending"
    case approved = "approved"
    case rejected = "rejected"
    case cancelled = "cancelled"
    case completed = "completed"

    var displayName: String {
        switch self {
        case .pending: return "Awaiting Approval"
        case .approved: return "Confirmed"
        case .rejected: return "Declined"
        case .cancelled: return "Cancelled"
        case .completed: return "Completed"
        }
    }

    var iconName: String {
        switch self {
        case .pending: return "clock.fill"
        case .approved: return "checkmark.circle.fill"
        case .rejected: return "xmark.circle.fill"
        case .cancelled: return "xmark.circle"
        case .completed: return "checkmark.seal.fill"
        }
    }

    var color: String {
        switch self {
        case .pending: return "brandGold"
        case .approved: return "brandGreen"
        case .rejected: return "brandRed"
        case .cancelled: return "brandRed"
        case .completed: return "brandGreen"
        }
    }
}

struct Quote: Codable {
    let id: String
    let bookingId: String
    let maxPrice: Double
    let finalPrice: Double?
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id = "quote_id"
        case bookingId = "booking_id"
        case maxPrice = "max_price"
        case finalPrice = "final_price"
        case createdAt = "created_at"
    }

    // Postgres DECIMAL columns arrive as strings from the pg library.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id        = try c.decode(String.self, forKey: .id)
        bookingId = try c.decode(String.self, forKey: .bookingId)
        createdAt = try c.decode(Date.self, forKey: .createdAt)

        maxPrice  = Self.decodeDouble(c, key: .maxPrice) ?? 0.0
        finalPrice = Self.decodeDouble(c, key: .finalPrice)
    }

    private static func decodeDouble(_ c: KeyedDecodingContainer<CodingKeys>, key: CodingKeys) -> Double? {
        if let v = try? c.decode(Double.self, forKey: key) { return v }
        if let s = try? c.decode(String.self, forKey: key) { return Double(s) }
        return nil
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(bookingId, forKey: .bookingId)
        try c.encode(maxPrice, forKey: .maxPrice)
        try c.encodeIfPresent(finalPrice, forKey: .finalPrice)
        try c.encode(createdAt, forKey: .createdAt)
    }
}

// MARK: - Booking Request/Response Models

struct PickupLocationPayload: Codable {
    let lat: Double
    let lng: Double
    let address: String
}

struct CreateBookingRequest: Codable {
    let tripId: String
    let seatsBooked: Int
    let fare: Double?
    let pickupLocation: PickupLocationPayload?

    enum CodingKeys: String, CodingKey {
        case tripId = "trip_id"
        case seatsBooked = "seats_booked"
        case fare
        case pickupLocation = "pickup_location"
    }
}

struct CreateBookingResponse: Codable {
    let booking: Booking
    let quote: Quote?
}

struct BookingListResponse: Codable {
    let bookings: [Booking]
    let total: Int
}

// MARK: - Rating Models

struct Rating: Codable, Identifiable {
    let id: String
    let bookingId: String
    let raterId: String
    let rateeId: String
    let score: Int
    let comment: String?
    let createdAt: Date
    let rater: User?

    enum CodingKeys: String, CodingKey {
        case id = "rating_id"
        case bookingId = "booking_id"
        case raterId = "rater_id"
        case rateeId = "ratee_id"
        case score, comment
        case createdAt = "created_at"
        case rater
    }
}

struct CreateRatingRequest: Codable {
    let score: Int
    let comment: String?
}

// MARK: - Driver Models

struct BookingWithRider: Codable, Identifiable {
    let id: String
    let tripId: String
    let riderId: String
    let riderName: String
    let riderEmail: String?
    let riderPhone: String?
    let riderRating: Double
    let riderPicture: String?
    let seatsBooked: Int
    let status: BookingStatus
    let bookingState: BookingState
    let pickupLocation: PickupLocation?
    let createdAt: Date
    let holdExpiresAt: Date?
    let scostBreakdown: ScostBreakdown?
    let fare: Double?
    let paymentIntentId: String?
    let paymentDeadlineAt: Date?
    let paymentConfirmedAt: Date?
    let cancellationReason: String?
    let riderPickupConfirmedAt: Date?
    let dropoffConfirmedAt: Date?

    var hasConfirmedPickup: Bool { riderPickupConfirmedAt != nil }
    var hasConfirmedDropoff: Bool { dropoffConfirmedAt != nil }

    init(
        id: String, tripId: String, riderId: String,
        riderName: String, riderEmail: String?,
        riderPhone: String?, riderRating: Double,
        riderPicture: String?, seatsBooked: Int,
        status: BookingStatus, bookingState: BookingState,
        pickupLocation: PickupLocation?, createdAt: Date,
        holdExpiresAt: Date?, scostBreakdown: ScostBreakdown?,
        fare: Double?, paymentIntentId: String?,
        paymentDeadlineAt: Date? = nil,
        paymentConfirmedAt: Date? = nil,
        cancellationReason: String? = nil,
        riderPickupConfirmedAt: Date? = nil,
        dropoffConfirmedAt: Date? = nil
    ) {
        self.id = id; self.tripId = tripId; self.riderId = riderId
        self.riderName = riderName; self.riderEmail = riderEmail
        self.riderPhone = riderPhone; self.riderRating = riderRating
        self.riderPicture = riderPicture; self.seatsBooked = seatsBooked
        self.status = status; self.bookingState = bookingState
        self.pickupLocation = pickupLocation; self.createdAt = createdAt
        self.holdExpiresAt = holdExpiresAt; self.scostBreakdown = scostBreakdown
        self.fare = fare; self.paymentIntentId = paymentIntentId
        self.paymentDeadlineAt = paymentDeadlineAt
        self.paymentConfirmedAt = paymentConfirmedAt
        self.cancellationReason = cancellationReason
        self.riderPickupConfirmedAt = riderPickupConfirmedAt
        self.dropoffConfirmedAt = dropoffConfirmedAt
    }

    func withBookingState(_ newState: BookingState) -> BookingWithRider {
        BookingWithRider(
            id: id, tripId: tripId, riderId: riderId,
            riderName: riderName, riderEmail: riderEmail,
            riderPhone: riderPhone, riderRating: riderRating,
            riderPicture: riderPicture, seatsBooked: seatsBooked,
            status: status, bookingState: newState,
            pickupLocation: pickupLocation, createdAt: createdAt,
            holdExpiresAt: holdExpiresAt, scostBreakdown: scostBreakdown,
            fare: fare, paymentIntentId: paymentIntentId,
            paymentDeadlineAt: paymentDeadlineAt,
            paymentConfirmedAt: paymentConfirmedAt,
            cancellationReason: cancellationReason,
            riderPickupConfirmedAt: riderPickupConfirmedAt,
            dropoffConfirmedAt: dropoffConfirmedAt
        )
    }

    enum CodingKeys: String, CodingKey {
        case id
        case tripId = "trip_id"
        case riderId = "rider_id"
        case riderName = "rider_name"
        case riderEmail = "rider_email"
        case riderPhone = "rider_phone"
        case riderRating = "rider_rating"
        case riderPicture = "rider_picture"
        case seatsBooked = "seats_booked"
        case status
        case bookingState = "booking_state"
        case pickupLocation = "pickup_location"
        case createdAt = "created_at"
        case holdExpiresAt = "hold_expires_at"
        case scostBreakdown = "scost_breakdown"
        case fare
        case paymentIntentId = "payment_intent_id"
        case paymentDeadlineAt = "payment_deadline_at"
        case paymentConfirmedAt = "payment_confirmed_at"
        case cancellationReason = "cancellation_reason"
        case riderPickupConfirmedAt = "rider_pickup_confirmed_at"
        case dropoffConfirmedAt = "dropoff_confirmed_at"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        tripId = try container.decode(String.self, forKey: .tripId)
        riderId = try container.decode(String.self, forKey: .riderId)
        riderName = try container.decode(String.self, forKey: .riderName)
        riderEmail = try container.decodeIfPresent(String.self, forKey: .riderEmail)
        riderPhone = try container.decodeIfPresent(String.self, forKey: .riderPhone)
        riderPicture = try container.decodeIfPresent(String.self, forKey: .riderPicture)
        seatsBooked = try container.decode(Int.self, forKey: .seatsBooked)
        status = try container.decode(BookingStatus.self, forKey: .status)
        bookingState = try container.decodeIfPresent(BookingState.self, forKey: .bookingState) ?? .pending
        pickupLocation = try container.decodeIfPresent(PickupLocation.self, forKey: .pickupLocation)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        holdExpiresAt = try container.decodeIfPresent(Date.self, forKey: .holdExpiresAt)
        scostBreakdown = try container.decodeIfPresent(ScostBreakdown.self, forKey: .scostBreakdown)
        paymentIntentId = try container.decodeIfPresent(String.self, forKey: .paymentIntentId)
        paymentDeadlineAt = try container.decodeIfPresent(Date.self, forKey: .paymentDeadlineAt)
        paymentConfirmedAt = try container.decodeIfPresent(Date.self, forKey: .paymentConfirmedAt)
        cancellationReason = try container.decodeIfPresent(String.self, forKey: .cancellationReason)
        riderPickupConfirmedAt = try container.decodeIfPresent(Date.self, forKey: .riderPickupConfirmedAt)
        dropoffConfirmedAt = try container.decodeIfPresent(Date.self, forKey: .dropoffConfirmedAt)
        if let fareDouble = try? container.decode(Double.self, forKey: .fare) {
            fare = fareDouble
        } else if let fareString = try? container.decode(String.self, forKey: .fare), let parsed = Double(fareString) {
            fare = parsed
        } else {
            fare = nil
        }

        // Backend sends rating as String ("0.00") or occasionally as Double
        if let ratingDouble = try? container.decode(Double.self, forKey: .riderRating) {
            riderRating = ratingDouble
        } else if let ratingString = try? container.decode(String.self, forKey: .riderRating),
                  let parsed = Double(ratingString) {
            riderRating = parsed
        } else {
            riderRating = 0.0
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(tripId, forKey: .tripId)
        try c.encode(riderId, forKey: .riderId)
        try c.encode(riderName, forKey: .riderName)
        try c.encodeIfPresent(riderEmail, forKey: .riderEmail)
        try c.encodeIfPresent(riderPhone, forKey: .riderPhone)
        try c.encode(riderRating, forKey: .riderRating)
        try c.encodeIfPresent(riderPicture, forKey: .riderPicture)
        try c.encode(seatsBooked, forKey: .seatsBooked)
        try c.encode(status, forKey: .status)
        try c.encode(bookingState, forKey: .bookingState)
        try c.encodeIfPresent(pickupLocation, forKey: .pickupLocation)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(holdExpiresAt, forKey: .holdExpiresAt)
        try c.encodeIfPresent(scostBreakdown, forKey: .scostBreakdown)
        try c.encodeIfPresent(fare, forKey: .fare)
        try c.encodeIfPresent(paymentIntentId, forKey: .paymentIntentId)
        try c.encodeIfPresent(paymentDeadlineAt, forKey: .paymentDeadlineAt)
        try c.encodeIfPresent(cancellationReason, forKey: .cancellationReason)
        try c.encodeIfPresent(riderPickupConfirmedAt, forKey: .riderPickupConfirmedAt)
        try c.encodeIfPresent(dropoffConfirmedAt, forKey: .dropoffConfirmedAt)
    }
}

struct PickupLocation: Codable {
    let lat: Double
    let lng: Double
    let address: String?
}

// MARK: - Scost Breakdown Models

struct ScostBreakdown: Codable {
    let travel: Double
    let walk: Double
    let detour: Double
    let advance: Double
    let social: Double
    let total: Double
}

// Response wrapper for trip bookings endpoint
struct TripBookingsResponse: Codable {
    let bookings: [BookingWithRider]
    let total: Int
}
