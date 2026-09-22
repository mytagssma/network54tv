"use client";

import { useState, useEffect, useCallback } from "react";
import EpisodeList from "./EpisodeList";
import type { Episode } from "@/types/anime";

interface EpisodeListFetcherProps {
  animeTitle: string;
  animeId: number;
  initialEpisodes: Episode[];
}

export default function EpisodeListFetcher({ animeTitle, animeId, initialEpisodes }: EpisodeListFetcherProps) {
  const [episodes, setEpisodes] = useState<Episode[]>(initialEpisodes);
  const [loading, setLoading] = useState(false);

  const fetchEpisodes = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ title: animeTitle, id: String(animeId) });
      const res = await fetch(`/api/episodes?${params}`);
      if (res.ok) {
        const data = await res.json();
        if (data.episodes) setEpisodes(data.episodes);
      }
    } catch {
      // keep current episodes on error
    } finally {
      setLoading(false);
    }
  }, [animeTitle, animeId]);

  // Fetch episodes on mount (auto provider — selector was removed)
  useEffect(() => {
    // Clear any stale stored provider from the removed header selector
    try { localStorage.removeItem("n54tv-provider"); } catch {}
    fetchEpisodes();
  }, [fetchEpisodes]);

  // Sub/Dub counts
  const subCount = episodes.filter((ep) => ep.hasSub !== false).length;
  const dubCount = episodes.filter((ep) => ep.hasDub === true).length;

  return (
    <div>
      <div className="flex items-center gap-4 mb-5">
        <h2 className="text-xl font-bold text-[var(--accent)] uppercase tracking-wider">
          // Episodes
        </h2>
        {episodes.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="bg-transparent border border-[var(--accent)]/20 text-[var(--accent)]/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider rounded-none">
              Sub {subCount}
            </span>
            <span className="bg-transparent border border-[var(--accent)]/20 text-[var(--accent)]/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider rounded-none">
              Dub {dubCount}
            </span>
          </div>
        )}
        {loading && (
          <span className="text-[10px] text-[var(--accent)]/40 font-mono animate-pulse">Loading...</span>
        )}
      </div>

      {episodes.length > 0 ? (
        <EpisodeList episodes={episodes} animeId={animeId} />
      ) : (
        <p className="text-[#6b6b70] italic">
          {loading ? "Fetching episodes..." : "No episodes available."}
        </p>
      )}
    </div>
  );
}
