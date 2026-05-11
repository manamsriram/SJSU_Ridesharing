import SwiftUI
import MapKit
import Combine
import CoreLocation

struct DriverTripDetailsView: View {
    let trip: Trip
    var onTripDeleted: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var authVM: AuthViewModel

    @State private var passengers: [BookingWithRider] = []
    @State private var isLoading = true
    @State private var isLoadingPassengers = false
    @State private var errorMessage: String?
    @State private var cancelTripError: String?
    @State private var chatDestination: DriverNotificationChatDestination?
    @State private var showCancelTripConfirm = false
    @State private var isCancellingTrip = false
    @State private var showDeleteTripConfirm = false
    @State private var isDeletingTrip = false
    @State private var deleteTripError: String?
    @State private var anchorPoints: [AnchorPoint] = []
    @State private var isLoadingAnchors = true
    @State private var showActiveTripView = false

    @State private var ratingTarget: BookingWithRider? = nil
    @State private var ratedBookingIds: Set<String> = []
    @State private var driverSelectedStars = 5
    @State private var driverRatingComment = ""
    @State private var isSubmittingDriverRating = false
    @State private var showSimulationView = false

    private func ratingForPassenger(_ bookingId: String) -> Int? {
        if ratedBookingIds.contains(bookingId) || UserDefaults.standard.bool(forKey: "driver_rated_\(bookingId)") {
            let score = UserDefaults.standard.integer(forKey: "driver_rating_score_\(bookingId)")
            return score > 0 ? score : 5
        }
        return nil
    }

    private var activePassengers: [BookingWithRider] {
        passengers.filter { $0.bookingState == .approved || $0.bookingState == .completed }
    }

    private var totalSeatsBooked: Int {
        activePassengers.reduce(0) { $0 + $1.seatsBooked }
    }

    private var totalEarnings: Double {
        if let payout = trip.totalPayout, payout > 0 {
            return payout
        }
        let fares = activePassengers.compactMap { $0.fare }
        return fares.reduce(0, +)
    }

    private var pendingBookings: [BookingWithRider] {
        passengers.filter { $0.bookingState == .pending }
    }

    private var isWithinOneHour: Bool {
        trip.departureTime.timeIntervalSinceNow <= 3600
    }

    private var approvedBookings: [BookingWithRider] {
        passengers.filter { $0.bookingState == .approved }
    }

    private var approvedPickupCoords: [CLLocationCoordinate2D] {
        approvedBookings.compactMap { booking in
            guard let pl = booking.pickupLocation else { return nil }
            return CLLocationCoordinate2D(latitude: pl.lat, longitude: pl.lng)
        }
    }

    @ViewBuilder
    private var routeMapWithPassengers: some View {
        let origin = trip.originPoint?.clLocationCoordinate2D
        let destination = trip.destinationPoint?.clLocationCoordinate2D

        // Use AnchorRouteMapView when we have anchor points, otherwise fall back to RouteMapView
        if !anchorPoints.isEmpty {
            AnchorRouteMapView(
                origin: origin,
                destination: destination,
                driver: nil,
                anchorPoints: anchorPoints,
                showsUserLocation: true
            )
        } else {
            // Fallback to existing RouteMapView for simple trips
            routeMapViewFallback(origin: origin, destination: destination)
        }
    }

    private func routeMapViewFallback(origin: CLLocationCoordinate2D?, destination: CLLocationCoordinate2D?) -> some View {
        let pickups = approvedPickupCoords
        let waypoint = pickups.first
        var fitCoords: [CLLocationCoordinate2D] = []
        if let o = origin { fitCoords.append(o) }
        if let d = destination { fitCoords.append(d) }
        fitCoords.append(contentsOf: pickups)

        return RouteMapView(
            origin: origin,
            destination: destination,
            driver: nil,
            waypoint: waypoint,
            riders: pickups,
            fitAnchors: fitCoords.isEmpty ? nil : fitCoords,
            showsUserLocation: true
        )
    }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 20) {
                    // Route map card
                    routeMapWithPassengers
                        .frame(height: 150)
                        .cornerRadius(12)
                        .disabled(true)
                        .padding(.top, 8)

                    // 1-hour lock disclaimer
                    if isWithinOneHour && (trip.status == .pending || trip.status == .enRoute) {
                        HStack(spacing: 10) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundColor(.brandGold)
                            Text("Trip operations are locked within 1 hour of departure.")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(.textPrimary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(14)
                        .background(Color.brandGold.opacity(0.12))
                        .cornerRadius(12)
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .strokeBorder(Color.brandGold.opacity(0.4), lineWidth: 1)
                        )
                    }

                    // Route itinerary card
                    routeItineraryCard

                    // Trip details card
                    tripDetailsCard

                    // Stats card
                    statsCard

                    // Passengers section
                    passengersSection

                    // Simulation controls (debug)
                    simulationControls
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .refreshable {
                await loadPassengers()
            }
            .background(Color.appBackground.ignoresSafeArea())
            .navigationTitle("Trip Passengers")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { dismiss() }) {
                        HStack(spacing: 4) {
                            Image(systemName: "xmark")
                        }
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.textPrimary)
                    }
                }

                ToolbarItem(placement: .navigationBarTrailing) {
                    if trip.status == .cancelled || trip.status == .completed {
                        Button(action: { showDeleteTripConfirm = true }) {
                            if isDeletingTrip {
                                ProgressView().scaleEffect(0.8)
                            } else {
                                Text("Delete Trip")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundColor(.brandRed)
                            }
                        }
                        .disabled(isDeletingTrip)
                    } else {
                        Button(action: { showCancelTripConfirm = true }) {
                            if isCancellingTrip {
                                ProgressView().scaleEffect(0.8)
                            } else {
                                Text(isWithinOneHour ? "Locked" : "Cancel Trip")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundColor(isWithinOneHour ? .textTertiary : .brandRed)
                            }
                        }
                        .disabled(isCancellingTrip || isWithinOneHour)
                    }
                }
            }
            .confirmationDialog("Cancel this trip?", isPresented: $showCancelTripConfirm, titleVisibility: .visible) {
                Button("Cancel Trip", role: .destructive) {
                    Task { await cancelTrip() }
                }
                Button("Keep Trip", role: .cancel) {}
            } message: {
                Text("This will cancel the trip and notify all passengers.")
            }
            .alert("Cancel Failed", isPresented: Binding(
                get: { cancelTripError != nil },
                set: { if !$0 { cancelTripError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(cancelTripError ?? "")
            }
            .confirmationDialog("Delete this trip?", isPresented: $showDeleteTripConfirm, titleVisibility: .visible) {
                Button("Delete Trip", role: .destructive) {
                    Task { await deleteTrip() }
                }
                Button("Keep", role: .cancel) {}
            } message: {
                Text("This will permanently remove the trip from your history.")
            }
            .alert("Delete Failed", isPresented: Binding(
                get: { deleteTripError != nil },
                set: { if !$0 { deleteTripError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(deleteTripError ?? "")
            }
        }
        .navigationViewStyle(.stack)
        .safeAreaInset(edge: .bottom) {
            let canStartTrip: Bool = {
                    if trip.status == .pending {
                        let now = Date()
                        let oneHourBefore = trip.departureTime.addingTimeInterval(-3600)
                        return Calendar.current.isDateInToday(trip.departureTime) && now >= oneHourBefore
                    }
                    return trip.status == .enRoute || trip.status == .arrived || trip.status == .inProgress
                }()
                if canStartTrip {
                Button(action: { showActiveTripView = true }) {
                    HStack(spacing: 8) {
                        Image(systemName: trip.status == .pending ? "car.fill" : "location.fill")
                        Text(trip.status == .pending ? "Start Trip" : "View Active Trip")
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Color.brand)
                    .foregroundColor(.white)
                    .cornerRadius(14)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                }
            }
        }
        .fullScreenCover(isPresented: $showActiveTripView) {
            NavigationView {
                ActiveTripView(trip: trip, isDriver: true)
                    .environmentObject(authVM)
            }
        }
        .fullScreenCover(isPresented: $showSimulationView) {
            NavigationView {
                ActiveTripView(trip: trip, isDriver: true, isSimulationMode: true)
                    .environmentObject(authVM)
            }
        }
        .task {
            await loadPassengers()
            await loadAnchorPoints()
        }
        .sheet(item: $chatDestination) { destination in
            ChatView(
                tripId: trip.id,
                otherPartyName: destination.otherPartyName,
                isDriver: true,
                riderId: destination.riderId,
                includesTabBarClearance: false
            )
            .environmentObject(authVM)
        }
        .sheet(item: $ratingTarget) { _ in
            passengerRatingSheet
        }
    }

    private var routeItineraryCard: some View {
        let approved = approvedBookings
        return VStack(spacing: 0) {
            HStack {
                Text("Route")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.textSecondary)
                Spacer()
            }
            .padding(.bottom, 12)

            routeStopRow(icon: "car.fill", iconColor: .brand, label: "Driver Start", address: trip.origin)
            routeConnector()

            if isLoading {
                HStack(spacing: 10) {
                    ProgressView()
                        .scaleEffect(0.7)
                        .frame(width: 26, height: 26)
                    Text("Loading rider pickups…")
                        .font(.system(size: 12))
                        .foregroundColor(.textTertiary)
                    Spacer()
                }
                routeConnector()
            } else {
                ForEach(approved) { passenger in
                    let addr = passenger.pickupLocation?.address ?? "Pickup location"
                    routeStopRow(
                        icon: "person.fill",
                        iconColor: .brandOrange,
                        label: "\(passenger.riderName)'s Pickup",
                        address: addr
                    )
                    routeConnector()
                }
            }

            routeStopRow(icon: "mappin.fill", iconColor: .brandGreen, label: "Final Dropoff", address: trip.destination)
        }
        .padding(16)
        .background(Color.cardBackground)
        .cornerRadius(16)
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(DesignSystem.Colors.border.opacity(0.7), lineWidth: 1)
        )
    }

    private func routeStopRow(icon: String, iconColor: Color, label: String, address: String) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 13))
                .foregroundColor(iconColor)
                .frame(width: 26, height: 26)
                .background(iconColor.opacity(0.12))
                .clipShape(Circle())
            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(iconColor)
                Text(address)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
    }

    private func routeConnector() -> some View {
        HStack(spacing: 0) {
            Spacer().frame(width: 12)
            Rectangle()
                .fill(DesignSystem.Colors.border.opacity(0.5))
                .frame(width: 2, height: 14)
            Spacer()
        }
    }

    private var tripDetailsCard: some View {
        VStack(spacing: 16) {
            detailRow(
                icon: "mappin.circle.fill",
                iconColor: .brand,
                title: "Pickup",
                value: trip.origin
            )
            Divider()
            detailRow(
                icon: "location.fill",
                iconColor: .brandGreen,
                title: "Drop-off",
                value: trip.destination
            )
            Divider()
            detailRow(
                icon: "clock",
                iconColor: .textSecondary,
                title: "Departure",
                value: formatDateTime(trip.departureTime)
            )
            Divider()
            detailRow(
                icon: "person.2.fill",
                iconColor: .textSecondary,
                title: "Seats Available",
                value: "\(trip.seatsAvailable)"
            )
        }
        .padding(16)
        .background(Color.cardBackground)
        .cornerRadius(16)
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(DesignSystem.Colors.border.opacity(0.7), lineWidth: 1)
        )
    }

    private func detailRow(icon: String, iconColor: Color, title: String, value: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundColor(iconColor)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 12))
                    .foregroundColor(.textSecondary)
                Text(value)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
    }

    private var statsCard: some View {
        let statusColor: Color = approvedBookings.isEmpty ? .brandGold : .brandGreen
        let statusLabel = approvedBookings.isEmpty ? "Pending" : "Confirmed"

        return VStack(spacing: 16) {
            detailRow(
                icon: "person.2.fill",
                iconColor: .brand,
                title: "Active Passengers",
                value: "\(totalSeatsBooked) booked / \(trip.seatsAvailable) seats"
            )
            Divider()
            detailRow(
                icon: "dollarsign.circle.fill",
                iconColor: .brandGreen,
                title: "Estimated Earnings",
                value: String(format: "$%.2f", totalEarnings)
            )
            Divider()
            HStack(spacing: 12) {
                Image(systemName: "circle.fill")
                    .font(.system(size: 10))
                    .foregroundColor(statusColor)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Status")
                        .font(.system(size: 12))
                        .foregroundColor(.textSecondary)
                    Text(statusLabel)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(.textPrimary)
                }
                Spacer()
            }
        }
        .padding(16)
        .background(Color.cardBackground)
        .cornerRadius(16)
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(DesignSystem.Colors.border.opacity(0.7), lineWidth: 1)
        )
    }

    private var passengersSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Passengers")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(.textPrimary)
                Spacer()
                if !pendingBookings.isEmpty {
                    Text("\(pendingBookings.count) pending")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.brandRed)
                }
            }

            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(48)
                    .background(Color.cardBackground)
                    .cornerRadius(16)
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .strokeBorder(DesignSystem.Colors.border.opacity(0.7), lineWidth: 1)
                    )
            } else if let error = errorMessage {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 32))
                        .foregroundColor(.brandRed)
                    Text(error)
                        .font(.system(size: 14))
                        .foregroundColor(.textSecondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(44)
                .background(Color.cardBackground)
                .cornerRadius(16)
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .strokeBorder(DesignSystem.Colors.border.opacity(0.7), lineWidth: 1)
                )
            } else if passengers.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "person.crop.circle.badge.questionmark")
                        .font(.system(size: 40))
                        .foregroundColor(.textTertiary)
                    Text("No passengers yet")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundColor(.textSecondary)
                    Text("Share your trip to get riders!")
                        .font(.system(size: 13))
                        .foregroundColor(.textTertiary)
                }
                .frame(maxWidth: .infinity)
                .padding(44)
                .background(Color.cardBackground)
                .cornerRadius(16)
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .strokeBorder(DesignSystem.Colors.border.opacity(0.7), lineWidth: 1)
                )
            } else {
                VStack(spacing: 12) {
                    if !pendingBookings.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Pending Requests")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(.brandRed)
                                .padding(.horizontal, 2)
                            ForEach(pendingBookings) { passenger in
                                PendingBookingCard(
                                    passenger: passenger,
                                    isLocked: isWithinOneHour,
                                    onApprove: { await approveBooking(passenger) },
                                    onReject: { await rejectBooking(passenger) },
                                    onChat: { openChat(with: passenger) }
                                )
                            }
                        }
                    }

                    let confirmedPassengers = passengers.filter {
                        $0.bookingState == .approved || $0.bookingState == .completed
                    }
                    ForEach(confirmedPassengers) { passenger in
                        PassengerCard(
                            passenger: passenger,
                            onChat: { openChat(with: passenger) },
                            onRate: passenger.bookingState == .completed && ratingForPassenger(passenger.id) == nil ? {
                                driverSelectedStars = 5
                                driverRatingComment = ""
                                ratingTarget = passenger
                            } : nil,
                            rating: passenger.bookingState == .completed ? ratingForPassenger(passenger.id) : nil
                        )
                    }
                }
            }
        }
    }

    private func formatDateTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    @ViewBuilder
    private var passengerRatingSheet: some View {
        NavigationView {
            VStack(spacing: 24) {
                if let target = ratingTarget {
                    VStack(spacing: 8) {
                        Circle()
                            .fill(Color.brand.opacity(0.12))
                            .frame(width: 72, height: 72)
                            .overlay(
                                Text(String(target.riderName.prefix(1)).uppercased())
                                    .font(.system(size: 28, weight: .bold))
                                    .foregroundColor(.brand)
                            )
                        Text(target.riderName)
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(.textPrimary)
                        Text("How was this passenger?")
                            .font(.system(size: 15))
                            .foregroundColor(.textSecondary)
                    }

                    HStack(spacing: 12) {
                        ForEach(1...5, id: \.self) { star in
                            Button(action: { driverSelectedStars = star }) {
                                Image(systemName: star <= driverSelectedStars ? "star.fill" : "star")
                                    .font(.system(size: 32))
                                    .foregroundColor(star <= driverSelectedStars ? .brandOrange : .textTertiary)
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Comment (optional)")
                            .font(.system(size: 13))
                            .foregroundColor(.textSecondary)
                        TextEditor(text: $driverRatingComment)
                            .frame(height: 80)
                            .padding(10)
                            .background(Color(.systemGray6))
                            .cornerRadius(10)
                    }
                    .padding(.horizontal)

                    Button(action: {
                        Task {
                            isSubmittingDriverRating = true
                            let comment = driverRatingComment.trimmingCharacters(in: .whitespacesAndNewlines)
                            do {
                                _ = try await BookingService.shared.rateBooking(
                                    id: target.id,
                                    score: driverSelectedStars,
                                    comment: comment.isEmpty ? nil : comment
                                )
                                UserDefaults.standard.set(true, forKey: "driver_rated_\(target.id)")
                                UserDefaults.standard.set(driverSelectedStars, forKey: "driver_rating_score_\(target.id)")
                                ratedBookingIds.insert(target.id)
                                ratingTarget = nil
                                await authVM.refreshUser()
                            } catch {
                                print("Rating error: \(error)")
                            }
                            isSubmittingDriverRating = false
                        }
                    }) {
                        Group {
                            if isSubmittingDriverRating {
                                ProgressView().tint(.white)
                            } else {
                                Text("Submit Rating")
                                    .font(.system(size: 16, weight: .semibold))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color.brand)
                        .foregroundColor(.white)
                        .cornerRadius(14)
                    }
                    .padding(.horizontal)
                    .disabled(isSubmittingDriverRating)
                }
                Spacer()
            }
            .padding(.top, 32)
            .navigationTitle("Rate Passenger")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Skip") { ratingTarget = nil }
                        .foregroundColor(.textSecondary)
                }
            }
        }
    }

    private func loadPassengers() async {
        guard !isLoadingPassengers else { return }

        if trip.status == .cancelled {
            passengers = []
            isLoading = false
            isLoadingPassengers = false
            return
        }

        isLoadingPassengers = true
        isLoading = true
        errorMessage = nil

        do {
            passengers = try await TripService.shared.getTripPassengers(tripId: trip.id)
        } catch {
            errorMessage = "Failed to load passengers"
            print("Error loading passengers: \(error)")
        }
        isLoading = false
        isLoadingPassengers = false
    }

    private func loadAnchorPoints() async {
        isLoadingAnchors = true
        do {
            anchorPoints = try await TripService.shared.getAnchorPoints(tripId: trip.id)
            isLoadingAnchors = false
        } catch {
            print("Error loading anchor points: \(error)")
            isLoadingAnchors = false
        }
    }

    private func approveBooking(_ passenger: BookingWithRider) async {
        do {
            let updated = try await BookingService.shared.approveBooking(id: passenger.id)
            if let idx = passengers.firstIndex(where: { $0.id == updated.id }) {
                passengers[idx] = passengers[idx].withBookingState(updated.bookingState)
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            print("Error approving booking: \(error)")
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    private func rejectBooking(_ passenger: BookingWithRider) async {
        do {
            _ = try await BookingService.shared.rejectBooking(id: passenger.id)
            passengers.removeAll { $0.id == passenger.id }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            print("Error rejecting booking: \(error)")
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    private func deleteTrip() async {
        isDeletingTrip = true
        do {
            try await TripService.shared.deleteTrip(tripId: trip.id)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onTripDeleted?()
            dismiss()
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            deleteTripError = "Failed to delete trip. Please try again."
        }
        isDeletingTrip = false
    }

    private func openChat(with passenger: BookingWithRider) {
        chatDestination = DriverNotificationChatDestination(
            tripId: trip.id,
            otherPartyName: passenger.riderName,
            riderId: passenger.riderId
        )
    }

    private func cancelTrip() async {
        isCancellingTrip = true
        do {
            _ = try await TripService.shared.cancelTrip(id: trip.id)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            dismiss()
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            cancelTripError = "Failed to cancel trip. Please try again."
        }
        isCancellingTrip = false
    }

    // MARK: - Simulation Controls

    @ViewBuilder private var simulationControls: some View {
        // Only show for pending trips
        if trip.status == .pending {
            VStack(alignment: .leading, spacing: 12) {
                Divider()
                Text("Trip Simulation")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.textTertiary)

                HStack(spacing: 8) {
                    Button("Simulate Full Ride") {
                        showSimulationView = true
                    }
                    .debugPill()
                }

                Text("Opens ActiveTripView in sandbox mode - trip remains pending")
                    .font(.system(size: 11))
                    .foregroundColor(.textTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8)
        }
    }
}


// MARK: - Debug Pill Helper

private extension View {
    func debugPill() -> some View {
        self
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(.brand)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Color.brand.opacity(0.1))
            .cornerRadius(8)
    }
}


// MARK: - Pending Booking Card

private struct PendingBookingCard: View {
    let passenger: BookingWithRider
    var isLocked: Bool = false
    let onApprove: () async -> Void
    let onReject: () async -> Void
    let onChat: () -> Void

    @State private var isApproving = false
    @State private var isRejecting = false
    @State private var now = Date()
    private let timer = Timer.publish(every: 60, on: .main, in: .common).autoconnect()

    private var timeRemaining: String? {
        guard let expires = passenger.holdExpiresAt else { return nil }
        let diff = expires.timeIntervalSince(now)
        guard diff > 0 else { return "Expired" }
        let hours = Int(diff) / 3600
        let mins = (Int(diff) % 3600) / 60
        if hours > 0 { return "\(hours)h \(mins)m left" }
        return "\(mins)m left"
    }

    private var countdownColor: Color {
        guard let expires = passenger.holdExpiresAt else { return .textTertiary }
        let diff = expires.timeIntervalSince(now)
        if diff <= 0 { return .brandRed }
        if diff <= 1800 { return .brandRed }
        if diff <= 3600 { return .brandOrange }
        return .textTertiary
    }

    var body: some View {
        HStack(spacing: 12) {
            // Rider avatar
            AsyncImage(url: URL(string: passenger.riderPicture ?? "")) { image in
                image.resizable()
            } placeholder: {
                Circle()
                    .fill(Color.brand.opacity(0.15))
            }
            .frame(width: 48, height: 48)
            .clipShape(Circle())

            // Rider info
            VStack(alignment: .leading, spacing: 4) {
                Text(passenger.riderName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.textPrimary)
                HStack(spacing: 6) {
                    Image(systemName: "star.fill")
                        .font(.system(size: 10))
                        .foregroundColor(.brandOrange)
                    Text(String(format: "%.1f", passenger.riderRating))
                        .font(.system(size: 12))
                        .foregroundColor(.textSecondary)
                    if let remaining = timeRemaining {
                        Spacer()
                        HStack(spacing: 3) {
                            Image(systemName: "clock")
                                .font(.system(size: 9))
                            Text(remaining)
                                .font(.system(size: 11, weight: .semibold))
                        }
                        .foregroundColor(countdownColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(countdownColor.opacity(0.1))
                        .clipShape(Capsule())
                    }
                }
                Text("\(passenger.seatsBooked) seat\(passenger.seatsBooked > 1 ? "s" : "")")
                    .font(.system(size: 11))
                    .foregroundColor(.textTertiary)

                // Fare and scost breakdown information
                if passenger.fare != nil || passenger.scostBreakdown != nil {
                    HStack(spacing: 12) {
                        if let fare = passenger.fare {
                            HStack(spacing: 4) {
                                Image(systemName: "dollarsign.circle.fill")
                                    .font(.system(size: 11))
                                    .foregroundColor(.brandGreen)
                                Text(String(format: "$%.2f", fare))
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundColor(.textPrimary)
                            }
                        }
                        if let scost = passenger.scostBreakdown {
                            HStack(spacing: 4) {
                                Image(systemName: "arrow.triangle.turn.up.right")
                                    .font(.system(size: 11))
                                    .foregroundColor(.brandOrange)
                                Text(formatScostDistance(scost.walk))
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundColor(.textPrimary)
                            }
                            HStack(spacing: 4) {
                                Image(systemName: "clock.fill")
                                    .font(.system(size: 11))
                                    .foregroundColor(.brand)
                                Text(formatScostTime(scost.advance))
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundColor(.textPrimary)
                            }
                        }
                    }
                    .padding(.top, 4)
                }

                // Payment status badge
                paymentBadge(for: passenger)
            }

            Spacer()

            // Action buttons
            HStack(spacing: 8) {
                Button(action: onChat) {
                    Image(systemName: "message.fill")
                        .font(.system(size: 16))
                        .foregroundColor(.brand)
                        .frame(width: 36, height: 36)
                        .background(Color.brand.opacity(0.1))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)

                Button(action: {
                    Task {
                        isRejecting = true
                        await onReject()
                        isRejecting = false
                    }
                }) {
                    if isRejecting {
                        ProgressView()
                            .frame(width: 36, height: 36)
                    } else {
                        Image(systemName: isLocked ? "lock.fill" : "xmark")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(isLocked ? .textTertiary : .brandRed)
                            .frame(width: 36, height: 36)
                            .background(isLocked ? Color.textTertiary.opacity(0.08) : Color.brandRed.opacity(0.1))
                            .clipShape(Circle())
                    }
                }
                .buttonStyle(.plain)
                .disabled(isRejecting || isLocked)

                Button(action: {
                    Task {
                        isApproving = true
                        await onApprove()
                        isApproving = false
                    }
                }) {
                    if isApproving {
                        ProgressView()
                            .frame(width: 36, height: 36)
                    } else {
                        Image(systemName: isLocked ? "lock.fill" : "checkmark")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(isLocked ? .textTertiary : .brandGreen)
                            .frame(width: 36, height: 36)
                            .background(isLocked ? Color.textTertiary.opacity(0.08) : Color.brandGreen.opacity(0.1))
                            .clipShape(Circle())
                    }
                }
                .buttonStyle(.plain)
                .disabled(isApproving || isLocked)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.cardBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Color.brandRed.opacity(0.5), lineWidth: 1)
                )
        )
        .onReceive(timer) { _ in now = Date() }
    }
}

// MARK: - Payment Badge Helper

private func formatDeadlineLabel(_ date: Date) -> String {
    let calendar = Calendar.current
    let formatter = DateFormatter()
    formatter.timeStyle = .short
    if calendar.isDateInToday(date) || calendar.isDateInTomorrow(date) {
        return formatter.string(from: date)
    }
    formatter.dateStyle = .medium
    return formatter.string(from: date)
}

private func paymentBadge(for passenger: BookingWithRider) -> some View {
    let paid = passenger.bookingState == .completed
    let held = passenger.paymentIntentId != nil
    let (icon, label, tint): (String, String, Color) = paid
        ? ("checkmark.shield.fill", "Paid", .brandGreen)
        : held
            ? ("lock.shield.fill", "Payment Held", .brandGreen)
            : ("clock.badge.exclamationmark.fill", "Awaiting Payment", .brandGold)
    return VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 10))
            Text(label)
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundColor(tint)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(tint.opacity(0.12))
        .cornerRadius(8)

        if !held, let deadline = passenger.paymentDeadlineAt {
            Text("Due by \(formatDeadlineLabel(deadline))")
                .font(.system(size: 10))
                .foregroundColor(.brandOrange)
                .padding(.horizontal, 4)
        }
    }
}

// MARK: - Helper Functions

func formatScostDistance(_ meters: Double) -> String {
    if meters < 1000 {
        return String(format: "%.0fm", meters)
    } else {
        return String(format: "%.1fkm", meters / 1000)
    }
}

func formatScostTime(_ seconds: Double) -> String {
    if seconds < 60 {
        return String(format: "%.0fs", seconds)
    } else if seconds < 3600 {
        return String(format: "%.0fm", seconds / 60)
    } else {
        return String(format: "%.1fh", seconds / 3600)
    }
}
