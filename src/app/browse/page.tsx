"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { searchAnimeClient, getTrendingClient, groupByReleaseSeason } from "@/lib/anilist";
import type { Anime } from "@/types/anime";
import AnimeCard from "@/components/anime/AnimeCard";

function BrowseContent() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q") || "";

  const [results, setResults] = useState<Anime[]>([]);
  const [trending, setTrending] = useState<Anime[]>([]);
  const [popular, setPopular] = useState<Anime[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [trendingPage, setTrendingPage] = useState(1);
  const [trendingHasNext, setTrendingHasNext] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [navigatingId, setNavigatingId] = useState<number | null>(null);
  // "" = default sort: home page's latest-updates order (queue#8)
  const [sort, setSort] = useState("");
  // Search filter: bucket results by release season/year (queue#19b)
  const [groupBySeason, setGroupBySeason] = useState(false);

  const toCard = (a: Anime) => ({
    id: a.id,
    title: a.title,
    image: a.coverImage,
    genres: a.genres,
    rating: a.score,
    episodes: a.episodes,
  });

  // Fetch initial data when query changes
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      setPage(1);
      setTrendingPage(1);
      if (query) {
        try {
          const data = await searchAnimeClient(query, 1, 24, sort ? { sort } : undefined);
          if (!cancelled) {
            setResults(data.media);
            setHasNextPage(data.hasNextPage);
          }
        } catch {
          if (!cancelled) setError("Search failed.");
        } finally {
          if (!cancelled) setLoading(false);
        }
      } else {
        try {
          const [trendingData, popularData] = await Promise.all([
            getTrendingClient(1, 12),
            // Use searchAnimeClient with popularity sort for popular (no dedicated getPopularClient)
            searchAnimeClient("", 1, 12, { sort: "POPULARITY_DESC" }),
          ]);
          if (!cancelled) {
            setTrending(trendingData.media);
            setTrendingHasNext(trendingData.hasNextPage);
            setPopular(popularData.media);
          }
        } catch {
          if (!cancelled) setError("Failed to load.");
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [query, sort]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      if (query) {
        const nextPage = page + 1;
        const data = await searchAnimeClient(query, nextPage, 24, sort ? { sort } : undefined);
        setResults((prev) => [...prev, ...data.media]);
        setHasNextPage(data.hasNextPage);
        setPage(nextPage);
      } else {
        const nextPage = trendingPage + 1;
        const data = await getTrendingClient(nextPage, 12);
        setTrending((prev) => [...prev, ...data.media]);
        setTrendingHasNext(data.hasNextPage);
        setTrendingPage(nextPage);
      }
    } catch (e: any) {
      setError(e?.message || "Failed to load more.");
    } finally {
      setLoadingMore(false);
    }
  }

  const title = query ? `Search: ${query}` : "Browse Anime";

  const renderCardGrid = (items: Anime[]) => (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
      {items.map((a) => <AnimeCard key={a.id} anime={toCard(a)} loading={a.id === navigatingId} onClick={() => setNavigatingId(a.id)} />)}
    </div>
  );

  let resultsNode: React.ReactNode = null;
  if (loading) {
    resultsNode = <div className="text-center py-12 text-[var(--text-decorative)] font-mono text-sm uppercase tracking-wider">Loading...</div>;
  } else if (error) {
    resultsNode = <div className="text-center py-20"><p className="text-red-400 font-mono text-sm">{error}</p></div>;
  } else if (query) {
    resultsNode = results.length > 0 ? (
      <div>
        {groupBySeason ? (
          groupByReleaseSeason(results).map((group) => (
            <section key={group.label} className="mb-8 last:mb-0">
              <div className="flex items-center gap-3 mb-4">
                <div className="h-4 w-1 bg-[var(--accent)]/60" />
                <h3 className="text-sm font-black text-[var(--accent)]/80 uppercase tracking-wider font-mono">// {group.label}</h3>
                <span className="text-[11px] text-[var(--text-decorative)] font-mono">{group.items.length} title{group.items.length === 1 ? "" : "s"}</span>
              </div>
              {renderCardGrid(group.items)}
            </section>
          ))
        ) : (
          renderCardGrid(results)
        )}
        {hasNextPage && (
          <div className="flex justify-center mt-8">
            <button type="button" onClick={loadMore} disabled={loadingMore} className="bg-[var(--accent)]/10 border border-[var(--accent)]/30 px-6 py-2.5 text-[var(--accent)] font-mono text-sm uppercase tracking-wider hover:bg-[var(--accent)]/20 disabled:opacity-50 transition-colors rounded-none min-h-[44px] sm:min-h-0">
              {loadingMore ? "Loading..." : "Load More"}
            </button>
          </div>
        )}
      </div>
    ) : (
      <div className="text-center py-20 border border-dashed border-[var(--accent)]/20 rounded-none">
        <p className="text-[var(--accent)]/50 font-mono text-sm tracking-wider">No results for &ldquo;{query}&rdquo;</p>
      </div>
    );
  } else {
    resultsNode = (
      <div>
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-5 w-1 bg-[var(--accent)]" />
            <svg className="w-4 h-4 text-[var(--accent)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 16.121A3 3 0 1012.015 11L11 14H9c0 .768.293 1.536.879 2.121z" />
            </svg>
            <h2 className="text-lg font-black text-[var(--accent)] uppercase tracking-wider font-mono">// Trending Now</h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {trending.map((a) => <AnimeCard key={a.id} anime={toCard(a)} loading={a.id === navigatingId} onClick={() => setNavigatingId(a.id)} />)}
          </div>
          {trendingHasNext && (
            <div className="flex justify-center mt-6">
              <button type="button" onClick={loadMore} disabled={loadingMore} className="bg-[var(--accent)]/10 border border-[var(--accent)]/30 px-6 py-2.5 text-[var(--accent)] font-mono text-sm uppercase tracking-wider hover:bg-[var(--accent)]/20 disabled:opacity-50 transition-colors rounded-none min-h-[44px] sm:min-h-0">
                {loadingMore ? "Loading..." : "Load More"}
              </button>
            </div>
          )}
        </div>
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="h-5 w-1 bg-[var(--accent)]/60" />
            <svg className="w-4 h-4 text-[var(--accent)]/70" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
            <h2 className="text-lg font-black text-[var(--accent)]/70 uppercase tracking-wider font-mono">// Most Popular</h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {popular.map((a) => <AnimeCard key={a.id} anime={toCard(a)} loading={a.id === navigatingId} onClick={() => setNavigatingId(a.id)} />)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-[var(--accent)] mb-6 uppercase tracking-wider">
          // {title}
        </h1>
        <SearchBar initialQuery={query} />
        {query && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 p-3 bg-[var(--panel)] border border-[var(--accent)]/20 rounded-none">
            <span className="text-xs text-[var(--accent)]/70 uppercase tracking-wider font-mono">// Filters</span>
            <div className="flex items-center gap-2">
              <label htmlFor="browse-sort" className="text-xs text-[var(--accent)]/70 uppercase tracking-wider font-mono">Sort</label>
              <select
                id="browse-sort"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                className="bg-[var(--background)] border border-[var(--accent)]/20 px-3 py-1.5 text-sm text-[var(--accent)] focus:outline-none focus:border-[var(--accent)] transition-colors rounded-none"
              >
                <option value="">Latest Updates</option>
                <option value="SCORE_DESC">Score</option>
                <option value="TRENDING_DESC">Trending</option>
                <option value="POPULARITY_DESC">Popularity</option>
                <option value="START_DATE_DESC">Newest Release</option>
              </select>
            </div>
            <button
              type="button"
              onClick={() => setGroupBySeason((prev) => !prev)}
              aria-pressed={groupBySeason}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 font-mono uppercase tracking-wider border transition-colors rounded-none min-h-[36px] ${
                groupBySeason
                  ? "bg-[var(--accent)] border-[var(--accent)] text-black"
                  : "bg-transparent border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/10"
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
              </svg>
              Group by Season
            </button>
          </div>
        )}
      </div>
      {resultsNode}
    </div>
  );
}

export default function BrowsePage() {
  return (
    <Suspense fallback={<div className="max-w-7xl mx-auto px-4 py-8"><div className="text-center py-12 text-[var(--text-decorative)] font-mono text-sm uppercase tracking-wider">Loading...</div></div>}>
      <BrowseContent />
    </Suspense>
  );
}

function SearchBar({ initialQuery }: { initialQuery: string }) {
  return (
    <div className="max-w-xl">
      <form action="/browse" method="GET" className="relative group">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-decorative)]"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input type="text" name="q" defaultValue={initialQuery} placeholder="Search anime..."
          className="w-full bg-[var(--panel)] border border-[var(--accent)]/30 text-white pl-10 pr-12 py-3 outline-none transition-all duration-300 focus:border-[var(--accent)] focus:accent-shadow-sm placeholder:text-[var(--text-decorative)] font-mono text-sm rounded-none" />
        <button type="submit" aria-label="Search" className="absolute right-1 top-1/2 -translate-y-1/2 px-3 py-2 text-[var(--accent)] hover:brightness-125 transition-colors min-h-[44px] sm:min-h-0 flex items-center">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </button>
      </form>
    </div>
  );
}
