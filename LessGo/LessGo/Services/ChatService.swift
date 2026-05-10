import Foundation

// MARK: - Chat Service

class ChatService {
    static let shared = ChatService()
    private let network = NetworkManager.shared

    private init() {}

    // MARK: - Send Message

    func sendMessage(tripId: String, riderId: String?, message: String) async throws -> Message {
        var body: [String: String] = ["message": message]
        if let riderId { body["rider_id"] = riderId }

        let message: Message = try await network.request(
            endpoint: "/trips/\(tripId)/messages",
            method: .post,
            body: body,
            requiresAuth: true
        )

        return message
    }

    // MARK: - Get Messages

    func getMessages(tripId: String, riderId: String?) async throws -> [Message] {
        var endpoint = "/trips/\(tripId)/messages"
        if let riderId {
            endpoint += "?rider_id=\(riderId)"
        }

        let response: MessagesResponse = try await network.request(
            endpoint: endpoint,
            method: .get,
            requiresAuth: true
        )

        return response.messages
    }
}
