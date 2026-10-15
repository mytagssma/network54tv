"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ComponentProps } from "react";
import type { Episode } from "@/types/anime";
import Player from "@/components/player/Player";
import EpisodeBrowser from "./EpisodeBrowser";
import { EpisodePanelHeader, DEFAULT_PAGE_SIZE } from "./EpisodeSelector";
import { DockIcon } from "@/components/ui/icons";
import { buttonClass } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

/**
 * Watch-page player + episode-panel composition with a dock toggle.
 *
 * The player sits at the top in both modes; the episode panel either flows
 * BELOW the page's middle band (default — exactly the pre-dock layout) or
 * docks as a playlist RAIL beside the player (lg+ only).
 *
 * Layout matrix:
 *   - undocked (default): the player keeps its `-mx-4` bleed; the panel
 *     renders below the children band (FranchiseStrip) at its historical
 *     `mt-8` position, with its own header row (title · count · pager ·
 *     toggle) inside.
 *   - docked, lg+: a flex row — player column (`flex-1 min-w-0`; the bleed
 *     is dropped at lg+ so both columns share the page column's optical
 *     line, and returns below lg for narrow parity) + the rail
 *     (`w-80 xl:w-96`). The panel's whole HEADER row moves UP into the
 *     page-title band (right of the h1, above the player's top edge), and
 *     the rail holds only the list panel, pinned to the player's measured
 *     height (ResizeObserver on the player column — the player is
 *     aspect-video, so height follows width) with `overscroll-contain`
 *     internal scrolling. The below-position panel gets `lg:hidden`, so
 *     exactly one instance is visible; both stay mounted, and the hidden
 *     one is inert (a display:none rect makes the reveal effect's
 *     on-screen gate fail).
 *   - below lg: ALWAYS the stacked layout regardless of the preference —
 *     every dock class is `lg:`-gated, and the toggle button itself is
 *     `hidden lg:grid` (docking doesn't exist there, so the control
 *     shouldn't either).
 *
 * The pager is ONE shared state (see the render-phase follow-sync below):
 * the band header and both panel positions page together.
 *
 * Persistence: a global (not per-anime) preference under
 * `n54tv-watch-dock`. SSR always renders undocked; the saved value is
 * applied in a mount effect only — the hydration-safe read pattern the
 * Player's prefs code uses (nothing reads storage during render).
 */

const DOCK_KEY = "n54tv-watch-dock";

type PlayerProps = ComponentProps<typeof Player>;

interface WatchDockProps extends Omit<PlayerProps, "episodes" | "anilistId"> {
  /** Required here (unlike Player's optional prop): the episode links need it. */
  anilistId: number;
  /** The page's h1 — rendered above the player; the docked header joins it. */
  title: ReactNode;
  /** The full raw run — feeds the episodes panel (sorted inside the browser). */
  episodes: Episode[];
  /** The drawer list page.tsx already maps — Player's own `episodes` prop. */
  drawerEpisodes: PlayerProps["episodes"];
  /** The page band between the player and the panel (FranchiseStrip). */
  children?: ReactNode;
}

/** Square pager-styled toggle; the pressed paint mirrors the "on" language
 *  of the player's other toggles (accent border + accent wash). Hidden
 *  below lg — docking is a lg+ layout, so the control is too. */
function DockToggle({
  docked,
  onToggle,
}: {
  docked: boolean;
  onToggle: () => void;
}) {
  const label = docked ? "Undock episodes" : "Dock episodes";
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-pressed={docked}
      className={cn(
        buttonClass("pager"),
        "hidden lg:grid",
        docked && "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/15"
      )}
    >
      <DockIcon className="h-4 w-4" />
    </button>
  );
}

export default function WatchDock({
  animeTitle,
  episodeNumber,
  anilistId,
  malId,
  nextEpisodeNumber,
  providerId,
  providerQuery,
  franchise,
  episodeHasDub,
  title,
  episodes,
  drawerEpisodes,
  children,
}: WatchDockProps) {
  const [docked, setDocked] = useState(false);

  // Hydration-safe restore: SSR must render the DEFAULT (undocked) layout,
  // so the saved preference is applied only after mount. Nothing reads
  // storage during render — a private-mode failure just stays undocked.
  // (setState here is the React-documented storage-hydration pattern; the
  // value isn't derivable during render, so the rule's cascade concern
  // doesn't apply — same read-in-effect shape as Player's prefs code.)
  useEffect(() => {
    try {
      if (localStorage.getItem(DOCK_KEY) === "1") {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDocked(true);
      }
    } catch {
      // private mode / disabled storage — keep the default
    }
  }, []);

  const toggleDock = () => {
    const next = !docked;
    setDocked(next);
    try {
      localStorage.setItem(DOCK_KEY, next ? "1" : "0");
    } catch {
      // a storage write must never break the page — just don't persist
    }
  };

  const toggle = <DockToggle docked={docked} onToggle={toggleDock} />;

  // Sorted once: the band header's range readout slices this run, and the
  // browsers receive it (their own sort is then a no-op).
  const sorted = useMemo(
    () => [...episodes].sort((a, b) => a.number - b.number),
    [episodes]
  );

  // ONE shared pager for the band header and both panel positions.
  const [page, setPage] = useState(() => {
    const idx = episodes.findIndex((ep) => ep.number === episodeNumber);
    return idx >= 0 ? Math.floor(idx / DEFAULT_PAGE_SIZE) : 0;
  });
  const pageCount = Math.ceil(episodes.length / DEFAULT_PAGE_SIZE);
  const currentPage = pageCount === 0 ? 0 : Math.min(Math.max(page, 0), pageCount - 1);

  // Follow the watched episode across client-side navigations (moved here
  // from EpisodeSelector when the pager became shared). Adjusted during
  // render (React's "adjust state when props change" pattern) rather than
  // in an effect: the page flips in the same render pass, so the reveal
  // effect inside the panel already runs against the correct page.
  const [syncKey, setSyncKey] = useState({ episodeNumber, episodes });
  if (syncKey.episodeNumber !== episodeNumber || syncKey.episodes !== episodes) {
    setSyncKey({ episodeNumber, episodes });
    const idx = episodes.findIndex((ep) => ep.number === episodeNumber);
    if (idx >= 0) setPage(Math.floor(idx / DEFAULT_PAGE_SIZE));
  }

  // The docked rail matches the player's rendered height EXACTLY (top and
  // bottom flush): the player is aspect-video, so its height follows its
  // width — measured with a ResizeObserver on the player column (same
  // fit-measure pattern as Player's row-fit effect). The measurement is
  // always on (one element, cheap), so the height is already known the
  // moment the dock flips — no tall-then-snap frame.
  const playerRef = useRef<HTMLDivElement>(null);
  const [playerH, setPlayerH] = useState(0);
  useEffect(() => {
    const el = playerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      // Equality-guarded: sub-pixel resize noise must not re-render.
      setPlayerH((prev) => (Math.abs(prev - h) >= 1 ? h : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <>
      {/* Title band — the h1 by default; docked (lg+) the panel header row
          joins it on the right, above the player's top edge. The h1's own
          `mb-4` still sets the gap below the band. */}
      <div className={docked ? "lg:flex lg:items-start lg:justify-between lg:gap-4" : ""}>
        {title}
        {docked && (
          <div className="hidden shrink-0 lg:block">
            <EpisodePanelHeader
              heading="// Episodes"
              episodes={sorted}
              pageSize={DEFAULT_PAGE_SIZE}
              pageCount={pageCount}
              currentPage={currentPage}
              onPageChange={setPage}
              headerExtra={toggle}
            />
          </div>
        )}
      </div>

      {/* Player row — a flex row only while docked (lg+); a bare wrapper
          around the player in the undocked stack. */}
      <div className={docked ? "flex flex-col lg:flex-row lg:items-start lg:gap-4" : ""}>
        {/* `-mx-4` bleed below lg in BOTH modes (narrow parity); at lg+ the
            docked column drops it so player and rail sit on one page-column
            line — a bleeding player against an inset rail reads lopsided. */}
        <div ref={playerRef} className={docked ? "-mx-4 flex-1 min-w-0 lg:mx-0" : "-mx-4"}>
          <Player
            animeTitle={animeTitle}
            episodeNumber={episodeNumber}
            anilistId={anilistId}
            malId={malId}
            nextEpisodeNumber={nextEpisodeNumber}
            providerId={providerId}
            providerQuery={providerQuery}
            episodes={drawerEpisodes}
            franchise={franchise}
            episodeHasDub={episodeHasDub}
          />
        </div>
        {docked && episodes.length > 0 && (
          // Height pinned to the player's measured height, so the panel's
          // top and bottom edges sit flush with the player's. `0`/unset =
          // pre-measure fallback: natural height for the first frame.
          <aside
            className="hidden w-80 shrink-0 lg:block xl:w-96"
            style={playerH > 0 ? { height: playerH } : undefined}
          >
            <EpisodeBrowser
              episodes={sorted}
              animeId={anilistId}
              provider={providerQuery}
              currentEpisode={episodeNumber}
              docked
              hideHeader
              page={currentPage}
              onPageChange={setPage}
            />
          </aside>
        )}
      </div>

      {children}

      {/* Below-position panel — the default flow. Hidden at lg+ ONLY while
          docked (the rail covers it there); below lg it's always the layout.
          Its header (with the toggle) renders inside, as before. */}
      {episodes.length > 0 && (
        <div className={docked ? "mt-8 lg:hidden" : "mt-8"}>
          <EpisodeBrowser
            episodes={sorted}
            animeId={anilistId}
            provider={providerQuery}
            currentEpisode={episodeNumber}
            page={currentPage}
            onPageChange={setPage}
            headerExtra={toggle}
          />
        </div>
      )}
    </>
  );
}
