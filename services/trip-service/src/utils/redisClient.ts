import Redis from 'ioredis';

const inKubernetes = process.env.KUBERNETES_SERVICE_HOST !== undefined;
const defaultRedisUrl = inKubernetes ? 'redis://redis:6379' : 'redis://127.0.0.1:6379';
const REDIS_URL = process.env.REDIS_URL || defaultRedisUrl;

let client: Redis | null = null;

try {
  client = new Redis(REDIS_URL, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  client.connect().then(() => {
    console.log(`✅ [trip-service] Redis connected at ${REDIS_URL}`);
  }).catch((err) => {
    console.warn(`⚠️  [trip-service] Redis unavailable — caching disabled: ${err.message}`);
    client = null;
  });
  client.on('error', () => { /* suppress noise after initial connect failure */ });
} catch {
  client = null;
}

export async function cacheGet(key: string): Promise<string | null> {
  if (!client) return null;
  try {
    return await client.get(key);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (!client) return;
  try {
    await client.setex(key, ttlSeconds, value);
  } catch {
    // graceful degradation
  }
}

export async function cacheDel(key: string): Promise<void> {
  if (!client) return;
  try {
    await client.del(key);
  } catch {
    // graceful degradation
  }
}
