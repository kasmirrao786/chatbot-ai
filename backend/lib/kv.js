/**
 * kv.js — the Redis migration seam that's been documented (but not built)
 * across escalation.js, booking.js, the rate limiter, and admin sessions
 * since early on. One small interface, two backends:
 *
 *  - REDIS_URL set    → real Redis (ioredis), values JSON-serialized, TTL
 *                        via Redis's native EX.
 *  - REDIS_URL unset  → in-memory Map, same interface, TTL via a stored
 *                        expiry timestamp checked lazily on read (same
 *                        behavior every one of these modules already had
 *                        individually — now centralized in one place).
 *
 * Everything that used to be "per-instance state, wiped on restart" is now
 * "per-instance state, wiped on restart, UNLESS you set REDIS_URL" — at
 * which point it's shared across instances and survives restarts, with
 * zero code changes anywhere else.
 */
const Redis = require("ioredis");

let redisClient = null;
let redisAvailable = false;

if (process.env.REDIS_URL) {
  redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    lazyConnect: false,
  });
  redisClient.on("connect", () => {
    redisAvailable = true;
    console.log("✅ Connected to Redis — rate limiting, sessions, and escalation/booking state are now shared across instances.");
  });
  redisClient.on("error", (err) => {
    if (redisAvailable) console.error("⚠️  Redis error (falling back to in-memory for subsequent calls):", err.message);
    redisAvailable = false;
  });
} else {
  console.log("ℹ️  REDIS_URL not set — using in-memory state (fine for one instance; won't survive a restart or scale past one instance).");
}

// In-memory fallback store: key -> { value, expiresAt }
const memoryStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.expiresAt && now > entry.expiresAt) memoryStore.delete(key);
  }
}, 5 * 60 * 1000).unref();

async function kvGet(key) {
  if (redisAvailable) {
    try {
      const raw = await redisClient.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.error(`⚠️  Redis GET failed for "${key}", falling back to in-memory:`, err.message);
    }
  }
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

async function kvSet(key, value, ttlSeconds) {
  if (redisAvailable) {
    try {
      if (ttlSeconds) await redisClient.set(key, JSON.stringify(value), "EX", ttlSeconds);
      else await redisClient.set(key, JSON.stringify(value));
      return;
    } catch (err) {
      console.error(`⚠️  Redis SET failed for "${key}", falling back to in-memory:`, err.message);
    }
  }
  memoryStore.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
}

async function kvDelete(key) {
  if (redisAvailable) {
    try {
      await redisClient.del(key);
      return;
    } catch (err) {
      console.error(`⚠️  Redis DEL failed for "${key}", falling back to in-memory:`, err.message);
    }
  }
  memoryStore.delete(key);
}

// For the rate-limit / brute-force-lockout pattern: append a timestamp to a
// list, trim anything outside the window, return the resulting count. Uses
// a Redis list when available (LPUSH + LTRIM + EXPIRE), the same
// filter-and-store approach as before otherwise.
async function kvAppendAndCountRecent(key, windowSeconds) {
  const now = Date.now();
  if (redisAvailable) {
    try {
      const pipeline = redisClient.pipeline();
      pipeline.lpush(key, now);
      pipeline.ltrim(key, 0, 999); // cap list size, defensive
      pipeline.expire(key, windowSeconds);
      await pipeline.exec();
      const raw = await redisClient.lrange(key, 0, -1);
      const cutoff = now - windowSeconds * 1000;
      return raw.map(Number).filter((t) => t > cutoff).length;
    } catch (err) {
      console.error(`⚠️  Redis list ops failed for "${key}", falling back to in-memory:`, err.message);
    }
  }
  const entry = memoryStore.get(key);
  const cutoff = now - windowSeconds * 1000;
  const hits = ((entry?.value) || []).filter((t) => t > cutoff);
  hits.push(now);
  memoryStore.set(key, { value: hits, expiresAt: now + windowSeconds * 1000 });
  return hits.length;
}

async function kvCountRecent(key, windowSeconds) {
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;
  if (redisAvailable) {
    try {
      const raw = await redisClient.lrange(key, 0, -1);
      return raw.map(Number).filter((t) => t > cutoff).length;
    } catch (err) {
      console.error(`⚠️  Redis LRANGE failed for "${key}", falling back to in-memory:`, err.message);
    }
  }
  const entry = memoryStore.get(key);
  return ((entry?.value) || []).filter((t) => t > cutoff).length;
}

function isRedisActive() {
  return redisAvailable;
}

module.exports = { kvGet, kvSet, kvDelete, kvAppendAndCountRecent, kvCountRecent, isRedisActive };
