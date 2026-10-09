"use client";

import { Fragment } from "react";
import Link from "next/link";
import {
  FRANCHISE_SORTS,
  franchiseSortGroups,
  type FranchiseEntry,
} from "@/components/watch/franchiseEntries";
import { useFranchiseSort } from "@/hooks/useFranchiseSort";

/**
 * Franchise selector for the watch page — every *watchable* franchise entry,
 * resolved by `getFranchiseItems()` (`src/lib/franchise.ts`): a bounded
 * transitive walk over the AniList relation graph, so seasons that are only
 * linked through *other* entries (Dr. STONE seasons 3/4 …) show up here just
 * like they do on the detail page row — and manga/novel, MUSIC (PVs, music
 * videos) and PREVIEW/CHARACTER edges never do. The entry model itself
 * (badges, `detail` labels, sort modes) lives in `./franchiseEntries`, which
 * the server page and the player's drawer share — only the strip's markup and
 * its sort control are client-side.
 *
 * ── Weight ────────────────────────────────────────────────────────────────
 * Rows, not chips: the selector is a responsive grid of large buttons that
 * borrow the episode list's visual language (`EpisodeList` /
 * `EpisodeSelector`) — `bg-[#131318]`, a 2px accent rail down the left edge
 * (`border-l-2 border-[var(--accent)]/30`, solid while active), mono chips up
 * front, the title filling the middle, a chevron on the right. The current
 * entry is the only solid one (accent fill + ▶) and never a link; mainline
 * seasons are tinted + railed louder; recaps/side stories/movies stay quiet.
 *
 * ── Order (the header's segmented toggle) ────────────────────────────────
 * Default is the resolver's canonical order — prequels → current → sequels →
 * rest (TV run first, then by format, then release order), shared with the
 * detail page. TIME re-orders the same set chronologically by air/release
 * start date (unknown dates last, ties fall back to the default order). The
 * choice persists in `localStorage` (`n54tv-franchise-sort`, read through
 * `useFranchiseSort`) and the player drawer's series list honors it too. The
 * current entry keeps its highlight in every mode — sorting only moves rows,
 * it never re-derives badges, tiers or links. One column on phones, two from
 * `sm`, three from `xl`.
 */

interface FranchiseStripProps {
  entries: FranchiseEntry[];
  provider?: string;
}

export default function FranchiseStrip({ entries, provider }: FranchiseStripProps) {
  // Only the current entry (or nothing) → nothing to switch to. The hook
  // stays above this return so the hook order never changes between renders.
  const [sortMode, setSortMode] = useFranchiseSort();
  if (entries.length < 2) return null;

  const providerQs = provider ? `?provider=${provider}` : "";
  const groups = franchiseSortGroups(entries, sortMode);

  // One large selection button — same skeleton as the episode list rows:
  // 2px accent rail, mono chips, filling title, trailing chevron. Tall enough
  // (56px) to read as a target on touch, wide enough to scan in a grid.
  const rowBase =
    "group flex min-h-[56px] w-full items-center gap-3 border-l-2 px-3 py-3 sm:px-4 text-left transition-colors rounded-none";

  const tierClass: Record<FranchiseEntry["tier"], string> = {
    // Current: solid accent, same read as the active episode row — no link.
    current: "border-l-[var(--accent)] bg-[var(--accent)] text-black",
    // Mainline season: railed + tinted — prominent, never louder than current.
    main: "border-l-[var(--accent)]/60 bg-[var(--accent)]/10 text-white hover:border-l-[var(--accent)] hover:bg-[var(--accent)]/20",
    // Recaps / side stories / movies: quiet rail on the list's own surface.
    minor:
      "border-l-[var(--accent)]/30 bg-[#131318] text-[#9a9aa0] hover:border-l-[var(--accent)] hover:bg-[#1a1a20] hover:text-white",
  };

  // Season number — the "episode number" of the row.
  const seasonClass: Record<FranchiseEntry["tier"], string> = {
    current: "shrink-0 border border-black/35 bg-black/15 px-1.5 py-1 text-[11px] font-bold leading-none tabular-nums text-black",
    main: "shrink-0 border border-[var(--accent)]/50 bg-[var(--accent)]/15 px-1.5 py-1 text-[11px] font-bold leading-none tabular-nums text-[var(--accent)]",
    minor:
      "shrink-0 border border-[var(--accent)]/30 px-1.5 py-1 text-[11px] font-bold leading-none tabular-nums text-[var(--accent)]/70",
  };

  // Format badge: TV / OVA / ONA / MOVIE / SPECIAL / RECAP …
  const badgeClass: Record<FranchiseEntry["tier"], string> = {
    current: "shrink-0 border border-black/25 bg-black/10 px-1.5 py-1 text-[9px] leading-none tracking-wider text-black/70",
    main: "shrink-0 border border-[var(--accent)]/35 px-1.5 py-1 text-[9px] leading-none tracking-wider text-[var(--accent)]/85",
    minor:
      "shrink-0 border border-[var(--accent)]/20 px-1.5 py-1 text-[9px] leading-none tracking-wider text-[var(--accent)]/55",
  };

  return (
    <div className="mt-6">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <h2 className="shrink-0 text-sm font-semibold uppercase tracking-wider text-[var(--accent)]">
          // Franchise
        </h2>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider tabular-nums text-[#6b6b70]">
          {entries.length - 1} related
        </span>

        {/* Sort — a compact segmented toggle, right-aligned on the heading row
            (it wraps under the heading on narrow phones instead of crowding
            it). `aria-pressed` carries the active mode; every button keeps its
            own tab stop, so the whole control is keyboard-operable as-is. */}
        <div
          role="group"
          aria-label="Sort franchise"
          className="ml-auto flex shrink-0 items-center border border-[var(--accent)]/25"
        >
          {FRANCHISE_SORTS.map((sort, index) => {
            const active = sortMode === sort.id;
            return (
              <button
                key={sort.id}
                type="button"
                aria-pressed={active}
                title={sort.title}
                onClick={() => setSortMode(sort.id)}
                className={`px-2 py-1.5 font-mono text-[9px] uppercase leading-none tracking-wider transition-colors ${
                  index > 0 ? "border-l border-[var(--accent)]/25" : ""
                } ${
                  active
                    ? "bg-[var(--accent)] text-black"
                    : "text-[var(--accent)]/55 hover:bg-[var(--accent)]/10 hover:text-[var(--accent)]"
                }`}
              >
                {sort.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Chunky rows — 1 col on phones, 2 from sm, 3 from xl (the episode
          grid's breakpoints), so the set is fully visible without scrolling.
          Both modes render one unlabelled group; the group-header branch below
          stays for any future mode that buckets rows. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-1.5 sm:gap-2">
        {groups.map((group) => (
          <Fragment key={group.label ?? "all"}>
            {group.label !== null && (
              <h3 className="col-span-full mt-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]/70 first:mt-0">
                <span className="shrink-0">{`// ${group.label}`}</span>
                <span
                  aria-hidden="true"
                  className="h-px min-w-4 flex-1 bg-[var(--accent)]/15"
                />
                <span className="shrink-0 font-mono tabular-nums text-[#6b6b70]">
                  {group.entries.length}
                </span>
              </h3>
            )}
            {group.entries.map((entry) => {
              const className = `${rowBase} ${tierClass[entry.tier]}`;

              const content = (
                <>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {entry.season !== undefined && (
                      <span className={seasonClass[entry.tier]}>{`S${entry.season}`}</span>
                    )}
                    <span className={badgeClass[entry.tier]}>{entry.badge}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] sm:text-sm">
                    {entry.title}
                  </span>
                  {entry.current ? (
                    <span aria-hidden="true" className="shrink-0 text-[11px] leading-none">
                      &#9654;
                    </span>
                  ) : (
                    <svg
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-[#6b6b70] transition-colors group-hover:text-[var(--accent)]"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  )}
                </>
              );

              if (entry.current) {
                return (
                  <span
                    key={entry.id}
                    aria-current="page"
                    title={entry.detail}
                    className={className}
                  >
                    {/* Verbose label for screen readers; the chips stay visual. */}
                    <span className="sr-only">{entry.detail}</span>
                    <span aria-hidden="true" className="flex w-full items-center gap-3">
                      {content}
                    </span>
                  </span>
                );
              }

              const href = entry.mainLine
                ? `/anime/${entry.id}/watch/1${providerQs}`
                : `/anime/${entry.id}${providerQs}`;

              return (
                <Link
                  key={entry.id}
                  href={href}
                  title={entry.detail}
                  aria-label={entry.detail}
                  className={className}
                >
                  <span aria-hidden="true" className="flex w-full items-center gap-3">
                    {content}
                  </span>
                </Link>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
