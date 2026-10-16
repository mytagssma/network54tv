"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import type { Episode } from "@/types/anime";
import { AvailabilityChip } from "@/components/anime/Availability";
import Button from "@/components/ui/Button";
import { cn } from "@/lib/utils";

/**
 * Paged episode selector (YouTube playlist-panel style).
 *
 * - ONE level of boxing: the outer panel owns the frame; the rows inside are
 *   FLAT — no per-row *box*, separated by collapsed hairline grid lines
 *   (top+left at a low accent tint, tucked under the panel border), with
 *   every state carried by background + text colour alone. The two exceptions
 *   are borrowed verbatim, not new design: EpisodeList's SUB/DUB mini-chips
 *   (only on rows whose flags are known true) and the shared `N/A` reason
 *   label on unavailable rows. The panel is the only box; if borders ever
 *   return to the rows, the panel border goes.
 * - Dense rows: episode number + short (truncated) name.
 * - Chunk navigation: `‹ 1/5 ›` — never renders the whole run at once.
 * - Natural height: each page is bounded by its own item count, so the grid
 *   flows at full height and the *page* scrolls (no inner scroll box).
 * - `docked` variant (watch page, lg+): the panel becomes the playlist RAIL
 *   beside the player — one column, its height pinned to the player's
 *   measured height by WatchDock (the panel just fills it, `lg:h-full`) with
 *   its own inner scroll (`lg:`-gated, so below lg the stacked natural-height
 *   layout is unaffected no matter what the dock preference says). The
 *   natural-height doc above describes the below-the-player layout; this rail
 *   is the scroll-contained exception.
 * - The row for the episode being watched is highlighted, and is revealed
 *   with a minimal page-level scroll when the panel is already on screen —
 *   the window is never yanked toward the list. Docked, `scrollIntoView`'s
 *   "nearest" resolves against the rail's own scrollport, so the same code
 *   reveals inside the rail instead.
 */

const DEFAULT_PAGE_SIZE = 24;
/** Exported: WatchDock's shared pager math (band header + both panel positions). */
export { DEFAULT_PAGE_SIZE };

interface EpisodeSelectorProps {
  /** Full episode run to page through (sorted by number by the caller). */
  episodes: Episode[];
  animeId: number;
  provider?: string;
  currentEpisode: number;
  /** Chunk size. Default 24 (≈ one screenful at 3 columns). */
  pageSize?: number;
  heading?: string;
  /**
   * Grouped view: returns a sticky section label for an episode (null for
   * none). A header row is rendered whenever the label changes between two
   * consecutive rows — and again at the start of every page.
   */
  getSectionLabel?: (episode: Episode) => string | null;
  /**
   * Watch-page dock: render as the scroll-contained rail beside the player
   * (one column, `lg:`-gated: full-height panel + inner scroll). Off = the
   * natural-height below-the-player panel.
   */
  docked?: boolean;
  /** Extra header-row controls, rendered right of the pager (dock toggle). */
  headerExtra?: ReactNode;
  /**
   * Controlled pager: when provided (with `onPageChange`), the page lives in
   * the caller — WatchDock shares ONE pager between the docked band header
   * and both panel positions. Omitted = self-managed (the /design specimen
   * renders the bare component and keeps the internal follow-sync below).
   */
  page?: number;
  onPageChange?: (page: number) => void;
  /** Docked: don't render the header here — the caller renders it in the
   *  page-title band instead (EpisodePanelHeader). */
  hideHeader?: boolean;
}

/**
 * The panel header row (title · EP count · range · pager · extras). Rendered
 * INSIDE the panel by default; in the docked watch layout WatchDock renders
 * it in the page-title band instead, via `hideHeader` on the panel.
 */
export function EpisodePanelHeader({
  heading,
  episodes,
  pageSize,
  pageCount,
  currentPage,
  onPageChange,
  headerExtra,
}: {
  heading: string;
  /** The SORTED run — the range readout slices it by the current page. */
  episodes: Episode[];
  pageSize: number;
  pageCount: number;
  currentPage: number;
  onPageChange: (page: number) => void;
  headerExtra?: ReactNode;
}) {
  const start = currentPage * pageSize;
  const firstEp = episodes[start];
  const lastEp = episodes[Math.min(start + pageSize - 1, episodes.length - 1)];
  return (
    <div className="flex items-center gap-3 mb-2">
      <h2 className="text-sm font-semibold text-[var(--accent)] uppercase tracking-wider shrink-0">
        {heading}
      </h2>
      <span className="label-micro text-[var(--text-decorative)] shrink-0 tabular-nums">
        {episodes.length} EP
      </span>

      {(pageCount > 1 || headerExtra) && (
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {pageCount > 1 && (
            <>
              <span className="hidden sm:block label-micro text-[var(--text-decorative)] tabular-nums">
                {firstEp && lastEp ? `${pad(firstEp.number)}–${pad(lastEp.number)}` : ""}
              </span>
              <Button
                type="button"
                variant="pager"
                onClick={() => onPageChange(currentPage - 1)}
                disabled={currentPage === 0}
                aria-label="Previous page of episodes"
              >
                <span aria-hidden="true">‹</span>
              </Button>
              <span className="font-mono text-[11px] text-[var(--accent)]/70 tabular-nums min-w-[3.5rem] text-center">
                {currentPage + 1}/{pageCount}
              </span>
              <Button
                type="button"
                variant="pager"
                onClick={() => onPageChange(currentPage + 1)}
                disabled={currentPage >= pageCount - 1}
                aria-label="Next page of episodes"
              >
                <span aria-hidden="true">›</span>
              </Button>
            </>
          )}
          {headerExtra}
        </div>
      )}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

// Flat row: NO box of its own. The only borders are the collapsed-grid
// hairlines (top+left) that separate neighbours; the -mt-px/-ml-px on the
// grid tucks the outer pair under the panel's own border, so the panel
// stays the single frame. States are background + text colour only.
const ROW_BASE =
  "flex min-h-[40px] items-center gap-2 rounded-none border-t border-l border-[var(--accent)]/10 px-2.5 transition-colors";

export default function EpisodeSelector({
  episodes,
  animeId,
  provider,
  currentEpisode,
  pageSize = DEFAULT_PAGE_SIZE,
  heading = "// Episodes",
  getSectionLabel,
  docked = false,
  headerExtra,
  page: pageProp,
  onPageChange: onPageChangeProp,
  hideHeader = false,
}: EpisodeSelectorProps) {
  const providerQs = provider ? `?provider=${provider}` : "";

  const pages = useMemo(() => {
    const out: Episode[][] = [];
    for (let i = 0; i < episodes.length; i += pageSize) {
      out.push(episodes.slice(i, i + pageSize));
    }
    return out;
  }, [episodes, pageSize]);

  // Self-managed page (default). With `page` + `onPageChange` from WatchDock
  // this state is ignored — the shared dock pager wins.
  const [internalPage, setInternalPage] = useState(() => {
    const idx = episodes.findIndex((ep) => ep.number === currentEpisode);
    return idx >= 0 ? Math.floor(idx / pageSize) : 0;
  });

  const pageCount = pages.length;
  const currentPage =
    pageCount === 0 ? 0 : Math.min(Math.max(pageProp ?? internalPage, 0), pageCount - 1);
  const onPageChange = onPageChangeProp ?? setInternalPage;
  const items = pages[currentPage] ?? [];

  const panelRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<number, HTMLElement>());

  // Follow the watched episode across client-side navigations (self-managed
  // mode only — the dock's controlled pager does this in WatchDock).
  // Adjusted during render (React's "adjust state when props change"
  // pattern) rather than in an effect: the page flips in the same render
  // pass, so the reveal effect below already runs against the correct page.
  const [syncKey, setSyncKey] = useState({ currentEpisode, episodes, pageSize });
  if (
    pageProp === undefined &&
    (syncKey.currentEpisode !== currentEpisode ||
      syncKey.episodes !== episodes ||
      syncKey.pageSize !== pageSize)
  ) {
    setSyncKey({ currentEpisode, episodes, pageSize });
    const idx = episodes.findIndex((ep) => ep.number === currentEpisode);
    if (idx >= 0) setInternalPage(Math.floor(idx / pageSize));
  }

  // Reveal the watched row when the panel is already on screen — a minimal
  // page-level scroll, never a jump that would pull the player out of view.
  useEffect(() => {
    const panel = panelRef.current;
    const row = rowRefs.current.get(currentEpisode);
    if (!panel || !row) return;
    const box = panel.getBoundingClientRect();
    const onScreen = box.top < window.innerHeight && box.bottom > 0;
    if (onScreen) row.scrollIntoView({ block: "nearest" });
  }, [currentEpisode, currentPage]);

  if (pageCount === 0) return null;

  return (
    // Docked: this wrapper must also fill the rail — WatchDock pins the
    // ASIDE to the player's measured height, and the panel's `lg:h-full`
    // resolves against THIS div. Without a definite height here, `h-full`
    // degrades to content height: the panel stops being a scroll container,
    // long lists spill past the rail, and the reveal scroll yanks the page.
    <div className={cn(docked && "lg:h-full")}>
      {/* Panel header — title, range, chunk navigation. Skipped when docked:
          WatchDock renders this same row in the page-title band instead. */}
      {!hideHeader && (
        <EpisodePanelHeader
          heading={heading}
          episodes={episodes}
          pageSize={pageSize}
          pageCount={pageCount}
          currentPage={currentPage}
          onPageChange={onPageChange}
          headerExtra={headerExtra}
        />
      )}

      {/* Episode grid — natural height, the page scrolls around it. Docked
          (lg+): `h-full` fills the rail, whose height WatchDock pins to the
          player's measured height — the playlist-rail treatment, scrolling
          internally when the run is longer. */}
      <div
        ref={panelRef}
        className={cn(
          "relative border border-[var(--accent)]/15 bg-[var(--panel)]",
          docked && "lg:h-full lg:overflow-y-auto overscroll-contain"
        )}
      >
        <div
          className={cn(
            "-mt-px -ml-px grid",
            docked ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
          )}
        >
          {items.map((ep, i) => {
            const isCurrent = ep.number === currentEpisode;
            const isAvailable = ep.available !== false;
            // Only tag what is actually known — unknown availability renders
            // no chip (same gate as EpisodeList's rows).
            const hasSub = ep.hasSub === true;
            const hasDub = ep.hasDub === true;

            const label = getSectionLabel ? getSectionLabel(ep) : null;
            const prevLabel = i > 0 && getSectionLabel ? getSectionLabel(items[i - 1]) : null;
            const showHeader = Boolean(label) && label !== prevLabel;

            const rowClass = isCurrent
              ? `${ROW_BASE} bg-[var(--accent)] text-black`
              : isAvailable
                ? `${ROW_BASE} text-[var(--text-secondary)] hover:bg-[var(--accent)]/10 hover:text-white group`
                : `${ROW_BASE} text-[var(--text-decorative)] opacity-60 cursor-not-allowed`;

            const numberClass = isCurrent
              ? "text-black/70"
              : isAvailable
                ? "text-[var(--accent)]/70"
                : "text-[var(--text-decorative)]";

            const setRowRef = (el: HTMLElement | null) => {
              if (el) rowRefs.current.set(ep.number, el);
              else rowRefs.current.delete(ep.number);
            };

            const inner = (
              <>
                <span
                  className={`w-6 shrink-0 text-right font-mono text-[11px] font-bold tabular-nums ${numberClass}`}
                >
                  {pad(ep.number)}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-xs"
                  title={ep.title || `Episode ${ep.number}`}
                >
                  {ep.title || `Episode ${ep.number}`}
                </span>
                {/* Per-row audio flags — the exact SUB/DUB mini-chips EpisodeList
                    renders (same components, same gate: only what is known true),
                    so both episode surfaces agree on a row's tracks. */}
                {isAvailable && (hasSub || hasDub) && (
                  <span className="flex items-center gap-1 shrink-0">
                    {hasSub && <AvailabilityChip kind="sub" />}
                    {hasDub && <AvailabilityChip kind="dub" />}
                  </span>
                )}
                {isCurrent ? (
                  <span aria-hidden="true" className="shrink-0 text-[9px] leading-none">
                    &#9654;
                  </span>
                ) : isAvailable ? (
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-[var(--accent)] opacity-0 transition-opacity group-hover:opacity-100 text-[11px] leading-none"
                  >
                    ›
                  </span>
                ) : (
                  // Unavailable rows used to be dimmed with no explanation at
                  // all — the same row EpisodeList labels `N/A`, in the same
                  // visual language, now labelled here too.
                  <AvailabilityChip kind="na" className="shrink-0" />
                )}
              </>
            );

            return (
              <Fragment key={ep.number}>
                {showHeader && (
                  <div className="col-span-full sticky top-0 z-10 border-y border-[var(--accent)]/25 bg-[var(--surface)] px-2 py-1.5 label-micro text-[var(--accent)]">
                    {label}
                  </div>
                )}
                {isAvailable ? (
                  <Link
                    href={`/anime/${animeId}/watch/${ep.number}${providerQs}`}
                    ref={setRowRef}
                    aria-current={isCurrent ? "page" : undefined}
                    className={rowClass}
                  >
                    {inner}
                  </Link>
                ) : (
                  <div ref={setRowRef} aria-disabled="true" className={rowClass}>
                    {inner}
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
