"use client";

import { useState, useEffect, FormEvent } from "react";
import { searchAnimeClient, getRecentlyAiredClient, GENRES, type SearchFilters, type TagFilter } from "@/lib/anilist";
import AnimeCard from "@/components/anime/AnimeCard";
import type { Anime } from "@/types/anime";

function mapAnimeToCard(anime: Anime) {
  return {
    id: anime.id,
    title: anime.title,
    image: anime.coverImage,
    genres: anime.genres,
  };
}

const FORMATS = ["TV", "Movie", "OVA", "Special", "ONA", "Music"];
const SEASONS = ["Winter", "Spring", "Summer", "Fall"];
const STATUSES = ["Finished", "Releasing", "Upcoming", "Cancelled"];

export default function Home() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Anime[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasSearched, setHasSearched] = useState(false);
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [filterFormat, setFilterFormat] = useState("");
  const [filterSeason, setFilterSeason] = useState("");
  const [filterTimeRange, setFilterTimeRange] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSort, setFilterSort] = useState("");
  const [filterTags, setFilterTags] = useState<Record<string, "include" | "exclude">>({});
  const [filterTagMode, setFilterTagMode] = useState<"OR" | "AND">("OR");

  const hasActiveFilters = Boolean(
    filterFormat || filterSeason || filterTimeRange || filterStatus || filterSort ||
    Object.keys(filterTags).length
  );

  function getFilters(): SearchFilters | undefined {
    const f: SearchFilters = {};
    if (filterFormat) f.format = filterFormat;
    if (filterSeason) f.season = filterSeason;
    if (filterTimeRange) f.timeRange = filterTimeRange;
    if (filterStatus) f.status = filterStatus;
    if (filterSort) f.sort = filterSort;
    if (Object.keys(filterTags).length) {
      const include = Object.keys(filterTags).filter((k) => filterTags[k] === "include");
      const exclude = Object.keys(filterTags).filter((k) => filterTags[k] === "exclude");
      if (include.length || exclude.length) {
        f.tagFilter = { include, exclude, mode: filterTagMode };
      }
    }
    return Object.keys(f).length ? f : undefined;
  }

  // Load recently aired on initial mount
  useEffect(() => {
    async function loadLatest() {
      setLoading(true);
      try {
        const data = await getRecentlyAiredClient(30, 1, 24);
        setResults(data.media);
        setHasNextPage(data.hasNextPage);
      } catch {
        setError("Failed to load latest anime.");
      } finally {
        setLoading(false);
      }
    }
    loadLatest();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed && !hasActiveFilters) return;

    setLoading(true);
    setError("");
    setHasSearched(true);
    setPage(1);

    try {
      const data = await searchAnimeClient(trimmed || "", 1, 24, getFilters());
      setResults(data.media);
      setHasNextPage(data.hasNextPage);
    } catch {
      setError("Search failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const trimmed = query.trim();
      const data = trimmed || hasActiveFilters
        ? await searchAnimeClient(trimmed, nextPage, 24, getFilters())
        : await getRecentlyAiredClient(30, nextPage, 24);
      setResults((prev) => [...prev, ...data.media]);
      setHasNextPage(data.hasNextPage);
      setPage(nextPage);
    } catch {
      setError("Failed to load more.");
    } finally {
      setLoadingMore(false);
    }
  }

  function handleClear() {
    setQuery("");
    setFilterFormat("");
    setFilterSeason("");
    setFilterTimeRange("");
    setFilterStatus("");
    setFilterSort("");
    setFilterTags({});
    setFilterTagMode("OR");
    setHasSearched(false);
    setError("");
    setPage(1);
    setLoading(true);
    getRecentlyAiredClient(30, 1, 24)
      .then((data) => {
        setResults(data.media);
        setHasNextPage(data.hasNextPage);
      })
      .catch(() => setError("Failed to load latest anime."))
      .finally(() => setLoading(false));
  }

  return (
    <div className="min-h-screen bg-[var(--background)] text-white">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Search header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-4 uppercase tracking-wider text-[var(--accent)]">
            // Browse Anime
          </h1>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            {/* Search row - stacked on mobile, inline on desktop */}
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1 w-full sm:w-auto">
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
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search anime..."
                  className="w-full bg-[var(--panel)] border border-[var(--accent)]/30 pl-10 pr-4 py-2.5 text-white placeholder-[var(--text-decorative)] focus:outline-none focus:border-[var(--accent)] focus:accent-shadow-sm transition-all font-mono text-sm rounded-none"
                />
              </div>
              {/* Buttons row - stacked on mobile, inline on desktop */}
              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                <button
                  type="submit"
                  disabled={loading}
                  className="bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-black px-6 py-2.5 font-bold uppercase tracking-wider text-sm transition-all accent-shadow-md rounded-none flex items-center justify-center gap-2"
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  {loading ? "Searching..." : "Search"}
                </button>
                {hasSearched && (
                  <button
                    type="button"
                    onClick={handleClear}
                    className="bg-transparent hover:bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/30 px-4 py-2.5 font-medium transition-colors rounded-none text-sm flex items-center justify-center gap-1.5"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowFilters(!showFilters)}
                  className={`px-4 py-2.5 font-medium transition-colors rounded-none text-sm flex items-center justify-center gap-1.5 ${
                    showFilters || hasActiveFilters
                      ? "bg-[var(--accent)] text-black"
                      : "bg-transparent text-[var(--accent)] border border-[var(--accent)]/30 hover:bg-[var(--accent)]/10"
                  }`}
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                  </svg>
                  Filters
                  {hasActiveFilters && <span className="text-[10px]">(active)</span>}
                  {showFilters && (
                    <svg
                      className="w-3 h-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Filter row (collapsible) */}
            {showFilters && (
              <div className="flex flex-wrap gap-3 p-4 bg-[var(--panel)] border border-[var(--accent)]/20 rounded-none">
                {/* Format */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-[var(--accent)]/70 uppercase tracking-wider font-mono">Format</label>
                  <select
                    value={filterFormat}
                    onChange={(e) => setFilterFormat(e.target.value)}
                    className="bg-[var(--background)] border border-[var(--accent)]/20 px-3 py-1.5 text-sm text-[var(--accent)] focus:outline-none focus:border-[var(--accent)] transition-colors rounded-none"
                  >
                    <option value="">Any</option>
                    {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>

                {/* Season */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-[var(--accent)]/70 uppercase tracking-wider font-mono">Season</label>
                  <select
                    value={filterSeason}
                    onChange={(e) => setFilterSeason(e.target.value)}
                    className="bg-[var(--background)] border border-[var(--accent)]/20 px-3 py-1.5 text-sm text-[var(--accent)] focus:outline-none focus:border-[var(--accent)] transition-colors rounded-none"
                  >
                    <option value="">Any</option>
                    {SEASONS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>

                {/* Time Range */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-[var(--accent)]/70 uppercase tracking-wider font-mono">Time Range</label>
                  <select
                    value={filterTimeRange}
                    onChange={(e) => setFilterTimeRange(e.target.value)}
                    className="bg-[var(--background)] border border-[var(--accent)]/20 px-3 py-1.5 text-sm text-[var(--accent)] focus:outline-none focus:border-[var(--accent)] transition-colors rounded-none"
                  >
                    <option value="">Any</option>
                    <option value="week">Past Week</option>
                    <option value="month">Past Month</option>
                    <option value="3months">Past 3 Months</option>
                    <option value="6months">Past 6 Months</option>
                    <option value="year">Past Year</option>
                  </select>
                </div>

                {/* Sort */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-[var(--accent)]/70 uppercase tracking-wider font-mono">Sort</label>
                  <select
                    value={filterSort}
                    onChange={(e) => setFilterSort(e.target.value)}
                    className="bg-[var(--background)] border border-[var(--accent)]/20 px-3 py-1.5 text-sm text-[var(--accent)] focus:outline-none focus:border-[var(--accent)] transition-colors rounded-none"
                  >
                    <option value="">Popularity</option>
                    <option value="SCORE_DESC">Score</option>
                    <option value="TRENDING_DESC">Trending</option>
                    <option value="START_DATE_DESC">Recently Updated</option>
                  </select>
                </div>

                {/* Status */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-[var(--accent)]/70 uppercase tracking-wider font-mono">Status</label>
                  <select
                    value={filterStatus}
                    onChange={(e) => setFilterStatus(e.target.value)}
                    className="bg-[var(--background)] border border-[var(--accent)]/20 px-3 py-1.5 text-sm text-[var(--accent)] focus:outline-none focus:border-[var(--accent)] transition-colors rounded-none"
                  >
                    <option value="">Any</option>
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>

                {/* Genre tags — full width row */}
                <div className="flex flex-col gap-2 pt-2 border-t border-[var(--accent)]/10 w-full">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-[var(--accent)]/70 uppercase tracking-wider font-mono">Tags</label>
                    <button
                      type="button"
                      onClick={() => setFilterTagMode(filterTagMode === "OR" ? "AND" : "OR")}
                      className={`text-[11px] px-2 py-0.5 font-mono uppercase tracking-wider border transition-colors rounded-none ${
                        Object.keys(filterTags).some((k) => filterTags[k] === "include")
                          ? "border-[var(--accent)]/30 text-[var(--accent)]"
                          : "border-[var(--accent)]/10 text-[var(--accent)]/30"
                      }`}
                    >
                      {filterTagMode === "OR" ? "Match Any" : "Match All"}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {GENRES.map((g) => {
                      const state = filterTags[g];
                      return (
                        <button
                          key={g}
                          type="button"
                          onClick={() => {
                            setFilterTags((prev) => {
                              const next = { ...prev };
                              if (!next[g]) next[g] = "include";
                              else if (next[g] === "include") next[g] = "exclude";
                              else delete next[g];
                              return next;
                            });
                          }}
                          className={`text-[11px] px-2 py-1 font-mono border transition-colors rounded-none ${
                            state === "include"
                              ? "bg-[var(--accent)]/20 border-[var(--accent)]/50 text-[var(--accent)]"
                              : state === "exclude"
                              ? "bg-red-900/20 border-red-500/40 text-red-400"
                              : "border-[var(--accent)]/10 text-[var(--text-decorative)] hover:border-[var(--accent)]/30"
                          }`}
                        >
                          {state === "exclude" ? "−" : state === "include" ? "+" : "·"} {g}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </form>
        </div>

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

        {/* Results */}
        {!loading && results.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold mb-4 text-[var(--accent)] uppercase tracking-wider">
              // {hasSearched ? "Search Results" : "Latest Releases"}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {results.map((anime) => (
                <AnimeCard key={anime.id} anime={mapAnimeToCard(anime)} />
              ))}
            </div>

            {/* Load More */}
            {hasNextPage && (
              <div className="flex justify-center mt-8">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="bg-[var(--accent)]/10 border border-[var(--accent)]/30 px-6 py-2.5 text-[var(--accent)] font-mono text-sm uppercase tracking-wider hover:bg-[var(--accent)]/20 disabled:opacity-50 transition-colors rounded-none"
                >
                  {loadingMore ? "Loading..." : "Load More"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* No results */}
        {!loading && hasSearched && results.length === 0 && !error && (
          <div className="text-center py-12 text-[var(--text-decorative)] font-mono text-sm">
            No anime found{query ? ` for "${query}"` : ""}{hasActiveFilters ? " with these filters" : ""}.
          </div>
        )}
      </div>
    </div>
  );
}
