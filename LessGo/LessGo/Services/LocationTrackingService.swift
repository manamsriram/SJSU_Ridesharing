import Foundation
import CoreLocation
import Combine
import MapKit

// MARK: - Location Tracking Service for Real-Time Ride Tracking

class LocationTrackingService: NSObject, ObservableObject {
    static let shared = LocationTrackingService()

    @Published var currentLocation: CLLocation?
    @Published var driverLocation: DriverLocation?
    @Published var isTracking = false
    /// Remaining route ahead during simulation — used to draw the lookahead path overlay on the map.
    @Published var simulationRemainingPath: [CLLocationCoordinate2D] = []
    var isSimulatingMovement: Bool { isSimulating }

    private let locationManager = CLLocationManager()
    private let network = NetworkManager.shared
    private var trackingTimer: Timer?
    private var driverPollingTimer: Timer?
    private var currentTripId: String?

    // Simulated movement
    private var simulatedRoute: [CLLocationCoordinate2D] = []
    private var simulationIndex = 0
    private var isSimulating = false
    private var simulationSendsToBackend = true
    private var simulationUpdatesDriverFeedOnly = false

    // CADisplayLink-based smooth interpolation
    private var displayLink: CADisplayLink?
    private var simulationStepStartTime: CFTimeInterval = 0
    private var simulationStepDuration: TimeInterval = 0.22

    override private init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        locationManager.distanceFilter = 10 // Update every 10 meters
    }

    // MARK: - Location Permissions

    func requestLocationPermission() {
        locationManager.requestWhenInUseAuthorization()
    }

    func requestAlwaysAuthorization() {
        locationManager.requestAlwaysAuthorization()
    }

    // MARK: - Driver Location Updates (Send to Backend)

    func startTrackingTrip(tripId: String) {
        if isTracking {
            if currentTripId == tripId { return }
            stopTrackingTrip()
        }

        currentTripId = tripId
        isTracking = true

        // Start location updates
        locationManager.startUpdatingLocation()
        locationManager.startUpdatingHeading()

        // Send location updates every 3 seconds
        trackingTimer?.invalidate()
        trackingTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.sendLocationUpdate()
        }

        print("📍 Started tracking trip: \(tripId)")
    }

    func stopTrackingTrip() {
        guard isTracking else { return }

        isTracking = false
        currentTripId = nil

        locationManager.stopUpdatingLocation()
        locationManager.stopUpdatingHeading()
        trackingTimer?.invalidate()
        trackingTimer = nil

        print("📍 Stopped tracking trip")
    }

    private func sendLocationUpdate() {
        guard let tripId = currentTripId,
              let location = currentLocation else { return }
        guard !isSimulating else { return }

        Task {
            do {
                let request = LocationUpdateRequest(
                    latitude: location.coordinate.latitude,
                    longitude: location.coordinate.longitude,
                    heading: locationManager.heading?.trueHeading,
                    speed: location.speed > 0 ? location.speed * 3.6 : nil, // Convert m/s to km/h
                    accuracy: location.horizontalAccuracy
                )

                let _: EmptyResponse = try await network.request(
                    endpoint: "/trips/\(tripId)/location",
                    method: .post,
                    body: request,
                    requiresAuth: true
                )

                print("📍 Location sent: \(location.coordinate.latitude), \(location.coordinate.longitude)")
            } catch {
                print("❌ Failed to send location update: \(error)")
            }
        }
    }

    // MARK: - Rider Location Updates (Receive from Backend)

    func fetchDriverLocation(tripId: String) async {
        if isSimulating && simulationUpdatesDriverFeedOnly && currentTripId == tripId {
            return
        }
        do {
            let location: DriverLocation = try await network.request(
                endpoint: "/trips/\(tripId)/location",
                method: .get,
                requiresAuth: false
            )

            await MainActor.run {
                self.driverLocation = location
            }
        } catch {
            print("❌ Failed to fetch driver location: \(error)")
        }
    }

    func startPollingDriverLocation(tripId: String) {
        if currentTripId != tripId {
            driverLocation = nil
        }
        currentTripId = tripId
        driverPollingTimer?.invalidate()
        Task { await fetchDriverLocation(tripId: tripId) }

        // Poll for driver location every 3 seconds
        driverPollingTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            Task {
                await self?.fetchDriverLocation(tripId: tripId)
            }
        }
    }

    func stopPollingDriverLocation() {
        driverPollingTimer?.invalidate()
        driverPollingTimer = nil
        currentTripId = nil
        driverLocation = nil
    }

    // MARK: - Simulated Movement (for Testing)

    func startSimulatedMovement(
        from start: CLLocationCoordinate2D,
        to end: CLLocationCoordinate2D,
        tripId: String,
        sendToBackend: Bool = true,
        updateDriverFeedOnly: Bool = false,
        stepInterval: TimeInterval = 0.35,
        steps: Int = 90
    ) {
        stopSimulatedMovement()

        currentTripId = tripId
        isSimulating = true
        isTracking = true
        simulationIndex = 0
        simulationSendsToBackend = sendToBackend
        simulationUpdatesDriverFeedOnly = updateDriverFeedOnly
        simulationStepDuration = stepInterval

        Task { @MainActor [weak self] in
            guard let self else { return }

            let routePoints = await self.generateRoutedPoints(from: start, to: end, fallbackSteps: max(12, steps))
            self.simulatedRoute = routePoints
            self.simulationIndex = 0
            self.simulationRemainingPath = routePoints
            self.simulationStepStartTime = CACurrentMediaTime()
            self.startDisplayLink()

            print("🎮 Started simulated movement: \(routePoints.count) points, \(stepInterval)s/step")
        }
    }

    private func startDisplayLink() {
        displayLink?.invalidate()
        let link = CADisplayLink(target: self, selector: #selector(displayLinkTick))
        link.preferredFramesPerSecond = 30
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    func stopSimulatedMovement() {
        guard isSimulating else { return }

        isSimulating = false
        isTracking = false
        currentTripId = nil
        simulatedRoute = []
        simulationIndex = 0
        simulationSendsToBackend = true
        simulationUpdatesDriverFeedOnly = false
        simulationRemainingPath = []

        displayLink?.invalidate()
        displayLink = nil

        print("🎮 Stopped simulated movement")
    }

    @objc private func displayLinkTick() {
        guard isSimulating, !simulatedRoute.isEmpty else {
            stopSimulatedMovement()
            return
        }
        guard simulationIndex < simulatedRoute.count else {
            stopSimulatedMovement()
            return
        }

        let now = CACurrentMediaTime()
        let elapsed = now - simulationStepStartTime
        let t = elapsed / simulationStepDuration

        let from = simulationIndex == 0 ? simulatedRoute[0] : simulatedRoute[simulationIndex - 1]
        let to = simulatedRoute[simulationIndex]

        let clamped = min(t, 1.0)
        let lat = from.latitude + (to.latitude - from.latitude) * clamped
        let lng = from.longitude + (to.longitude - from.longitude) * clamped
        let interpolated = CLLocationCoordinate2D(latitude: lat, longitude: lng)

        currentLocation = CLLocation(
            coordinate: interpolated,
            altitude: 0,
            horizontalAccuracy: 5,
            verticalAccuracy: 5,
            timestamp: Date()
        )

        if simulationUpdatesDriverFeedOnly, let tripId = currentTripId {
            driverLocation = DriverLocation(
                locationId: "sim_\(simulationIndex)",
                tripId: tripId,
                driverId: "simulated_driver",
                latitude: interpolated.latitude,
                longitude: interpolated.longitude,
                heading: nil,
                speed: 28.0,
                accuracy: 5.0,
                createdAt: Date()
            )
        }

        guard t >= 1.0 else { return }

        if simulationSendsToBackend, let tripId = currentTripId {
            sendSimulatedLocation(coordinate: to, tripId: tripId)
        }
        simulationIndex += 1
        // Carry over any excess time so steps don't drift
        simulationStepStartTime = now - max(0, elapsed - simulationStepDuration)
        simulationRemainingPath = simulationIndex < simulatedRoute.count
            ? Array(simulatedRoute[simulationIndex...])
            : []
    }

    private func sendSimulatedLocation(coordinate: CLLocationCoordinate2D, tripId: String) {
        Task {
            do {
                let request = LocationUpdateRequest(
                    latitude: coordinate.latitude,
                    longitude: coordinate.longitude,
                    heading: nil,
                    speed: 32.0,
                    accuracy: 5.0
                )
                let _: EmptyResponse = try await network.request(
                    endpoint: "/trips/\(tripId)/location",
                    method: .post,
                    body: request,
                    requiresAuth: true
                )
            } catch {
                print("❌ Failed to send simulated location: \(error)")
            }
        }
    }

    private func generateRoutePoints(from start: CLLocationCoordinate2D, to end: CLLocationCoordinate2D, steps: Int) -> [CLLocationCoordinate2D] {
        var points: [CLLocationCoordinate2D] = []

        for i in 0...steps {
            let fraction = Double(i) / Double(steps)
            let lat = start.latitude + (end.latitude - start.latitude) * fraction
            let lng = start.longitude + (end.longitude - start.longitude) * fraction
            points.append(CLLocationCoordinate2D(latitude: lat, longitude: lng))
        }

        return points
    }

    private func generateRoutedPoints(
        from start: CLLocationCoordinate2D,
        to end: CLLocationCoordinate2D,
        fallbackSteps: Int
    ) async -> [CLLocationCoordinate2D] {
        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: start))
        request.destination = MKMapItem(placemark: MKPlacemark(coordinate: end))
        request.transportType = .automobile
        request.requestsAlternateRoutes = false

        do {
            let response = try await MKDirections(request: request).calculate()
            if let route = response.routes.first {
                let rawPoints = route.polyline.coordinates
                if rawPoints.count >= 2 {
                    return densifyRoute(rawPoints, targetCount: max(fallbackSteps, 40))
                }
            }
        } catch {
            print("🎮 Routed simulation fallback to linear path: \(error)")
        }

        return generateRoutePoints(from: start, to: end, steps: fallbackSteps)
    }

    private func densifyRoute(_ points: [CLLocationCoordinate2D], targetCount: Int) -> [CLLocationCoordinate2D] {
        guard points.count >= 2 else { return points }
        if points.count >= targetCount { return points }

        var expanded: [CLLocationCoordinate2D] = []
        let segments = max(1, points.count - 1)
        let insertsPerSegment = max(1, (targetCount - points.count) / segments)

        for idx in 0..<(points.count - 1) {
            let a = points[idx]
            let b = points[idx + 1]
            expanded.append(a)
            for i in 1...insertsPerSegment {
                let t = Double(i) / Double(insertsPerSegment + 1)
                let lat = a.latitude + (b.latitude - a.latitude) * t
                let lng = a.longitude + (b.longitude - a.longitude) * t
                expanded.append(CLLocationCoordinate2D(latitude: lat, longitude: lng))
            }
        }
        expanded.append(points.last!)
        return expanded
    }
}

// MARK: - CLLocationManagerDelegate

extension LocationTrackingService: CLLocationManagerDelegate {
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        guard !isSimulating else { return }
        currentLocation = location
    }

    func locationManager(_ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus) {
        switch status {
        case .authorizedWhenInUse, .authorizedAlways:
            print("📍 Location permission granted")
        case .denied, .restricted:
            print("❌ Location permission denied")
        case .notDetermined:
            print("⏳ Location permission not determined")
        @unknown default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        print("❌ Location error: \(error.localizedDescription)")
    }
}

// MARK: - Models

struct LocationUpdateRequest: Codable {
    let latitude: Double
    let longitude: Double
    let heading: Double?
    let speed: Double?
    let accuracy: Double?
}

struct DriverLocation: Codable {
    let locationId: String
    let tripId: String
    let driverId: String
    let latitude: Double
    let longitude: Double
    let heading: Double?
    let speed: Double?
    let accuracy: Double?
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case locationId = "location_id"
        case tripId = "trip_id"
        case driverId = "driver_id"
        case latitude, longitude, heading, speed, accuracy
        case createdAt = "created_at"
    }

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}

private extension MKPolyline {
    var coordinates: [CLLocationCoordinate2D] {
        var coords = Array(repeating: CLLocationCoordinate2D(), count: pointCount)
        getCoordinates(&coords, range: NSRange(location: 0, length: pointCount))
        return coords
    }
}
