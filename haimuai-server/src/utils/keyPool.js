/**
 * Gemini API Key Pool Manager
 * ─────────────────────────────────────────────────────────────
 * Reads GEMINI_API_KEYS (comma-separated) from .env.
 * Falls back to GEMINI_API_KEY (single key) for backwards compat.
 *
 * Features:
 *  - Round-robin across sessions (each new session gets the next key)
 *  - Per-key quota tracking: marks a key as exhausted on 429/403-quota
 *  - Auto-cooldown: exhausted keys are retried after COOLDOWN_MS (1 hour)
 *  - Fallback: if ALL keys are exhausted, waits and retries
 *  - Admin endpoint: GET /api/ai/keys/status shows pool health
 */

const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown per key after quota hit

class GeminiKeyPool {
  constructor() {
    this._keys = [];
    this._index = 0; // round-robin cursor
    this._exhausted = {}; // { keyIndex: timestamp_when_exhausted }
    this._load();
  }

  _load() {
    // Support comma-separated multi-key list OR single key
    const multiKey = process.env.GEMINI_API_KEYS || '';
    const singleKey = process.env.GEMINI_API_KEY || '';

    if (multiKey) {
      this._keys = multiKey
        .split(',')
        .map(k => k.trim())
        .filter(Boolean);
    } else if (singleKey) {
      this._keys = [singleKey];
    }

    if (this._keys.length === 0) {
      console.error('[KeyPool] ⚠️  No Gemini API keys configured! Set GEMINI_API_KEYS in .env');
    } else {
      console.log(`[KeyPool] Loaded ${this._keys.length} Gemini API key(s)`);
    }
  }

  get totalKeys() {
    return this._keys.length;
  }

  /**
   * Get the next available key using round-robin.
   * Skips keys that are in their cooldown window.
   * Returns null if all keys are exhausted (caller should wait or 503).
   */
  getKey() {
    const n = this._keys.length;
    if (n === 0) return null;

    const now = Date.now();

    // Try each key starting from current round-robin position
    for (let i = 0; i < n; i++) {
      const idx = (this._index + i) % n;
      const exhaustedAt = this._exhausted[idx];

      if (!exhaustedAt || (now - exhaustedAt) >= COOLDOWN_MS) {
        // Clear stale cooldown
        if (exhaustedAt) {
          delete this._exhausted[idx];
          console.log(`[KeyPool] Key #${idx + 1} cooldown expired — back in pool`);
        }
        // Advance round-robin for next call
        this._index = (idx + 1) % n;
        return { key: this._keys[idx], idx };
      }
    }

    return null; // all keys in cooldown
  }

  /**
   * Mark a key as quota-exhausted after a 429 or quota-403.
   * It will be retried after COOLDOWN_MS.
   */
  markExhausted(idx) {
    this._exhausted[idx] = Date.now();
    const remaining = Object.keys(this._exhausted).length;
    const total = this._keys.length;
    console.warn(`[KeyPool] Key #${idx + 1} marked exhausted. ${total - remaining}/${total} keys available.`);
  }

  /**
   * Status report for admin endpoint.
   */
  status() {
    const now = Date.now();
    return this._keys.map((key, idx) => {
      const exhaustedAt = this._exhausted[idx];
      const isExhausted = exhaustedAt && (now - exhaustedAt) < COOLDOWN_MS;
      const cooldownRemaining = isExhausted
        ? Math.ceil((COOLDOWN_MS - (now - exhaustedAt)) / 60000)
        : 0;
      return {
        index: idx + 1,
        keyPreview: `...${key.slice(-6)}`, // show last 6 chars only
        status: isExhausted ? 'exhausted' : 'active',
        cooldownRemainingMins: cooldownRemaining,
      };
    });
  }
}

// Singleton — shared across all requests
const keyPool = new GeminiKeyPool();

module.exports = keyPool;
