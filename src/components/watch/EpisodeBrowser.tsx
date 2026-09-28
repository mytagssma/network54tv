"use client";

import { useMemo } from "react";
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
 */

interface EpisodeBrowserProps {
  episodes: Episode[];
  animeId: number;
  provider?: string;
  currentEpisode: number;
}

export default function EpisodeBrowser({
  episodes,
  animeId,
  provider,
  currentEpisode,
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
    />
  );
}
