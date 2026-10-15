"use client";

import { useMemo, type ReactNode } from "react";
import type { Episode } from "@/types/anime";
import EpisodeSelector from "./EpisodeSelector";

/**
 * Watch-page episode panel — one flat, paged run of every episode.
 *
 * There is no section/tab layer here: the arrow pager inside
 * `EpisodeSelector` (`‹ 73–96  4/19  ›`) is the sole navigation and always
 * spans the *whole* episode list, so the browser just sorts the run once and
 * hands it over intact. The pager pages through everything, and the header
 * count (`448 EP`) reflects the full set.
 *
 * `docked` / `headerExtra` are the watch page's dock rail passing straight
 * through to `EpisodeSelector` — this component adds no dock behaviour of
 * its own.
 */

interface EpisodeBrowserProps {
  episodes: Episode[];
  animeId: number;
  provider?: string;
  currentEpisode: number;
  /** Docked-rail variant (full-height, one column) — see EpisodeSelector. */
  docked?: boolean;
  /** Header-row extras (the dock toggle) — see EpisodeSelector. */
  headerExtra?: ReactNode;
  /** Controlled pager (shared with WatchDock's band header) — see EpisodeSelector. */
  page?: number;
  onPageChange?: (page: number) => void;
  /** Docked: header renders in the page-title band instead — see EpisodeSelector. */
  hideHeader?: boolean;
}

export default function EpisodeBrowser({
  episodes,
  animeId,
  provider,
  currentEpisode,
  docked,
  headerExtra,
  page,
  onPageChange,
  hideHeader,
}: EpisodeBrowserProps) {
  const sorted = useMemo(
    () => [...episodes].sort((a, b) => a.number - b.number),
    [episodes]
  );

  return (
    <EpisodeSelector
      episodes={sorted}
      animeId={animeId}
      provider={provider}
      currentEpisode={currentEpisode}
      docked={docked}
      headerExtra={headerExtra}
      page={page}
      onPageChange={onPageChange}
      hideHeader={hideHeader}
    />
  );
}
