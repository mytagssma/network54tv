"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { searchAnimeClient, getTrendingClient, type SearchFilters } from "@/lib/anilist";
import type { Anime } from "@/types/anime";
import AnimeCard from "@/components/anime/AnimeCard";
import {
  FilterPanel,
  FilterSelect,
  FORMATS,
  GroupedResults,
  GroupingToggle,
  ResetButton,
  SEASONS,
  SORT_OPTIONS,
  SearchHeading,
  SearchRow,
  SectionHeading,
  STATUSES,
  TagFilterGrid,
  TIME_RANGES,
  toOptions,
  type TagMode,
  type TagState,
} from "@/components/search";

const FILTER_PANEL_ID = "browse-filter-panel";

function BrowseContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
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

  // ── Filters ────────────────────────────────────────────────────────────
  // Client state: `?q=` stays purely the query, and any change re-runs the
  // search immediately (initial fetch and load-more both read `filters`).
  // "" = none-selected ("Any"); sort "" = latest-updates order (queue#8).
  const [format, setFormat] = useState("");
  const [season, setSeason] = useState("");
  const [timeRange, setTimeRange] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("");
  const [tags, setTags] = useState<Record<string, TagState>>({});
  const [tagMode, setTagMode] = useState<TagMode>("OR");
  // Search filter: cluster results into franchises (seasons/prequels/spin-offs
  // together) — on by default; an explicit sort keeps the fetched order.
  const [groupFranchise, setGroupFranchise] = useState(true);
  // The panel sits under the same Filters toggle as before and starts open so
  // the controls stay one click away after a search.
  const [showFilters, setShowFilters] = useState(true);

  // Memoised so the fetch effect only re-runs when a filter actually changes.
  const filters = useMemo<SearchFilters | undefined>(() => {
    const f: SearchFilters = {};
    if (format) f.format = format;
    if (season) f.season = season;
    if (timeRange) f.timeRange = timeRange;
    if (status) f.status = status;
    if (sort) f.sort = sort;
    if (Object.keys(tags).length) {
      const include = Object.keys(tags).filter((k) => tags[k] === "include");
      const exclude = Object.keys(tags).filter((k) => tags[k] === "exclude");
      if (include.length || exclude.length) {
        f.tagFilter = { include, exclude, mode: tagMode };
      }
    }
    return Object.keys(f).length ? f : undefined;
  }, [format, season, timeRange, status, sort, tags, tagMode]);

  const hasActiveFilters = Boolean(
    format || season || timeRange || status || sort || Object.keys(tags).length
  );

  const toCard = (a: Anime) => ({
    id: a.id,
    title: a.title,
    image: a.coverImage,
    genres: a.genres,
    rating: a.score,
    episodes: a.episodes,
  });

  function handleTagToggle(genre: string) {
    setTags((prev) => {
      const next = { ...prev };
      if (!next[genre]) next[genre] = "include";
      else if (next[genre] === "include") next[genre] = "exclude";
      else delete next[genre];
      return next;
    });
  }

  // Every control back to its default (grouping included — browse default is on).
  function resetFilters() {
    setFormat("");
    setSeason("");
    setTimeRange("");
    setStatus("");
    setSort("");
    setTags({});
    setTagMode("OR");
    setGroupFranchise(true);
  }

  // Clear drops the query as well, so it also drops the filters that came
  // with it and returns to the trending/popular landing view.
  function handleClear() {
    resetFilters();
    router.push("/browse");
  }

  // Fetch initial data when the query or any filter changes
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      setPage(1);
      setTrendingPage(1);
      if (query) {
        try {
          const data = await searchAnimeClient(query, 1, 24, filters);
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
  }, [query, filters]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      if (query) {
        const nextPage = page + 1;
        const data = await searchAnimeClient(query, nextPage, 24, filters);
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

  const loadMoreButton = () => (
    <button
      type="button"
      onClick={loadMore}
      disabled={loadingMore}
      className="min-h-[44px] bg-[var(--accent)]/10 border border-[var(--accent)]/30 px-6 py-2.5 text-[var(--accent)] font-mono text-sm uppercase tracking-wider hover:bg-[var(--accent)]/20 disabled:opacity-50 transition-colors rounded-none"
    >
      {loadingMore ? "Loading..." : "Load More"}
    </button>
  );

  let resultsNode: React.ReactNode = null;
  if (loading) {
    resultsNode = <div className="text-center py-12 text-[var(--text-decorative)] font-mono text-sm uppercase tracking-wider">Loading...</div>;
  } else if (error) {
    resultsNode = <div className="text-center py-20"><p className="text-red-400 font-mono text-sm">{error}</p></div>;
  } else if (query) {
    resultsNode = results.length > 0 ? (
      <div>
        <GroupedResults
          items={results}
          groupFranchise={groupFranchise}
          preserveOrder={Boolean(sort)}
          navigatingId={navigatingId}
          onNavigate={setNavigatingId}
        />
        {hasNextPage && (
          <div className="flex justify-center mt-8">{loadMoreButton()}</div>
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
          <SectionHeading title="Trending Now" icon={<FlameIcon className="h-4 w-4 text-[var(--accent)]" />} />
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {trending.map((a) => <AnimeCard key={a.id} anime={toCard(a)} loading={a.id === navigatingId} onClick={() => setNavigatingId(a.id)} />)}
          </div>
          {trendingHasNext && (
            <div className="flex justify-center mt-6">{loadMoreButton()}</div>
          )}
        </div>
        <div>
          <SectionHeading
            title="Most Popular"
            tone="soft"
            icon={<StarIcon className="h-4 w-4 text-[var(--accent)]/70" />}
          />
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
        <SearchHeading title="Browse Anime" query={query} />
        {/* URL-driven GET search: submitting navigates to /browse?q=... */}
        <SearchRow
          action="/browse"
          initialValue={query}
          onClear={query ? handleClear : undefined}
          filters={
            query
              ? {
                  open: showFilters,
                  active: hasActiveFilters,
                  onToggle: () => setShowFilters((prev) => !prev),
                  panelId: FILTER_PANEL_ID,
                }
              : undefined
          }
        >
          {query && (
            <FilterPanel id={FILTER_PANEL_ID} open={showFilters}>
              <FilterSelect
                label="Format"
                value={format}
                onChange={setFormat}
                options={toOptions(FORMATS)}
              />
              <FilterSelect
                label="Season"
                value={season}
                onChange={setSeason}
                options={toOptions(SEASONS)}
              />
              <FilterSelect
                label="Time Range"
                value={timeRange}
                onChange={setTimeRange}
                options={TIME_RANGES}
              />
              <FilterSelect
                label="Sort"
                value={sort}
                onChange={setSort}
                options={SORT_OPTIONS}
                noneLabel="Latest Updates"
              />
              <FilterSelect
                label="Status"
                value={status}
                onChange={setStatus}
                options={toOptions(STATUSES)}
              />
              <GroupingToggle
                active={groupFranchise}
                onClick={() => setGroupFranchise((prev) => !prev)}
              />
              <ResetButton onClick={resetFilters} />
              <TagFilterGrid
                tags={tags}
                onToggle={handleTagToggle}
                mode={tagMode}
                onModeToggle={() => setTagMode((mode) => (mode === "OR" ? "AND" : "OR"))}
              />
            </FilterPanel>
          )}
        </SearchRow>
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

function FlameIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 16.121A3 3 0 1012.015 11L11 14H9c0 .768.293 1.536.879 2.121z" />
    </svg>
  );
}

function StarIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
    </svg>
  );
}
