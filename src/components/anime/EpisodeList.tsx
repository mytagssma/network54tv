"use client";

import { useState } from "react";
import Link from "next/link";
import type { Episode } from "@/types/anime";

interface EpisodeListProps {
  episodes: Episode[];
  animeId: number;
}

export default function EpisodeList({ episodes, animeId }: EpisodeListProps) {
  const [clickedEp, setClickedEp] = useState<number | null>(null);

  return (
    <div className="grid gap-2 sm:gap-3 max-h-[60vh] sm:max-h-none overflow-y-auto">
      {episodes.map((episode) => {
        const isAvailable = episode.available !== false;
        const isClicked = clickedEp === episode.number;

        return isAvailable ? (
          <Link
            key={`${episode.id}-${episode.number}`}
            href={`/anime/${animeId}/watch/${episode.number}`}
            onClick={() => setClickedEp(episode.number)}
            className={`flex items-center gap-3 sm:gap-4 p-3 sm:p-4 transition-all group rounded-none ${
              isClicked
                ? "bg-[var(--accent)]/10 border-l-2 border-[var(--accent)] animate-pulse"
                : "bg-[#131318] hover:bg-[#1a1a20] border-l-2 border-[var(--accent)]/30 hover:border-l-[var(--accent)]"
            }`}
          >
            <span className="text-[var(--accent)]/50 font-mono text-xs w-7 text-right shrink-0 font-bold">
              {String(episode.number).padStart(2, "0")}
            </span>
            <div className="flex-1 min-w-0">
              <p className={`transition-colors ${isClicked ? "text-white" : "text-[#9a9aa0] group-hover:text-white"}`}>
                {episode.title || `Episode ${episode.number}`}
              </p>
            </div>
            {isClicked ? (
              <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin shrink-0" />
            ) : (
              <svg
                className="w-5 h-5 text-[#6b6b70] group-hover:text-[var(--accent)] shrink-0 transition-colors"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            )}
          </Link>
        ) : (
          <div
            key={`${episode.id}-${episode.number}`}
            className="flex items-center gap-3 sm:gap-4 bg-[#131318] border-l-2 border-[#6b6b70]/30 p-3 sm:p-4 rounded-none opacity-50 cursor-not-allowed"
          >
            <span className="text-[#6b6b70] font-mono text-sm w-8 text-right shrink-0 font-bold">
              {String(episode.number).padStart(2, "0")}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[#6b6b70] truncate">
                {episode.title || `Episode ${episode.number}`}
              </p>
            </div>
            <span className="text-[10px] font-mono text-[#6b6b70] uppercase tracking-wider shrink-0">
              N/A
            </span>
          </div>
        );
      })}
    </div>
  );
}