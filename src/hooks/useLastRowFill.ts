"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Width-aware "Load More" for responsive card grids.
 *
 * Two cooperating pieces:
 *
 * 1. `useLastRowFill` measures the LAST grid inside the container it is
 *    attached to (`data-rowfill` tagged elements). The column count comes from
 *    the computed `grid-template-columns`, the filled slots from the number of
 *    rendered cards. A Load More click appends about one whole source page
 *    (`fallbackNeed` — 12 or 24 cards, i.e. several rows), and whenever the
 *    last row then has a hole — after that click, on a debounced width change,
 *    on any data change — the fill effect asks the caller for exactly
 *    `columns - count % columns` more cards to complete it. Consecutive fills
 *    are capped so a source that can never complete a row degrades into a
 *    stopped button instead of a fetch loop.
 *
 * 2. `createPageBuffer` keeps AniList's fixed `page`/`perPage` arithmetic
 *    intact while still serving *variable* amounts: whole pages are pulled into
 *    a pending queue (the cursor only advances by whole pages) and handed out
 *    row by row. Nothing is skipped or duplicated, and because the queue
 *    absorbs the remainder of a page, most fills cost no request at all.
 *
 * Grids opt in by carrying `data-rowfill=""`, and must be inside the div the
 * caller passes to `setContainer` (that wrapper should also hold the Load More
 * button, so the measured row is the one directly above it).
 */

const RESIZE_DEBOUNCE_MS = 200;
const DEFAULT_MAX_FILL_ATTEMPTS = 3;
const DEFAULT_FALLBACK_NEED = 24;
/** Safety valve: one fill never pulls more than this many source pages. */
const MAX_PAGES_PER_TAKE = 4;

/** Read the resolved column count of a grid container. */
function countColumns(grid: HTMLElement): number {
  const template = getComputedStyle(grid).gridTemplateColumns;
  if (!template || template === "none") return 1;
  // Unresolved `repeat(4, minmax(0, 1fr))` — net the counter out.
  const repeat = template.match(/repeat\(\s*(\d+)/);
  if (repeat) return Math.max(1, Number(repeat[1]));
  const tracks = template.trim().split(/\s+/).filter(Boolean);
  return Math.max(1, tracks.length);
}

function measureGrid(grid: HTMLElement): { cols: number; filled: number } {
  const filled = grid.children.length;
  let cols = countColumns(grid);
  // Safety net for a degenerate read (computed style reported a single track):
  // count the cards that share the first card's top edge — that is a full row.
  // Only ever used when the computed value already looks wrong, so a failure
  // here can't invent columns the layout doesn't have.
  if (cols === 1 && filled > 1) {
    const first = grid.children[0] as HTMLElement;
    let inFirstRow = 1;
    while (inFirstRow < filled) {
      const child = grid.children[inFirstRow] as HTMLElement;
      if (!first || child.offsetTop !== first.offsetTop) break;
      inFirstRow += 1;
    }
    cols = inFirstRow;
  }
  return { cols, filled };
}

// ─── Page buffer ─────────────────────────────────────────────────────────────

export interface PageChunk<T> {
  media: T[];
  hasNextPage: boolean;
}

export interface PageBuffer<T> {
  /** New dataset loaded — drop the queue and restart the cursor at page 1. */
  reset(hasNextPage: boolean): void;
  /** The source still advertises another page. */
  hasMore(): boolean;
  /** Cards already fetched but not yet shown. */
  pending(): number;
  /** More cards can reach the grid: another page, or a non-empty queue. */
  canFetch(): boolean;
  /**
   * Hand out exactly `count` cards, fetching whole source pages when the queue
   * runs dry. Returns fewer only when the source is exhausted. `isCancelled`
   * is polled after every await so a newer dataset never receives (or loses)
   * cards fetched for an older one.
   */
  take(
    count: number,
    fetchPage: (page: number) => Promise<PageChunk<T>>,
    isCancelled?: () => boolean
  ): Promise<T[]>;
}

export function createPageBuffer<T>(): PageBuffer<T> {
  let queue: T[] = [];
  let nextPage = 1;
  let more = false;

  return {
    reset(hasNextPage) {
      queue = [];
      nextPage = 1;
      more = hasNextPage;
    },
    hasMore: () => more,
    pending: () => queue.length,
    canFetch: () => more || queue.length > 0,
    async take(count, fetchPage, isCancelled) {
      const out: T[] = [];
      let fetches = 0;
      while (out.length < count) {
        if (queue.length === 0) {
          if (!more || fetches >= MAX_PAGES_PER_TAKE) break;
          const page = nextPage + 1;
          const chunk = await fetchPage(page);
          // Bail before mutating anything: the buffer may already belong to a
          // newer query/filter load.
          if (isCancelled?.()) break;
          fetches += 1;
          nextPage = page;
          const media = chunk.media ?? [];
          more = Boolean(chunk.hasNextPage) && media.length > 0;
          if (media.length === 0) break;
          queue.push(...media);
        }
        const slice = Math.min(count - out.length, queue.length);
        if (slice <= 0) break;
        out.push(...queue.splice(0, slice));
      }
      return out;
    },
  };
}

/** Append new cards, dropping ids already visible (keeps React keys unique). */
export function appendUnique<T extends { id: number }>(existing: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((item) => item.id));
  const added = incoming.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return added.length === 0 ? existing : [...existing, ...added];
}

// ─── Row-fill driver ─────────────────────────────────────────────────────────

export interface UseLastRowFillOptions {
  /** False while the initial (or a filter-driven) load is in flight. */
  ready: boolean;
  /** Visible item count — any change re-runs the last-row check. */
  count: number;
  /** More cards can still be shown (source has pages, or the queue holds some). */
  hasMore: boolean;
  /** Append exactly `need` cards to the visible list. */
  fetchNeeded: (need: number) => Promise<void>;
  onError?: (error: unknown) => void;
  /** Source page size: cards appended per Load More click, and the safety
      net when no grid can be measured. Callers pass their perPage (12/24). */
  fallbackNeed?: number;
  /** Consecutive incomplete fills before giving up — the loop safety valve. */
  maxFillAttempts?: number;
}

export interface LastRowFill {
  /** Attach to the wrapper holding the grid(s) and the Load More button. */
  setContainer: (node: HTMLDivElement | null) => void;
  loadingMore: boolean;
  /** Button handler: append ~one source page (several rows); the fill
      effect then tops up the last row if the batch left it incomplete. */
  loadMore: () => void;
}

export function useLastRowFill(options: UseLastRowFillOptions): LastRowFill {
  const { ready, count, hasMore } = options;

  // Latest closures/props for callbacks fired from events and effects. Synced
  // in an effect (not during render) — the fill effect below is deliberately
  // driven only by the values it cares about.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tick, setTick] = useState(0);
  const inFlightRef = useRef(false);
  const attemptsRef = useRef(0);

  const readLastGrid = useCallback((): { cols: number; filled: number } | null => {
    if (!container) return null;
    const grids = container.querySelectorAll<HTMLElement>("[data-rowfill]");
    const grid = grids[grids.length - 1];
    if (!grid) return null;
    return measureGrid(grid);
  }, [container]);

  const runFetch = useCallback(async (need: number) => {
    if (need <= 0 || inFlightRef.current) return;
    inFlightRef.current = true;
    setLoadingMore(true);
    try {
      await optionsRef.current.fetchNeeded(need);
    } catch (error) {
      optionsRef.current.onError?.(error);
    } finally {
      inFlightRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  /** Load More click → a batch of `fallbackNeed` cards (≈ one source page:
      the buffer drains first, then the next page is fetched as needed), so a
      click lands several rows at once. The fill effect below then tops up the
      last row if the batch left it short — measurement stays out of the click
      path entirely. */
  const loadMore = useCallback(() => {
    if (inFlightRef.current || !optionsRef.current.hasMore) return;
    // A deliberate click earns a fresh fill budget.
    attemptsRef.current = 0;
    void runFetch(optionsRef.current.fallbackNeed ?? DEFAULT_FALLBACK_NEED);
  }, [runFetch]);

  // A fresh layout measurement (viewport change) earns a new fill budget —
  // declared before the fill effect so the reset wins in the same flush.
  useEffect(() => {
    attemptsRef.current = 0;
  }, [tick]);

  // Keep the last row complete after every layout or data change.
  useEffect(() => {
    if (!ready) {
      // A fresh dataset is loading — refill budget starts over.
      attemptsRef.current = 0;
      return;
    }
    if (!hasMore || inFlightRef.current) return;
    const measured = readLastGrid();
    if (!measured || measured.filled === 0) return;
    const remainder = measured.filled % measured.cols;
    if (remainder === 0) {
      attemptsRef.current = 0;
      return;
    }
    if (attemptsRef.current >= (optionsRef.current.maxFillAttempts ?? DEFAULT_MAX_FILL_ATTEMPTS)) {
      return;
    }
    attemptsRef.current += 1;
    void runFetch(measured.cols - remainder);
  }, [container, tick, ready, count, hasMore, loadingMore, readLastGrid, runFetch]);

  // Column count follows the viewport: a ResizeObserver on the container plus a
  // window resize listener (Tailwind breakpoints are viewport-based, so a
  // breakpoint can flip while the container width stays put). Debounced, then
  // the fill effect re-reads the computed columns.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setTick((value) => value + 1), RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener("resize", schedule);
    let observer: ResizeObserver | undefined;
    if (container && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(container);
    }
    return () => {
      window.removeEventListener("resize", schedule);
      clearTimeout(timer);
      observer?.disconnect();
    };
  }, [container]);

  return { setContainer, loadingMore, loadMore };
}
