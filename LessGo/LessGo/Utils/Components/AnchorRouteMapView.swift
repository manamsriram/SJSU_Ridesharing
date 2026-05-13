import SwiftUI
import MapKit

// MARK: - AnchorRouteMapView
// Extended map view that renders multi-segment routes from anchor points
// produced by He et al. Algorithm 3 route merging.
//
// Renders:
//  - Solid blue polyline for the main driver route segments
//  - Dashed gold polyline for detour segments (pickup → dropoff for each rider)
//  - Blue circle pins for rider pickups, gold circle pins for rider dropoffs
//  - Standard pickup (brandGold) and destination (brandGreen) driver pins

struct AnchorRouteMapView: UIViewRepresentable {
    // Driver's trip origin and final destination
    let origin: CLLocationCoordinate2D?
    let destination: CLLocationCoordinate2D?
    // Driver's live location
    let driver: CLLocationCoordinate2D?
    // Ordered anchor points from Algorithm 3 (may be empty for simple trips)
    var anchorPoints: [AnchorPoint] = []
    // Additional rider pickup coordinates to display (for riders not covered by anchor points)
    var riders: [CLLocationCoordinate2D] = []
    var showsUserLocation: Bool = true
    // Mined frequent routes (He et al. 2014) rendered as dashed navy polylines
    var frequentRoutes: [FrequentRouteSegment] = []
    // When set, only show pickup/dropoff pins for this rider (hides other riders' locations)
    var ownRiderId: String? = nil
    // Remaining simulation path — shown during active simulation as a lookahead trail
    var simulationPath: [CLLocationCoordinate2D] = []
    // Pickup pin shown during the enRoute leg of a simulation
    var simulationPickup: CLLocationCoordinate2D? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView(frame: .zero)
        map.delegate = context.coordinator
        map.showsCompass = false
        map.showsScale = false
        map.pointOfInterestFilter = .excludingAll
        map.isRotateEnabled = false
        map.isPitchEnabled = false
        map.showsUserLocation = showsUserLocation
        return map
    }

    func updateUIView(_ mapView: MKMapView, context: Context) {
        context.coordinator.mapView = mapView
        mapView.showsUserLocation = showsUserLocation

        guard mapView.bounds.width > 0, mapView.bounds.height > 0 else {
            context.coordinator.scheduleLayoutRetry {
                guard mapView.bounds.width > 0, mapView.bounds.height > 0 else { return }
                self.syncMapContent(mapView, context: context)
            }
            return
        }

        syncMapContent(mapView, context: context)
    }

    private func syncMapContent(_ mapView: MKMapView, context: Context) {
        context.coordinator.syncAnchorAnnotations(
            origin: origin,
            destination: destination,
            driver: driver,
            anchors: anchorPoints,
            riders: riders,
            ownRiderId: ownRiderId,
            simulationPickup: simulationPickup
        )
        context.coordinator.updateAnchorRoute(
            origin: origin,
            destination: destination,
            anchors: anchorPoints,
            mapView: mapView
        )
        context.coordinator.updateFrequentRoutes(frequentRoutes, mapView: mapView)
        context.coordinator.updateSimulationPath(simulationPath, mapView: mapView)
        context.coordinator.fitToContent(mapView, origin: origin, destination: destination, anchors: anchorPoints)
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, MKMapViewDelegate {
        weak var mapView: MKMapView?
        private var annotationsByID: [String: MKPointAnnotation] = [:]
        private var routeOverlays: [MKOverlay] = []
        private var frequentRouteOverlays: [MKOverlay] = []
        private var simulationPathOverlay: MKPolyline?
        private var lastAnchorKey: String = ""
        private var lastFrequentRouteKey: String = ""
        private var lastSimPathKey: String = ""
        private var pendingDirections: [MKDirections] = []
        private var pendingLayoutRetry = false

        func scheduleLayoutRetry(_ retry: @escaping () -> Void) {
            guard !pendingLayoutRetry else { return }
            pendingLayoutRetry = true

            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.pendingLayoutRetry = false
                retry()
            }
        }

        // MARK: Annotations

        func syncAnchorAnnotations(
            origin: CLLocationCoordinate2D?,
            destination: CLLocationCoordinate2D?,
            driver: CLLocationCoordinate2D?,
            anchors: [AnchorPoint],
            riders: [CLLocationCoordinate2D] = [],
            ownRiderId: String? = nil,
            simulationPickup: CLLocationCoordinate2D? = nil
        ) {
            guard let mapView else { return }

            var desired: [String: (CLLocationCoordinate2D, String)] = [:]
            if let origin      { desired["origin"]      = (origin,      "pickup") }
            if let destination { desired["destination"] = (destination, "destination") }
            if let driver      { desired["driver"]      = (driver,      "driver") }
            if let simulationPickup { desired["sim_pickup"] = (simulationPickup, "sim_pickup") }

            // Collect anchor pickup coordinates so we can skip duplicate rider pins
            var anchorPickupCoords: Set<String> = []

            for (i, anchor) in anchors.enumerated() {
                // If ownRiderId is set, only pin this rider's own stop (polyline still uses all anchors)
                if let ownRiderId, let anchorRiderId = anchor.riderId, anchorRiderId != ownRiderId {
                    continue
                }
                let key = "anchor_\(i)_\(anchor.type)"
                let coord = CLLocationCoordinate2D(latitude: anchor.lat, longitude: anchor.lng)
                desired[key] = (
                    coord,
                    anchor.type == .pickup ? "anchor_pickup" : "anchor_dropoff"
                )
                if anchor.type == .pickup {
                    anchorPickupCoords.insert("\(anchor.lat.rounded(toPlaces: 4)),\(anchor.lng.rounded(toPlaces: 4))")
                }
            }

            // Add rider pickup annotations for riders not already covered by anchor points
            for (idx, rider) in riders.enumerated() {
                let riderKey = "\(rider.latitude.rounded(toPlaces: 4)),\(rider.longitude.rounded(toPlaces: 4))"
                if anchorPickupCoords.contains(riderKey) { continue }
                desired["rider_\(idx)"] = (rider, "rider")
            }

            let removedKeys = Set(annotationsByID.keys).subtracting(desired.keys)
            for key in removedKeys {
                if let ann = annotationsByID.removeValue(forKey: key) {
                    mapView.removeAnnotation(ann)
                }
            }

            for (key, payload) in desired {
                let (coord, title) = payload
                if let existing = annotationsByID[key] {
                    existing.coordinate = coord
                    existing.title = title
                } else {
                    let ann = MKPointAnnotation()
                    ann.coordinate = coord
                    ann.title = title
                    annotationsByID[key] = ann
                    mapView.addAnnotation(ann)
                }
            }
        }

        // MARK: Route rendering

        func updateAnchorRoute(
            origin: CLLocationCoordinate2D?,
            destination: CLLocationCoordinate2D?,
            anchors: [AnchorPoint],
            mapView: MKMapView
        ) {
            // Build waypoint list: origin → anchor pickups/dropoffs → destination
            var waypoints: [CLLocationCoordinate2D] = []
            if let o = origin { waypoints.append(o) }
            for anchor in anchors {
                waypoints.append(CLLocationCoordinate2D(latitude: anchor.lat, longitude: anchor.lng))
            }
            if let d = destination { waypoints.append(d) }

            let key = waypoints
                .map { "\($0.latitude.rounded(toPlaces: 4)),\($0.longitude.rounded(toPlaces: 4))" }
                .joined(separator: "|")

            guard key != lastAnchorKey else { return }
            lastAnchorKey = key

            // Cancel pending direction requests
            pendingDirections.forEach { $0.cancel() }
            pendingDirections = []

            // Remove existing overlays
            mapView.removeOverlays(routeOverlays)
            routeOverlays = []

            guard waypoints.count >= 2 else { return }

            // If no anchor points, do a single directions request origin→destination
            if anchors.isEmpty {
                if let o = origin, let d = destination {
                    requestSegment(from: o, to: d, isDashed: false, mapView: mapView)
                }
                return
            }

            // Request directions for each consecutive pair
            for i in 0..<(waypoints.count - 1) {
                let fromAnchorIdx = i - 1   // -1 for origin offset
                let toAnchorIdx   = i
                let isDashed = fromAnchorIdx >= 0 && toAnchorIdx < anchors.count &&
                               (anchors[max(0, fromAnchorIdx)].type == .pickup)
                requestSegment(
                    from: waypoints[i],
                    to: waypoints[i + 1],
                    isDashed: isDashed,
                    mapView: mapView
                )
            }
        }

        private func requestSegment(
            from: CLLocationCoordinate2D,
            to: CLLocationCoordinate2D,
            isDashed: Bool,
            mapView: MKMapView
        ) {
            let request = MKDirections.Request()
            request.source      = MKMapItem(placemark: MKPlacemark(coordinate: from))
            request.destination = MKMapItem(placemark: MKPlacemark(coordinate: to))
            request.transportType = .automobile
            request.requestsAlternateRoutes = false

            let directions = MKDirections(request: request)
            pendingDirections.append(directions)

            directions.calculate { [weak self] response, error in
                guard let self else { return }
                DispatchQueue.main.async {
                    if let route = response?.routes.first {
                        if isDashed {
                            let dashed = DashedPolyline(points: route.polyline.points(), count: route.polyline.pointCount)
                            mapView.addOverlay(dashed)
                            self.routeOverlays.append(dashed)
                        } else {
                            mapView.addOverlay(route.polyline)
                            self.routeOverlays.append(route.polyline)
                        }
                    } else {
                        // Geodesic fallback
                        var coords = [from, to]
                        if isDashed {
                            let dashed = DashedPolyline(coordinates: &coords, count: 2)
                            mapView.addOverlay(dashed)
                            self.routeOverlays.append(dashed)
                        } else {
                            let geo = MKGeodesicPolyline(coordinates: &coords, count: 2)
                            mapView.addOverlay(geo)
                            self.routeOverlays.append(geo)
                        }
                    }
                }
            }
        }

        // MARK: Frequent Routes

        func updateFrequentRoutes(_ routes: [FrequentRouteSegment], mapView: MKMapView) {
            let key = routes.map { "\($0.originZone)_\($0.destZone)" }.joined(separator: "|")
            guard key != lastFrequentRouteKey else { return }
            lastFrequentRouteKey = key

            mapView.removeOverlays(frequentRouteOverlays)
            frequentRouteOverlays = []

            for route in routes {
                var coords = [
                    CLLocationCoordinate2D(latitude: route.originCenter.lat, longitude: route.originCenter.lng),
                    CLLocationCoordinate2D(latitude: route.destCenter.lat,   longitude: route.destCenter.lng),
                ]
                let polyline = FrequentRoutePolyline(coordinates: &coords, count: 2)
                mapView.addOverlay(polyline, level: .aboveRoads)
                frequentRouteOverlays.append(polyline)
            }
        }

        // MARK: Simulation Path

        func updateSimulationPath(_ path: [CLLocationCoordinate2D], mapView: MKMapView) {
            let key = path.isEmpty ? "" : "\(path.count)|\(path[0].latitude)"
            guard key != lastSimPathKey else { return }
            lastSimPathKey = key

            if let existing = simulationPathOverlay {
                mapView.removeOverlay(existing)
                simulationPathOverlay = nil
            }
            guard path.count >= 2 else { return }
            var coords = path
            let overlay = SimulationPathPolyline(coordinates: &coords, count: coords.count)
            mapView.addOverlay(overlay, level: .aboveRoads)
            simulationPathOverlay = overlay
        }

        // MARK: Fit

        func fitToContent(
            _ mapView: MKMapView,
            origin: CLLocationCoordinate2D?,
            destination: CLLocationCoordinate2D?,
            anchors: [AnchorPoint]
        ) {
            guard mapView.bounds.width > 0, mapView.bounds.height > 0 else { return }

            var coords: [CLLocationCoordinate2D] = []
            if let o = origin      { coords.append(o) }
            if let d = destination { coords.append(d) }
            for a in anchors { coords.append(CLLocationCoordinate2D(latitude: a.lat, longitude: a.lng)) }
            guard !coords.isEmpty else { return }

            var rect = MKMapRect.null
            for c in coords {
                let pt = MKMapPoint(c)
                rect = rect.isNull
                    ? MKMapRect(x: pt.x, y: pt.y, width: 1, height: 1)
                    : rect.union(MKMapRect(x: pt.x, y: pt.y, width: 1, height: 1))
            }
            let minSide = 8_000.0
            if rect.size.width < minSide || rect.size.height < minSide {
                rect = MKMapRect(
                    x: rect.origin.x - max(0, (minSide - rect.size.width) / 2),
                    y: rect.origin.y - max(0, (minSide - rect.size.height) / 2),
                    width: max(rect.size.width, minSide),
                    height: max(rect.size.height, minSide)
                )
            }
            mapView.setVisibleMapRect(
                rect,
                edgePadding: UIEdgeInsets(top: 40, left: 40, bottom: 40, right: 40),
                animated: true
            )
        }

        // MARK: Delegate

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            if let sim = overlay as? SimulationPathPolyline {
                let renderer = MKPolylineRenderer(polyline: sim)
                renderer.strokeColor = UIColor.systemTeal.withAlphaComponent(0.75)
                renderer.lineWidth = 3
                renderer.lineCap = .round
                return renderer
            }
            if let frequent = overlay as? FrequentRoutePolyline {
                let renderer = MKPolylineRenderer(polyline: frequent)
                renderer.strokeColor = UIColor(red: 0, green: 0.33, blue: 0.63, alpha: 1) // #0055A2 SJSU dark blue
                renderer.lineWidth = 3
                renderer.lineDashPattern = [8, 4]
                renderer.alpha = 0.55
                return renderer
            }
            if let dashed = overlay as? DashedPolyline {
                let renderer = MKPolylineRenderer(polyline: dashed)
                renderer.strokeColor = UIColor(Color.brandGold)
                renderer.lineWidth = 3
                renderer.lineDashPattern = [6, 6]
                renderer.alpha = 0.85
                return renderer
            }
            if let polyline = overlay as? MKPolyline {
                let renderer = MKPolylineRenderer(polyline: polyline)
                renderer.strokeColor = UIColor(Color.brand)
                renderer.lineWidth = 4
                renderer.lineCap = .round
                renderer.lineJoin = .round
                renderer.alpha = 0.9
                return renderer
            }
            return MKOverlayRenderer(overlay: overlay)
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if annotation is MKUserLocation { return nil }
            let id = "anchor-annotation"
            let view = (mapView.dequeueReusableAnnotationView(withIdentifier: id) as? MKMarkerAnnotationView)
                ?? MKMarkerAnnotationView(annotation: annotation, reuseIdentifier: id)
            view.annotation = annotation
            view.canShowCallout = false
            view.titleVisibility = .hidden
            view.subtitleVisibility = .hidden
            view.glyphTintColor = .white

            switch annotation.title ?? nil {
            case "pickup":
                view.markerTintColor = UIColor(Color.brandGold)
                view.glyphImage = UIImage(systemName: "person.fill")
            case "destination":
                view.markerTintColor = UIColor(Color.brandGreen)
                view.glyphImage = UIImage(systemName: "flag.fill")
            case "driver":
                view.markerTintColor = UIColor(Color.brand)
                view.glyphImage = UIImage(systemName: "car.fill")
            case "sim_pickup":
                view.markerTintColor = UIColor.systemTeal
                view.glyphImage = UIImage(systemName: "figure.wave")
            case "rider":
                view.markerTintColor = UIColor(Color.brandRed)
                view.glyphImage = UIImage(systemName: "figure.walk")
            case "anchor_pickup":
                view.markerTintColor = UIColor(Color.brand.opacity(0.8))
                view.glyphImage = UIImage(systemName: "circle.fill")
            case "anchor_dropoff":
                view.markerTintColor = UIColor(Color.brandGold.opacity(0.8))
                view.glyphImage = UIImage(systemName: "circle.fill")
            default:
                view.markerTintColor = .systemBlue
                view.glyphImage = UIImage(systemName: "mappin")
            }
            return view
        }
    }
}

// MARK: - DashedPolyline
// Subclass of MKPolyline so we can detect it in the renderer delegate
// and apply the dashed stroke style for detour segments.

final class DashedPolyline: MKPolyline {}

// MARK: - SimulationPathPolyline
// Lookahead path shown during active simulation runs.

final class SimulationPathPolyline: MKPolyline {}

// MARK: - FrequentRoutePolyline
// Subclass of MKPolyline used to render He et al. frequent route segments
// (zone center → zone center) as a dashed navy overlay at low opacity.

final class FrequentRoutePolyline: MKPolyline {}

extension Double {
    fileprivate func rounded(toPlaces places: Int) -> Double {
        let factor = pow(10.0, Double(places))
        return (self * factor).rounded() / factor
    }
}
