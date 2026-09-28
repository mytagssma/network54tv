"use client";

import { useState, useEffect } from "react";
import { getRecentlyAiredClient } from "@/lib/anilist";
import type { Anime } from "@/types/anime";
import AnimeCard from "@/components/anime/AnimeCard";

/**
 * Landing feed — the latest releases only. Search and filtering live on
 * /browse (the navbar search icon links there).
 */
export default function Home() {
  const [results, setResults] = useState<Anime[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [navigatingId, setNavigatingId] = useState<number | null>(null);

  // Load recently aired on initial mount
  useEffect(() => {
    let cancelled = false;
    async function loadLatest() {
      setLoading(true);
      try {
        const data = await getRecentlyAiredClient(30, 1, 24);
        if (cancelled) return;
        setResults(data.media);
        setHasNextPage(data.hasNextPage);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load latest anime.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadLatest();
    return () => { cancelled = true; };
  }, []);

  async function loadMore() {
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const data = await getRecentlyAiredClient(30, nextPage, 24);
      setResults((prev) => [...prev, ...data.media]);
      setHasNextPage(data.hasNextPage);
      setPage(nextPage);
    } catch (e: any) {
      setError(e?.message || "Failed to load more.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="min-h-screen bg-[var(--background)] text-white">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold uppercase tracking-wider text-[var(--accent)] mb-6">
          // Latest Releases
        </h1>

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 border-l-2 border-red-500 px-4 py-3 mb-6 text-red-400 text-sm font-mono rounded-none">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="text-center py-12 text-[var(--text-decorative)] font-mono text-sm uppercase tracking-wider">
            Loading...
          </div>
        )}

        {/* Feed — the grid container stays mounted so the page structure is
            stable while the first page loads. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {results.map((anime) => (
            <AnimeCard
              key={anime.id}
              anime={{
                id: anime.id,
                title: anime.title,
                image: anime.coverImage,
                genres: anime.genres,
                rating: anime.score,
                episodes: anime.episodes,
              }}
              loading={anime.id === navigatingId}
              onClick={() => setNavigatingId(anime.id)}
            />
          ))}
        </div>

        {/* Load More */}
        {!loading && results.length > 0 && hasNextPage && (
          <div className="flex justify-center mt-8">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="min-h-[44px] bg-[var(--accent)]/10 border border-[var(--accent)]/30 px-6 py-2.5 text-[var(--accent)] font-mono text-sm uppercase tracking-wider hover:bg-[var(--accent)]/20 disabled:opacity-50 transition-colors rounded-none"
            >
              {loadingMore ? "Loading..." : "Load More"}
            </button>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && results.length === 0 && (
          <div className="text-center py-12 text-[var(--text-decorative)] font-mono text-sm">
            No releases to show right now.
          </div>
        )}
      </div>
    </div>
  );
}
