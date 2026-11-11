const redis = require('redis');

let redisClient = null;
let isConnected = false;

// In-memory fallback lock storage with TTL support (used if Redis is offline/unreachable)
const inMemoryStore = new Map();

// Periodic sweep to clean up expired in-memory locks
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of inMemoryStore.entries()) {
    if (item.expiresAt <= now) {
      inMemoryStore.delete(key);
    }
  }
}, 10000).unref();

// Initialize Redis Client if URL is present
if (process.env.REDIS_URL) {
  try {
    redisClient = redis.createClient({
      url: process.env.REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 3) {
            console.warn('⚠️ [Redis] Reconnection stopped after 3 attempts. Active in-memory lock engine is handling concurrency.');
            return false; // Stop retrying indefinitely
          }
          return Math.min(retries * 500, 2000);
        }
      }
    });

    redisClient.on('connect', () => {
      isConnected = true;
      console.log('🟢 [Redis] Connected to Redis Cloud successfully! Concurrent locking is live.');
    });

    redisClient.on('ready', () => {
      isConnected = true;
    });

    redisClient.on('error', (err) => {
      isConnected = false;
      console.warn('🔴 [Redis Error]:', err.message);
    });

    redisClient.on('end', () => {
      isConnected = false;
    });

    redisClient.connect().catch((err) => {
      isConnected = false;
      console.warn('⚠️ [Redis] Initial connection error:', err.message, '- Active in-memory lock engine fallback enabled.');
    });
  } catch (err) {
    console.warn('⚠️ [Redis] Failed to initialize client:', err.message);
  }
} else {
  console.log('ℹ️ [Redis] No REDIS_URL configured. Running with in-memory lock engine.');
}

// Low-level helper methods that route to live Redis or in-memory fallback
const clientProxy = {
  get isOpen() {
    return isConnected && redisClient && redisClient.isOpen;
  },

  async get(key) {
    if (this.isOpen) {
      try {
        return await redisClient.get(key);
      } catch (err) {
        console.warn('⚠️ [Redis.get error, using fallback]:', err.message);
      }
    }
    const item = inMemoryStore.get(key);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      inMemoryStore.delete(key);
      return null;
    }
    return item.value;
  },

  async set(key, value, options = {}) {
    if (this.isOpen) {
      try {
        let opts = options;
        if (typeof opts !== 'object' || opts === null) {
          opts = {};
        }
        return await redisClient.set(key, value, opts);
      } catch (err) {
        console.warn('⚠️ [Redis.set error, using fallback]:', err.message);
      }
    }

    const now = Date.now();
    const existing = inMemoryStore.get(key);
    if (existing && existing.expiresAt > now) {
      if (options.NX) return null;
    }
    const ttlMs = options.EX ? Number(options.EX) * 1000 : 600000;
    inMemoryStore.set(key, { value, expiresAt: now + ttlMs });
    return 'OK';
  },

  async del(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.length === 0) return 0;

    let deletedCount = 0;
    if (this.isOpen) {
      try {
        return await redisClient.del(list);
      } catch (err) {
        console.warn('⚠️ [Redis.del error, using fallback]:', err.message);
      }
    }

    for (const k of list) {
      if (inMemoryStore.delete(k)) deletedCount++;
    }
    return deletedCount;
  },

  async keys(pattern) {
    if (this.isOpen) {
      try {
        return await redisClient.keys(pattern);
      } catch (err) {
        console.warn('⚠️ [Redis.keys error, using fallback]:', err.message);
      }
    }

    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    const matched = [];
    const now = Date.now();
    for (const [k, v] of inMemoryStore.entries()) {
      if (v.expiresAt <= now) {
        inMemoryStore.delete(k);
      } else if (regex.test(k)) {
        matched.push(k);
      }
    }
    return matched;
  },

  // ========================================================
  // 🛡️ HIGH-LEVEL CONCURRENCY LOCK ENGINE FOR SEAT BOOKINGS
  // ========================================================

  /**
   * Atomically acquires locks on an array of seats for a given show.
   * If ANY seat fails to lock (already locked by someone else), all locks
   * acquired during this request are automatically rolled back.
   *
   * @param {string} showId - ID of the show
   * @param {string[]} seats - Array of seat IDs (e.g. ['A1', 'A2'])
   * @param {string} userId - User ID locking the seats
   * @param {number} ttlSeconds - Time-to-live in seconds (default 600 = 10 mins)
   * @returns {Promise<{success: boolean, lockedSeats?: string[], failedSeat?: string, message?: string}>}
   */
  async acquireSeatLocks(showId, seats, userId, ttlSeconds = 600) {
    if (!showId || !Array.isArray(seats) || seats.length === 0 || !userId) {
      return { success: false, message: 'Invalid lock parameters.' };
    }

    const lockedKeys = [];

    for (const seat of seats) {
      const lockKey = `lock:show:${showId}:seat:${seat}`;
      const acquired = await this.set(lockKey, userId.toString(), {
        NX: true,
        EX: ttlSeconds
      });

      if (acquired) {
        lockedKeys.push(lockKey);
      } else {
        // Rollback: delete any locks we already acquired in this batch
        if (lockedKeys.length > 0) {
          await this.del(lockedKeys);
        }
        return {
          success: false,
          failedSeat: seat,
          message: `Seat ${seat} is currently being booked by another customer. Please select a different seat.`
        };
      }
    }

    return {
      success: true,
      lockedSeats: seats,
      lockedKeys
    };
  },

  /**
   * Releases seat locks for a show.
   * If userId is provided, only releases locks held by that user.
   *
   * @param {string} showId
   * @param {string[]} seats
   * @param {string|null} userId
   */
  async releaseSeatLocks(showId, seats, userId = null) {
    if (!showId || !Array.isArray(seats) || seats.length === 0) return { success: true };

    const keysToDelete = [];
    for (const seat of seats) {
      const lockKey = `lock:show:${showId}:seat:${seat}`;
      if (userId) {
        const holder = await this.get(lockKey);
        if (holder && holder.toString() === userId.toString()) {
          keysToDelete.push(lockKey);
        }
      } else {
        keysToDelete.push(lockKey);
      }
    }

    if (keysToDelete.length > 0) {
      await this.del(keysToDelete);
    }

    return { success: true, releasedCount: keysToDelete.length };
  },

  /**
   * Verifies that the user still holds the lock for all requested seats,
   * or acquires it if not already locked. Used before saving the booking.
   *
   * @param {string} showId
   * @param {string[]} seats
   * @param {string} userId
   * @param {number} extensionTtl - Extension TTL in seconds (default 120s)
   */
  async verifyOrAcquireSeatLocks(showId, seats, userId, extensionTtl = 120) {
    if (!showId || !Array.isArray(seats) || seats.length === 0 || !userId) {
      return { success: false, message: 'Invalid verification parameters.' };
    }

    const userIdStr = userId.toString();

    for (const seat of seats) {
      const lockKey = `lock:show:${showId}:seat:${seat}`;
      const holder = await this.get(lockKey);

      if (holder) {
        if (holder !== userIdStr) {
          return {
            success: false,
            failedSeat: seat,
            message: `Seat ${seat} is currently locked by another customer.`
          };
        }
      } else {
        // Lock might have just expired at the boundary; re-acquire
        const acquired = await this.set(lockKey, userIdStr, { NX: true, EX: extensionTtl });
        if (!acquired) {
          return {
            success: false,
            failedSeat: seat,
            message: `Seat ${seat} lock expired and was acquired by another customer.`
          };
        }
      }
    }

    return { success: true };
  },

  /**
   * Retrieves all currently locked seat IDs for a given show.
   * @param {string} showId
   * @returns {Promise<string[]>}
   */
  async getLockedSeats(showId) {
    try {
      const pattern = `lock:show:${showId}:seat:*`;
      const keys = await this.keys(pattern);
      return keys.map((k) => k.split(':seat:')[1]).filter(Boolean);
    } catch (err) {
      console.warn('⚠️ [getLockedSeats error]:', err.message);
      return [];
    }
  }
};

module.exports = clientProxy;
