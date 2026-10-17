/**
 * Command registry and matching logic behind the global search overlay.
 *
 * The shortcut is platform-aware to avoid conflicting with the browser's own
 * Cmd+K binding on macOS:
 *   - macOS:   Ctrl+K  (Cmd+K is reserved by browsers for tab/search)
 *   - Windows/Linux: Ctrl+K or Cmd+K
 *
 * Pure and DOM-free so the ranking rules can be unit tested directly.
 */

/** The default set of destinations reachable from anywhere in the app. */
const BASE_COMMANDS = [
  {
    id: 'nav-explorer',
    title: 'Explorer',
    subtitle: 'Simulate a contract call and inspect its resource cost',
    group: 'Navigation',
    href: '/?tab=explorer',
    keywords: ['result', 'simulate', 'analyze', 'home'],
  },
  {
    id: 'nav-history',
    title: 'Invocation history',
    subtitle: 'Revisit previous simulations',
    group: 'Navigation',
    href: '/?tab=history',
    keywords: ['past', 'previous', 'runs', 'recent'],
  },
  {
    id: 'nav-transactions',
    title: 'Transactions',
    subtitle: 'Browse recent on-chain transactions',
    group: 'Navigation',
    href: '/?tab=transactions',
    keywords: ['ledger', 'tx', 'onchain'],
  },
  {
    id: 'nav-schema',
    title: 'Subgraph schema',
    subtitle: 'Visualize contract calls and storage mappings',
    group: 'Navigation',
    href: '/?tab=schema',
    keywords: ['graph', 'diagram', 'nodes', 'visualizer', 'dependencies'],
  },
  {
    id: 'nav-settings',
    title: 'Settings',
    subtitle: 'Configure custom RPC and indexer endpoints',
    group: 'Preferences',
    href: '/settings',
    keywords: ['rpc', 'indexer', 'endpoint', 'preferences', 'config', 'custom'],
  },
];

/**
 * Best-effort detection of macOS. In browsers `navigator.platform` has been the
 * long-standing signal ("MacIntel", "MacPPC", "Mac68K"); `navigator.userAgent`
 * is a fallback for environments where `platform` is unavailable. Both are
 * safe to read in Node.js tests (`navigator` is simply undefined there).
 *
 * Exported so callers can pass a concrete value when they want deterministic
 * behaviour (e.g. tests) instead of relying on the runtime user-agent.
 */
function defaultIsMac() {
  if (typeof navigator !== 'undefined') {
    if (typeof navigator.platform === 'string' && /Mac/i.test(navigator.platform)) {
      return true;
    }
    if (typeof navigator.userAgent === 'string' && /Mac/i.test(navigator.userAgent)) {
      return true;
    }
  }
  return false;
}

/**
 * True when a keyboard event should open the global search overlay.
 *
 * The shortcut is platform-aware because macOS browsers reserve Cmd+K for their
 * own tab/search UI, which would intercept the keystroke before it reached us.
 * On macOS only Ctrl+K opens the overlay; on Windows and Linux both Ctrl+K and
 * Cmd+K work (Cmd is the Windows key there and rarely collides).
 *
 * `options.isMac` lets tests drive both branches deterministically; in normal
 * use it defaults to {@link defaultIsMac}.
 *
 * @param {KeyboardEvent | null | undefined} event
 * @param {{ isMac?: boolean }} [options]
 * @returns {boolean}
 */
function isSearchShortcut(event, options = {}) {
  if (!event || typeof event.key !== 'string') return false;
  const isMac = typeof options.isMac === 'boolean' ? options.isMac : defaultIsMac();

  // On macOS ignore Cmd (metaKey) entirely so the browser keeps Cmd+K for its
  // own tab/search; only Ctrl+K opens the overlay.
  if (isMac) {
    if (!event.ctrlKey) return false;
  } else {
    if (!(event.metaKey || event.ctrlKey)) return false;
  }
  // Cmd+Alt+K / Ctrl+Alt+K and friends belong to other tools.
  if (event.altKey) return false;
  return event.key.toLowerCase() === 'k';
}

/** True when a keyboard event should close the overlay. */
function isDismissShortcut(event) {
  return Boolean(event) && event.key === 'Escape';
}

function normalize(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .trim();
}

/** Every character of `query` appears in `text`, in order. */
function isSubsequence(query, text) {
  let cursor = 0;
  for (let i = 0; i < text.length && cursor < query.length; i += 1) {
    if (text[i] === query[cursor]) cursor += 1;
  }
  return cursor === query.length;
}

/**
 * Split a searchable field into useful fuzzy-match candidates.
 *
 * Keeping the complete value allows multi-word queries to match, while the
 * individual tokens make typos in one word (for example "histroy") useful.
 */
function fuzzyCandidates(value) {
  const normalized = normalize(value);
  if (!normalized) return [];

  const words = normalized.split(/[\s/_-]+/).filter(Boolean);
  return words.length > 1 ? [normalized, ...words] : [normalized];
}

/**
 * Keep fuzzy matching conservative for short queries and progressively allow
 * more edits as the query gets longer.
 */
function fuzzyEditLimit(length) {
  if (length < 3) return 0;
  if (length <= 4) return 1;
  if (length <= 8) return 2;
  return 3;
}

/**
 * Optimal-string-alignment Damerau-Levenshtein distance.
 *
 * Unlike a plain subsequence check, this catches substitutions, insertions,
 * deletions and adjacent transpositions, which are the common search typos we
 * want Cmd+K to tolerate.
 */
function damerauLevenshteinDistance(source, target) {
  const rows = source.length + 1;
  const columns = target.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(columns).fill(0));

  for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
  for (let column = 0; column < columns; column += 1) matrix[0][column] = column;

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitutionCost = source[row - 1] === target[column - 1] ? 0 : 1;

      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + substitutionCost,
      );

      if (
        row > 1 &&
        column > 1 &&
        source[row - 1] === target[column - 2] &&
        source[row - 2] === target[column - 1]
      ) {
        matrix[row][column] = Math.min(
          matrix[row][column],
          matrix[row - 2][column - 2] + 1,
        );
      }
    }
  }

  return matrix[source.length][target.length];
}

function scoreFuzzyCandidates(query, candidates, baseScore) {
  const maxEdits = fuzzyEditLimit(query.length);
  if (maxEdits === 0) return 0;

  let bestScore = 0;

  for (const candidate of candidates) {
    if (Math.abs(candidate.length - query.length) > maxEdits) continue;

    const distance = damerauLevenshteinDistance(query, candidate);
    if (distance <= maxEdits) {
      bestScore = Math.max(bestScore, baseScore - distance * 5);
    }
  }

  return bestScore;
}

/**
 * Score a command against a query. Higher is better; `0` means no match.
 *
 * Exact/prefix/substring matches remain strongest. Typo-tolerant matches are
 * ranked below direct title matches but above the loose subsequence fallback.
 */
function scoreCommand(command, query) {
  const q = normalize(query);
  if (q === '') return 1;

  const title = normalize(command.title);
  const subtitle = normalize(command.subtitle);
  const keywords = Array.isArray(command.keywords) ? command.keywords.map(normalize) : [];

  if (title === q) return 100;
  if (title.startsWith(q)) return 90;
  if (title.split(/\s+/).some((word) => word.startsWith(q))) return 80;
  if (keywords.some((keyword) => keyword === q || keyword.startsWith(q))) return 70;
  if (title.includes(q)) return 60;
  if (subtitle.includes(q)) return 40;
  if (keywords.some((keyword) => keyword.includes(q))) return 30;

  const fuzzyScore = Math.max(
    scoreFuzzyCandidates(q, fuzzyCandidates(title), 55),
    scoreFuzzyCandidates(q, keywords.flatMap(fuzzyCandidates), 45),
    scoreFuzzyCandidates(q, fuzzyCandidates(subtitle), 30),
  );
  if (fuzzyScore > 0) return fuzzyScore;

  if (isSubsequence(q, title)) return 20;

  return 0;
}

/**
 * Filter and rank commands for a query.
 *
 * Ties keep registry order so the list does not jump around while typing.
 */
function filterCommands(commands, query, options = {}) {
  const limit = typeof options.limit === 'number' ? options.limit : 10;
  const list = Array.isArray(commands) ? commands : [];

  return list
    .map((command, index) => ({ command, index, score: scoreCommand(command, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
    .slice(0, limit)
    .map((entry) => entry.command);
}

/**
 * Build a human-readable parameter hint string from a contract function's
 * input list, e.g. `(from: address, to: address, amount: u128)`.
 *
 * Falls back gracefully when `inputs` is absent or empty.
 *
 * @param {Array<{name: string, type: string, optional?: boolean}>} inputs
 * @returns {string}
 */
function buildParamHint(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return '()';
  const parts = inputs.map((input) => {
    const name = String(input.name ?? '');
    const type = String(input.type ?? '');
    const suffix = input.optional ? '?' : '';
    return `${name}${suffix}: ${type}`;
  });
  return `(${parts.join(', ')})`;
}

/**
 * Build the searchable command list, optionally extended with contextual
 * entries such as the current contract's functions.
 *
 * Contract function commands include a parameter type-hint subtitle and extra
 * keywords derived from parameter names and types so users can search for
 * e.g. "address" or "u128" to surface relevant functions.
 *
 * @param {{ functions?: Array<{name: string, inputs?: Array<{name:string,type:string,optional?:boolean}>, outputs?: string}>, extra?: Array<object> }} [context]
 */
function buildCommandRegistry(context = {}) {
  const functionCommands = (Array.isArray(context.functions) ? context.functions : []).map(
    (fn) => {
      const paramHint = buildParamHint(fn.inputs);
      const outputHint = fn.outputs ? ` → ${fn.outputs}` : '';
      const paramKeywords = Array.isArray(fn.inputs)
        ? fn.inputs.flatMap((input) => [input.name, input.type].filter(Boolean))
        : [];

      return {
        id: `fn-${fn.name}`,
        title: `${fn.name}${paramHint}${outputHint}`,
        subtitle: buildFunctionSubtitle(fn),
        group: 'Contract functions',
        action: 'select-function',
        payload: { name: fn.name },
        keywords: ['function', 'invoke', 'call', ...paramKeywords],
      };
    },
  );

  const extra = Array.isArray(context.extra) ? context.extra : [];
  return [...BASE_COMMANDS, ...functionCommands, ...extra];
}

/**
 * Build a subtitle for a contract function that describes its parameters.
 *
 * @param {{ inputs?: Array<{name: string, type: string, description?: string, optional?: boolean}>, outputs?: string }} fn
 * @returns {string}
 */
function buildFunctionSubtitle(fn) {
  if (!Array.isArray(fn.inputs) || fn.inputs.length === 0) {
    return fn.outputs ? `Returns ${fn.outputs}` : 'No parameters';
  }
  const paramList = fn.inputs
    .map((input) => {
      const optional = input.optional ? ' (optional)' : '';
      const description = input.description ? ` — ${input.description}` : '';
      return `${input.name}: ${input.type}${optional}${description}`;
    })
    .join(', ');
  return `Params: ${paramList}`;
}

/** Wrap-around cursor movement for arrow-key navigation. */
function moveHighlight(current, delta, length) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  const next = (current + delta) % length;
  return next < 0 ? next + length : next;
}

/** Prefix for the DOM ids the search listbox gives its options. */
const SEARCH_OPTION_ID_PREFIX = 'global-search-option-';

/**
 * DOM id for a command's option element.
 *
 * The combobox points at the active option with `aria-activedescendant`, which
 * needs a stable id per option. Command ids are not guaranteed to be valid ids
 * ("fn:transfer_from"), so anything outside the safe set is folded to a dash,
 * and a missing id folds to `unknown` rather than to a bare prefix.
 */
function optionIdFor(command) {
  const raw = command && command.id != null ? String(command.id) : 'unknown';
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '-') || 'unknown';
  return `${SEARCH_OPTION_ID_PREFIX}${safe}`;
}

/**
 * Clamp a stored highlight to a result list that may have shrunk since the
 * highlight was set. Returns 0 for an empty list so callers can index safely.
 */
function normalizeHighlight(current, length) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  if (!Number.isFinite(current) || current < 0) return 0;
  const whole = Math.trunc(current);
  return whole >= length ? length - 1 : whole;
}

/**
 * Resolve a listbox navigation key to an index.
 *
 * `Home` and `End` jump to the ends; anything else keeps the clamped current
 * position, so callers can pass any key without special-casing it first.
 */
function moveHighlightTo(key, current, length) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  return normalizeHighlight(current, length);
}

/**
 * Internal command `group` values mapped to display categories.
 *
 * Order matters for {@link groupResultsByCategory}: the entries here define
 * the canonical display order (pages → functions → settings).
 */
const CATEGORY_ORDER = [
  { category: 'pages', groups: ['Navigation'] },
  { category: 'functions', groups: ['Contract functions'] },
  { category: 'settings', groups: ['Preferences'] },
];

/** Human-readable heading shown above each category bucket. */
const CATEGORY_LABELS = {
  pages: 'Pages',
  functions: 'Functions',
  settings: 'Settings',
};

/**
 * Map an internal `group` string to a `SearchCategory`.
 *
 * Unknown or missing groups fall back to `'pages'` so they still render in a
 * sensible place instead of being dropped.
 *
 * @param {string} group
 * @returns {'pages' | 'functions' | 'settings'}
 */
function categoryForGroup(group) {
  const value = String(group == null ? '' : group);
  for (const entry of CATEGORY_ORDER) {
    if (entry.groups.includes(value)) return entry.category;
  }
  return 'pages';
}

/**
 * Group a flat ordered results array into display categories.
 *
 * Empty categories are omitted. Categories always appear in the order
 * pages → functions → settings so the list stays stable as the query narrows.
 *
 * @param {Array<{ group?: string }>} results
 * @returns {Array<{ category: 'pages' | 'functions' | 'settings', label: string, commands: object[] }>}
 */
function groupResultsByCategory(results) {
  const list = Array.isArray(results) ? results : [];
  const buckets = new Map();
  for (const entry of CATEGORY_ORDER) {
    buckets.set(entry.category, []);
  }

  for (const command of list) {
    const category = categoryForGroup(command && command.group);
    buckets.get(category).push(command);
  }

  return CATEGORY_ORDER
    .map((entry) => entry.category)
    .filter((category) => buckets.get(category).length > 0)
    .map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      commands: buckets.get(category),
    }));
}

module.exports = {
  BASE_COMMANDS,
  isSearchShortcut,
  isDismissShortcut,
  scoreCommand,
  filterCommands,
  buildCommandRegistry,
  buildParamHint,
  buildFunctionSubtitle,
  moveHighlight,
  moveHighlightTo,
  normalizeHighlight,
  optionIdFor,
  SEARCH_OPTION_ID_PREFIX,
  defaultIsMac,
  categoryForGroup,
  groupResultsByCategory,
};
