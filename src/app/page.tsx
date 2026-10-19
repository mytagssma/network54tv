"use client";

import { useState, useEffect } from "react";
import { getRecentlyAiredClient } from "@/lib/anilist";
import type { Anime } from "@/types/anime";
import AnimeCard from "@/components/anime/AnimeCard";
import { appendUnique, createPageBuffer, useLastRowFill } from "@/hooks/useLastRowFill";

const FEED_WINDOW_DAYS = 30;
// Fixed page size: the width-aware Load More only decides how many *visible*
// cards to release per fill (see useLastRowFill), never the AniList perPage.
const FEED_PER_PAGE = 24;

/**
 * Landing feed — the latest releases only. Search and filtering live on
 * /browse (the navbar search icon links there).
 */
export default function Home() {
  const [results, setResults] = useState<Anime[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [navigatingId, setNavigatingId] = useState<number | null>(null);
  // Whole-page cursor + pending queue: pages are fetched with FEED_PER_PAGE
  // and released to the grid in row-sized bites, so the last row of the grid
  // is always complete without skipping or duplicating items.
  const [feedBuffer] = useState(() => createPageBuffer<Anime>());

  // Load recently aired on initial mount
  useEffect(() => {
    let cancelled = false;
    async function loadLatest() {
      setLoading(true);
      try {
        const data = await getRecentlyAiredClient(FEED_WINDOW_DAYS, 1, FEED_PER_PAGE);
        if (cancelled) return;
        setResults(data.media);
        feedBuffer.reset(data.hasNextPage);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load latest anime.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadLatest();
    return () => { cancelled = true; };
  }, [feedBuffer]);

  // Width-aware fill: keeps the grid's last row complete on Load More, on
  // viewport changes, and after every fetch — until the source is exhausted.
  const { setContainer, loadMore, loadingMore } = useLastRowFill({
    ready: !loading,
    count: results.length,
    hasMore: feedBuffer.canFetch(),
    fetchNeeded: async (need) => {
      const items = await feedBuffer.take(
        need,
        (page) => getRecentlyAiredClient(FEED_WINDOW_DAYS, page, FEED_PER_PAGE)
      );
      if (items.length > 0) setResults((prev) => appendUnique(prev, items));
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to load more."),
    fallbackNeed: FEED_PER_PAGE,
  });

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
            stable while the first page loads. The wrapper also scopes the
            width-aware Load More: its `data-rowfill` grid is the one measured. */}
        <div ref={setContainer}>
          <div data-rowfill="" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
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
                  status: anime.status,
                  nextAiringEpisode: anime.nextAiringEpisode,
                  // The EXACT episode that just aired — the episode field of the
                  // airing-schedule row that ordered this feed. The strip offers
                  // this precise AniList number rather than a re-derived one.
                  latestAiredEpisode: anime.latestAiredEpisode,
                }}
                // This feed IS "what just aired", so each card also offers the
                // latest RELEASED episode straight from its cover; every other
                // AnimeCard surface (browse/search/detail) leaves the prop off.
                playLatest
                loading={anime.id === navigatingId}
                onClick={() => setNavigatingId(anime.id)}
              />
            ))}
          </div>

          {/* Load More */}
          {!loading && results.length > 0 && feedBuffer.canFetch() && (
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
        </div>

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
