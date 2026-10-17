// searchCommands.test.cjs — unit tests for the global search overlay
// Covers search behavior from Issues #623, #387 and #396 (platform-aware shortcut)
// Runs with: node --test ./lib/searchCommands.test.cjs

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BASE_COMMANDS,
  isSearchShortcut,
  isDismissShortcut,
  scoreCommand,
  filterCommands,
  buildCommandRegistry,
  buildParamHint,
  buildFunctionSubtitle,
  moveHighlight,
  categoryForGroup,
  groupResultsByCategory,
} = require('./searchCommands');

// ── Shortcut detection ──────────────────────────────────────────────────────
//
// The shortcut is platform-aware (issue #396): macOS browsers reserve Cmd+K
// for their own tab/search, so on macOS only Ctrl+K opens the overlay.
// On Windows/Linux both Ctrl+K and Cmd+K work.

test('isSearchShortcut (non-mac): matches Ctrl+K and Cmd+K', () => {
  assert.equal(isSearchShortcut({ key: 'k', ctrlKey: true }, { isMac: false }), true);
  assert.equal(isSearchShortcut({ key: 'k', metaKey: true }, { isMac: false }), true);
});

test('isSearchShortcut (mac): matches Ctrl+K but NOT Cmd+K', () => {
  // Cmd+K is reserved by macOS browsers — the overlay must not grab it.
  assert.equal(isSearchShortcut({ key: 'k', ctrlKey: true }, { isMac: true }), true);
  assert.equal(isSearchShortcut({ key: 'k', metaKey: true }, { isMac: true }), false);
  // Even Ctrl+Cmd+K should not open, since Cmd is present and Ctrl alone is the
  // required modifier — but having both is ambiguous, so we only accept Ctrl.
  assert.equal(isSearchShortcut({ key: 'k', ctrlKey: true, metaKey: true }, { isMac: true }), true);
});

test('isSearchShortcut: is case insensitive (Shift+Ctrl+K still opens)', () => {
  assert.equal(isSearchShortcut({ key: 'K', ctrlKey: true, shiftKey: true }, { isMac: false }), true);
  assert.equal(isSearchShortcut({ key: 'K', ctrlKey: true, shiftKey: true }, { isMac: true }), true);
});

test('isSearchShortcut: ignores a bare k and other modifier combos', () => {
  assert.equal(isSearchShortcut({ key: 'k' }, { isMac: false }), false);
  assert.equal(isSearchShortcut({ key: 'k' }, { isMac: true }), false);
  assert.equal(isSearchShortcut({ key: 'k', altKey: true, metaKey: true }, { isMac: false }), false);
  assert.equal(isSearchShortcut({ key: 'k', altKey: true, ctrlKey: true }, { isMac: true }), false);
  assert.equal(isSearchShortcut({ key: 'j', ctrlKey: true }, { isMac: false }), false);
});

test('isSearchShortcut: tolerates missing or malformed events', () => {
  assert.equal(isSearchShortcut(null), false);
  assert.equal(isSearchShortcut(undefined), false);
  assert.equal(isSearchShortcut({}), false);
  // Options do not rescue a bad event.
  assert.equal(isSearchShortcut(null, { isMac: true }), false);
  assert.equal(isSearchShortcut({}, { isMac: false }), false);
});

test('isDismissShortcut: matches Escape only', () => {
  assert.equal(isDismissShortcut({ key: 'Escape' }), true);
  assert.equal(isDismissShortcut({ key: 'Enter' }), false);
  assert.equal(isDismissShortcut(null), false);
});

// ── Result grouping (categoryForGroup / groupResultsByCategory) ─────────────

test('categoryForGroup: maps known groups to the right category', () => {
  assert.equal(categoryForGroup('Navigation'), 'pages');
  assert.equal(categoryForGroup('Contract functions'), 'functions');
  assert.equal(categoryForGroup('Preferences'), 'settings');
});

test('categoryForGroup: unknown or missing groups fall back to pages', () => {
  assert.equal(categoryForGroup('Something else'), 'pages');
  assert.equal(categoryForGroup(''), 'pages');
  assert.equal(categoryForGroup(undefined), 'pages');
  assert.equal(categoryForGroup(null), 'pages');
});

test('groupResultsByCategory: groups results and omits empty categories', () => {
  const results = [
    { id: 'nav-explorer', group: 'Navigation', title: 'Explorer', subtitle: '', keywords: [] },
    { id: 'nav-settings', group: 'Preferences', title: 'Settings', subtitle: '', keywords: [] },
    { id: 'fn-transfer', group: 'Contract functions', title: 'transfer', subtitle: '', keywords: [] },
  ];
  const groups = groupResultsByCategory(results);
  assert.equal(groups.length, 3, 'all three categories present');
  assert.equal(groups[0].category, 'pages');
  assert.equal(groups[1].category, 'functions');
  assert.equal(groups[2].category, 'settings');
  assert.equal(groups[0].commands.length, 1);
  assert.equal(groups[1].commands.length, 1);
  assert.equal(groups[2].commands.length, 1);
});

test('groupResultsByCategory: omits categories with no commands', () => {
  const results = [
    { id: 'nav-explorer', group: 'Navigation', title: 'Explorer', subtitle: '', keywords: [] },
    { id: 'nav-history', group: 'Navigation', title: 'History', subtitle: '', keywords: [] },
  ];
  const groups = groupResultsByCategory(results);
  assert.equal(groups.length, 1, 'only pages category present');
  assert.equal(groups[0].category, 'pages');
  assert.equal(groups[0].commands.length, 2);
});

test('groupResultsByCategory: tolerates a non-array or empty input', () => {
  assert.deepEqual(groupResultsByCategory([]), []);
  assert.deepEqual(groupResultsByCategory(null), []);
  assert.deepEqual(groupResultsByCategory(undefined), []);
});

// ── Registry ────────────────────────────────────────────────────────────────

test('buildCommandRegistry: includes the base navigation commands', () => {
  const registry = buildCommandRegistry();
  assert.equal(registry.length, BASE_COMMANDS.length);
  assert.ok(registry.some((c) => c.href === '/settings'));
});

test('buildCommandRegistry: appends contract functions as selectable commands', () => {
  const registry = buildCommandRegistry({ functions: [{ name: 'transfer', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'u128' }], outputs: 'bool' }, { name: 'mint', inputs: [] }] });
  const transfer = registry.find((c) => c.id === 'fn-transfer');
  assert.ok(transfer);
  assert.equal(transfer.action, 'select-function');
  assert.deepEqual(transfer.payload, { name: 'transfer' });
});

test('buildCommandRegistry: every command has a unique id', () => {
  const ids = buildCommandRegistry({ functions: [{ name: 'transfer' }] }).map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ── Scoring & filtering ─────────────────────────────────────────────────────

const COMMANDS = [
  { id: 'a', title: 'Settings', subtitle: 'Custom RPC endpoints', group: 'Preferences', keywords: ['rpc', 'indexer'] },
  { id: 'b', title: 'Invocation history', subtitle: 'Previous runs', group: 'Navigation', keywords: ['past'] },
  { id: 'c', title: 'Transactions', subtitle: 'Recent on-chain activity', group: 'Navigation', keywords: ['tx'] },
];

test('scoreCommand: an exact title beats a prefix which beats a substring', () => {
  const exact = scoreCommand(COMMANDS[0], 'settings');
  const prefix = scoreCommand(COMMANDS[0], 'sett');
  const subtitleHit = scoreCommand(COMMANDS[0], 'endpoints');
  assert.ok(exact > prefix);
  assert.ok(prefix > subtitleHit);
});

test('scoreCommand: returns 0 when nothing matches', () => {
  assert.equal(scoreCommand(COMMANDS[0], 'zzzzzz'), 0);
});

test('filterCommands: an empty query returns everything in registry order', () => {
  assert.deepEqual(
    filterCommands(COMMANDS, '').map((c) => c.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(filterCommands(COMMANDS, '   ').length, 3);
});

test('filterCommands: matching is case insensitive', () => {
  assert.deepEqual(
    filterCommands(COMMANDS, 'SETTINGS').map((c) => c.id),
    ['a'],
  );
});

test('filterCommands: matches on keywords as well as titles', () => {
  assert.deepEqual(
    filterCommands(COMMANDS, 'rpc').map((c) => c.id),
    ['a'],
  );
});

test('filterCommands: matches a word start inside a multi-word title', () => {
  assert.deepEqual(
    filterCommands(COMMANDS, 'history').map((c) => c.id),
    ['b'],
  );
});

test('filterCommands: fuzzy matching tolerates a substituted character in a title', () => {
  assert.deepEqual(
    filterCommands(COMMANDS, 'settungs').map((c) => c.id),
    ['a'],
  );
});

test('filterCommands: fuzzy matching handles adjacent transpositions in title words', () => {
  assert.deepEqual(
    filterCommands(COMMANDS, 'histroy').map((c) => c.id),
    ['b'],
  );
});

test('filterCommands: fuzzy matching also applies to keywords', () => {
  assert.deepEqual(
    filterCommands(COMMANDS, 'indexre').map((c) => c.id),
    ['a'],
  );
});

test('filterCommands: direct matches rank above fuzzy matches', () => {
  const commands = [
    { id: 'fuzzy', title: 'Settungs', subtitle: '', group: 'Test', keywords: [] },
    { id: 'direct', title: 'Settings', subtitle: '', group: 'Test', keywords: [] },
  ];

  assert.deepEqual(
    filterCommands(commands, 'settings').map((c) => c.id),
    ['direct', 'fuzzy'],
  );
});

test('filterCommands: ranks the strongest match first', () => {
  const results = filterCommands(COMMANDS, 'tran');
  assert.equal(results[0].id, 'c');
});

test('filterCommands: returns an empty list when nothing matches', () => {
  assert.deepEqual(filterCommands(COMMANDS, 'quantum'), []);
});

test('filterCommands: honours the result limit', () => {
  assert.equal(filterCommands(COMMANDS, '', { limit: 2 }).length, 2);
});

test('filterCommands: tolerates a non-array registry', () => {
  assert.deepEqual(filterCommands(null, 'x'), []);
  assert.deepEqual(filterCommands(undefined, ''), []);
});

// ── Keyboard navigation ─────────────────────────────────────────────────────

test('moveHighlight: steps forward and wraps at the end', () => {
  assert.equal(moveHighlight(0, 1, 3), 1);
  assert.equal(moveHighlight(2, 1, 3), 0);
});

test('moveHighlight: steps backward and wraps at the start', () => {
  assert.equal(moveHighlight(1, -1, 3), 0);
  assert.equal(moveHighlight(0, -1, 3), 2);
});

test('moveHighlight: stays at 0 for an empty result list', () => {
  assert.equal(moveHighlight(0, 1, 0), 0);
  assert.equal(moveHighlight(3, -1, 0), 0);
});

// ── Parameter type hints ─────────────────────────────────────────────────────

test('buildParamHint: formats a function with multiple inputs', () => {
  const inputs = [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'u128' },
  ];
  assert.equal(buildParamHint(inputs), '(from: address, to: address, amount: u128)');
});

test('buildParamHint: handles a no-argument function', () => {
  assert.equal(buildParamHint([]), '()');
  assert.equal(buildParamHint(null), '()');
  assert.equal(buildParamHint(undefined), '()');
});

test('buildParamHint: marks optional parameters with a trailing ?', () => {
  const inputs = [
    { name: 'account', type: 'address' },
    { name: 'memo', type: 'string', optional: true },
  ];
  assert.equal(buildParamHint(inputs), '(account: address, memo?: string)');
});

test('buildFunctionSubtitle: lists each param with type', () => {
  const fn = {
    name: 'transfer',
    inputs: [
      { name: 'from', type: 'address', description: 'Sender address' },
      { name: 'to', type: 'address', description: 'Recipient address' },
      { name: 'amount', type: 'u128' },
    ],
    outputs: 'bool',
  };
  const subtitle = buildFunctionSubtitle(fn);
  assert.ok(subtitle.startsWith('Params:'), 'subtitle should start with Params:');
  assert.ok(subtitle.includes('from: address'), 'should include from param');
  assert.ok(subtitle.includes('Sender address'), 'should include description');
  assert.ok(subtitle.includes('amount: u128'), 'should include amount param');
});

test('buildFunctionSubtitle: no-arg function returns readable string', () => {
  const subtitle = buildFunctionSubtitle({ name: 'symbol', inputs: [], outputs: 'string' });
  assert.equal(subtitle, 'Returns string');
});

test('buildFunctionSubtitle: no-arg no-output returns "No parameters"', () => {
  const subtitle = buildFunctionSubtitle({ name: 'ping', inputs: [] });
  assert.equal(subtitle, 'No parameters');
});

test('buildCommandRegistry: function title includes inline param and return hints', () => {
  const registry = buildCommandRegistry({
    functions: [
      {
        name: 'transfer',
        inputs: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'u128' },
        ],
        outputs: 'bool',
      },
    ],
  });
  const cmd = registry.find((c) => c.id === 'fn-transfer');
  assert.ok(cmd, 'transfer command should be in registry');
  assert.ok(
    cmd.title.includes('from: address'),
    `title should contain param hint, got: ${cmd.title}`,
  );
  assert.ok(
    cmd.title.includes('→ bool'),
    `title should contain return type hint, got: ${cmd.title}`,
  );
});

test('buildCommandRegistry: function keywords include param names and types for searching', () => {
  const registry = buildCommandRegistry({
    functions: [
      {
        name: 'transfer',
        inputs: [{ name: 'from', type: 'address' }, { name: 'amount', type: 'u128' }],
      },
    ],
  });
  const cmd = registry.find((c) => c.id === 'fn-transfer');
  assert.ok(cmd.keywords.includes('from'), 'keywords should include param name "from"');
  assert.ok(cmd.keywords.includes('address'), 'keywords should include param type "address"');
  assert.ok(cmd.keywords.includes('amount'), 'keywords should include param name "amount"');
  assert.ok(cmd.keywords.includes('u128'), 'keywords should include param type "u128"');
});

test('filterCommands: searching by param type surfaces matching functions', () => {
  const registry = buildCommandRegistry({
    functions: [
      { name: 'transfer', inputs: [{ name: 'from', type: 'address' }, { name: 'amount', type: 'u128' }] },
      { name: 'symbol', inputs: [] },
    ],
  });
  const results = filterCommands(registry, 'u128');
  assert.ok(results.some((c) => c.id === 'fn-transfer'), 'transfer should match "u128" search');
  assert.ok(!results.some((c) => c.id === 'fn-symbol'), 'symbol should NOT match "u128" search');
});

test('filterCommands: searching by param name surfaces matching functions', () => {
  const registry = buildCommandRegistry({
    functions: [
      { name: 'transfer', inputs: [{ name: 'from', type: 'address' }, { name: 'amount', type: 'u128' }] },
      { name: 'balance', inputs: [{ name: 'account', type: 'address' }] },
    ],
  });
  const results = filterCommands(registry, 'account');
  assert.ok(results.some((c) => c.id === 'fn-balance'), 'balance should match "account" search');
  // `balance` has an exact keyword hit on "account"; `transfer` only matches
  // fuzzily ("account" ≈ "amount", edit distance 2), so balance must rank first.
  assert.equal(results[0].id, 'fn-balance', 'exact param-name match should outrank fuzzy match');
});
