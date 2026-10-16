import type { Anime, AnimeRelation } from "@/types/anime";
// Shared franchise eligibility — the detail row, the watch strip and this
// client-side grouping must agree on what counts as a franchise entry (and
// which edges count as a link). See `src/lib/franchise.ts`.
import { IGNORED_RELATION_TYPES, isFranchiseFormat } from "@/lib/franchise";

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
      meanScore
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
query ($search: String, $page: Int, $perPage: Int, $format: MediaFormat, $season: MediaSeason, $status: MediaStatus, $status_not: MediaStatus, $genre_in: [String], $genre_not_in: [String], $sort: [MediaSort], $startDate_greater: FuzzyDateInt, $countryOfOrigin_in: [CountryCode]) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(search: $search, type: ANIME, isAdult: false, format: $format, season: $season, status: $status, status_not: $status_not, genre_in: $genre_in, genre_not_in: $genre_not_in, sort: $sort, startDate_greater: $startDate_greater, countryOfOrigin_in: $countryOfOrigin_in) {
      id
      title { romaji english native }
      synonyms
      coverImage { large extraLarge color }
      bannerImage
      description
      averageScore
      meanScore
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
      startDate { year month day }
      relations {
        edges {
          node { id }
          relationType
        }
      }
    }
  }
}
`;

/**
 * Every query that feeds `anilistMediaToAnime` — this detail query and the
 * list queries behind the cards (trending/popular/seasonal/recent/search) —
 * selects BOTH score fields: AniList leaves
 * `averageScore` null until it has computed it (brand-new / low-traffic
 * entries) even when votes exist, while `meanScore` is populated — so
 * `anilistMediaToAnime` falls back to `meanScore`. Established titles carry
 * both, equal.
 */
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
    meanScore
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
    startDate { year month day }
    relations {
      edges {
        node { id type format title { romaji english } coverImage { large } }
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
      meanScore
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
        meanScore
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
}
`;

// Upcoming feed (queue#10). `RECENTLY_AIRED_QUERY` gets its "already aired"
// guarantee from the time window alone (`airingAt` between now-window and
// now), but the schedule API has no media-status filter at all (AniList:
// `Unknown argument "status" on field "airingSchedules"`), so it cannot ask
// for "anime that have not started yet" — that has to be a `media` query.
// `status: NOT_YET_RELEASED` alone is not enough either: ~5k entries match
// and most are TBA with a null `startDate`, which AniList sorts AHEAD of
// every real date in both directions, burying the soonest titles.
// `startDate_greater` (same FuzzyDateInt filter SEARCH_QUERY speaks) drops
// the TBA tail server-side; `sort: START_DATE` then yields premiere dates in
// ascending order — soonest-first, page after page (pageInfo.hasNextPage is
// real, so Load More is backed by actual pagination).
const UPCOMING_QUERY = `
query ($page: Int, $perPage: Int, $startDate_greater: FuzzyDateInt) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(status: NOT_YET_RELEASED, type: ANIME, isAdult: false, sort: START_DATE, startDate_greater: $startDate_greater) {
      id
      title { romaji english native }
      coverImage { large extraLarge color }
      bannerImage
      description
      averageScore
      meanScore
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
      startDate { year month day }
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
      meanScore
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
    // Strip AniList HTML only — never truncate: a 300-char cut was slicing
    // synopses mid-word (the detail page clamps + modal handles length).
    description: media.description?.replace(/<[^>]*>/g, ""),
    // averageScore stays null on brand-new / low-traffic entries until AniList
    // has computed it (even with votes in); meanScore is populated there, so
    // fall back to it. Established titles return both, equal.
    score: media.averageScore ?? media.meanScore,
    episodes: media.episodes,
    duration: media.duration,
    status: media.status,
    // Carried through so the card badge can compute released/total (the home
    // and browse card feeds both derive from this mapper).
    nextAiringEpisode: media.nextAiringEpisode ?? undefined,
    season: media.season,
    seasonYear: media.seasonYear,
    format: media.format,
    genres: media.genres || [],
    studios: media.studios?.nodes?.map((s: any) => s.name) || [],
    trending: media.trending || 0,
    color: media.coverImage?.color,
    startDate: media.startDate?.year
      ? media.startDate.year * 10000 +
        (media.startDate.month || 1) * 100 +
        (media.startDate.day || 1)
      : undefined,
    relations: mapRelations(media.relations),
  };
}

/** Flatten `relations.edges` → `{ id, relationType }` for franchise clustering. */
function mapRelations(relations: any): AnimeRelation[] | undefined {
  const edges = relations?.edges;
  if (!Array.isArray(edges) || edges.length === 0) return undefined;
  const mapped: AnimeRelation[] = [];
  for (const edge of edges) {
    const id = edge?.node?.id;
    if (typeof id !== "number") continue;
    mapped.push({ id, relationType: String(edge.relationType || "OTHER").toUpperCase() });
  }
  return mapped.length > 0 ? mapped : undefined;
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

/**
 * Optimal-string-alignment (restricted Damerau-Levenshtein) distance:
 * insertions, deletions, substitutions AND adjacent transpositions each
 * cost 1. The transposition case matters because it is one of the most
 * common human typos and plain Levenshtein prices it at 2 — "peice" for
 * "piece" scored 0.6 and failed the 0.72 word bar, killing the whole
 * "one peice" search. Strings far apart in length short-circuit to
 * "unrelated".
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const maxLen = Math.max(m, n);
  if (Math.abs(m - n) > maxLen * 0.55) return maxLen;

  // OSA needs d[i-2][j-2] for the transpose case — keep three rolling rows.
  let prev2: number[] = [];
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let best = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (
        i > 1 &&
        j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1) &&
        prev2.length === n + 1
      ) {
        best = Math.min(best, prev2[j - 2] + 1);
      }
      cur[j] = best;
    }
    // Rotate: old prev → prev2, cur → prev, recycled buffer → cur.
    const spare = prev2;
    prev2 = prev;
    prev = cur;
    cur = spare.length === n + 1 ? spare : new Array<number>(n + 1);
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
  filters?: SearchFilters,
  signal?: AbortSignal
): Promise<any[]> {
  // An explicit user-chosen sort must be reflected exactly — no re-ranking.
  if (filters?.sort) return rawMedia;
  if (rawMedia.length < 2) return rawMedia;

  const trimmed = query.trim();
  const queryNorm = trimmed.length >= 2 ? normalizeTitle(trimmed) : "";
  const queryWords = queryNorm ? queryNorm.split(" ") : [];
  const useFuzzy = queryNorm.length >= 2 && queryWords.length > 0;

  const airedAt = await latestAiredAt(fetcher, rawMedia.map((m: any) => m.id), signal);

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
  mediaIds: number[],
  signal?: AbortSignal
): Promise<Map<number, number>> {
  const times = new Map<number, number>();
  if (mediaIds.length === 0) return times;
  try {
    const now = Math.floor(Date.now() / 1000);
    const data = await fetcher(LATEST_AIRING_QUERY, {
      mediaId_in: mediaIds,
      airingAt_lesser: now,
      perPage: 50,
    }, signal);
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

// The optional `signal` is the stale-response guard: browse passes the
// AbortSignal of its query effect, and only the PRIMARY search request in
// executeSearch() forwards it — the ranking lookup below is a refinement
// whose results the caller discards anyway (its own `cancelled` flag).
type MediaFetcher = (
  query: string,
  variables: Record<string, any>,
  signal?: AbortSignal
) => Promise<any>;

// ─── Relevance-gated typo tolerance (sparse-page retry) ─────────────────
//
// AniList's `search` resolves strictly server-side and will not correct a
// misspelling itself: "lord of the mystries" → [] and even the lone word
// "mystries" → [] (verified against the API). So the only way to surface the
// intended title for a typo'd phrase is to re-query with parts of it and
// judge the candidates locally.
//
// A first version of that retry (queue#5, "widenSearchPool") appended
// whatever a per-word re-query returned, unranked and ungated: "mystries" →
// [] then "lord" → Overlord rendered under the typed phrase, because
// rankSearchResults() only REORDERS the page — it never filters — so every
// injected title reached the grid. That failure defines the rules below:
//
//   (a) page 1 only, and only without an explicit sort, and only when the
//       primary page came back sparse (< RETRY_POOL_MIN hits, 0 included);
//   (b) retry queries are derived from the typed words — longest (most
//       distinctive) first, at most RETRY_MAX_WORD_QUERIES extra requests,
//       no dictionary, no new network service. A word whose OWN query comes
//       back empty additionally gets glued-run probes (the token with a
//       space inserted at a candidate split — "fatezero" → "fate zero" —
//       see RETRY_SPLIT_MAX / retryGluedProbes below) and trailing-
//       truncation variants (RETRY_TRUNCATE_* / retryTruncationVariants).
//       The retry runs in PARALLEL ROUNDS — words at once, then probes at
//       once (see retrySparseSearch) — so a sparse search costs 3
//       round-trips instead of one per request;
//   (c) the primary page is AniList's own answer for the phrase and is
//       never dropped — the gate only filters RETRY-INJECTED candidates;
//   (d) an injected candidate must pass passesQueryGate(): every significant
//       query word (stop words and <3-char tokens excluded) has to
//       fuzzy-match a DISTINCT word of ONE title string (romaji, english,
//       native or a synonym). "Overlord" is rejected for "lord of the
//       mystries" — it explains neither word ("lord" is only a suffix of
//       "overlord", similarity 0.5) — while "Lord of Mysteries" passes:
//       "lord" is verbatim, "mystries" ≈ "mysteries" at edit distance 1.
//       A query word may also be explained by 2–3 ADJACENT title words
//       concatenated, because users type word runs glued together
//       ("onepunch man" → "One Punch Man", "fatezero" → "Fate/Zero"); the
//       join consumes the whole window so the distinct-word rule still
//       holds, and "lord" still cannot stand for "overlord" (one word, not
//       a run). Word similarity uses Damerau-Levenshtein so an adjacent
//       transposition ("peice"/"piece") costs 1, not 2;
//   (e) candidates failing the gate are discarded outright, and an empty
//       page after gating is still a legitimate empty answer — the browse
//       page renders its empty-results state for it;
//   (f) the whole retry is hard-capped at RETRY_REQUEST_BUDGET upstream
//       requests per sparse search (primary + word retries + variants), and
//       a word query that already returned candidates is never re-tried in
//       variant form. The budget is ALLOCATED before each parallel round is
//       fired, so concurrency can never overshoot the cap;
//   (g) single-token queries skip the WORD round — re-querying the identical
//       string is the primary request (self-query guard) — but they DO get
//       trailing-truncation variants of the typed token, gated like every
//       other injected candidate. That is the lever an equal-length typo
//       needs: "apothicary" retrieves nothing, its variant "apothicar"
//       returns the Apothecary Diaries family, and the gate accepts it.
//       The old widenSearchPool bug — lone word "lord" injecting Overlord —
//       stays prevented: the gate still rejects "lord" vs "overlord"
//       (similarity 0.5, no shared prefix, length delta 4 > 3);
//   (h) the whole retry phase is wall-clock capped (RETRY_DEADLINE_MS):
//       rounds are only fired while under the deadline and in-flight rounds
//       are aborted at it, so upstream rate-limit backoff can never pin the
//       UI (observed: 48s for a sparse search under a warm rate limit).
//
// Why variants exist at all — probed AniList `search` behaviour (graphql
// direct, sort SEARCH_MATCH, and re-probed through /api/anilist):
//
//   correct spelling ............ "apothecary"        → family ✓
//   trailing deletion ........... "apothecar"         → family ✓
//   TRAILING-TRUNCATED TYPO ..... "apothicar"         → family ✓  ← lever used
//                                 "apothica" → ✓, "apothic" → ✓, "apothi" → ✗(0)
//   equal-length substitution ... "apothicary"        → 0 ✗  (never self-corrects)
//   vowel swaps of the typo ..... "epothicary"/"apethicary"/"apothacary" → 0 ✗
//                                 (only the TRUE spelling "apothecary" hits,
//                                 and left-to-right generation would need ~10
//                                 queries to reach it — over budget)
//
// So AniList fuzzy-matches a query token only when it is SHORTER than the
// indexed token (trailing deletion, tolerance ≈ the length difference) and
// only down to ~7 characters; equal-length misspellings and short prefixes
// get nothing. Chosen lever: chop the TYPO'd word from the right (longest
// first, ≥ RETRY_TRUNCATE_MIN_LEN, ≤ RETRY_VARIANT_MAX per word, stop at the
// first non-empty response). Vowel-swap generation was measured and rejected
// (see above) — it costs more budget and retrieves nothing this matcher
// would not already retrieve.

const RETRY_POOL_MIN = 6;
const RETRY_MAX_WORD_QUERIES = 2;
// Primary + word retries + variants, hard cap per sparse search (rule f).
const RETRY_REQUEST_BUDGET = 6;
// Wall-clock cap for the whole retry phase (rule h): upstream rate limits
// stack across the parallel rounds and the hardened /api/anilist fetch
// retries them with backoff, so a sparse search could otherwise pin the UI
// for tens of seconds (observed: 48s for "levi attack on titan" under a
// warm rate limit). Rounds are fired only while under the deadline, and
// in-flight rounds are aborted at it — what arrived by then is kept, the
// rest degrades to the honest empty state.
const RETRY_DEADLINE_MS = 9_000;
// A 1–2 character query still arrives via Enter-submit and hard loads and
// matches a huge swath of AniList — every title containing those letters.
// Left at the full page size it is the cheapest way to hand the grid a large
// page of weak matches (and a large franchise-grouping job) on
// memory-constrained phones. Cap the page for them: the initial grid stays
// small, and Load More / pagination keep the full result set reachable for
// anyone who actually wants it.
const SHORT_QUERY_MAX_PAGE = 12;
// Trailing-truncation variants per zero-return word (rule b).
// Capped at 2: observed truncation wins land within one or two chops
// ("apothicary" → "apothicar", "bleachh" → "bleach"), and the request freed
// here funds the glued-word probes below — the budget (rule f) is shared.
const RETRY_VARIANT_MAX = 2;
// Trailing-truncation variants may go down to 4 chars. AniList stops
// PREFIX-matching below ~7 characters ("apothic" ✓ / "apothi" → 0), but a
// variant that lands exactly on a title word retrieves at ANY length ("bleachh"
// → chop → "bleach" is BLEACH's own word; "aot" retrieves via exact synonym),
// and a short variant that matches nothing simply returns 0 — cost is the
// bounded request, never junk. The 4-char floor just stops pointless 1–3
// character probes.
const RETRY_TRUNCATE_MIN_LEN = 4;
// Glued word runs ("onepunch" for "one punch", "fatezero" for "Fate/Zero")
// cannot be retrieved by their own query or by tail truncation — the missing
// space is in the MIDDLE. The glued probes re-query the token with a space
// inserted at a candidate split ("fatezero" → "fate zero"), which AniList
// resolves as a normal multi-word search; the gate's joined-words rule (d)
// then decides whether the retrieved titles genuinely explain the glued
// word. Split points run ends-then-inward (3, len−3, 4) so the common
// short-first-word pattern ("one punch") is covered first; each side must
// leave at least 3 chars so the probes cannot degenerate into noise.
const RETRY_SPLIT_MAX = 3;
// Retry queries cast a wider net than the caller's page: the gate filters
// EVERY injected candidate, so a wider page only adds rescue surface — the
// intended title for a typo'd phrase often sits just past a 20-cap relevance
// page ("demon" → Demon Slayer buried under common-word noise). 50 is
// AniList's perPage cap.
const RETRY_FETCH_PER_PAGE = 50;

// Words too generic to stand as evidence on their own ("lord OF THE
// mysteries"); they stay in the phrase for whole-string ranking in
// rankSearchResults() but are skipped by the per-word gate. Sub-3-char
// tokens are dropped for the same reason.
const RETRY_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "by", "for", "from", "in", "into",
  "is", "it", "no", "not", "of", "on", "or", "the", "to", "with",
]);

// Same per-word bar alignWords() already uses (1 edit on a 4-char word, 2 on
// a 9-char one), plus a prefix allowance for truncated spellings ("myster" →
// "mysteries"); the 4-char floor stops short tokens from prefix-matching
// half of AniList.
const RETRY_WORD_THRESHOLD = 0.72;
const RETRY_PREFIX_MIN = 4;
// Inflected titles: the ground truth for "apothicary diary" is titled "The
// Apothecary Diaries" and none of its fields carries the singular "diary"
// (probed: romaji is "Kusuriya no Hitorigoto", synonyms are all foreign
// titles), while lev("diary","diaries") = 3 → similarity 0.571 < 0.72, so
// the similarity/prefix rules alone REJECTED the correct answer. The gate
// therefore also accepts a shared stem: ≥4 common leading chars and ≤3 chars
// of length difference ("diary"/"diaries" share "diar"). This is a
// false-negative fix, not a loosening of rule (d): every significant word
// must still be explained by a distinct title word, and "overlord" still
// cannot stand for "lord" (0 shared prefix chars, similarity 0.5, length
// difference 4 > 3) — re-verified by the Overlord regression checks.
const MORPH_COMMON_PREFIX_MIN = 4;
const MORPH_LENGTH_DELTA_MAX = 3;

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Significant query words, longest (most distinctive) first. */
function retryQueryWords(query: string): string[] {
  return normalizeTitle(query)
    .split(" ")
    .filter((word) => word.length >= 3 && !RETRY_STOPWORDS.has(word))
    .sort((a, b) => b.length - a.length);
}

/**
 * One query word standing in for one title word: exact, close, prefix of a
 * longer word, or the same stem with an inflection ("diary" → "diaries").
 */
function retryWordMatches(queryWord: string, titleWord: string): boolean {
  if (queryWord === titleWord) return true;
  if (wordSimilarity(queryWord, titleWord) >= RETRY_WORD_THRESHOLD) return true;
  const minLen = Math.min(queryWord.length, titleWord.length);
  if (
    minLen >= RETRY_PREFIX_MIN &&
    (titleWord.startsWith(queryWord) || queryWord.startsWith(titleWord))
  ) {
    return true;
  }
  const delta = Math.abs(queryWord.length - titleWord.length);
  return (
    delta > 0 &&
    delta <= MORPH_LENGTH_DELTA_MAX &&
    commonPrefixLength(queryWord, titleWord) >= MORPH_COMMON_PREFIX_MIN
  );
}

/**
 * Gate rule (d): can the FULL typed phrase be explained by ONE title string?
 * Every significant query word must match a distinct word of the same field,
 * so a candidate that only accounts for one word of a longer phrase fails.
 */
function passesQueryGate(query: string, media: SearchableTitle): boolean {
  const queryWords = retryQueryWords(query);
  // A phrase of only stop/short words has nothing to prove — the gate stays
  // open and AniList's primary answer is used untouched.
  if (queryWords.length === 0) return true;
  const fields = [
    media.title?.romaji,
    media.title?.english,
    media.title?.native,
    ...(media.synonyms || []),
  ];
  for (const field of fields) {
    if (!field) continue;
    const titleWords = normalizeTitle(field).split(" ").filter(Boolean);
    if (titleWords.length < queryWords.length) continue;
    const used = new Set<number>();
    let covered = 0;
    for (const queryWord of queryWords) {
      const idx = titleWords.findIndex(
        (titleWord, i) => !used.has(i) && retryWordMatches(queryWord, titleWord)
      );
      if (idx !== -1) {
        used.add(idx);
        covered++;
        continue;
      }
      // Joined-words match: users type word runs glued together ("onepunch
      // man" for "One Punch Man", "fatezero" for "Fate/Zero"). A query word
      // may also be explained by 2–3 ADJACENT unused title words
      // concatenated — the join consumes the whole window, so the
      // distinct-word rule still holds and "lord" still cannot stand for
      // "overlord" (that is one word, not a run).
      let matchedRun = 0;
      for (const runLen of [2, 3]) {
        for (let i = 0; i + runLen <= titleWords.length; i++) {
          let windowFree = true;
          for (let k = 0; k < runLen; k++) {
            if (used.has(i + k)) {
              windowFree = false;
              break;
            }
          }
          if (!windowFree) continue;
          const joined = titleWords.slice(i, i + runLen).join("");
          if (!retryWordMatches(queryWord, joined)) continue;
          for (let k = 0; k < runLen; k++) used.add(i + k);
          matchedRun = runLen;
          break;
        }
        if (matchedRun) break;
      }
      if (!matchedRun) break;
      covered++;
    }
    if (covered === queryWords.length) return true;
  }
  return false;
}

// GraphQL media rows arrive as untyped JSON; the retry only ever touches the
// pieces the gate needs — the id (dedupe) and the title fields (see
// SearchableTitle).
type RawSearchMedia = SearchableTitle & { id: number };

/**
 * Trailing-truncation variants of a zero-return word, longest first — the
 * lever the probed AniList behaviour actually rewards (a query token that is
 * SHORTER than the indexed token still matches: "apothicar" → the
 * Apothecary Diaries family, while the equal-length misspelling "apothicary"
 * → 0). Cut from the right down to RETRY_TRUNCATE_MIN_LEN, at most
 * RETRY_VARIANT_MAX of them.
 */
function retryTruncationVariants(word: string): string[] {
  const variants: string[] = [];
  for (
    let length = word.length - 1;
    length >= RETRY_TRUNCATE_MIN_LEN && variants.length < RETRY_VARIANT_MAX;
    length--
  ) {
    variants.push(word.slice(0, length));
  }
  return variants;
}

/**
 * Glued-run probes for a zero-return word: the token with a space inserted
 * at each candidate split, ends-then-inward. Each side must leave at least
 * 3 chars; at most RETRY_SPLIT_MAX probes.
 */
function retryGluedProbes(word: string): string[] {
  const len = word.length;
  const minSplit = 3;
  if (len < minSplit * 2) return [];
  const splits = [minSplit, len - minSplit, 4];
  const probes: string[] = [];
  const seen = new Set<string>();
  for (const s of splits) {
    if (s < minSplit || s > len - minSplit) continue;
    const probe = `${word.slice(0, s)} ${word.slice(s)}`;
    if (seen.has(probe)) continue;
    seen.add(probe);
    probes.push(probe);
    if (probes.length >= RETRY_SPLIT_MAX) break;
  }
  return probes;
}

/**
 * Rules (b)/(f): fetch candidates from the typed words themselves (reusing
 * the primary request's filters, so the retry obeys the same
 * genre/status/region constraints), extend zero-return words with truncation
 * variants, and keep only what clears the gate. Hard-capped at
 * RETRY_REQUEST_BUDGET upstream requests including the primary.
 *
 * Latency shape — the retry runs in PARALLEL ROUNDS, so a sparse search
 * costs three round-trips no matter how many upstream requests it spends
 * (the sequential schedule before this pass cost one round-trip per request,
 * up to six):
 *
 *   round 1   the primary phrase               (already spent by the caller)
 *   round 2   every significant word at once   (Promise.allSettled)
 *   round 3   truncation variants of the words that came back empty, at once
 *
 * The budget is allocated BEFORE each round is fired (rule f), so the
 * concurrency can never overshoot it: variants are split across zero-return
 * words longest-word-first (base share, then leftovers). Per word the
 * LONGEST non-empty variant result wins — the same winner the sequential
 * stop-at-first chain picked, just fetched concurrently. Injection stays in
 * word order (longest first) and rankSearchResults() re-sorts afterwards,
 * so the result list is identical to the sequential schedule's.
 */
async function retrySparseSearch(
  fetcher: MediaFetcher,
  variables: Record<string, unknown>,
  query: string,
  primaryMedia: RawSearchMedia[],
  signal?: AbortSignal
): Promise<RawSearchMedia[]> {
  const queryNorm = normalizeTitle(query).trim();
  const allWords = retryQueryWords(query);
  // Rule (g), revised: a single-significant-token query must not re-query
  // itself (that IS the primary request), but its trailing-truncation
  // variants are exactly the lever an equal-length typo needs — "apothicary"
  // retrieves nothing, its variant "apothicar" returns the Apothecary
  // Diaries family, and the gate accepts it (similarity 0.818 ≥ 0.72). So
  // single tokens skip the word round and go straight to variants.
  const selfQuery = allWords.length === 1 && allWords[0] === queryNorm;
  const words = selfQuery ? [] : allWords.slice(0, RETRY_MAX_WORD_QUERIES);
  // The primary search already spent one request of the budget (rule f).
  let remaining = RETRY_REQUEST_BUDGET - 1;
  if ((words.length === 0 && !selfQuery) || remaining <= 0) return primaryMedia;

  const seen = new Set(primaryMedia.map((m) => m.id));
  const injected: RawSearchMedia[] = [];
  const poolSize = () => primaryMedia.length + injected.length;
  // Rule (h): wall-clock deadline for the whole retry phase.
  const startedAt = Date.now();
  /** The caller's abort merged with the retry-phase deadline. */
  const deadlineSignal = (): AbortSignal => {
    const left = Math.max(1, RETRY_DEADLINE_MS - (Date.now() - startedAt));
    const timeout = AbortSignal.timeout(left);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };
  /** One upstream page-1 search; a failed re-query degrades to no candidates. */
  const fetchCandidates = async (search: string): Promise<RawSearchMedia[]> => {
    try {
      // The signal travels into every retry round too, so a query
      // that was superseded mid-retry dies at the network instead of leaving
      // the parallel rounds running behind it.
      const data = await fetcher(
        SEARCH_QUERY,
        { ...variables, search, page: 1, perPage: RETRY_FETCH_PER_PAGE },
        deadlineSignal()
      );
      return data?.Page?.media || [];
    } catch {
      // The retry is a refinement — a failed re-query never fails the search.
      // An aborted round degrades to "no candidates", exactly like a failure.
      return [];
    }
  };
  /** One round: settle every request at once, input order preserved. */
  const runRound = async (searches: string[]): Promise<RawSearchMedia[][]> => {
    const settled = await Promise.allSettled(searches.map(fetchCandidates));
    return settled.map((result) => (result.status === "fulfilled" ? result.value : []));
  };
  const inject = (candidates: RawSearchMedia[]) => {
    for (const media of candidates) {
      if (!media || media.id == null || seen.has(media.id)) continue;
      seen.add(media.id);
      // Rules (d)/(e): gate every injected title against the FULL phrase.
      if (passesQueryGate(query, media)) injected.push(media);
    }
  };

  if (poolSize() >= RETRY_POOL_MIN) return [...primaryMedia, ...injected];
  if (Date.now() - startedAt >= RETRY_DEADLINE_MS) return [...primaryMedia, ...injected];

  // Round 2 — every significant word at once (longest word first).
  const activeWords = words.slice(0, Math.min(words.length, remaining));
  remaining -= activeWords.length;
  const wordResults = await runRound(activeWords);
  const zeroWords: string[] = [];
  // Single-token queries have no word round — their variant plan is built
  // from the typed token itself (rule g, revised).
  if (selfQuery) zeroWords.push(queryNorm);
  wordResults.forEach((candidates, i) => {
    if (candidates.length > 0) inject(candidates);
    else zeroWords.push(activeWords[i]);
  });

  // Round 3 — glued-run probes AND truncation variants of the zero-return
  // words, all at once (rule b, evidence in the note above). Glued probes
  // come first inside each word's plan: they are the only retrieval that
  // can surface a mid-word space, and the shared budget is too small to
  // reach them behind a full truncation plan. Budget split across the
  // zero-return words, longest word first, so parallelism still cannot
  // exceed rule (f).
  const plans = zeroWords.map((word) => {
    const seenProbe = new Set<string>();
    const plan: string[] = [];
    for (const probe of [...retryGluedProbes(word), ...retryTruncationVariants(word)]) {
      if (seenProbe.has(probe)) continue;
      seenProbe.add(probe);
      plan.push(probe);
    }
    return plan;
  });
  let variantBudget = remaining;
  const variantSearches: string[] = [];
  const variantOwners: string[] = []; // parallel to variantSearches
  for (let i = 0; i < plans.length && variantBudget > 0; i++) {
    const share = Math.ceil(variantBudget / (plans.length - i));
    const take = Math.min(plans[i].length, share);
    for (const variant of plans[i].slice(0, take)) {
      variantSearches.push(variant);
      variantOwners.push(zeroWords[i]);
    }
    variantBudget -= take;
  }
  remaining -= variantSearches.length;

  if (
    variantSearches.length > 0 &&
    poolSize() < RETRY_POOL_MIN &&
    Date.now() - startedAt < RETRY_DEADLINE_MS
  ) {
    const variantResults = await runRound(variantSearches);
    // Plans are longest-first, so the first non-empty hit per word is the
    // longest (most faithful) variant — inject that one only.
    const pickedWords = new Set<string>();
    for (let i = 0; i < variantSearches.length; i++) {
      if (variantResults[i].length === 0) continue;
      if (pickedWords.has(variantOwners[i])) continue;
      pickedWords.add(variantOwners[i]);
      inject(variantResults[i]);
    }
  }

  return [...primaryMedia, ...injected];
}

async function executeSearch(
  fetcher: MediaFetcher,
  query: string,
  page: number,
  perPage: number,
  filters?: SearchFilters,
  signal?: AbortSignal
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  // Short-query cap (see SHORT_QUERY_MAX_PAGE): broad 1–2 character searches
  // fetch a smaller page so the initial grid and its franchise grouping stay
  // cheap on phones. Pagination keeps the same page size, so the buffer's
  // page arithmetic stays aligned.
  const effectivePerPage =
    query.trim().length <= 2 ? Math.min(perPage, SHORT_QUERY_MAX_PAGE) : perPage;
  const variables: Record<string, any> = { page, perPage: effectivePerPage };
  if (query) variables.search = query;
  // Queue#10 — with no explicit sort the order is the "Latest Updates" feed
  // (the Sort select's none-label), so it must never surface titles that have
  // not premiered yet: AniList's `search` happily returns them and the season
  // fallback in rankSearchResults() ranks a future season at the top (it is
  // clamped to "now"). Status = Upcoming asks for those titles explicitly and
  // must not be contradicted by `status_not`; an explicit sort is a different
  // feed (e.g. the landing "Most Popular") and is left alone. Upcoming titles
  // remain reachable through the Status filter and the browse Upcoming
  // section — see UPCOMING_QUERY.
  const statusFilter = (filters?.status || "").toUpperCase();
  const wantsUpcoming = statusFilter === "UPCOMING" || statusFilter === "NOT_YET_RELEASED";
  if (!filters?.sort && !wantsUpcoming) {
    variables.status_not = "NOT_YET_RELEASED";
  }
  if (filters?.format) variables.format = filters.format.toUpperCase();
  if (filters?.season) variables.season = filters.season.toUpperCase();
  if (filters?.seasonYear) variables.seasonYear = filters.seasonYear;
  if (filters?.status) variables.status = STATUS_API_MAP[filters.status] || filters.status.toUpperCase();
  if (filters?.status_not) variables.status_not = filters.status_not.toUpperCase();
  // Region (country of origin): "JP" | "CN" | "KR" → CountryCode list. Left
  // unset entirely when the default "Any" is selected, so no filter is sent.
  if (filters?.region) variables.countryOfOrigin_in = [filters.region.toUpperCase()];
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

  // Primary search request — the only one carrying the caller's signal, so a
  // query that gets superseded (new submit, filter change, clear) dies at
  // the network instead of racing its replacement back to the component.
  const data = await fetcher(SEARCH_QUERY, variables, signal);
  const pageData = data.Page;
  // The primary page is AniList's own answer for the typed phrase and is used
  // exactly as returned. A sparse page 1 additionally triggers the
  // relevance-gated typo retry below (rules a–g in the note above): only
  // retry-injected candidates are gated, primary results never are, and an
  // empty page stays empty all the way to the browse empty-results state.
  let rawMedia: any[] = pageData.media || [];
  if (page === 1 && !filters?.sort && query.trim() && rawMedia.length < RETRY_POOL_MIN) {
    rawMedia = await retrySparseSearch(fetcher, variables, query, rawMedia, signal);
  }

  // Client-side AND mode: keep only media matching ALL included genres
  if (filters?.tagFilter?.mode === "AND" && filters.tagFilter.include.length > 1) {
    const required = new Set(filters.tagFilter.include);
    rawMedia = rawMedia.filter((m: any) => {
      const animeGenres = new Set(m.genres || []);
      return [...required].every((g) => animeGenres.has(g));
    });
  }

  rawMedia = await rankSearchResults(fetcher, rawMedia, query, filters, signal);
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
  "Action", "Adventure", "Comedy", "Drama", "Ecchi",
  "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music",
  "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life",
  "Sports", "Supernatural", "Thriller",
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
  /** Country of origin — AniList CountryCode ("JP" | "CN" | "KR"). Unset = Any. */
  region?: string;
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
 * The airing-feed time window, bucketed to a 15-minute grid.
 *
 * `Date.now()` in the query VARIABLES churned the client GET URL
 * (`/api/anilist?payload={…airingAt_greater…}`) every single second, so the
 * L1 in-process Map and the CDN's `s-maxage` could never key two home loads
 * together — every load paid the full AniList round trip (log: consecutive
 * 677–1220ms GETs whose airingAt differed by exactly 1s). Flooring BOTH
 * bounds to the same grid keeps the window LENGTH byte-identical
 * (`lesser - greater === daysWindow * 86400`, a multiple of 900s) while the
 * URL only changes twice an hour, which is what makes the cache reachable.
 *
 * Trade-off: episodes that aired within the current bucket are excluded until
 * the grid flips — at most 15 minutes of schedule lag on a 30-day window.
 */
const AIRING_FEED_GRID_SEC = 15 * 60;

function recentlyAiredWindow(daysWindow: number): {
  airingAt_greater: number;
  airingAt_lesser: number;
} {
  const nowBucket = Math.floor(Math.floor(Date.now() / 1000) / AIRING_FEED_GRID_SEC) * AIRING_FEED_GRID_SEC;
  return {
    airingAt_greater: nowBucket - daysWindow * 24 * 60 * 60,
    airingAt_lesser: nowBucket,
  };
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
  const { airingAt_greater, airingAt_lesser } = recentlyAiredWindow(daysWindow);

  const data = await fetchGraphQL(RECENTLY_AIRED_QUERY, {
    airingAt_greater,
    airingAt_lesser,
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

// ─── Upcoming feed (queue#10) ─────────────────────────────────────────────
//
// AniList has no sort by air date (MediaSort only orders by `startDate`), so
// "soonest-first" means ascending premiere date. The lower bound is computed
// per call — "yesterday" — so premieres *today* stay in the section until
// they actually air (the filter is a strict `>`), while every TBA entry with
// a null startDate is dropped server-side (AniList sorts those ahead of all
// real dates). Titles whose listed premiere already passed but that are
// still NOT_YET_RELEASED (delayed productions) fall out of both feeds — they
// are reachable through the browse Status = Upcoming filter.
function fuzzyDateDaysAgo(days: number): number {
  const shifted = new Date(Date.now() - days * 86_400_000);
  return (
    shifted.getUTCFullYear() * 10000 +
    (shifted.getUTCMonth() + 1) * 100 +
    shifted.getUTCDate()
  );
}

/**
 * Not-yet-released anime with a known premiere date, soonest first — the
 * data behind the browse page's `// UPCOMING` section.
 */
export async function getUpcoming(
  page = 1,
  perPage = 12
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const data = await fetchGraphQL(UPCOMING_QUERY, {
    page,
    perPage,
    startDate_greater: fuzzyDateDaysAgo(1),
  });
  const pageData = data.Page;
  return {
    media: pageData.media.map(anilistMediaToAnime),
    hasNextPage: pageData.pageInfo.hasNextPage,
  };
}

// ─── Client-side API wrappers (for use in "use client" components) ───────

async function anilistFetch(
  query: string,
  variables: Record<string, any>,
  signal?: AbortSignal
) {
  // GET (not POST) so the response is a normal cacheable request: Vercel's
  // edge honours the route's s-maxage and serves repeats without a
  // serverless invocation — the whole point of the CDN layer (a cold
  // lambda's in-memory Map starts empty). Aborted requests simply never
  // read the response; they cannot poison the cache.
  const payload = encodeURIComponent(JSON.stringify({ query, variables }));
  const res = await fetch(`/api/anilist?payload=${payload}`, {
    // AbortSignal — present on search calls so a superseded query dies at
    // the network; undefined for callers that never pass one.
    signal,
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
  const { airingAt_greater, airingAt_lesser } = recentlyAiredWindow(daysWindow);

  const data = await anilistFetch(RECENTLY_AIRED_QUERY, {
    airingAt_greater,
    airingAt_lesser,
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
  filters?: SearchFilters,
  /** Aborts the primary request when a newer query takes over. */
  signal?: AbortSignal
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  return executeSearch(anilistFetch, query, page, perPage, filters, signal);
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

/** Client twin of {@link getUpcoming} — same query, same soonest-first order. */
export async function getUpcomingClient(
  page = 1,
  perPage = 12
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const data = await anilistFetch(UPCOMING_QUERY, {
    page,
    perPage,
    startDate_greater: fuzzyDateDaysAgo(1),
  });
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

// ─── Franchise grouping (queue:seasons) ────────────────────────────────────────
//
// The old toggle bucketed results by BROADCAST season ("Fall 2024"), which
// scatters a franchise across buckets: Naruto (2002), Shippuden (2007) and
// Boruto (2017) never showed up together. This pass clusters results into
// FRANCHISES instead: union-find over the AniList `relations` edges whose
// target is also present in the fetched result set (so manga/SOURCE targets
// drop out automatically — results are `type: ANIME` only). Membership and
// edge rules are the shared ones from `src/lib/franchise.ts`: only TV /
// TV_SHORT / MOVIE / SPECIAL / OVA / ONA entries join a group (MUSIC never
// does — it would surface a PV inside a season run), and CHARACTER/PREVIEW
// edges never link anything, so grouping agrees with the detail row and the
// watch strip. Inside a cluster the PREQUEL→SEQUEL chain is walked from the
// earliest `startDate` to derive "Season 1/2/3…" numbers, prequels become
// "Prequel" and everything else (ONA/OVA/side-stories) keeps its format as a
// label. Fully client-side and dependency-free; recomputed from the
// accumulated result list on every render, so "Load More" re-buckets
// incrementally.

export interface SeasonGroup {
  /** Franchise title (cluster root) or the lone title for a standalone result. */
  label: string;
  /** Members ordered main-season-first (chronological when not preserving an explicit sort). */
  items: Anime[];
  /** Compact "S1–S3 · Prequel · OVA" summary rendered next to the title count. */
  detail?: string;
}

export interface FranchiseGroupOptions {
  /**
   * Keep the fetched order inside every group. Used when the user picked an
   * explicit sort — that ordering must be honoured exactly. With the default
   * ordering, items are sorted by franchise season (then air date) instead.
   */
  preserveOrder?: boolean;
}

/** Formats that can be a genuine new TV season of the same source material. */
const TV_ONLY_FORMATS = new Set(["TV"]);
/** Links that mean "alternate take / extra", not "next season". */
const NON_SEASON_RELATIONS = new Set([
  "ALTERNATIVE",
  "SIDE_STORY",
  "SPIN_OFF",
  "SUMMARY",
  "CONTAINS",
  "CHARACTER",
  "OTHER",
]);

/** YYYYMMDD sort key; falls back to the season year, then sorts last. */
function startDateKey(anime: Anime): number {
  if (typeof anime.startDate === "number" && anime.startDate > 0) return anime.startDate;
  if (anime.seasonYear) return anime.seasonYear * 10000;
  return Number.MAX_SAFE_INTEGER;
}

/** "MOVIE" → "Movie", "OVA"/"ONA"/"TV" kept as-is … used in the detail summary. */
function formatLabel(anime: Anime): string {
  const raw = String(anime.format || "").toUpperCase();
  if (!raw) return "Other";
  if (raw === "OVA" || raw === "ONA" || raw === "TV") return raw;
  if (raw === "MOVIE") return "Movie";
  if (raw === "TV_SHORT") return "TV Short";
  if (raw === "SPECIAL") return "Special";
  if (raw === "MUSIC") return "Music";
  return raw.charAt(0) + raw.slice(1).toLowerCase();
}

/**
 * Union-find over `relations` edges whose target id is in the result set.
 * Clusters keep first-appearance order, so group order follows the fetched
 * ordering (latest-updates, fuzzy tiers or an explicit sort).
 *
 * Eligibility mirrors the franchise resolver exactly: an entry only joins a
 * cluster when its format is one of TV / TV_SHORT / MOVIE / SPECIAL / OVA /
 * ONA (so a MUSIC PV never rides along with the show it soundtracks — it
 * stays a standalone result), and only non-ignored edges count (no
 * CHARACTER / PREVIEW links).
 */
function clusterByFranchise(items: Anime[]): Anime[][] {
  const indexOf = new Map<number, number>();
  items.forEach((item, i) => {
    if (typeof item.id === "number" && !indexOf.has(item.id)) indexOf.set(item.id, i);
  });

  const parent = items.map((_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== x) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Keep the earliest result index as root → clusters follow first appearance.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  items.forEach((item, i) => {
    // Ineligible format → never a franchise member (checked from both ends,
    // since either side of an edge could be the PV / CD entry).
    if (!isFranchiseFormat(item.format)) return;
    for (const rel of item.relations || []) {
      if (typeof rel?.id !== "number" || rel.id === item.id) continue;
      if (IGNORED_RELATION_TYPES.has(String(rel.relationType || "").toUpperCase())) continue;
      const j = indexOf.get(rel.id);
      if (j === undefined || j === i) continue;
      if (!isFranchiseFormat(items[j].format)) continue;
      union(i, j);
    }
  });

  const groups = new Map<number, Anime[]>();
  const roots: number[] = [];
  items.forEach((item, i) => {
    const root = find(i);
    let bucket = groups.get(root);
    if (!bucket) {
      bucket = [];
      groups.set(root, bucket);
      roots.push(root);
    }
    bucket.push(item);
  });
  return roots.map((root) => groups.get(root)!);
}

/** Pair key that is stable regardless of argument order. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

interface FranchiseChain {
  /** child id → ids of its in-cluster prequels (edge direction normalised). */
  prequelsOf: Map<number, Set<number>>;
  /** parent id → ids of its in-cluster sequels. */
  sequelsOf: Map<number, Set<number>>;
  /** season number per id, anchored at the cluster's earliest startDate. */
  seasonOf: Map<number, number>;
}

function buildSeasonChain(members: Anime[]): FranchiseChain {
  const idSet = new Set<number>();
  for (const m of members) idSet.add(m.id);
  const byId = new Map<number, Anime>();
  for (const m of members) byId.set(m.id, m);

  const prequelsOf = new Map<number, Set<number>>();
  const addPrequel = (child: number, parent: number) => {
    if (child === parent || !idSet.has(child) || !idSet.has(parent)) return;
    let set = prequelsOf.get(child);
    if (!set) prequelsOf.set(child, (set = new Set()));
    set.add(parent);
  };

  // Same-source material shared by two anime (AniList points anime → manga
  // with ADAPTATION/SOURCE; those ids are never part of an ANIME result set).
  const sourcesOf = new Map<number, Set<number>>();
  // Direct anime ↔ anime links seen between two in-cluster members.
  const directLinks = new Map<string, Set<string>>();

  for (const m of members) {
    for (const rel of m.relations || []) {
      if (typeof rel?.id !== "number" || rel.id === m.id) continue;
      const type = String(rel.relationType || "").toUpperCase();

      if (type === "ADAPTATION" || type === "SOURCE") {
        if (!idSet.has(rel.id)) {
          // Source material (manga/novel) — remember for season chaining.
          let set = sourcesOf.get(m.id);
          if (!set) sourcesOf.set(m.id, (set = new Set()));
          set.add(rel.id);
          continue;
        }
        // Anime → anime ADAPTATION: fall through and record it as a link.
      }

      if (!idSet.has(rel.id)) continue;

      if (type === "PREQUEL") addPrequel(m.id, rel.id); // rel.id precedes m
      else if (type === "SEQUEL") addPrequel(rel.id, m.id); // m precedes rel.id

      const key = pairKey(m.id, rel.id);
      let types = directLinks.get(key);
      if (!types) directLinks.set(key, (types = new Set()));
      types.add(type);
    }
  }

  // "Genuinely a new TV season" fallback: two TV anime adapting the same
  // source material with no explicit season edge between them (and not marked
  // as an alternative/remake) chain in air-date order.
  const sourceCarrier = new Map<number, number[]>(); // source id → member ids
  for (const [id, sources] of sourcesOf) {
    for (const source of sources) {
      let carriers = sourceCarrier.get(source);
      if (!carriers) sourceCarrier.set(source, (carriers = []));
      carriers.push(id);
    }
  }
  const considered = new Set<string>();
  for (const carriers of sourceCarrier.values()) {
    for (let a = 0; a < carriers.length; a++) {
      for (let b = a + 1; b < carriers.length; b++) {
        const idA = carriers[a];
        const idB = carriers[b];
        const key = pairKey(idA, idB);
        if (considered.has(key)) continue;
        considered.add(key);
        const animeA = byId.get(idA);
        const animeB = byId.get(idB);
        if (!animeA || !animeB) continue;
        if (!TV_ONLY_FORMATS.has(String(animeA.format || "").toUpperCase())) continue;
        if (!TV_ONLY_FORMATS.has(String(animeB.format || "").toUpperCase())) continue;
        const types = directLinks.get(key);
        if (types) {
          // An explicit season edge already ordered them (or refuses to).
          let skip = false;
          for (const type of types) {
            if (type === "PREQUEL" || type === "SEQUEL" || type === "ADAPTATION") continue;
            skip = true; // ALTERNATIVE / SIDE_STORY / OTHER … not a new season
          }
          if (skip || types.has("PREQUEL") || types.has("SEQUEL")) continue;
        }
        const [early, late] =
          startDateKey(animeA) <= startDateKey(animeB) ? [idA, idB] : [idB, idA];
        addPrequel(late, early);
      }
    }
  }

  const sequelsOf = new Map<number, Set<number>>();
  for (const [child, parents] of prequelsOf) {
    for (const parent of parents) {
      let set = sequelsOf.get(parent);
      if (!set) sequelsOf.set(parent, (set = new Set()));
      set.add(child);
    }
  }

  // Season numbers: every chain component is anchored at its earliest-startDate
  // member ("Season 1"), sequels count up, prequels count down.
  const seasonOf = new Map<number, number>();
  const chainNodes = new Set<number>([...prequelsOf.keys(), ...sequelsOf.keys()]);
  const seen = new Set<number>();
  const components: number[][] = [];
  for (const start of chainNodes) {
    if (seen.has(start)) continue;
    const component: number[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const cur = queue.pop()!;
      component.push(cur);
      for (const next of [
        ...(prequelsOf.get(cur) || []),
        ...(sequelsOf.get(cur) || []),
      ]) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    components.push(component);
  }
  components.sort((a, b) => {
    const da = Math.min(...a.map((id) => startDateKey(byId.get(id)!)));
    const db = Math.min(...b.map((id) => startDateKey(byId.get(id)!)));
    return da - db;
  });

  for (const component of components) {
    let anchor = component[0];
    for (const id of component) {
      if (startDateKey(byId.get(id)!) < startDateKey(byId.get(anchor)!)) anchor = id;
    }
    seasonOf.set(anchor, 1);
    const queue = [anchor];
    while (queue.length) {
      const cur = queue.shift()!;
      const season = seasonOf.get(cur)!;
      for (const parent of prequelsOf.get(cur) || []) {
        if (seasonOf.has(parent)) continue;
        seasonOf.set(parent, season - 1);
        queue.push(parent);
      }
      for (const child of sequelsOf.get(cur) || []) {
        if (seasonOf.has(child)) continue;
        seasonOf.set(child, season + 1);
        queue.push(child);
      }
    }
  }

  return { prequelsOf, sequelsOf, seasonOf };
}

/** 1,2,3 → "S1–S3"; 1,3 → "S1, S3" */
function seasonRunsLabel(seasons: number[]): string {
  const unique = [...new Set(seasons)].sort((a, b) => a - b);
  const runs: string[] = [];
  let i = 0;
  while (i < unique.length) {
    let j = i;
    while (j + 1 < unique.length && unique[j + 1] === unique[j] + 1) j++;
    runs.push(unique[i] === unique[j] ? `S${unique[i]}` : `S${unique[i]}–S${unique[j]}`);
    i = j + 1;
  }
  return runs.join(", ");
}

/** "S1–S3 · Prequel · OVA/Movie" summary for the group heading. */
function franchiseDetail(
  members: Anime[],
  seasonOf: Map<number, number>,
  single: boolean
): string | undefined {
  const seasons: number[] = [];
  const formats: string[] = [];
  let prequels = 0;
  for (const m of members) {
    const season = seasonOf.get(m.id);
    if (season === undefined) formats.push(formatLabel(m));
    else if (season >= 1) seasons.push(season);
    else prequels++;
  }
  if (single) return formats[0] || undefined;

  const parts: string[] = [];
  if (seasons.length > 0) parts.push(seasonRunsLabel(seasons));
  if (prequels > 0) parts.push(prequels > 1 ? `Prequel ×${prequels}` : "Prequel");
  const uniqueFormats = [...new Set(formats)];
  if (uniqueFormats.length > 0) {
    const shown = uniqueFormats.slice(0, 3).join("/");
    const rest = uniqueFormats.length - 3;
    parts.push(rest > 0 ? `${shown} +${rest}` : shown);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function buildFranchiseGroup(members: Anime[], options?: FranchiseGroupOptions): SeasonGroup {
  const { seasonOf } = buildSeasonChain(members);

  // Anchor: earliest startDate in the cluster (ties → first in fetch order).
  let root = 0;
  for (let i = 1; i < members.length; i++) {
    if (startDateKey(members[i]) < startDateKey(members[root])) root = i;
  }

  const indexed = members.map((anime, index) => ({ anime, index, season: seasonOf.get(anime.id) }));
  if (!options?.preserveOrder) {
    indexed.sort((a, b) => {
      // 0 = main chain seasons (S1, S2, …), 1 = prequels, 2 = unlinked extras.
      const bucketOf = (s: number | undefined) => (s === undefined ? 2 : s >= 1 ? 0 : 1);
      const ba = bucketOf(a.season);
      const bb = bucketOf(b.season);
      if (ba !== bb) return ba - bb;
      if (a.season !== b.season && a.season !== undefined && b.season !== undefined) {
        return a.season - b.season;
      }
      const da = startDateKey(a.anime);
      const db = startDateKey(b.anime);
      if (da !== db) return da - db;
      return a.index - b.index;
    });
  }

  const items = indexed.map((entry) => entry.anime);
  return {
    label: members[root].title,
    items,
    detail: franchiseDetail(members, seasonOf, members.length === 1),
  };
}

/**
 * Cluster search results into franchises: every result linked to another
 * result through an AniList relation edge lands in the same group (seasons,
 * prequels, sequels, ONA/OVA spin-offs together), standalone titles become
 * single-item groups. Group order = first appearance in the fetched order.
 */
export function groupByFranchise(
  items: Anime[],
  options?: FranchiseGroupOptions
): SeasonGroup[] {
  if (items.length === 0) return [];
  return clusterByFranchise(items).map((members) => buildFranchiseGroup(members, options));
}
