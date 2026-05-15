import Foundation
import UIKit

// MARK: - Register response (no tokens — user must verify email first)
struct RegisterResponse: Codable {
    let userId: String
    enum CodingKeys: String, CodingKey { case userId = "user_id" }
}

// MARK: - Auth Service

class AuthService {
    static let shared = AuthService()
    private let network = NetworkManager.shared

    private init() {}

    // MARK: - Authentication

    func register(name: String, email: String, password: String) async throws -> RegisterResponse {
        struct RegisterRequest: Encodable {
            let name: String; let email: String; let password: String
        }
        let response: RegisterResponse = try await network.request(
            endpoint: "/auth/register",
            method: .post,
            body: RegisterRequest(name: name, email: email, password: password),
            requiresAuth: false
        )
        return response
    }

    func verifyEmail(email: String, otp: String) async throws -> AuthResponse {
        struct VerifyRequest: Encodable { let email: String; let otp: String }
        let response: AuthResponse = try await network.request(
            endpoint: "/auth/verify-email",
            method: .post,
            body: VerifyRequest(email: email, otp: otp),
            requiresAuth: false
        )
        KeychainManager.shared.saveAccessToken(response.accessToken)
        KeychainManager.shared.saveRefreshToken(response.refreshToken)
        KeychainManager.shared.saveUserId(response.user.id)
        SavedAccountManager.shared.saveSession(user: response.user, accessToken: response.accessToken, refreshToken: response.refreshToken)
        return response
    }

    func resendOtp(email: String) async throws {
        struct ResendRequest: Encodable { let email: String }
        let _: EmptyResponse = try await network.request(
            endpoint: "/auth/resend-otp",
            method: .post,
            body: ResendRequest(email: email),
            requiresAuth: false
        )
    }

    func login(email: String, password: String) async throws -> AuthResponse {
        let request = LoginRequest(email: email, password: password)

        let response: AuthResponse = try await network.request(
            endpoint: "/auth/login",
            method: .post,
            body: request,
            requiresAuth: false
        )

        // Save tokens
        KeychainManager.shared.saveAccessToken(response.accessToken)
        KeychainManager.shared.saveRefreshToken(response.refreshToken)
        KeychainManager.shared.saveUserId(response.user.id)
        SavedAccountManager.shared.saveSession(
            user: response.user,
            accessToken: response.accessToken,
            refreshToken: response.refreshToken
        )

        return response
    }

    /// Local sign-out used by the multi-account UX.
    /// We intentionally do not revoke the backend refresh token by default,
    /// otherwise "saved accounts" become unusable after sign out.
    func logout(revokeRemoteSession: Bool = false) async throws {
        if revokeRemoteSession {
            let _: EmptyResponse = try await network.request(
                endpoint: "/auth/logout",
                method: .post
            )
        }

        // Clear only the active session so saved accounts remain available.
        KeychainManager.shared.clearActiveSession()
    }

    func getCurrentUser() async throws -> User {
        let user: User = try await network.request(
            endpoint: "/auth/me",
            method: .get
        )
        return user
    }

    func verifyToken() async throws -> User {
        let response: TokenVerificationResponse = try await network.request(
            endpoint: "/auth/verify",
            method: .get
        )
        return response.user
    }

    /// Refresh the access token using the stored refresh token
    func refreshAccessToken() async throws -> String {
        guard let refreshToken = KeychainManager.shared.getRefreshToken() else {
            throw NetworkError.unauthorized
        }

        struct RefreshRequest: Encodable {
            let refreshToken: String
        }

        struct RefreshResponse: Codable {
            let accessToken: String
        }

        let response: RefreshResponse = try await network.request(
            endpoint: "/auth/refresh",
            method: .post,
            body: RefreshRequest(refreshToken: refreshToken),
            requiresAuth: false
        )

        // Save the new access token
        KeychainManager.shared.saveAccessToken(response.accessToken)
        if let userId = KeychainManager.shared.getUserId() {
            KeychainManager.shared.saveAccessToken(response.accessToken, for: userId)
            SavedAccountManager.shared.markUsed(userId)
        }

        return response.accessToken
    }

    // MARK: - SJSU ID Verification

    func uploadSJSUID(image: UIImage, userId: String) async throws -> User {
        guard let imageData = image.jpegData(compressionQuality: 0.8) else {
            throw NetworkError.unknown(NSError(domain: "Image conversion failed", code: 0))
        }

        let filename = "sjsu_id_\(userId)_\(Date().timeIntervalSince1970).jpg"

        let user: User = try await network.uploadMultipart(
            endpoint: "/auth/verify-id",
            parameters: ["userId": userId],
            files: ["sjsuId": (imageData, filename)]
        )

        return user
    }

    // MARK: - Debug: instant verification

    #if DEBUG
    /// Calls the dev-only endpoint that immediately sets the user's SJSU ID status to "verified".
    /// Only available in debug builds — the endpoint is disabled in production.
    func testVerifyUser(userId: String) async throws -> User {
        let user: User = try await network.request(
            endpoint: "/auth/test/verify/\(userId)",
            method: .post
        )
        return user
    }
    #endif

    // MARK: - Change Password

    func changePassword(currentPassword: String, newPassword: String) async throws {
        struct ChangePasswordRequest: Encodable {
            let currentPassword: String
            let newPassword: String
        }
        let _: EmptyResponse = try await network.request(
            endpoint: "/auth/change-password",
            method: .put,
            body: ChangePasswordRequest(currentPassword: currentPassword, newPassword: newPassword)
        )
    }

    // MARK: - Helpers

    var isLoggedIn: Bool {
        KeychainManager.shared.getAccessToken() != nil ||
        KeychainManager.shared.getRefreshToken() != nil
    }
}

// MARK: - Helper Models

struct TokenVerificationResponse: Codable {
    let valid: Bool
    let user: User
}
