import type { ContractFunction } from './sorobantypes';

export interface SearchCommand {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  /** Route to navigate to when selected. */
  href?: string;
  /** Non-navigation action identifier handled by the overlay. */
  action?: string;
  payload?: Record<string, unknown>;
  keywords?: string[];
}

/** One of the three public display categories for grouped search results. */
export type SearchCategory = 'pages' | 'functions' | 'settings';

/** A category bucket returned by `groupResultsByCategory`. */
export interface SearchResultGroup {
  category: SearchCategory;
  /** Human-readable heading, e.g. "Pages", "Functions", "Settings". */
  label: string;
  commands: SearchCommand[];
}

export declare const BASE_COMMANDS: SearchCommand[];

/**
 * Best-effort macOS detection (navigator.platform / navigator.userAgent).
 * Exported so tests can pass a concrete value to {@link isSearchShortcut}.
 */
export declare function defaultIsMac(): boolean;

/**
 * True when the event should open the global search overlay.
 *
 * Platform-aware to avoid the macOS browser Cmd+K conflict:
 *   - macOS: only Ctrl+K opens the overlay (Cmd+K is reserved by browsers).
 *   - Windows/Linux: Ctrl+K or Cmd+K both open the overlay.
 *
 * Pass `isMac` to drive both branches deterministically (e.g. in tests); in
 * normal use it defaults to {@link defaultIsMac}.
 */
export declare function isSearchShortcut(
  event: KeyboardEvent | null | undefined,
  options?: { isMac?: boolean },
): boolean;

/** True when the event is Escape. */
export declare function isDismissShortcut(event: KeyboardEvent | null | undefined): boolean;

export declare function scoreCommand(command: SearchCommand, query: string): number;

export declare function filterCommands(
  commands: SearchCommand[],
  query: string,
  options?: { limit?: number },
): SearchCommand[];

/**
 * Build a human-readable parameter hint string, e.g.
 * `(from: address, to: address, amount: u128)`.
 */
export declare function buildParamHint(
  inputs: Array<{ name: string; type: string; optional?: boolean }>,
): string;

/**
 * Build a subtitle string that lists parameter names, types and
 * optional descriptions for a contract function.
 */
export declare function buildFunctionSubtitle(fn: ContractFunction): string;

/**
 * Build the full command registry.  Contract function entries now include
 * a `title` with inline parameter and return-type hints and a `subtitle`
 * that lists each parameter with its type and description.
 */
export declare function buildCommandRegistry(context?: {
  functions?: ContractFunction[];
  extra?: SearchCommand[];
}): SearchCommand[];

export declare function moveHighlight(current: number, delta: number, length: number): number;

/**
 * Map an internal `group` string to a `SearchCategory`.
 * Unknown groups fall back to `'pages'`.
 */
export declare function categoryForGroup(group: string): SearchCategory;

/**
 * Group a flat ordered results array into display categories.
 * Empty categories are omitted. Categories always appear in the order:
 * pages → functions → settings.
 */
export declare function groupResultsByCategory(results: SearchCommand[]): SearchResultGroup[];
