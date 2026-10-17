# Frontend Features

Reference for four browser-side features of the Sky Moon Scope web app. All code
lives under [`web/`](../web).

Shared conventions:

- Pure logic ships as plain `.js` modules with a hand-written `.d.ts`, so the
  unit tests (`node --test`, `.cjs`) exercise the real implementation instead of
  a copy. This mirrors the existing `lib/gasGolfingSort.js` pattern.
- Run everything with `npm test`, `npm run lint` and `npm run build` from `web/`.

---

## 1. Subgraph schema visualizer (issue #628)

An interactive node diagram of contract-to-contract calls and the ledger keys
each invocation touches, rendered with [React Flow](https://reactflow.dev).

| File | Role |
| --- | --- |
| `lib/schemaGraph.js` / `.d.ts` | Turns an `/analyze` report into `{ nodes, edges, stats }` |
| `components/SchemaVisualizer.tsx` | React Flow canvas, custom node types, minimap |
| `lib/schemaGraph.test.cjs` | Unit tests for the graph model |

**Where to find it:** the **Schema** tab on the home page, or `/?tab=schema`.

`buildSchemaGraph(report, options)` reads three parts of the report:

- `call_graph.root` — walked breadth-first into one node per unique
  `contract_id::function`, positioned by depth (column) and sibling index (row).
  Layout is deterministic, so the same report always draws the same diagram.
- `state_dependency` and `state_snapshot.ledger_entries` — rendered as storage
  nodes edged off the entry point. A key present in the post-simulation snapshot
  is labelled `writes`, otherwise `reads`.
- `ttl_analysis.touched_entries` — annotates storage nodes with remaining
  ledgers.

Re-entrant calls (A → B → A) are detected via the ancestor chain: the edge is
still drawn and labelled `re-entrant`, but the branch is not expanded again, so
cyclic graphs cannot hang the renderer. Storage nodes are capped
(`maxStorageNodes`, default 12) with the overflow reported in
`stats.hiddenStorageNodes`.

The component is mounted through `next/dynamic` with `ssr: false` because React
Flow measures real DOM nodes.

---

## 2. Global search shortcut (issues #623, #396)

The search overlay opens with a platform-aware keyboard shortcut:

- **macOS**: `Ctrl+K` — Cmd+K is reserved by macOS browsers for tab/search, so
  the overlay listens for Ctrl+K only to avoid the conflict.
- **Windows / Linux**: `Ctrl+K` or `Cmd+K` (the Windows key) both open it.

| File | Role |
| --- | --- |
| `lib/searchCommands.js` / `.d.ts` | Command registry, shortcut detection, ranking, parameter-hint builders |
| `lib/searchHistory.js` / `.d.ts` | Search history — persist/load recently visited commands from localStorage |
| `components/GlobalSearchModal.tsx` | The overlay; mounted once in `pages/_app.tsx` |
| `lib/searchCommands.test.cjs` | Unit tests for matching, keyboard navigation, and parameter hints |
| `lib/searchHistory.test.cjs` | Unit tests for history push/dedup/remove/clear |

Shortcut detection lives in `isSearchShortcut(event, { isMac })` in
`lib/searchCommands.js`. It uses `defaultIsMac()` (navigator.platform /
navigator.userAgent) at runtime; tests pass an explicit `isMac` boolean to drive
both branches deterministically. The header search button shows the
platform-appropriate hint (`⌃K` on macOS, `Ctrl K` elsewhere) resolved after
mount to avoid SSR hydration mismatches.

The listener sits on `window` so the shortcut fires regardless of focus.
`Escape`, the backdrop and the close button all dismiss it; `↑`/`↓` move the
highlight (wrapping at both ends) and `Enter` runs the highlighted command.

Commands come from `buildCommandRegistry()`:

- **Navigation / Preferences** entries carry an `href` and are routed with
  `next/router`. Home-page panels are addressed as `/?tab=<id>`, which
  `pages/index.tsx` reads back out of the query string.
- **Contract function** entries carry an `action` instead. Selecting one
  dispatches a `Sky Moon Scope:search-command` `CustomEvent`, which the home page
  listens for — so the modal never needs to know page-internal state.

Ranking (`scoreCommand`), strongest first: exact title, title prefix, word start
within the title, keyword hit, title substring, subtitle substring, keyword
substring, then a loose subsequence fallback. Ties keep registry order so the
list does not reshuffle while typing.

Adding a command means appending one object to `BASE_COMMANDS`.

### Search history (recently visited panels)

When the query is empty the overlay shows the **Recently visited** section
instead of a blank list. Every time the user selects a command it is pushed to
the top of a LocalStorage-backed history list (key
`sky-moon-scope:search-history`, capped at 8 entries). The list deduplicates by
command `id` so revisiting a panel simply bubbles it to the top rather than
creating a duplicate entry.

```
lib/searchHistory.js   pushHistory / removeHistoryEntry / clearHistory
                       commandToEntry / historyToCommands
                       loadHistory / saveHistory (localStorage adapter)
```

`historyToCommands` converts stored entries back to `SearchCommand`-shaped
objects (with `group: 'Recent'`) so they flow through the existing
`filterCommands` ranking pipeline unchanged when the user starts typing.

### Contract function parameter type hints

Contract function commands in the registry now surface full parameter and
return-type information so developers can search by type or parameter name:

- **Title** — `transfer(from: address, to: address, amount: u128) → bool`
  (inline signature with optional `?` suffix for optional params).
- **Subtitle** — `Params: from: address — Sender address, to: address —
  Recipient address, amount: u128` (per-param description if present).
- **Keywords** — parameter names and Soroban types are added as search keywords,
  so typing `u128` or `address` in the search box surfaces every matching
  function.

Two helper functions are exported from `lib/searchCommands.js`:

| Function | Purpose |
| --- | --- |
| `buildParamHint(inputs)` | Formats `(name: type, …)` from a `ContractInput[]` |
| `buildFunctionSubtitle(fn)` | Builds a human-readable param listing for the subtitle |

---

## 3. User preference settings page (issue #622)

`/settings` lets power users point the app at self-hosted infrastructure.

| File | Role |
| --- | --- |
| `lib/userSettings.js` / `.d.ts` | Validation, normalization, LocalStorage I/O |
| `pages/settings.tsx` | The form, with per-endpoint connection tests |
| `lib/userSettings.test.cjs` | Unit tests |

Stored under the LocalStorage key `Sky Moon Scope-user-settings`:

| Field | Meaning |
| --- | --- |
| `rpcUrl` | Custom Soroban RPC endpoint; blank means the selected network's default |
| `indexerUrl` | Custom analyzer/indexer base URL; blank means `NEXT_PUBLIC_API_URL` |
| `requestTimeoutMs` | Timeout for the connection tests, clamped to 1000–120000 |

Nothing is sent to the backend — preferences never leave the browser.

Endpoints must be absolute `http://` or `https://` URLs; trailing slashes are
stripped on save. Reads are defensive: corrupt JSON, an unavailable store or a
stale schema all fall back to defaults rather than throwing.

**Test** buttons probe each endpoint — a JSON-RPC `getHealth` for RPC, `GET
/health` for the indexer. Any HTTP answer (including 404) counts as reachable,
since that still proves the host is live.

`lib/api.ts` resolves the base URL per request via `getApiBaseUrl()`, so a saved
`indexerUrl` takes effect immediately, without a rebuild. `components/upload-zone.tsx`
uses the same resolution for its analyze endpoint.

---

## 4. Web Worker for WASM decoding (issue #621)

Decoding uploaded bytecode on the main thread froze the UI. Parsing now runs in
a dedicated worker.

| File | Role |
| --- | --- |
| `public/wasm/wasmValidation.js` | The decoder — magic number, version, section walk, exports/imports, data segments |
| `public/wasm/wasmWorker.js` | Classic Web Worker wrapping the decoder |
| `lib/wasmValidation.js` / `.d.ts` | Re-export so app code and tests share one implementation |
| `hooks/useWasmValidationWorker.ts` | Lazily owns the worker, with a main-thread fallback |
| `lib/wasmValidation.test.cjs`, `lib/wasmWorker.test.cjs` | Decoder and worker-protocol tests |

### Why `public/`

The worker is served as a static file and pulls the decoder in with
`importScripts()` at runtime. That deliberately avoids bundler worker-entry
semantics, which differ between webpack and Turbopack — this way `next dev` and
`next build` behave identically. The UMD wrapper in `wasmValidation.js` lets the
same file be a worker global, a bundler import and a `require()` in tests.

### Protocol

```
→ { type: 'ping' }                                          ← { type: 'pong' }
→ { id, type: 'validate', buffer: ArrayBuffer, maxBytes? }   ← { id, type: 'result', report }
                                                             ← { id, type: 'error', message }
```

The hook boots the worker lazily (pages that never upload pay nothing) and only
sends real work after the `pong` handshake. If the worker cannot start — CSP, an
old browser, a 2s handshake timeout — validation silently runs the *same*
function on the main thread, so results are identical and an upload never fails
because of worker plumbing. Buffers are transferred rather than copied on the
happy path.

`validateWasmModule` never throws: decode failures come back as
`{ valid: false, errors: [...] }`, which is what crosses the message channel.
Beyond magic number and version it walks every top-level section and decodes the
export table, which is what `extractContractFunctions()` surfaces in the UI.

---

## 5. Keyboard navigation for interactive components

Full keyboard support across the dashboard's interactive widgets, so power users
and screen-reader users can drive every control without a mouse.

| Component | Keys added |
| --- | --- |
| `components/ResourceHeatmap.tsx` | Tab bar: `←` / `→` (move between tabs), `Home` / `End` (jump to first / last). ARIA: `role=tablist`, `role=tab`, `aria-selected`, roving `tabIndex`. |
| `components/FunctionSidebar.tsx` | Function list: `↑` / `↓` (move selection), `Home` / `End` (jump to first / last), `Enter` / `Space` (confirm selection). ARIA: `role=listbox` / `role=option`, `aria-selected`, roving `tabIndex`. |
| `components/NetworkSwitcher.tsx` | Network list: `↑` / `↓` (move focus), `Home` / `End` (jump), `Enter` / `Space` (select & close), `Escape` (close & return focus to trigger). ARIA: roving `tabIndex`, `focus:` styles on unselected options. |
| `components/GlobalSearchModal.tsx` | Already fully keyboard-accessible (`↑` / `↓`, `Enter`, `Escape`, `Ctrl+K` / `Cmd+K`) — no changes needed. |
| `components/NutritionLabel.tsx` | Gas breakdown toggle is a native `<button>` with `aria-expanded` / `aria-controls` — no changes needed. |
| `components/StakingCalculator.tsx` | All compound-frequency pills and preset buttons are native `<button>` elements — keyboard-accessible by default. |

**Roving tabIndex pattern**: only the currently active / selected item has
`tabIndex={0}`; all others have `tabIndex={-1}`. Arrow keys move focus
programmatically via `element.focus()`, so a single Tab press moves in/out of
the widget rather than cycling through every option.

Tests live in `components/keyboard-nav.test.cjs` and run with
`node --test components/keyboard-nav.test.cjs` (no build needed).

---

## 6. Heatmap color scale reset between contract loads

**Problem**: when a second contract was profiled without reloading the page,
hover highlights and the active tab from the first contract persisted on the new
data, giving incorrect visual cues (e.g. a cell from contract A would remain
"hovered" while displaying contract B's numbers).

**Fix** (`components/ResourceHeatmap.tsx`): a `useEffect` watches all five
primitive fields of the `resourceCost` prop
(`cpu_instructions`, `ram_bytes`, `ledger_read_bytes`, `ledger_write_bytes`,
`transaction_size_bytes`). When any of them changes — which always happens when
a new simulation result arrives — it resets:

- `activeTab` → `'gauges'` (the default overview)
- `hoveredCellId`, `hoveredRamId`, `hoveredSegmentId`, `hoveredKey` → `null`

The `useMemo` hooks that build the cell and segment arrays already recompute on
these same props, so after the reset the UI is fully consistent with the new
contract's data.

State that belongs only to the user's current interaction (hovering over a cell)
is ephemeral and tied to a specific contract, so clearing it on every new load
is the correct behaviour — users can simply re-hover when they want details on
the new contract.

Tests for this fix are included in `components/keyboard-nav.test.cjs` under the
`Heatmap: …` suite (8 scenarios covering each prop trigger and the no-change
case).
