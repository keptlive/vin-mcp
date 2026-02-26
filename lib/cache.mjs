// LRU Cache with TTL for VIN decode results

const DEFAULT_MAX = 1000;
const DEFAULT_TTL = 60 * 60 * 1000; // 1 hour

export class LRUCache {
  constructor(max = DEFAULT_MAX, ttl = DEFAULT_TTL) {
    this.max = max;
    this.ttl = ttl;
    this.map = new Map(); // key → { value, expires }
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.map.delete(key);
      return undefined;
    }
    // Move to end (most recent)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this.map.delete(key); // remove old position
    this.map.set(key, { value, expires: Date.now() + this.ttl });
    // Evict oldest if over capacity
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }

  // Prune all expired entries
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (now > entry.expires) this.map.delete(key);
    }
  }
}

// Shared cache instances
export const vinCache = new LRUCache(1000, 60 * 60 * 1000);     // 1hr for full decodes
export const recallCache = new LRUCache(500, 6 * 60 * 60 * 1000); // 6hr for recalls (change less often)
export const ratingCache = new LRUCache(500, 24 * 60 * 60 * 1000); // 24hr for safety ratings (static)
export const fuelCache = new LRUCache(500, 24 * 60 * 60 * 1000);  // 24hr for fuel economy (static)
