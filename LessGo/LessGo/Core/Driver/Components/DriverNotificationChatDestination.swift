import SwiftUI

// MARK: - Driver Notification Chat Destination

struct DriverNotificationChatDestination: Identifiable {
    let tripId: String
    let otherPartyName: String
    var riderId: String? = nil
    var id: String { tripId + (riderId ?? "") }
}
