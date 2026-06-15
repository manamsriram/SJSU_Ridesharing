import Foundation

// NSCache-backed in-memory cache with per-entry TTL.
// Auto-evicts entries on memory pressure (NSCache behaviour).
// Thread-safe: NSCache handles concurrent access internally.
final class ProfileCache {
    static let shared = ProfileCache()
    private init() {}

    private let cache = NSCache<NSString, CacheEntry>()

    static let userProfileTTL: TimeInterval = 5 * 60      // 5 min — ratings/vehicle_info can change
    static let vehicleDataTTL: TimeInterval = 24 * 3600   // 24 h  — static reference data

    func get<T: Decodable>(_ key: String, as type: T.Type) -> T? {
        guard let entry = cache.object(forKey: key as NSString),
              entry.expiresAt > Date() else {
            cache.removeObject(forKey: key as NSString)
            return nil
        }
        return try? JSONDecoder().decode(T.self, from: entry.data)
    }

    func set<T: Encodable>(_ value: T, forKey key: String, ttl: TimeInterval) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        cache.setObject(CacheEntry(data: data, ttl: ttl), forKey: key as NSString)
    }

    func remove(_ key: String) {
        cache.removeObject(forKey: key as NSString)
    }

    func removeAll() {
        cache.removeAllObjects()
    }
}

private final class CacheEntry: NSObject {
    let data: Data
    let expiresAt: Date

    init(data: Data, ttl: TimeInterval) {
        self.data = data
        self.expiresAt = Date().addingTimeInterval(ttl)
    }
}
