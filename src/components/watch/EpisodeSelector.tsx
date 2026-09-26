"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Episode } from "@/types/anime";

/**
 * Paged, bounded episode selector (YouTube playlist-panel style).
 *
 * - Dense rows: episode number + short (truncated) name.
 * - Chunk navigation: `‹ 1/5 ›` — never renders the whole run at once.
 * - Fixed max height with `overflow-y-auto`, so the panel never inflates
 *   the page's scroll length.
 * - The row for the episode being watched is highlighted and centered inside
 *   the panel on mount / navigation (panel-only scroll — the window is never
 *   scrolled as a side effect).
 */

const DEFAULT_PAGE_SIZE = 24;

interface EpisodeSelectorProps {
  /** Episodes to page through (already filtered by section, if any). */
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
}

const pad = (n: number) => String(n).padStart(2, "0");

const ROW_BASE =
  "flex min-h-[40px] items-center gap-2 rounded-none border px-2.5 transition-colors";

export default function EpisodeSelector({
  episodes,
  animeId,
  provider,
  currentEpisode,
  pageSize = DEFAULT_PAGE_SIZE,
  heading = "// Episodes",
  getSectionLabel,
}: EpisodeSelectorProps) {
  const providerQs = provider ? `?provider=${provider}` : "";

  const pages = useMemo(() => {
    const out: Episode[][] = [];
    for (let i = 0; i < episodes.length; i += pageSize) {
      out.push(episodes.slice(i, i + pageSize));
    }
    return out;
  }, [episodes, pageSize]);

  const [page, setPage] = useState(() => {
    const idx = episodes.findIndex((ep) => ep.number === currentEpisode);
    return idx >= 0 ? Math.floor(idx / pageSize) : 0;
  });

  const pageCount = pages.length;
  const currentPage = pageCount === 0 ? 0 : Math.min(Math.max(page, 0), pageCount - 1);
  const items = pages[currentPage] ?? [];
  const firstEp = items[0];
  const lastEp = items[items.length - 1];

  const scrollerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<number, HTMLElement>());

  // Follow the watched episode across client-side navigations
  useEffect(() => {
    const idx = episodes.findIndex((ep) => ep.number === currentEpisode);
    if (idx >= 0) setPage(Math.floor(idx / pageSize));
  }, [currentEpisode, episodes, pageSize]);

  // Center the current row inside the panel only (never scrolls the window)
  useEffect(() => {
    const scroller = scrollerRef.current;
    const row = rowRefs.current.get(currentEpisode);
    if (!scroller || !row) return;
    scroller.scrollTop = Math.max(
      0,
      row.offsetTop - (scroller.clientHeight - row.offsetHeight) / 2
    );
  }, [currentEpisode, currentPage]);

  if (pageCount === 0) return null;

  return (
    <div>
      {/* Panel header — title, range, chunk navigation */}
      <div className="flex items-center gap-3 mb-2">
        <h2 className="text-sm font-semibold text-[var(--accent)] uppercase tracking-wider shrink-0">
          {heading}
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-wider text-[#6b6b70] shrink-0 tabular-nums">
          {episodes.length} EP
        </span>

        {pageCount > 1 && (
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <span className="hidden sm:block font-mono text-[10px] uppercase tracking-wider text-[#6b6b70] tabular-nums">
              {firstEp && lastEp ? `${pad(firstEp.number)}–${pad(lastEp.number)}` : ""}
            </span>
            <button
              type="button"
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage === 0}
              aria-label="Previous page of episodes"
              className="h-7 w-7 grid place-items-center rounded-none border border-[var(--accent)]/25 text-base leading-none text-[var(--accent)]/70 transition-colors hover:border-[var(--accent)]/60 hover:text-[var(--accent)] disabled:opacity-30 disabled:pointer-events-none"
            >
              <span aria-hidden="true">‹</span>
            </button>
            <span className="font-mono text-[11px] text-[var(--accent)]/70 tabular-nums min-w-[3.5rem] text-center">
              {currentPage + 1}/{pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage >= pageCount - 1}
              aria-label="Next page of episodes"
              className="h-7 w-7 grid place-items-center rounded-none border border-[var(--accent)]/25 text-base leading-none text-[var(--accent)]/70 transition-colors hover:border-[var(--accent)]/60 hover:text-[var(--accent)] disabled:opacity-30 disabled:pointer-events-none"
            >
              <span aria-hidden="true">›</span>
            </button>
          </div>
        )}
      </div>

      {/* Bounded list — scrolls internally so the page length never grows */}
      <div
        ref={scrollerRef}
        className="relative max-h-[300px] sm:max-h-[340px] overflow-y-auto overscroll-contain border border-[var(--accent)]/15 bg-[var(--panel)]"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 p-1.5">
          {items.map((ep, i) => {
            const isCurrent = ep.number === currentEpisode;
            const isAvailable = ep.available !== false;

            const label = getSectionLabel ? getSectionLabel(ep) : null;
            const prevLabel = i > 0 && getSectionLabel ? getSectionLabel(items[i - 1]) : null;
            const showHeader = Boolean(label) && label !== prevLabel;

            const rowClass = isCurrent
              ? `${ROW_BASE} bg-[var(--accent)] border-[var(--accent)] text-black`
              : isAvailable
                ? `${ROW_BASE} border-[var(--accent)]/10 bg-black/30 text-[#9a9aa0] hover:border-[var(--accent)]/50 hover:bg-[var(--accent)]/10 hover:text-white group`
                : `${ROW_BASE} border-[#6b6b70]/10 bg-black/20 text-[#6b6b70] opacity-60 cursor-not-allowed`;

            const numberClass = isCurrent
              ? "text-black/70"
              : isAvailable
                ? "text-[var(--accent)]/70"
                : "text-[#6b6b70]";

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
                {isCurrent ? (
                  <span aria-hidden="true" className="shrink-0 text-[9px] leading-none">
                    &#9654;
                  </span>
                ) : (
                  isAvailable && (
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-[var(--accent)] opacity-0 transition-opacity group-hover:opacity-100 text-[11px] leading-none"
                    >
                      ›
                    </span>
                  )
                )}
              </>
            );

            return (
              <Fragment key={ep.number}>
                {showHeader && (
                  <div className="col-span-full sticky top-0 z-10 border-b border-[var(--accent)]/25 bg-[#1a1a20] px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider text-[var(--accent)]">
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
