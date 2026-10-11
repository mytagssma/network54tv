"use client";

// The whole /browse UI (search wiring, filters, grid, live search). It used
// to BE `app/browse/page.tsx`; the route entry is now a server component that
// fetches page 1 for a hard `?q=` load and passes it in as `initialSearch`
// (see that file), while everything below — including the query pipeline
// through `searchAnimeClient` — is unchanged client behaviour.

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { searchAnimeClient, getTrendingClient, getUpcomingClient, type SearchFilters } from "@/lib/anilist";
import { LANDING_PER_PAGE, SEARCH_PER_PAGE, type InitialSearch } from "@/lib/browse";
import type { Anime } from "@/types/anime";
import AnimeCard from "@/components/anime/AnimeCard";
import UpcomingCard from "@/components/anime/UpcomingCard";
import { appendUnique, createPageBuffer, useLastRowFill } from "@/hooks/useLastRowFill";
import { useClearSearch } from "@/hooks/useClearSearch";
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
  type FilterOption,
  type TagMode,
  type TagState,
} from "@/components/search";

const FILTER_PANEL_ID = "browse-filter-panel";

// Region (country of origin) options — value is the AniList CountryCode, the
// label is what the select shows. "Any" (value "") is prepended by FilterSelect.
const REGION_OPTIONS: FilterOption[] = [
  { value: "JP", label: "Japanese" },
  { value: "CN", label: "Chinese" },
  { value: "KR", label: "Korean" },
];

// Page sizes live in @/lib/browse — the server page needs the search page
// size too, and the two must never drift apart (see the note there).

/**
 * Identity of a browse dataset: the query plus the filters it was fetched
 * with. The landing view ignores filters (its three feeds are fixed), so an
 * empty query always maps to the same key — a filter toggle there re-ran an
 * identical fetch before, it now correctly reuses it.
 */
function requestKey(query: string, filters?: SearchFilters): string {
  if (!query) return "landing";
  return filters ? `q:${query}:${JSON.stringify(filters)}` : `q:${query}`;
}

interface BrowseContentProps {
  /**
   * First page of results the SERVER page already fetched for this exact
   * `q` (document requests only — see fetchInitialSearch). It seeds the
   * initial state so the SSR HTML carries the real results or the real
   * empty state instead of a loading box, and the effect below skips the
   * duplicate request. `null` (client navigation, or the server fetch
   * failed) → behaviour is exactly what it was before: fetch on mount.
   */
  initialSearch?: InitialSearch | null;
}

function BrowseContent({ initialSearch = null }: BrowseContentProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const query = searchParams.get("q") || "";

  // SSR seed — only trusted for the query it was fetched for. Whether it is
  // already reflected in `results` is tracked by `resultsKeyRef` below.
  const seeded = Boolean(initialSearch && initialSearch.query === query);

  const [results, setResults] = useState<Anime[]>(() => (seeded ? initialSearch!.media : []));
  const [trending, setTrending] = useState<Anime[]>([]);
  const [popular, setPopular] = useState<Anime[]>([]);
  // Not-yet-released titles (queue#10) — no longer mixed into the default
  // "Latest Updates" search order, they get their own landing section below.
  const [upcoming, setUpcoming] = useState<Anime[]>([]);
  // Seeded search → the data is already here, so first paint is the results
  // (or the empty state), not "Loading...". Landing and unseeded searches
  // keep the old loading-first behaviour (including the landing's own
  // "Loading..." box).
  const [loading, setLoading] = useState(() => !seeded);
  const [error, setError] = useState("");
  const [navigatingId, setNavigatingId] = useState<number | null>(null);
  // Whole-page cursor + pending queue per feed: pages are fetched with the
  // fixed perPage (see @/lib/browse) and released to the grid in row-sized
  // bites, so the last row can always be completed without skipping or
  // duplicating items. The search buffer starts seeded with the server's
  // hasNextPage so Load More / row fill work before any effect has run.
  const [searchBuffer] = useState(() => {
    const buffer = createPageBuffer<Anime>();
    if (seeded) buffer.reset(initialSearch!.hasNextPage);
    return buffer;
  });
  const [trendingBuffer] = useState(() => createPageBuffer<Anime>());
  // Popular is its own landing section with its own Load More, so it needs
  // its own cursor/queue — same helpers, same page arithmetic as above.
  const [popularBuffer] = useState(() => createPageBuffer<Anime>());
  // Upcoming: same again — its own section, its own real pagination
  // (UPCOMING_QUERY pages through AniList, so Load More is not faked).
  const [upcomingBuffer] = useState(() => createPageBuffer<Anime>());
  // Bumped whenever a new query/filter load starts; a "load more" still in
  // flight from the previous search bails out instead of appending stale cards.
  const epochRef = useRef(0);

  // ── Filters ────────────────────────────────────────────────────────────
  // Client state: `?q=` stays purely the query, and any change re-runs the
  // search immediately (initial fetch and load-more both read `filters`).
  // "" = none-selected ("Any"); sort "" = latest-updates order (queue#8).
  const [format, setFormat] = useState("");
  const [season, setSeason] = useState("");
  const [timeRange, setTimeRange] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("");
  const [region, setRegion] = useState("");
  const [tags, setTags] = useState<Record<string, TagState>>({});
  const [tagMode, setTagMode] = useState<TagMode>("OR");
  // Search filter: cluster results into franchises (seasons/prequels/spin-offs
  // together) — on by default; an explicit sort keeps the fetched order.
  const [groupFranchise, setGroupFranchise] = useState(true);
  // The panel sits under the same Filters toggle and starts collapsed — the
  // toolbar stays a single short row on phones; the Filters button (and its
  // aria-expanded/chevron) re-opens the controls in place.
  const [showFilters, setShowFilters] = useState(false);

  // Memoised so the fetch effect only re-runs when a filter actually changes.
  const filters = useMemo<SearchFilters | undefined>(() => {
    const f: SearchFilters = {};
    if (format) f.format = format;
    if (season) f.season = season;
    if (timeRange) f.timeRange = timeRange;
    if (status) f.status = status;
    if (sort) f.sort = sort;
    if (region) f.region = region;
    if (Object.keys(tags).length) {
      const include = Object.keys(tags).filter((k) => tags[k] === "include");
      const exclude = Object.keys(tags).filter((k) => tags[k] === "exclude");
      if (include.length || exclude.length) {
        f.tagFilter = { include, exclude, mode: tagMode };
      }
    }
    return Object.keys(f).length ? f : undefined;
  }, [format, season, timeRange, status, sort, region, tags, tagMode]);

  const hasActiveFilters = Boolean(
    format || season || timeRange || status || sort || region || Object.keys(tags).length
  );

  // Which dataset `results` currently holds — the request key it was fetched
  // with ("" = none yet). An effect run whose key already matches has its
  // data and skips the network. That is what makes the server's SSR seed
  // count as "already fetched" (the HTML ships real results / the real empty
  // state and the mount effect does not repeat the request), and it also
  // keeps React StrictMode's remount from duplicating a completed load.
  // Set only on success, so a failed load still retries on the next run.
  const resultsKeyRef = useRef(seeded ? requestKey(query, filters) : "");

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
    setRegion("");
    setTags({});
    setTagMode("OR");
    setGroupFranchise(true);
  }

  // Clear drops the query as well, so it also drops the filters that came
  // with it and returns to the trending/popular landing view. Fired by the
  // header's ✕ (global) through the clear-search event — the row button that
  // used to live here moved into the header field.
  function handleClear() {
    resetFilters();
    router.push("/browse");
  }
  useClearSearch(handleClear);

  // Fetch initial data when the query or any filter changes
  useEffect(() => {
    let cancelled = false;
    // Queue#11 — as-you-type fires a search per debounced pause, so a slow
    // response for an OLD query can easily land after a NEWER one. Cleanup
    // runs `cancelled = true` first, then aborts: the pending request dies
    // without a network wait, and even if it had already settled the flag
    // keeps every setState below from ever touching stale data.
    const controller = new AbortController();
    async function load() {
      const key = requestKey(query, filters);
      if (resultsKeyRef.current === key) {
        // `results` already IS this dataset — the server-rendered seed (or an
        // earlier load) — so there is nothing to request and no reason to
        // flip back to the loading box. A pending load for a DIFFERENT key
        // was cancelled by this effect's cleanup, so clearing `loading` here
        // can never strand a request in flight.
        setLoading(false);
        setError("");
        return;
      }
      setLoading(true);
      setError("");
      // Any "load more" still in flight belongs to the previous dataset.
      epochRef.current += 1;
      if (query) {
        try {
          const data = await searchAnimeClient(
            query,
            1,
            SEARCH_PER_PAGE,
            filters,
            controller.signal
          );
          if (!cancelled) {
            setResults(data.media);
            searchBuffer.reset(data.hasNextPage);
            resultsKeyRef.current = key;
          }
        } catch {
          // Includes the abort above — never surfaced (see `cancelled`).
          if (!cancelled) setError("Search failed.");
        } finally {
          if (!cancelled) setLoading(false);
        }
      } else {
        // Back on the landing view: drop whatever a previous search fetched,
        // so the stale grid can't flash for a query that left the URL (and
        // can't be shown dimmed under the next search either). The key goes
        // with it — from here until this load lands, `results` matches no
        // request key at all (a cancelled run must not claim landing data).
        resultsKeyRef.current = "";
        setResults([]);
        try {
          const [trendingData, popularData, upcomingData] = await Promise.all([
            getTrendingClient(1, LANDING_PER_PAGE),
            // Use searchAnimeClient with popularity sort for popular (no dedicated getPopularClient)
            searchAnimeClient("", 1, LANDING_PER_PAGE, { sort: "POPULARITY_DESC" }),
            // Not-yet-released anime, soonest premiere first (queue#10).
            // Supplementary section — its failure must never blank the
            // Trending/Popular feed, so it resolves to null instead.
            getUpcomingClient(1, LANDING_PER_PAGE).catch(() => null),
          ]);
          if (!cancelled) {
            setTrending(trendingData.media);
            trendingBuffer.reset(trendingData.hasNextPage);
            setPopular(popularData.media);
            popularBuffer.reset(popularData.hasNextPage);
            if (upcomingData) {
              setUpcoming(upcomingData.media);
              upcomingBuffer.reset(upcomingData.hasNextPage);
            }
            resultsKeyRef.current = key;
          }
        } catch {
          if (!cancelled) setError("Failed to load.");
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [query, filters, searchBuffer, trendingBuffer, popularBuffer, upcomingBuffer]);

  // Hand the grid exactly `need` cards. Cards come out of the pending queue
  // first; only when it runs dry do we pull the next whole AniList page, so the
  // fixed page cursor stays contiguous and no item is ever skipped or shown
  // twice. Returns fewer than `need` only once the source is exhausted.
  async function fetchNeeded(need: number) {
    const epoch = epochRef.current;
    if (query) {
      const items = await searchBuffer.take(
        need,
        (page) => searchAnimeClient(query, page, SEARCH_PER_PAGE, filters),
        () => epochRef.current !== epoch
      );
      if (items.length > 0 && epochRef.current === epoch) {
        setResults((prev) => appendUnique(prev, items));
      }
    } else {
      const items = await trendingBuffer.take(
        need,
        (page) => getTrendingClient(page, LANDING_PER_PAGE),
        () => epochRef.current !== epoch
      );
      if (items.length > 0 && epochRef.current === epoch) {
        setTrending((prev) => appendUnique(prev, items));
      }
    }
  }

  // Popular feed: same buffer/epoch/dedupe contract as the search/trending
  // path above, but it appends to its own section. The page callback keeps
  // the exact landing query ("" + POPULARITY_DESC) so page N+1 continues the
  // same ordering page N was fetched with.
  async function fetchPopularNeeded(need: number) {
    const epoch = epochRef.current;
    const items = await popularBuffer.take(
      need,
      (page) => searchAnimeClient("", page, LANDING_PER_PAGE, { sort: "POPULARITY_DESC" }),
      () => epochRef.current !== epoch
    );
    if (items.length > 0 && epochRef.current === epoch) {
      setPopular((prev) => appendUnique(prev, items));
    }
  }

  // Upcoming feed: same buffer/epoch/dedupe contract as the sections above;
  // page N+1 continues the ascending START_DATE order page N came from.
  async function fetchUpcomingNeeded(need: number) {
    const epoch = epochRef.current;
    const items = await upcomingBuffer.take(
      need,
      (page) => getUpcomingClient(page, LANDING_PER_PAGE),
      () => epochRef.current !== epoch
    );
    if (items.length > 0 && epochRef.current === epoch) {
      setUpcoming((prev) => appendUnique(prev, items));
    }
  }

  // Width-aware fill: measures the last row of the grid(s) and keeps it
  // complete — on Load More, on viewport changes, and after every fetch.
  const { setContainer, loadMore, loadingMore } = useLastRowFill({
    ready: !loading,
    count: query ? results.length : trending.length,
    hasMore: query ? searchBuffer.canFetch() : trendingBuffer.canFetch(),
    fetchNeeded,
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to load more."),
    // Batch size per Load More click: one source page — 24 for search,
    // 12 for the trending landing — so a click lands several rows at once
    // and the fill effect tops up the last row afterwards.
    fallbackNeed: query ? SEARCH_PER_PAGE : LANDING_PER_PAGE,
  });

  // The popular section is a separate grid *below* the trending container, so
  // it gets its own fill engine rather than sharing the one above (which
  // measures only the last `[data-rowfill]` grid inside ITS container). Same
  // helpers, same 12-card batch, its own last-row measurement — and in search
  // mode the section isn't rendered, so `ready` stays false and the container
  // is null: no fetch can fire for a grid nobody is looking at.
  const {
    setContainer: setPopularContainer,
    loadMore: loadMorePopular,
    loadingMore: loadingMorePopular,
  } = useLastRowFill({
    ready: !loading && !query,
    count: popular.length,
    hasMore: popularBuffer.canFetch(),
    fetchNeeded: fetchPopularNeeded,
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to load more."),
    fallbackNeed: LANDING_PER_PAGE,
  });

  // Upcoming: a third, independent fill engine — same landing-only gating as
  // popular (`ready` false in search mode, container unmounted), same 12-card
  // batch, its own last-row measurement over the Upcoming grid.
  const {
    setContainer: setUpcomingContainer,
    loadMore: loadMoreUpcoming,
    loadingMore: loadingMoreUpcoming,
  } = useLastRowFill({
    ready: !loading && !query,
    count: upcoming.length,
    hasMore: upcomingBuffer.canFetch(),
    fetchNeeded: fetchUpcomingNeeded,
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to load more."),
    fallbackNeed: LANDING_PER_PAGE,
  });

  const loadMoreButton = (onClick: () => void, disabled: boolean) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="min-h-[44px] bg-[var(--accent)]/10 border border-[var(--accent)]/30 px-6 py-2.5 text-[var(--accent)] font-mono text-sm uppercase tracking-wider hover:bg-[var(--accent)]/20 disabled:opacity-50 transition-colors rounded-none"
    >
      {disabled ? "Loading..." : "Load More"}
    </button>
  );

  // Queue#11 — search-as-you-type: while a query change is fetching, keep
  // the previous grid visible but dimmed (aria-busy, Load More withheld)
  // instead of swapping in the "Loading..." box. No nodes are inserted or
  // removed, so the page never collapses/reflows on every keystroke pause;
  // `results` itself still holds only results for a search view (the effect
  // above empties it on the way back to the landing view).
  const refreshing = loading && Boolean(query) && results.length > 0;

  let resultsNode: React.ReactNode = null;
  if (loading && !refreshing) {
    resultsNode = <div className="text-center py-12 text-[var(--text-decorative)] font-mono text-sm uppercase tracking-wider">Loading...</div>;
  } else if (error) {
    resultsNode = <div className="text-center py-20"><p className="text-red-400 font-mono text-sm">{error}</p></div>;
  } else if (query) {
    resultsNode = results.length > 0 ? (
      // Container for the fill logic: the last `data-rowfill` grid inside it
      // is the one whose final row is measured against the Load More button.
      // While `loading` this is the STALE grid of the previous query — the
      // fill engine is paused too (`ready: !loading`), and Load More is
      // hidden so a stale-buffer page can never be handed to the new query.
      <div
        ref={setContainer}
        aria-busy={loading}
        className={loading ? "opacity-60" : undefined}
      >
        <GroupedResults
          items={results}
          groupFranchise={groupFranchise}
          preserveOrder={Boolean(sort)}
          navigatingId={navigatingId}
          onNavigate={setNavigatingId}
        />
        {!loading && searchBuffer.canFetch() && (
          <div className="flex justify-center mt-8">{loadMoreButton(loadMore, loadingMore)}</div>
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
        <div className="mb-10" ref={setContainer}>
          <SectionHeading title="Trending Now" icon={<FlameIcon className="h-4 w-4 text-[var(--accent)]" />} />
          <div data-rowfill="" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {trending.map((a) => <AnimeCard key={a.id} anime={toCard(a)} loading={a.id === navigatingId} onClick={() => setNavigatingId(a.id)} />)}
          </div>
          {trendingBuffer.canFetch() && (
            <div className="flex justify-center mt-6">{loadMoreButton(loadMore, loadingMore)}</div>
          )}
        </div>
        <div ref={setPopularContainer}>
          <SectionHeading
            title="Most Popular"
            tone="soft"
            icon={<StarIcon className="h-4 w-4 text-[var(--accent)]/70" />}
          />
          <div data-rowfill="" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {popular.map((a) => <AnimeCard key={a.id} anime={toCard(a)} loading={a.id === navigatingId} onClick={() => setNavigatingId(a.id)} />)}
          </div>
          {/* End of data → the buffer stops reporting `canFetch` and the
              button drops out; the fill engine tops the last row up first. */}
          {popularBuffer.canFetch() && (
            <div className="flex justify-center mt-6">{loadMoreButton(loadMorePopular, loadingMorePopular)}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-8">
        {/* Heading row (heading + Filters) lives in SearchRow. The query
            field and Clear ✕ live in the header (Navbar): the ✕ broadcasts
            and this page runs its full Clear — filters/chips reset plus the
            push to /browse that empties the header field via the URL.
            The field's debounced keystrokes come back through onLiveQuery
            (queue#11): `replace`, never `push`, so a burst of typing adds no
            history entries; the effect above keyed on `query` does the one
            search execution per quiet pause. */}
        <SearchRow
          query={query}
          onLiveQuery={(value) =>
            router.replace(value ? `/browse?q=${encodeURIComponent(value)}` : "/browse")
          }
          heading={
            <SearchHeading
              title="Browse Anime"
              query={query}
              className="truncate"
            />
          }
          filters={{
            open: showFilters,
            active: hasActiveFilters,
            onToggle: () => setShowFilters((prev) => !prev),
            panelId: FILTER_PANEL_ID,
          }}
        >
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
            <FilterSelect
              label="Region"
              value={region}
              onChange={setRegion}
              options={REGION_OPTIONS}
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
        </SearchRow>
      </div>
      {resultsNode}
      {/* // UPCOMING (queue#10) — not-yet-released titles kept out of the
          "Latest Updates" order get their own landing section. Rendered as a
          sibling of `resultsNode` (not inside it) so the heading is already
          in the SSR shell; the grid fills in with the landing fetch. */}
      {!query && !error && (
        <div className="mt-10" ref={setUpcomingContainer}>
          <SectionHeading
            title="Upcoming"
            tone="soft"
            icon={<CalendarIcon className="h-4 w-4 text-[var(--accent)]/70" />}
          />
          {!loading && upcoming.length > 0 && (
            <>
              <div data-rowfill="" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {upcoming.map((a) => (
                  <UpcomingCard
                    key={a.id}
                    anime={a}
                    loading={a.id === navigatingId}
                    onClick={() => setNavigatingId(a.id)}
                  />
                ))}
              </div>
              {/* Real pagination: UPCOMING_QUERY pages through AniList, so the
                  buffer only reports `canFetch` while a next page exists. */}
              {upcomingBuffer.canFetch() && (
                <div className="flex justify-center mt-6">{loadMoreButton(loadMoreUpcoming, loadingMoreUpcoming)}</div>
              )}
            </>
          )}
          {!loading && upcoming.length === 0 && (
            <div className="text-center py-6 text-[var(--text-decorative)] font-mono text-sm">
              No upcoming titles right now.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default BrowseContent;

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

function CalendarIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}
