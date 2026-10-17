'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Clock, CornerDownLeft, Search, X } from 'lucide-react';

import {
  buildCommandRegistry,
  filterCommands,
  groupResultsByCategory,
  isDismissShortcut,
  isSearchShortcut,
  moveHighlight,
  moveHighlightTo,
  normalizeHighlight,
  optionIdFor,
} from '../lib/searchCommands';
import type { SearchCommand } from '../lib/searchCommands';
import {
  historyToCommands,
  loadHistory,
  pushHistory,
  saveHistory,
} from '../lib/searchHistory';
import type { HistoryEntry } from '../lib/searchHistory';
import { MOCK_CONTRACT_FUNCTIONS } from '../lib/sorobantypes';

/**
 * Custom event fired when a non-navigation command is picked, so pages can
 * react without the modal needing to know about their internal state.
 */
export const SEARCH_COMMAND_EVENT = 'sky-moon-scope:search-command';

/**
 * App-wide quick search overlay.
 *
 * Mounted once in `_app`, so the search shortcut works on every page without
 * moving the mouse to the header. The shortcut is platform-aware (see
 * `isSearchShortcut`): Ctrl+K on macOS (Cmd+K is reserved by the browser for
 * tab/search), and Ctrl+K or Cmd+K on Windows/Linux.
 *
 * Features:
 * - Search history: recently run commands surface at the top when the query is
 *   empty, labelled with a clock icon. Selecting any command persists it.
 * - Contract function type hints: function titles carry inline parameter and
 *   return-type signatures; subtitles list each param with its Soroban type.
 */
export function GlobalSearchModal() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Load history from localStorage when the modal first opens.
  useEffect(() => {
    if (open) {
      setHistory(loadHistory());
    }
  }, [open]);

  const commands = useMemo(
    () => buildCommandRegistry({ functions: contractFunctions }),
    // Rebuild whenever the loaded contract's function list changes, so a new
    // upload is reflected in the search index without a page reload.
    [contractFunctions],
  );

  /**
   * When the query is empty show recently visited commands (history).
   * When the user is typing show ranked search results.
   */
  const results = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed === '') {
      return historyToCommands(history);
    }
    return filterCommands(commands, query);
  }, [commands, query, history]);

  const isShowingHistory = query.trim() === '' && history.length > 0;

  // The list shrinks as the query narrows, so the stored index can outlive the
  // option it pointed at. Everything reads the clamped value, which keeps
  // `aria-activedescendant` from naming an option that is no longer rendered.
  const activeIndex = normalizeHighlight(highlight, results.length);
  const activeOptionId = results.length > 0 ? optionIdFor(results[activeIndex]) : undefined;

  // Voice search — transcript updates the query field live as the user speaks.
  const { supported: voiceSupported, listening, error: voiceError, start: startVoice, stop: stopVoice } =
    useVoiceSearch({ onTranscript: setQuery });

  const close = useCallback(() => {
    // Stop any active voice session before closing so we don't leave an
    // orphaned microphone stream.
    stopVoice();
    setOpen(false);
    setQuery('');
    setHighlight(0);
  }, [stopVoice]);

  const runCommand = useCallback(
    (command: SearchCommand | undefined) => {
      if (!command) return;

      // Persist to history before navigating / dispatching.
      const updatedHistory = pushHistory(loadHistory(), command);
      saveHistory(updatedHistory);
      setHistory(updatedHistory);

      close();

      if (command.href) {
        void router.push(command.href);
        return;
      }

      if (command.action && typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent(SEARCH_COMMAND_EVENT, {
            detail: { action: command.action, payload: command.payload },
          }),
        );
      }
    },
    [close, router],
  );

  // Global shortcut listener — intentionally on window so it fires regardless
  // of which element currently has focus.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isSearchShortcut(event)) {
        event.preventDefault();
        setOpen((prev) => !prev);
        return;
      }

      if (isDismissShortcut(event) && open) {
        event.preventDefault();
        setOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Focus the input and lock background scroll while the overlay is up.
  useEffect(() => {
    if (!open) {
      document.body.style.overflow = '';
      return;
    }

    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  // Keep the active option on screen. The list scrolls (max-h-80), so without
  // this the highlight walks off the bottom and a keyboard-only user is
  // selecting something they cannot see.
  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, results.length]);

  if (!open) return null;

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight(moveHighlight(activeIndex, 1, results.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight(moveHighlight(activeIndex, -1, results.length));
    } else if (event.key === 'Home' || event.key === 'End') {
      // First/last result, per the listbox keyboard interaction pattern.
      event.preventDefault();
      setHighlight(moveHighlightTo(event.key, activeIndex, results.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runCommand(results[activeIndex]);
    }
  };

  // Human-readable label for the mic button, used by screen readers and the
  // tooltip title attribute.
  const micLabel = listening ? 'Stop voice input' : 'Search by voice';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Global search"
    >
      <div
        className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm"
        onClick={close}
        aria-hidden="true"
      />

      <div className="relative z-10 w-full max-w-xl overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
          {/* Pulsing mic indicator replaces the search icon while listening */}
          {listening ? (
            <span
              className="relative flex h-4 w-4 shrink-0 items-center justify-center"
              aria-hidden="true"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" />
              <Mic className="relative h-4 w-4 text-cyan-400" />
            </span>
          ) : (
            <Search className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
          )}

          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="global-search-results"
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            placeholder={listening ? 'Listening…' : 'Search pages, functions and settings...'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            className="w-full bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />

          {/* Mic button — hidden when the browser does not support the API */}
          {voiceSupported && (
            <button
              type="button"
              data-testid="voice-search-btn"
              onClick={listening ? stopVoice : startVoice}
              aria-label={micLabel}
              aria-pressed={listening}
              title={micLabel}
              className={`shrink-0 rounded p-1 transition-colors ${
                listening
                  ? 'text-cyan-400 hover:text-cyan-200'
                  : voiceError
                    ? 'text-red-400 hover:text-red-300'
                    : 'text-slate-500 hover:text-slate-200'
              }`}
            >
              {listening ? (
                <MicOff className="h-4 w-4" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Inline error hint — appears briefly when mic is denied / unavailable */}
          {voiceError && voiceError !== 'aborted' && !listening && (
            <span
              role="alert"
              aria-live="polite"
              className="shrink-0 text-[10px] text-red-400"
            >
              {voiceError === 'not-allowed'
                ? 'Mic blocked'
                : voiceError === 'no-speech'
                  ? 'No speech'
                  : voiceError === 'network'
                    ? 'Network error'
                    : 'Voice error'}
            </span>
          )}

          <button
            type="button"
            onClick={close}
            aria-label="Close search"
            className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Section heading when showing history */}
        {isShowingHistory && (
          <div className="flex items-center gap-2 px-4 pt-3 pb-1">
            <Clock className="h-3 w-3 text-slate-500" aria-hidden="true" />
            <span className="text-[11px] uppercase tracking-wider text-slate-500">
              Recently visited
            </span>
          </div>
        )}

        <ul id="global-search-results" role="listbox" className="max-h-80 overflow-y-auto py-2">
          {results.length === 0 && query.trim() === '' && (
            <li className="px-4 py-6 text-center text-sm text-slate-500">
              Start typing to search pages and functions&hellip;
            </li>
          )}
          {results.length === 0 && query.trim() !== '' && (
            <li className="px-4 py-6 text-center text-sm text-slate-500">
              No matches for &ldquo;{query}&rdquo;
            </li>
          )}

          {groups.map((group) => (
            <React.Fragment key={group.category}>
              {/* Category header — presentational only, not a listbox option */}
              <li
                role="presentation"
                aria-hidden="true"
                className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-widest text-slate-500"
              >
                <span className="min-w-0 flex items-start gap-2">
                  {isShowingHistory && (
                    <Clock
                      className="mt-0.5 h-3 w-3 shrink-0 text-slate-500"
                      aria-hidden="true"
                    />
                  )}
                  <span>
                    <span
                      className={`block truncate text-sm font-medium ${
                        index === highlight ? 'text-cyan-300' : 'text-slate-200'
                      }`}
                    >
                      {command.title}
                    </span>
                    {command.subtitle && (
                      <span className="block truncate text-xs text-slate-500">
                        {command.subtitle}
                      </span>
                    )}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-500">
                  {command.group}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between border-t border-slate-800 px-4 py-2 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5">
            <CornerDownLeft className="h-3 w-3" /> to select &bull; ↑↓ to navigate
          </span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}

export default GlobalSearchModal;
