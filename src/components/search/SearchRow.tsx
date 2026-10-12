"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, SlidersIcon } from "./icons";

/** State for the Filters toggle. */
export interface FiltersToggle {
  /** Panel is open. */
  open: boolean;
  /** Some filter is set (drives the "(active)" note and filled style). */
  active: boolean;
  onToggle: () => void;
  /** id of the panel this button controls. */
  panelId: string;
}

interface SearchRowProps {
  /** Page heading sitting left of the Filters toggle (a SearchHeading). */
  heading?: ReactNode;
  /** Filters toggle — always rendered, so the panel stays reachable
      whether a query is active or the landing view is showing. */
  filters: FiltersToggle;
  /** Filter panel, rendered below the heading row. */
  children?: ReactNode;
  /** `?q=` the browse page currently reflects — the live search compares
      the debounced value against it so an unchanged value never
      re-navigates (queue#11). */
  query?: string;
  /** Debounced header-field value; "" means "back to the landing view".
      Browse routes it with `router.replace` so keystrokes don't pile up
      history entries (queue#11). */
  onLiveQuery?: (value: string) => void;
}

// ─── Search as you type (queue#11) ───────────────────────────────────────
//
// The query field lives in the header (Navbar) and only pushes the URL on
// submit, so typing never reached /browse — and Navbar itself is off-limits.
// This row, mounted only while /browse is on screen, therefore listens for
// the field's native `input` events (they bubble up to document; React's
// root-level delegation neither captures nor stops them) and debounces a
// navigation through `onLiveQuery`. One quiet pause = one search execution.

/** Quiet time after the last keystroke before the search fires. */
export const LIVE_SEARCH_DEBOUNCE_MS = 300;

/** Live search fires only at this length or more — three characters. Shorter
    prefixes ("lo") match a huge swath of AniList and each pause would spend a
    full search chain (primary + airing lookup + possible retries) plus an RSC
    navigation and a 12-image grid render; stacked mid-word on a low-memory
    phone that is the Aw Snap recipe (mobile crash on ?q=lo). Typing stays
    local until the 3rd character; Enter submits (and hard loads fetch) any
    length, so short queries remain reachable — they just never fire live. */
export const LIVE_SEARCH_MIN_CHARS = 3;

/** What a debounced field value should do to the current URL query. */
export type LiveQueryPlan =
  | { action: "hold" } // too short — keep waiting, touch nothing
  | { action: "skip" } // already reflected in the URL — no request
  | { action: "clear" } // field empty → back to the landing view
  | { action: "navigate"; value: string };

/**
 * Decide what a debounced field value means for the current URL query.
 *
 * `raw` is trimmed, matching what Enter submits — so trailing whitespace
 * never re-triggers a search Enter would have skipped. `currentQuery` is the
 * live query at FIRE time, never a string captured at keystroke time, which
 * is what makes the awkward sequences resolve correctly: ✕/Backspace-to-empty
 * clears instead of resurrecting older text, and an Enter that already pushed
 * the same value lands on `skip` instead of a second, identical request.
 */
export function resolveLiveQuery(
  raw: string,
  currentQuery: string,
  min: number = LIVE_SEARCH_MIN_CHARS
): LiveQueryPlan {
  const value = raw.trim();
  if (value === "") {
    return currentQuery === "" ? { action: "skip" } : { action: "clear" };
  }
  if (value.length < min) return { action: "hold" };
  if (value === currentQuery) return { action: "skip" };
  return { action: "navigate", value };
}

/**
 * Run `fn` debounced by `ms`: every call resets the window, so only the last
 * keystroke of a burst ever reaches `fn`. `.cancel()` drops the pending call
 * — used while an IME composition is in progress and on unmount, so a
 * half-typed kana/kanji reading is never searched and nothing fires after
 * the row is gone.
 */
export function createDebounce(
  fn: () => void,
  ms: number
): (() => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
  run.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return run;
}

/**
 * Browse's search block: heading + Filters toggle on ONE row, panel below.
 *
 * The query field and the Clear ✕ moved to the header search (Navbar), so
 * the separate button row under the heading is gone — this component now
 * only positions the Filters toggle against the heading: right-aligned on
 * "// SEARCH: …" and on the landing heading alike.
 *
 * It also hosts the browse-side half of search-as-you-type (queue#11): the
 * header field only updates its own draft state, so this row listens for its
 * debounced `input` events and reports the value through `onLiveQuery`.
 */
export default function SearchRow({
  heading,
  filters,
  children,
  query = "",
  onLiveQuery,
}: SearchRowProps) {
  const filled = filters.open || filters.active;

  // The debounced fire must read props as they are when it RUNS, not as they
  // were when the keystroke arrived — hence refs (the same pattern the
  // clear-search channel uses in useClearSearch). `inputRef` gets claimed by
  // the listener below; the thunk re-reads `.value` at fire time so a ✕ or
  // Backspace that emptied the field in the meantime is seen as "".
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onLiveQueryRef = useRef(onLiveQuery);
  const queryRef = useRef(query);
  useEffect(() => {
    onLiveQueryRef.current = onLiveQuery;
    queryRef.current = query;
  });

  const enabled = Boolean(onLiveQuery);
  useEffect(() => {
    if (!enabled) return;

    const fire = createDebounce(() => {
      const el = inputRef.current;
      if (!el) return;
      const plan = resolveLiveQuery(el.value, queryRef.current);
      if (plan.action === "navigate") onLiveQueryRef.current?.(plan.value);
      else if (plan.action === "clear") onLiveQueryRef.current?.("");
      // hold / skip → no navigation, therefore no request.
    }, LIVE_SEARCH_DEBOUNCE_MS);

    // Only the header field: input[name="q"] is its unique signature (the
    // filter controls are selects/checkboxes), so other fields never count
    // as typing in the search.
    const field = (e: Event) =>
      e.target instanceof HTMLInputElement && e.target.name === "q" ? e.target : null;

    const onInput = (e: Event) => {
      const el = field(e);
      if (!el) return;
      inputRef.current = el;
      // IME composition in progress: drop whatever was pending so a
      // half-typed kana/kanji reading is never sent; compositionend below
      // schedules the finished text instead.
      if ((e as InputEvent).isComposing === true) {
        fire.cancel();
        return;
      }
      fire();
    };

    const onCompositionEnd = (e: Event) => {
      const el = field(e);
      if (!el) return;
      inputRef.current = el;
      fire();
    };

    document.addEventListener("input", onInput);
    document.addEventListener("compositionend", onCompositionEnd);
    return () => {
      document.removeEventListener("input", onInput);
      document.removeEventListener("compositionend", onCompositionEnd);
      fire.cancel();
    };
  }, [enabled]);

  return (
    <div className="flex flex-col gap-3">
      {/* One line at 360px: heading flexes and truncates, button keeps its
          natural width (`shrink-0`, never wraps). `[&>h1]:mb-0` drops
          SearchHeading's built-in mb-4 — inside this row it would offset the
          heading from the button's centre (higher specificity beats .mb-4
          regardless of stylesheet order). */}
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <div className="min-w-0 flex-1 [&>h1]:mb-0">{heading}</div>

        <button
          type="button"
          onClick={filters.onToggle}
          aria-expanded={filters.open}
          aria-controls={filters.panelId}
          className={cn(
            "flex min-h-[44px] shrink-0 items-center justify-center gap-1.5 rounded-none border px-3 py-2.5 text-sm font-medium transition-colors sm:px-4",
            filled
              ? "border-[var(--accent)] bg-[var(--accent)] text-black"
              : "border-[var(--accent)]/30 bg-transparent text-[var(--accent)] hover:bg-[var(--accent)]/10"
          )}
        >
          <SlidersIcon className="h-4 w-4" />
          {/* Below sm the button drops the label and chevron and shows the
              sliders glyph alone (a ~44×44 target); the sr-only spans keep
              its accessible name — "Filters (active)" — exactly as the
              labeled version reads on wider screens. */}
          <span className="hidden sm:inline">Filters</span>
          {filters.active && <span className="hidden text-[10px] sm:inline">(active)</span>}
          <span className="sr-only sm:hidden">Filters{filters.active ? " (active)" : ""}</span>
          <ChevronDownIcon
            className={cn(
              "hidden h-3 w-3 transition-transform sm:inline-block",
              filters.open && "rotate-180"
            )}
          />
        </button>
      </div>

      {children}
    </div>
  );
}
