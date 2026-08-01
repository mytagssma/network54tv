"use client";

import { useState } from "react";
import type { Episode } from "@/types/anime";
import Link from "next/link";
import Button from "../ui/Button";

interface EpisodeListProps {
  episodes: Episode[];
  animeId: number;
  animeTitle: string;
}

export default function EpisodeList({
  episodes,
  animeId,
  animeTitle,
}: EpisodeListProps) {
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const sorted = [...episodes].sort((a, b) =>
    sortOrder === "asc" ? a.number - b.number : b.number - a.number
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-cyan-300 uppercase tracking-wider font-mono">
          Episodes
          <span className="text-cyan-600 text-sm ml-2">
            ({episodes.length})
          </span>
        </h2>
        <button
          onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
          className="text-xs font-mono uppercase tracking-widest text-cyan-500 hover:text-cyan-400 transition-colors"
        >
          {sortOrder === "asc" ? "▼ Newest" : "▲ Oldest"}
        </button>
      </div>

      <div className="grid gap-1">
        {sorted.map((ep) => (
          <Link
            key={`${ep.id}-${ep.number}`}
            href={`/anime/${animeId}/watch/${ep.number}`}
            className="group flex items-center gap-3 px-4 py-3 border border-cyan-500/10 
                       hover:border-cyan-400/30 hover:bg-cyan-950/20 transition-all duration-200"
          >
            {/* Episode number */}
            <div className="flex-shrink-0 w-10 h-10 flex items-center justify-center border border-cyan-500/20 group-hover:border-cyan-400/50 transition-colors">
              <span className="text-sm font-bold font-mono text-cyan-300">
                {String(ep.number).padStart(2, "0")}
              </span>
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-cyan-100 group-hover:text-cyan-200 transition-colors truncate">
                {ep.title || `Episode ${ep.number}`}
              </p>
              {ep.image && (
                <p className="text-[10px] font-mono text-cyan-600/50 mt-0.5">
                  {ep.providerId}
                </p>
              )}
            </div>

            {/* Play icon */}
            <svg
              className="w-5 h-5 text-cyan-600 group-hover:text-cyan-400 transition-colors flex-shrink-0"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          </Link>
        ))}
      </div>

      {episodes.length === 0 && (
        <div className="text-center py-12 border border-dashed border-cyan-500/20">
          <p className="text-cyan-600 font-mono text-sm tracking-wider">
            No episodes available yet
          </p>
        </div>
      )}
    </div>
  );
}
