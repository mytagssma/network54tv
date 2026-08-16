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
  const [provider, setProvider] = useState("");

  const fetchEpisodes = useCallback(async (providerId: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ title: animeTitle, id: String(animeId) });
      if (providerId) params.set("provider", providerId);
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

  // Read provider from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem("n54tv-provider") || "";
    setProvider(stored);
  }, []);

  // Listen for provider-changed custom event
  useEffect(() => {
    const handler = (e: Event) => {
      const newProvider = (e as CustomEvent).detail || "";
      setProvider(newProvider);
      fetchEpisodes(newProvider);
    };
    window.addEventListener("n54tv-provider-changed", handler);
    return () => window.removeEventListener("n54tv-provider-changed", handler);
  }, [fetchEpisodes]);

  // Also listen for storage events (from other tabs)
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === "n54tv-provider") {
        const newProvider = e.newValue || "";
        setProvider(newProvider);
        fetchEpisodes(newProvider);
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
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
