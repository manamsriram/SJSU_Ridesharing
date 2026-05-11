import Foundation
import CoreLocation
import MapKit

// MARK: - Search Criteria Model

struct SearchCriteria {
    let direction: TripDirection
    let location: String
    let address: String
    let coordinate: CLLocationCoordinate2D
    let departureTime: Date

    init(direction: TripDirection, location: String, address: String = "", coordinate: CLLocationCoordinate2D, departureTime: Date) {
        self.direction = direction
        self.location = location
        self.address = address
        self.coordinate = coordinate
        self.departureTime = departureTime
    }

    enum TripDirection: String {
        case toSJSU = "to_sjsu"
        case fromSJSU = "from_sjsu"
    }

    /// The origin coordinate for the trip (rider's coord when going to SJSU, SJSU when going from SJSU).
    var originCoordinate: CLLocationCoordinate2D {
        switch direction {
        case .toSJSU:   return coordinate
        case .fromSJSU: return AppConstants.sjsuCoordinate
        }
    }

    /// The destination coordinate for the trip (SJSU when going to SJSU, rider's coord when going from SJSU).
    var destinationCoordinate: CLLocationCoordinate2D {
        switch direction {
        case .toSJSU:   return AppConstants.sjsuCoordinate
        case .fromSJSU: return coordinate
        }
    }
}
