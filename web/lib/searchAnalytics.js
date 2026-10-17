/**
 * Search analytics for the global search overlay.
 *
 * Records which queries the user typed and which commands they selected, then
 * surfaces the most-used ones so the overlay can show "recent / popular" hints.
 *
 * Everything is stored in LocalStorage — nothing ever leaves the browser.
 * All reads are defensive: corrupt JSON, a full quota or an unavailable store
 * all fall back gracefully rather than throwing.
 *
 * Pure and DOM-free so the logic can be unit tested directly under `node --test`.
 */

const ANALYTICS_STORAGE_KEY = 'sky-moon-scope-search-analytics';

/**
 * Maximum number of distinct query strings or command ids we keep.
 * When the cap is reached the least-used entry is evicted before inserting
 * the new one, so the store stays bounded regardless of usage patterns.
 */
const MAX_ENTRIES = 200;

/** Minimum query length we bother recording (single keystrokes are noise). */
const MIN_QUERY_LENGTH = 2;

// ─── Types (documented here; see .d.ts for the TypeScript-facing shape) ───────
//
// StoredAnalytics = {
//   queries:  Record<string, number>   // normalised query → hit count
//   commands: Record<string, number>   // command id       → selection count
// }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const debugWarn = (...args) => {
  if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
    console.warn(...args);
  }
};

function resolveStorage(storage) {
  if (storage) return storage;
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  return null;
}

/** Normalise a query string: lowercase + collapse whitespace. */
function normalizeQuery(query) {
  return String(query == null ? '' : query)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return an empty analytics object. Used as the default when storage is
 * missing or corrupt.
 */
function emptyAnalytics() {
  return { queries: {}, commands: {} };
}

/**
 * Coerce an arbitrary value from JSON into a valid analytics object.
 * Unknown keys and non-numeric counts are silently dropped.
 */
function normalizeAnalytics(raw) {
  if (!raw || typeof raw !== 'object') return emptyAnalytics();

  const queries = {};
  if (raw.queries && typeof raw.queries === 'object') {
    for (const [key, val] of Object.entries(raw.queries)) {
      const count = Number(val);
      if (typeof key === 'string' && key.length > 0 && Number.isFinite(count) && count > 0) {
        queries[key] = Math.round(count);
      }
    }
  }

  const commands = {};
  if (raw.commands && typeof raw.commands === 'object') {
    for (const [key, val] of Object.entries(raw.commands)) {
      const count = Number(val);
      if (typeof key === 'string' && key.length > 0 && Number.isFinite(count) && count > 0) {
        commands[key] = Math.round(count);
      }
    }
  }

  return { queries, commands };
}

/**
 * Increment `map[key]` by 1, evicting the least-used entry first when the map
 * has reached `MAX_ENTRIES` and `key` is not already present.
 *
 * Mutates `map` in place and returns it.
 *
 * @param {Record<string, number>} map
 * @param {string} key
 * @returns {Record<string, number>}
 */
function increment(map, key) {
  if (Object.prototype.hasOwnProperty.call(map, key)) {
    // Fast path: key already exists, just bump it.
    map[key] += 1;
    return map;
  }

  // Need to insert a new key — evict the least-used one if we're at the cap.
  const keys = Object.keys(map);
  if (keys.length >= MAX_ENTRIES) {
    let minKey = keys[0];
    let minVal = map[minKey];
    for (let i = 1; i < keys.length; i++) {
      if (map[keys[i]] < minVal) {
        minVal = map[keys[i]];
        minKey = keys[i];
      }
    }
    delete map[minKey];
  }

  map[key] = 1;
  return map;
}

/**
 * Return the top `n` entries from a frequency map, sorted descending by count.
 *
 * @param {Record<string, number>} map
 * @param {number} n
 * @returns {Array<{ value: string, count: number }>}
 */
function topN(map, n) {
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
  return Object.entries(map)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read the persisted analytics object from storage.
 * Always returns a valid `{ queries, commands }` object.
 *
 * @param {Storage|null} [storage]  Optional storage override (for tests).
 */
function loadAnalytics(storage) {
  const store = resolveStorage(storage);
  if (!store) return emptyAnalytics();

  try {
    const raw = store.getItem(ANALYTICS_STORAGE_KEY);
    if (!raw) return emptyAnalytics();
    return normalizeAnalytics(JSON.parse(raw));
  } catch {
    return emptyAnalytics();
  }
}

/**
 * Persist an analytics object to storage.
 *
 * @param {{ queries: Record<string, number>, commands: Record<string, number> }} analytics
 * @param {Storage|null} [storage]
 */
function saveAnalytics(analytics, storage) {
  const store = resolveStorage(storage);
  if (!store) return;

  try {
    store.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(analytics));
  } catch (error) {
    debugWarn('Failed to persist Sky Moon Scope search analytics:', error);
  }
}

/**
 * Record a search interaction: the query the user had typed and the command id
 * they selected.  Both are optional — pass an empty string to skip recording
 * that dimension.
 *
 * Queries shorter than `MIN_QUERY_LENGTH` characters (after normalisation) are
 * not recorded because single keystrokes are noise rather than signal.
 *
 * @param {string} query      The raw query string from the search input.
 * @param {string} commandId  The `id` of the command that was selected.
 * @param {Storage|null} [storage]  Optional storage override (for tests).
 */
function recordSearch(query, commandId, storage) {
  const analytics = loadAnalytics(storage);

  const q = normalizeQuery(query);
  if (q.length >= MIN_QUERY_LENGTH) {
    increment(analytics.queries, q);
  }

  const cmd = String(commandId == null ? '' : commandId).trim();
  if (cmd.length > 0) {
    increment(analytics.commands, cmd);
  }

  saveAnalytics(analytics, storage);
}

/**
 * Return the `n` most-searched query strings, sorted by frequency.
 *
 * @param {number} [n=5]
 * @param {Storage|null} [storage]
 * @returns {Array<{ value: string, count: number }>}
 */
function getTopQueries(n, storage) {
  const { queries } = loadAnalytics(storage);
  return topN(queries, n ?? 5);
}

/**
 * Return the `n` most-selected command ids, sorted by frequency.
 *
 * @param {number} [n=5]
 * @param {Storage|null} [storage]
 * @returns {Array<{ value: string, count: number }>}
 */
function getTopCommands(n, storage) {
  const { commands } = loadAnalytics(storage);
  return topN(commands, n ?? 5);
}

/**
 * Erase all stored analytics.
 *
 * @param {Storage|null} [storage]
 */
function clearAnalytics(storage) {
  const store = resolveStorage(storage);
  if (!store) return;

  try {
    store.removeItem(ANALYTICS_STORAGE_KEY);
  } catch (error) {
    debugWarn('Failed to clear Sky Moon Scope search analytics:', error);
  }
}

module.exports = {
  ANALYTICS_STORAGE_KEY,
  MAX_ENTRIES,
  MIN_QUERY_LENGTH,
  normalizeQuery,
  loadAnalytics,
  saveAnalytics,
  recordSearch,
  getTopQueries,
  getTopCommands,
  clearAnalytics,
  // Exported for tests only:
  increment,
  topN,
  normalizeAnalytics,
};
