import type { Anime } from "@/types/anime";

const ANILIST_API = "https://graphql.anilist.co";

const TRENDING_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(sort: TRENDING_DESC, type: ANIME, isAdult: false) {
      id
      title { romaji english native }
      coverImage { large extraLarge color }
      bannerImage
      description
      averageScore
      episodes
      duration
      status
      season
      seasonYear
      format
      genres
      trending
      popularity
      studios { nodes { name } }
      nextAiringEpisode { airingAt episode }
    }
  }
}
`;

const SEARCH_QUERY = `
query ($search: String, $page: Int, $perPage: Int, $format: MediaFormat, $season: MediaSeason, $status: MediaStatus, $status_not: MediaStatus, $genre_in: [String], $genre_not_in: [String], $sort: [MediaSort], $startDate_greater: FuzzyDateInt) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(search: $search, type: ANIME, isAdult: false, format: $format, season: $season, status: $status, status_not: $status_not, genre_in: $genre_in, genre_not_in: $genre_not_in, sort: $sort, startDate_greater: $startDate_greater) {
      id
      title { romaji english native }
      synonyms
      coverImage { large extraLarge color }
      bannerImage
      description
      averageScore
      episodes
      duration
      status
      season
      seasonYear
      format
      genres
      trending
      popularity
      studios { nodes { name } }
    }
  }
}
`;

const DETAIL_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    title { romaji english native }
    coverImage { large extraLarge color }
    bannerImage
    description
    averageScore
    episodes
    duration
    status
    season
    seasonYear
    format
    genres
    trending
    popularity
    studios { nodes { name } }
    nextAiringEpisode { airingAt episode }
    relations {
      edges {
        node { id title { romaji english } coverImage { large } }
        relationType
      }
    }
  }
}
`;

const POPULAR_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(sort: POPULARITY_DESC, type: ANIME, isAdult: false) {
      id
      title { romaji english native }
      coverImage { large extraLarge color }
      bannerImage
      description
      averageScore
      episodes
      duration
      status
      season
      seasonYear
      format
      genres
      trending
      popularity
      studios { nodes { name } }
    }
  }
}
`;

const RECENTLY_AIRED_QUERY = `
query ($airingAt_greater: Int, $airingAt_lesser: Int, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    airingSchedules(
      airingAt_greater: $airingAt_greater
      airingAt_lesser: $airingAt_lesser
      sort: TIME_DESC
    ) {
      airingAt
      episode
      media {
        id
        isAdult
        title { romaji english native }
        coverImage { large extraLarge color }
        bannerImage
        description
        averageScore
        episodes
        duration
        status
        season
        seasonYear
        format
        genres
        trending
        popularity
        studios { nodes { name } }
      }
    }
  }
}
`;

const SEASONAL_QUERY = `
query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(season: $season, seasonYear: $seasonYear, type: ANIME, isAdult: false, sort: POPULARITY_DESC) {
      id
      title { romaji english native }
      coverImage { large extraLarge color }
      bannerImage
      description
      averageScore
      episodes
      duration
      status
      season
      seasonYear
      format
      genres
      trending
      popularity
      studios { nodes { name } }
    }
  }
}
`;

function anilistMediaToAnime(media: any): Anime {
  return {
    id: media.id,
    idMal: media.idMal || undefined,
    title: media.title?.english || media.title?.romaji || "Unknown",
    englishTitle: media.title?.english,
    nativeTitle: media.title?.native,
    coverImage: media.coverImage?.extraLarge || media.coverImage?.large || "",
    bannerImage: media.bannerImage,
    description: media.description
      ?.replace(/<[^>]*>/g, "")
      ?.substring(0, 300),
    score: media.averageScore,
    episodes: media.episodes,
    duration: media.duration,
    status: media.status,
    season: media.season,
    seasonYear: media.seasonYear,
    format: media.format,
    genres: media.genres || [],
    studios: media.studios?.nodes?.map((s: any) => s.name) || [],
    trending: media.trending || 0,
    color: media.coverImage?.color,
  };
}

// ─── Fuzzy title matching (queue#5) ──────────────────────────────────────
// AniList's `search` argument is resolved server-side and is only
// approximate: it happily returns near-misses, misspellings and loosely
// related titles in a fixed order. The helpers below score every fetched
// title (romaji/english/native + synonyms) with a lightweight, dependency
// free subsequence/edit-distance pass so close matches and typos can be
// re-ranked above weaker hits. Nothing leaves the process — no embeddings,
// no external services.

interface SearchableTitle {
  title?: {
    romaji?: string | null;
    english?: string | null;
    native?: string | null;
  } | null;
  synonyms?: (string | null)[] | null;
}

// Characters that separate words in titles (ASCII punctuation + common
// typographic/CJK separators). Anything else is treated as word content so
// non-latin scripts survive normalization.
const TITLE_SEPARATORS = new Set(
  "\u00d7\u00b7\u30fb\u3001\u3002\u300c\u300d\u2010\u2011\u2013\u2014\u2018\u2019\u201c\u201d\uff01\uff08\uff09\uff1a\uff1b\uff1f".split("")
);

function isTitleSeparator(ch: string): boolean {
  if (TITLE_SEPARATORS.has(ch)) return true;
  const code = ch.charCodeAt(0);
  return (
    (code >= 33 && code <= 47) || // !"#$%&'()*+,-./
    (code >= 58 && code <= 64) || // :;<=>?@
    (code >= 91 && code <= 96) || // [\]^_`
    (code >= 123 && code <= 126) // {|}~
  );
}

/** Lowercase, strip accents/punctuation, collapse whitespace. */
function normalizeTitle(value: string): string {
  const decomposed = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  let out = "";
  let pendingSpace = false;
  for (const ch of decomposed) {
    if (isTitleSeparator(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += ch;
  }
  return out;
}

/** Levenshtein distance; strings far apart in length short-circuit to "unrelated". */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const maxLen = Math.max(m, n);
  if (Math.abs(m - n) > maxLen * 0.55) return maxLen;

  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[n];
}

/** Does every character of `query` appear in `text` in order? (abbreviation-style match) */
function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (let j = 0; j < text.length && i < query.length; j++) {
    if (query.charCodeAt(i) === text.charCodeAt(j)) i++;
  }
  return i === query.length;
}

function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const dist = editDistance(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

/** Greedy, order-independent alignment of query words against title words. */
function alignWords(
  queryWords: string[],
  titleWords: string[]
): { matched: number; coverage: number; all: boolean } {
  if (queryWords.length === 0) return { matched: 0, coverage: 0, all: false };
  const used = new Array<boolean>(titleWords.length).fill(false);
  let sum = 0;
  let matched = 0;
  for (const qw of queryWords) {
    let bestIdx = -1;
    let bestSim = 0;
    for (let i = 0; i < titleWords.length; i++) {
      if (used[i]) continue;
      const sim = wordSimilarity(qw, titleWords[i]);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestSim >= 0.72) {
      used[bestIdx] = true;
      matched++;
      sum += bestSim;
    }
  }
  return {
    matched,
    coverage: sum / queryWords.length,
    all: matched === queryWords.length,
  };
}

/** Similarity of one normalized query against one normalized title, in [0, 1]. */
function scoreTitle(queryNorm: string, queryWords: string[], titleNorm: string): number {
  if (!titleNorm) return 0;
  if (titleNorm === queryNorm) return 1;

  const ratio = Math.min(1, queryNorm.length / titleNorm.length);
  let best = 0;

  // Substring containment (with a word-boundary bonus).
  const idx = titleNorm.indexOf(queryNorm);
  if (idx === 0) {
    best = 0.92 + 0.07 * ratio;
  } else if (idx > 0) {
    const boundary = titleNorm.charAt(idx - 1) === " ";
    best = (boundary ? 0.82 : 0.7) + 0.1 * ratio;
  }

  // Word-level match (handles swapped words and per-word typos).
  const words = alignWords(queryWords, titleNorm.split(" "));
  if (words.all) {
    // Every query word is present — but titles that are much longer than the
    // query (a word appearing somewhere inside) rank below near-equal titles.
    best = Math.max(best, 0.62 + 0.2 * words.coverage + 0.14 * ratio);
  } else if (words.matched > 0) {
    best = Math.max(best, 0.4 + 0.35 * words.coverage);
  }

  // Whole-string fuzzy similarity (catches typos across the full query).
  const dist = editDistance(queryNorm, titleNorm);
  const sim = 1 - dist / Math.max(queryNorm.length, titleNorm.length);
  if (sim >= 0.6) best = Math.max(best, 0.55 + 0.35 * sim);

  // Abbreviation / subsequence style matches ("aot" → "attack on titan").
  if (isSubsequence(queryNorm, titleNorm)) {
    best = Math.max(best, 0.55 + 0.35 * ratio);
  }

  return Math.min(best, 1);
}

/** Best score across romaji/english/native titles and synonyms. */
function mediaTitleScore(
  queryNorm: string,
  queryWords: string[],
  media: SearchableTitle
): number {
  const fields = [
    media.title?.romaji,
    media.title?.english,
    media.title?.native,
    ...(media.synonyms || []),
  ];
  let best = 0;
  for (const field of fields) {
    if (!field) continue;
    const normalized = normalizeTitle(field);
    if (!normalized) continue;
    const score = scoreTitle(queryNorm, queryWords, normalized);
    if (score > best) {
      best = score;
      if (best >= 1) break;
    }
  }
  return best;
}

// Match buckets: strong hits (exact/typo'd close matches) surface first,
// then partial matches, then the rest — within each bucket the fetched
// (server-side) order is preserved.
const STRONG_MATCH = 0.85;
const PARTIAL_MATCH = 0.6;

function matchTier(score: number): number {
  if (score >= STRONG_MATCH) return 0;
  if (score >= PARTIAL_MATCH) return 1;
  return 2;
}

/**
 * Re-rank a fetched search page for the default ordering:
 *
 * 1. fuzzy title tiers (queue#5) — close matches/typos surface first, but only
 *    when the user did not pick a sort explicitly;
 * 2. home "Latest Releases" order (queue#8) — most recently aired episode
 *    first (airing TIME_DESC), release season as fallback, ties broken by the
 *    server-side order.
 *
 * Operates strictly within the fetched page, so pagination stays intact.
 */
export async function rankSearchResults(
  fetcher: MediaFetcher,
  rawMedia: any[],
  query: string,
  filters?: SearchFilters
): Promise<any[]> {
  // An explicit user-chosen sort must be reflected exactly — no re-ranking.
  if (filters?.sort) return rawMedia;
  if (rawMedia.length < 2) return rawMedia;

  const trimmed = query.trim();
  const queryNorm = trimmed.length >= 2 ? normalizeTitle(trimmed) : "";
  const queryWords = queryNorm ? queryNorm.split(" ") : [];
  const useFuzzy = queryNorm.length >= 2 && queryWords.length > 0;

  const airedAt = await latestAiredAt(fetcher, rawMedia.map((m: any) => m.id));

  const ranked = rawMedia.map((media, index) => ({
    media,
    index,
    tier: useFuzzy ? matchTier(mediaTitleScore(queryNorm, queryWords, media)) : 0,
    recency: airedAt.get(media.id) ?? releaseSeasonEpoch(media),
  }));
  ranked.sort(
    (a, b) => a.tier - b.tier || b.recency - a.recency || a.index - b.index
  );
  return ranked.map((entry) => entry.media);
}

// ─── Default sort: home page "Latest Releases" order (queue#8) ───────────
//
// The home page renders its "Latest Releases" feed from an airing-schedule
// query sorted with TIME_DESC (see RECENTLY_AIRED_QUERY). AniList's MediaSort
// enum has no TIME_DESC member — TIME_DESC only exists on AiringSort — so the
// default search order reproduces that exact ordering with the same
// `airingSchedules(sort: TIME_DESC)` lookup scoped to the ids on the fetched
// page. Entries without schedule data (old/special titles) fall back to their
// release season, which keeps the "most recently updated first" semantics.
// Any sort the user picks explicitly bypasses all of this.
export const DEFAULT_SEARCH_SORT = "TIME_DESC";

const LATEST_AIRING_QUERY = `
query ($mediaId_in: [Int], $airingAt_lesser: Int, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    airingSchedules(mediaId_in: $mediaId_in, airingAt_lesser: $airingAt_lesser, sort: TIME_DESC) {
      airingAt
      mediaId
    }
  }
}
`;

const SEASON_START_MONTH: Record<string, number> = {
  WINTER: 0,
  SPRING: 3,
  SUMMER: 6,
  FALL: 9,
};

/** Unix seconds for the start of a media's release season (fallback recency key). */
function releaseSeasonEpoch(media: any): number {
  const year = media?.seasonYear;
  if (!year) return 0;
  const month = SEASON_START_MONTH[String(media.season || "").toUpperCase()] ?? 0;
  const epoch = Math.floor(Date.UTC(year, month, 1) / 1000);
  // Never rank a not-yet-aired season above something that already aired today.
  return Math.min(epoch, Math.floor(Date.now() / 1000));
}

/**
 * Most recently aired episode timestamp per media id (TIME_DESC, only
 * episodes that already aired — the same order the home page uses).
 * Falls back to an empty map on failure; callers then order by season.
 */
async function latestAiredAt(
  fetcher: MediaFetcher,
  mediaIds: number[]
): Promise<Map<number, number>> {
  const times = new Map<number, number>();
  if (mediaIds.length === 0) return times;
  try {
    const now = Math.floor(Date.now() / 1000);
    const data = await fetcher(LATEST_AIRING_QUERY, {
      mediaId_in: mediaIds,
      airingAt_lesser: now,
      perPage: 50,
    });
    const schedules = data?.Page?.airingSchedules || [];
    for (const schedule of schedules) {
      if (!schedule || typeof schedule.airingAt !== "number") continue;
      // Sorted TIME_DESC → first sighting of a media is its latest aired episode.
      if (!times.has(schedule.mediaId)) times.set(schedule.mediaId, schedule.airingAt);
    }
  } catch {
    // Airing lookup is an ordering refinement — never fail the search over it.
  }
  return times;
}

// ─── Search pipeline ─────────────────────────────────────────────────────

type MediaFetcher = (query: string, variables: Record<string, any>) => Promise<any>;

// When the server-side search comes back nearly empty (AniList's `search`
// resolves server-side and a typo'd query can return nothing at all), retry
// with the individual query words so the fuzzy re-rank has candidates to
// surface. First page only, capped attempts, best effort — pagination stays
// untouched because later pages are always plain server-side pages.
const FUZZY_POOL_MIN = 6;
const FUZZY_POOL_ATTEMPTS = 2;

async function widenSearchPool(
  fetcher: MediaFetcher,
  variables: Record<string, any>,
  query: string,
  rawMedia: any[]
): Promise<any[]> {
  const words = normalizeTitle(query).split(" ").filter((w) => w.length >= 3);
  if (words.length < 2) return rawMedia;
  // Longest words first — they are the most distinctive part of a query.
  words.sort((a, b) => b.length - a.length);
  const seen = new Set(rawMedia.map((m: any) => m.id));
  for (const word of words.slice(0, FUZZY_POOL_ATTEMPTS)) {
    if (rawMedia.length >= FUZZY_POOL_MIN) break;
    try {
      const data = await fetcher(SEARCH_QUERY, { ...variables, search: word, page: 1 });
      const extra: any[] = data?.Page?.media || [];
      for (const media of extra) {
        if (!media || media.id == null || seen.has(media.id)) continue;
        seen.add(media.id);
        rawMedia.push(media);
      }
    } catch {
      // Widening is a refinement — never fail the search over it.
    }
  }
  return rawMedia;
}

async function executeSearch(
  fetcher: MediaFetcher,
  query: string,
  page: number,
  perPage: number,
  filters?: SearchFilters
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const variables: Record<string, any> = { page, perPage };
  if (query) variables.search = query;
  if (filters?.format) variables.format = filters.format.toUpperCase();
  if (filters?.season) variables.season = filters.season.toUpperCase();
  if (filters?.seasonYear) variables.seasonYear = filters.seasonYear;
  if (filters?.status) variables.status = STATUS_API_MAP[filters.status] || filters.status.toUpperCase();
  if (filters?.status_not) variables.status_not = filters.status_not.toUpperCase();
  if (filters?.genres?.length) variables.genre_in = filters.genres;
  if (filters?.tagFilter) {
    const { include, exclude } = filters.tagFilter;
    if (include.length > 0) variables.genre_in = include;
    if (exclude.length > 0) variables.genre_not_in = exclude;
  }
  if (filters?.sort) {
    // Explicit sort chosen by the user — honoured exactly.
    variables.sort = [filters.sort];
  } else if (!query) {
    // Default ordering (queue#8): no search term means the candidate pool
    // should already be recent releases; ranks are then ordered by the home
    // "Latest Releases" airing TIME_DESC order in rankSearchResults().
    // With a search term we keep AniList's relevance ordering as the pool so
    // fuzzy re-ranking starts from the best matching candidates.
    variables.sort = ["START_DATE_DESC"];
  }
  if (filters?.timeRange) {
    const now = new Date();
    let start = new Date(now);
    switch (filters.timeRange) {
      case 'week': start.setDate(now.getDate() - 7); break;
      case 'month': start.setMonth(now.getMonth() - 1); break;
      case '3months': start.setMonth(now.getMonth() - 3); break;
      case '6months': start.setMonth(now.getMonth() - 6); break;
      case 'year': start.setFullYear(now.getFullYear() - 1); break;
    }
    const y = start.getFullYear();
    const m = start.getMonth() + 1;
    const d = start.getDate();
    variables.startDate_greater = y * 10000 + m * 100 + d;
  }

  const data = await fetcher(SEARCH_QUERY, variables);
  const pageData = data.Page;
  let rawMedia: any[] = pageData.media || [];

  // Sparse first page + a real query → widen the pool so fuzzy matching has
  // something to work with (queue#5).
  if (page === 1 && !filters?.sort && query.trim() && rawMedia.length < FUZZY_POOL_MIN) {
    rawMedia = await widenSearchPool(fetcher, variables, query, rawMedia);
  }

  // Client-side AND mode: keep only media matching ALL included genres
  if (filters?.tagFilter?.mode === "AND" && filters.tagFilter.include.length > 1) {
    const required = new Set(filters.tagFilter.include);
    rawMedia = rawMedia.filter((m: any) => {
      const animeGenres = new Set(m.genres || []);
      return [...required].every((g) => animeGenres.has(g));
    });
  }

  rawMedia = await rankSearchResults(fetcher, rawMedia, query, filters);
  const media = rawMedia.map(anilistMediaToAnime);

  return {
    media,
    hasNextPage: pageData.pageInfo.hasNextPage && media.length > 0,
  };
}

async function fetchGraphQL(query: string, variables: Record<string, any>) {
  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: "https://anilist.co",
      Referer: "https://anilist.co/",
    },
    body: JSON.stringify({ query, variables }),
    next: { revalidate: 300 },
  });
  if (!res.ok) throw new Error(`AniList API error: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message);
  return json.data;
}

export async function getTrending(
  page = 1,
  perPage = 20
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const data = await fetchGraphQL(TRENDING_QUERY, { page, perPage });
  const pageData = data.Page;
  return {
    media: pageData.media.map(anilistMediaToAnime),
    hasNextPage: pageData.pageInfo.hasNextPage,
  };
}

// Map display labels → AniList API enum values
export const STATUS_API_MAP: Record<string, string> = {
  Finished: "FINISHED",
  Releasing: "RELEASING",
  Upcoming: "NOT_YET_RELEASED",
  Cancelled: "CANCELLED",
};

export const GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Fantasy",
  "Horror", "Mecha", "Music", "Mystery", "Psychological",
  "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural",
  "Thriller",
] as const;

export interface TagFilter {
  include: string[];
  exclude: string[];
  mode: "AND" | "OR";
}

export interface SearchFilters {
  format?: string;
  season?: string;
  seasonYear?: number;
  status?: string;
  status_not?: string;
  genres?: string[];
  tagFilter?: TagFilter;
  sort?: string;
  timeRange?: string;
}

export async function searchAnime(
  query: string,
  page = 1,
  perPage = 20,
  filters?: SearchFilters
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  return executeSearch(fetchGraphQL, query, page, perPage, filters);
}

/**
 * Fetch anime with recently aired episodes (by airing schedule), deduplicated.
 * Uses a time window filter to get only episodes that aired within the past N days.
 */
export async function getRecentlyAired(
  daysWindow = 7,
  page = 1,
  perPage = 50
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - daysWindow * 24 * 60 * 60;

  const data = await fetchGraphQL(RECENTLY_AIRED_QUERY, {
    airingAt_greater: windowStart,
    airingAt_lesser: now,
    page,
    perPage,
  });

  const schedules = data.Page.airingSchedules || [];

  // Deduplicate by media ID — keep first (most recently aired) entry per anime
  const seen = new Set<number>();
  const unique: any[] = [];
  for (const s of schedules) {
    if (s?.media?.id && !seen.has(s.media.id) && !s.media.isAdult) {
      seen.add(s.media.id);
      unique.push(s.media);
    }
  }

  return {
    media: unique.map(anilistMediaToAnime),
    hasNextPage: data.Page.pageInfo.hasNextPage,
  };
}

export async function getAnimeById(id: number): Promise<Anime | null> {
  try {
    const data = await fetchGraphQL(DETAIL_QUERY, { id });
    if (!data.Media) return null;
    return anilistMediaToAnime(data.Media);
  } catch {
    return null;
  }
}

export async function getAnimeFull(id: number): Promise<any | null> {
  try {
    const data = await fetchGraphQL(DETAIL_QUERY, { id });
    return data.Media || null;
  } catch {
    return null;
  }
}

export async function getPopular(
  page = 1,
  perPage = 20
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const data = await fetchGraphQL(POPULAR_QUERY, { page, perPage });
  const pageData = data.Page;
  return {
    media: pageData.media.map(anilistMediaToAnime),
    hasNextPage: pageData.pageInfo.hasNextPage,
  };
}

export async function getSeasonal(
  season: string,
  year: number,
  page = 1,
  perPage = 20
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const data = await fetchGraphQL(SEASONAL_QUERY, {
    page,
    perPage,
    season: season.toUpperCase(),
    seasonYear: year,
});
  const pageData = data.Page;
  return {
    media: pageData.media.map(anilistMediaToAnime),
    hasNextPage: pageData.pageInfo.hasNextPage,
  };
}

// ─── Client-side API wrappers (for use in "use client" components) ───────

async function anilistFetch(query: string, variables: Record<string, any>) {
  const res = await fetch("/api/anilist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList API error: ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.data;
}

export async function getRecentlyAiredClient(
  daysWindow = 7,
  page = 1,
  perPage = 50
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - daysWindow * 24 * 60 * 60;

  const data = await anilistFetch(RECENTLY_AIRED_QUERY, {
    airingAt_greater: windowStart,
    airingAt_lesser: now,
    page,
    perPage,
  });

  const schedules = data.Page.airingSchedules || [];

  const seen = new Set<number>();
  const unique: any[] = [];
  for (const s of schedules) {
    if (s?.media?.id && !seen.has(s.media.id) && !s.media.isAdult) {
      seen.add(s.media.id);
      unique.push(s.media);
    }
  }

  return {
    media: unique.map(anilistMediaToAnime),
    hasNextPage: data.Page.pageInfo.hasNextPage,
  };
}

export async function searchAnimeClient(
  query: string,
  page = 1,
  perPage = 20,
  filters?: SearchFilters
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  return executeSearch(anilistFetch, query, page, perPage, filters);
}

export async function getTrendingClient(
  page = 1,
  perPage = 20
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const data = await anilistFetch(TRENDING_QUERY, { page, perPage });
  const pageData = data.Page;
  return {
    media: pageData.media.map(anilistMediaToAnime),
    hasNextPage: pageData.pageInfo.hasNextPage,
  };
}

export async function getAnimeByIdClient(id: number): Promise<Anime | null> {
  try {
    const data = await anilistFetch(DETAIL_QUERY, { id });
    if (!data.Media) return null;
    return anilistMediaToAnime(data.Media);
  } catch {
    return null;
  }
}
