"use client";

import { useState } from "react";
import Link from "next/link";
import type { Episode } from "@/types/anime";
import { AvailabilityChip } from "./Availability";
import { ChevronRightIcon } from "@/components/ui/icons";

interface EpisodeListProps {
  episodes: Episode[];
  animeId: number;
  provider?: string;
}

export default function EpisodeList({ episodes, animeId, provider }: EpisodeListProps) {
  const [clickedEp, setClickedEp] = useState<number | null>(null);
  const providerQs = provider ? `?provider=${provider}` : "";

  return (
    <div className="grid gap-2 sm:gap-3 max-h-[60vh] sm:max-h-none overflow-y-auto">
      {episodes.map((episode) => {
        const isAvailable = episode.available !== false;
        const isClicked = clickedEp === episode.number;
        // Only tag what is actually known — unknown availability renders no chip.
        const hasSub = episode.hasSub === true;
        const hasDub = episode.hasDub === true;

        return isAvailable ? (
          <Link
            key={`${episode.id}-${episode.number}`}
            href={`/anime/${animeId}/watch/${episode.number}${providerQs}`}
            onClick={() => setClickedEp(episode.number)}
            className={`flex items-center gap-3 sm:gap-4 p-3 sm:p-4 transition-all group rounded-none ${
              isClicked
                ? "bg-[var(--accent)]/10 border-l-2 border-[var(--accent)] animate-pulse"
                : "bg-[var(--panel)] hover:bg-[var(--surface)] border-l-2 border-[var(--accent)]/30 hover:border-l-[var(--accent)]"
            }`}
          >
            <span className="text-[var(--accent)]/50 font-mono text-xs w-7 text-right shrink-0 font-bold">
              {String(episode.number).padStart(2, "0")}
            </span>
            <div className="flex-1 min-w-0">
              <p className={`transition-colors ${isClicked ? "text-white" : "text-[var(--text-secondary)] group-hover:text-white"}`}>
                {episode.title || `Episode ${episode.number}`}
              </p>
            </div>
            {(hasSub || hasDub) && (
              <span className="flex items-center gap-1 shrink-0">
                {hasSub && <AvailabilityChip kind="sub" />}
                {hasDub && <AvailabilityChip kind="dub" />}
              </span>
            )}
            {isClicked ? (
              <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin shrink-0" />
            ) : (
              <ChevronRightIcon className="w-5 h-5 text-[var(--text-decorative)] group-hover:text-[var(--accent)] shrink-0 transition-colors" />
            )}
          </Link>
        ) : (
          <div
            key={`${episode.id}-${episode.number}`}
            className="flex items-center gap-3 sm:gap-4 bg-[var(--panel)] border-l-2 border-[var(--text-decorative)]/30 p-3 sm:p-4 rounded-none opacity-50 cursor-not-allowed"
          >
            <span className="text-[var(--text-decorative)] font-mono text-xs w-7 text-right shrink-0 font-bold">
              {String(episode.number).padStart(2, "0")}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[var(--text-decorative)] truncate">
                {episode.title || `Episode ${episode.number}`}
              </p>
            </div>
            <AvailabilityChip kind="na" className="shrink-0" />
          </div>
        );
      })}
    </div>
  );
}