/**
 * Multi-provider streaming source fetcher using kaizoku-core.
 *
 * Chains all available anime providers (anikoto → anizone → allmanga → anineko → megaplay → animeunity)
 * to find working streaming URLs. Falls back through providers until one returns sources.
 *
 * Each provider has its own ID namespace, so search + fetchAnimeInfo must run per-provider.
 * Results are cached per (provider, normalized title) to avoid redundant searches.
 */
import {
  anikoto,
  anizone,
  allmanga,
  anineko,
  megaplay,
  animeunity,
  kickassanime,
  configure,
} from "kaizoku-core";
import type { Episode, StreamSource, Subtitle } from "@/types/anime";
import { getAnimeById } from "@/lib/anilist";

// ─── Wire scrape proxy for Cloudflare-protected providers ──────────────
// kaizoku-core reads SCRAPE_PROXY_URL/SCRAPE_PROXY_KEY from env automatically,
// but we call configure() explicitly to ensure it's set before any provider runs.
const scrapeProxyUrl = process.env.SCRAPE_PROXY_URL;
const scrapeProxyKey = process.env.SCRAPE_PROXY_KEY;

// Point kaizoku-core's internal AniList client to our proxy (adds Origin header
// to bypass AniList's server-IP block). The /api/anilist/fetch route forwards
// with browser-like headers.
// Build an absolute URL for the AniList proxy. On Vercel, VERCEL_URL is
// host-only (e.g. "xyz.vercel.app") — we must prepend https://.
function buildSiteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) {
    const raw = process.env.VERCEL_URL.replace(/\/+$/, "");
    return raw.startsWith("http") ? raw : `https://${raw}`;
  }
  return "http://localhost:3000";
}

const siteUrl = buildSiteUrl();
const anilistProxyUrl = `${siteUrl}/api/anilist/fetch`;

const configOpts: Record<string, any> = { anilistProxyUrl };
if (scrapeProxyUrl) {
  configOpts.scrapeProxyUrl = scrapeProxyUrl;
  configOpts.scrapeProxyKey = scrapeProxyKey || undefined;
  console.log("[providers] Scrape proxy configured:", scrapeProxyUrl);
}
console.log("[providers] AniList proxy:", anilistProxyUrl);
configure(configOpts);

// ─── Types ───────────────────────────────────────────────────────────

interface ProviderSession {
  providerId: string;
  animeId: string;
  episodes: any[];
}

interface StreamResult {
  sources: StreamSource[];
  subtitles: Subtitle[];
  headers?: Record<string, string>;
  providerId: string;
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
}

// ─── Caching ──────────────────────────────────────────────────────────

const sessionCache = new Map<string, ProviderSession>();
const SESSION_CACHE_MAX = 200;

function cacheKey(provider: string, title: string): string {
  return `${provider}::${normalize(title)}`;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

/**
 * Token-level Jaccard similarity between two (already normalizable) titles.
 * Used to decide whether a lone search hit still looks like the requested
 * anime — e.g. "spy x family" vs "spy family" (the `×` is stripped by
 * `normalize`, so the substring test below misses while the anime matches).
 */
function titleSimilarity(a: string, b: string): number {
  const setA = new Set(normalize(a).split(/\s+/).filter(Boolean));
  const setB = new Set(normalize(b).split(/\s+/).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  return shared / (setA.size + setB.size - shared);
}

/** Minimum similarity for accepting a non-title-matching search fallback. */
const SEARCH_FALLBACK_MIN_SIMILARITY = 0.5;

/** Tokens that can form a trailing season/sequel marker in a title. */
const SEASON_TOKEN_RE =
  /^(?:\d+(?:st|nd|rd|th)?|season|part|cour|ova|special|final|last)$/;

/**
 * Trailing season marker of a normalized title: the maximal run of
 * season-ish tokens at its end, kept only when it actually signals a
 * season/sequel (contains a digit, or `final`/`last`/`ova`/`special`).
 * "theatre of darkness yamishibai 17" → ["17"]; "oshi no ko" → [].
 */
function trailingSeasonMarker(clean: string): string[] {
  const tokens = clean.split(/\s+/).filter(Boolean);
  let i = tokens.length;
  while (i > 0 && SEASON_TOKEN_RE.test(tokens[i - 1])) i--;
  const tail = tokens.slice(i);
  const signalsSeason = tail.some(
    (t) => /^\d/.test(t) || t === "final" || t === "last" || t === "ova" || t === "special"
  );
  return signalsSeason ? tail : [];
}

// ─── Provider Adapters ────────────────────────────────────────────────

/**
 * Every name a search hit may be indexed under, normalized and deduped:
 * the provider's `title` plus the alias fields it ships alongside it.
 *
 * Providers frequently display an English/localized title while carrying the
 * romaji name the user actually searched with in a sibling field (anikoto
 * answers `{ id: "wushen-zhuzai-6sro6", title: "The God of War Dominates",
 * romaji: "Wushen Zhuzai" }`). Matching on `title` alone silently dropped
 * those hits, so a provider that DID carry the anime never got consulted.
 */
function resultNames(r: any): string[] {
  const names: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v !== "string" || !v.trim()) return;
    const n = normalize(v);
    if (n && !names.includes(n)) names.push(n);
  };
  const t = r?.title;
  if (typeof t === "string") push(t);
  else if (t && typeof t === "object") {
    push(t.romaji);
    push(t.english);
  }
  push(r?.romaji);
  return names;
}

/**
 * Query variants worth sending to a provider's `search`, most specific first:
 * the full title, then its head segment when the title carries a subtitle
 * ("Wushen Zhuzai: Da Wei Pian" → "Wushen Zhuzai"). Providers frequently
 * index only the base name, so the full string returns nothing useful while
 * the head returns the right entry (which the result's own `romaji`/title
 * then identifies — see `resultNames`).
 *
 * Variants are only consulted once the full title produced no candidate, so a
 * lookup that already works costs exactly what it did before.
 *
 * The season guard is ALWAYS derived from the original `title`, never from a
 * variant — otherwise "…Yamishibai 17" would relax to the base entry.
 */
function titleQueryVariants(title: string): string[] {
  const variants: string[] = [];
  const push = (v: string): void => {
    const t = v.trim();
    if (t && !variants.includes(t)) variants.push(t);
  };
  push(title);
  // Head before ":" / "：" / " - " (a bare "Re:" must NOT yield "Re").
  const head = (title.split(/\s+[:：-]\s+|[:：]/)[0] ?? "").trim();
  if (head && head !== title && normalize(head).split(/\s+/).filter(Boolean).length >= 2) {
    push(head);
  }
  return variants;
}

/**
 * Try to find anime matching `title` using a provider's `search` function.
 * Returns an ordered, deduped list of provider-specific candidate IDs:
 * title-matching results first (original order, exact-name matches ranked
 * ahead of sub-part and season/superset variants). When nothing matched, a
 * fallback is returned only if a search produced exactly ONE result and its
 * title is still recognisably the same anime (≥ `SEARCH_FALLBACK_MIN_SIMILARITY`
 * token overlap). Unconditionally taking `results[0]` used to attach a
 * different anime's episode list to the page.
 *
 * A hit matches when ANY of its names (title / provider alias, see
 * `resultNames`) is substring-related to the query, and that particular name
 * passes the season guard below — so an alias never smuggles a result past
 * the guard its own title would have failed.
 *
 * `idOfResult` maps a search hit onto the ID its `fetchAnimeInfo` expects —
 * some providers (allmanga) key their info/episode endpoints on a different
 * namespace (numeric AniList ID) than their search hit's own id (Mongo _id).
 *
 * A query whose trailing tokens form a season marker ("…Yamishibai 17")
 * never attaches to a result lacking that marker: the base entry would
 * otherwise serve the wrong season's episode list — and for still-airing
 * titles (AniList `episodes: null`) no expected count exists to gate it.
 */
async function searchProvider(
  providerName: string,
  searchFn: (q: string) => Promise<any>,
  title: string,
  idOfResult?: (r: any) => string | number | null
): Promise<(string | number)[]> {
  try {
    const clean = normalize(title);
    const marker = trailingSeasonMarker(clean);
    const markerOk = (name: string): boolean => {
      if (marker.length === 0) return true;
      // Ordinal canonicalization: "3rd" and "3" are the same season digit.
      const canon = (t: string): string => t.replace(/^(\d+)(?:st|nd|rd|th)$/, "$1");
      const required = marker.filter(
        (t) => /^\d/.test(canon(t)) || t === "final" || t === "last" || t === "ova" || t === "special"
      );
      const tokens = new Set(name.split(/\s+/).filter(Boolean).map(canon));
      return required.every((t) => tokens.has(canon(t)));
    };
    const idOf = (r: any): string | number | null =>
      idOfResult ? idOfResult(r) : (r?.id ?? r?.animeId ?? null);

    // Ranking tier: 0 = a name equals the query, 1 = the name is a sub-part
    // of it ("Wushen Zhuzai" ⊂ "Wushen Zhuzai: Da Wei Pian"), 2 = the name
    // extends the query (season/superset variant).
    const collect = (results: any[]): { id: string | number; tier: number }[] => {
      const found: { id: string | number; tier: number }[] = [];
      const seen = new Set<string | number>();
      for (const r of results) {
        let tier = -1;
        for (const n of resultNames(r)) {
          if (!n.includes(clean) && !clean.includes(n)) continue;
          if (!markerOk(n)) continue;
          const t = n === clean ? 0 : clean.includes(n) ? 1 : 2;
          if (tier < 0 || t < tier) tier = t;
        }
        if (tier < 0) continue;
        const id = idOf(r);
        if (id === null || seen.has(id)) continue;
        seen.add(id);
        found.push({ id, tier });
      }
      // Best match first (stable within a tier): a base query ("…Yamishibai")
      // must prefer the exact base entry over whichever season the provider
      // listed first, and a sub-part alias over a loose superset hit.
      return found.sort((a, b) => a.tier - b.tier);
    };

    let loneHit: any = null;
    for (const q of titleQueryVariants(title)) {
      const res = await searchFn(q);
      const results = res?.results ?? res?.data ?? [];
      if (!Array.isArray(results) || results.length === 0) continue;
      const candidates = collect(results);
      if (candidates.length > 0) return candidates.map((c) => c.id);
      // Remember the first sole hit for the similarity fallback below — but
      // never a blind `results[0]`.
      if (results.length === 1 && loneHit === null) loneHit = results[0];
    }
    if (loneHit === null) return [];

    let bestSimilarity = -1;
    for (const n of resultNames(loneHit)) {
      if (!markerOk(n)) continue;
      const sim = titleSimilarity(clean, n);
      if (sim > bestSimilarity) bestSimilarity = sim;
    }
    if (bestSimilarity < SEARCH_FALLBACK_MIN_SIMILARITY) return [];
    const loneId = idOf(loneHit);
    return loneId !== null ? [loneId] : [];
  } catch (err) {
    console.warn(`[providers] searchProvider(${providerName}) failed:`, err instanceof Error ? err.message : err);
    return [];
  }
}

// ─── Episode Retrieval ────────────────────────────────────────────────

async function getSessionForProvider(
  providerName: string,
  title: string,
  doSearch: () => Promise<(string | number)[]>,
  doFetchInfo: (id: string) => Promise<any>,
  episodeNumber?: number
): Promise<ProviderSession | null> {
  const key = cacheKey(providerName, title);
  const cached = sessionCache.get(key);
  if (cached) {
    // Only trust the cache if it can serve the requested episode — a cached
    // "Part 1" session (e.g. 11 eps) must not poison an ep-12 request.
    const cachedOk =
      episodeNumber === undefined ||
      (Array.isArray(cached.episodes) &&
        cached.episodes.some((e: any) => e?.number === episodeNumber));
    if (cachedOk) return cached;
    // else fall through to re-search
  }

  try {
    const ids = await doSearch();
    if (ids.length === 0) return null;

    for (const id of ids) {
      const info = await doFetchInfo(String(id));
      const episodes = info?.episodes ?? info?.data?.episodes ?? [];
      if (!Array.isArray(episodes) || episodes.length === 0) continue;
      if (
        episodeNumber !== undefined &&
        !episodes.some((e: any) => e?.number === episodeNumber)
      ) {
        continue;
      }

      const session: ProviderSession = { providerId: providerName, animeId: String(id), episodes };
      sessionCache.set(key, session);
      if (sessionCache.size > SESSION_CACHE_MAX) {
        const firstKey = sessionCache.keys().next().value;
        if (firstKey) sessionCache.delete(firstKey);
      }
      return session;
    }
    return null;
  } catch (err) {
    console.warn(`[providers] getSessionForProvider(${providerName}, "${title}") failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Provider Definitions ─────────────────────────────────────────────

interface ProviderDef {
  name: string;
  getSession: (title: string, anilistId?: number, episodeNumber?: number) => Promise<ProviderSession | null>;
  getSources: (episodeId: string, type: "sub" | "dub", episodeNumber: number, server?: string) => Promise<StreamResult | null>;
}

const PROVIDERS: ProviderDef[] = [
  // 1. kickassanime — primary high-quality provider with multi-subtitle support
  {
    name: "kickassanime",
    getSession: (title, _anilistId, episodeNumber) =>
      getSessionForProvider(
        "kickassanime",
        title,
        () => searchProvider("kickassanime", (q) => kickassanime.search(q), title),
        (id) => kickassanime.fetchAnimeInfo(id),
        episodeNumber
      ),
    getSources: async (episodeId, type, _ep, _server) => {
      try {
        const data = await kickassanime.fetchSources(episodeId, type);
        return toStreamResult(data, "kickassanime");
      } catch (err) {
        console.warn(`[providers] kickassanime fetchSources failed:`, err instanceof Error ? err.message : err);
        return null;
      }
    },
  },

  // 2. anikoto — fallback, has server selection
  {
    name: "anikoto",
    getSession: (title, _anilistId, episodeNumber) =>
      getSessionForProvider(
        "anikoto",
        title,
        () => searchProvider("anikoto", (q) => anikoto.search(q), title),
        (id) => anikoto.fetchAnimeInfo(id),
        episodeNumber
      ),
    getSources: async (episodeId, type, _ep, server) => {
      // megaplay.buzz `getSources` (vidstream-2) now returns encrypted payload
      // instead of sources — fall back through servers until one works.
      const serverOrder = server
        ? [server, "hd-1", "vidstream-2"]
        : ["hd-1", "vidstream-2"];
      const seen = new Set<string>();
      for (const s of serverOrder) {
        if (seen.has(s)) continue;
        seen.add(s);
        try {
          const data = await anikoto.fetchSources(episodeId, type as any, s as any);
          const result = toStreamResult(data, "anikoto");
          if (result) return result;
        } catch {
          // try next server
        }
      }
      return null;
    },
  },

  // 2. anizone
  {
    name: "anizone",
    getSession: (title, _anilistId, episodeNumber) =>
      getSessionForProvider(
        "anizone",
        title,
        () => searchProvider("anizone", (q) => anizone.search(q), title),
        (id) => anizone.fetchAnimeInfo(id),
        episodeNumber
      ),
    getSources: async (episodeId, _type, episodeNumber, _server) => {
      const data = await anizone.fetchSources(episodeId, undefined, episodeNumber);
      return toStreamResult(data, "anizone");
    },
  },

  // 3. allmanga
  {
    name: "allmanga",
    getSession: (title, _anilistId, episodeNumber) =>
      getSessionForProvider(
        "allmanga",
        title,
        () =>
          searchProvider(
            "allmanga",
            (q) => allmanga.search(q),
            title,
            // fetchAnimeInfo needs the numeric AniList ID (it resolves AniZip /
            // AniList media and builds `watch/allmanga/<anilistId>/<ep>` ids
            // that fetchSources parses); search hits carry their Mongo show
            // `_id` in `id` — passing that always throws. Null aniListId ⇒
            // null ⇒ the candidate is skipped instead of aborting the walk.
            (r) =>
              r?.aniListId !== null && r?.aniListId !== undefined && r.aniListId !== ""
                ? String(r.aniListId)
                : null
          ),
        (id) => allmanga.fetchAnimeInfo(id),
        episodeNumber
      ),
    getSources: async (episodeId, type, _ep, _server) => {
      const data = await allmanga.fetchSources(episodeId, type);
      return toStreamResult(data, "allmanga");
    },
  },

  // 4. anineko — fetchAnimeInfo(anilistId) expects a numeric AniList ID, not a search slug
  {
    name: "anineko",
    getSession: async (title, anilistId) => {
      if (!anilistId) return null;
      const cacheKeyStr = cacheKey("anineko", title);
      const cached = sessionCache.get(cacheKeyStr);
      if (cached) return cached;
      try {
        const info = await anineko.fetchAnimeInfo(String(anilistId));
        const episodes = info?.episodes ?? [];
        if (!Array.isArray(episodes) || episodes.length === 0) return null;
        const session: ProviderSession = { providerId: "anineko", animeId: String(anilistId), episodes };
        sessionCache.set(cacheKeyStr, session);
        return session;
      } catch (err) {
        console.warn(`[providers] anineko getSession("${title}", anilistId=${anilistId}) failed:`, err instanceof Error ? err.message : err);
        return null;
      }
    },
    getSources: async (episodeId, type, _ep, _server) => {
      const data = await anineko.fetchSources(episodeId, type);
      return toStreamResult(data, "anineko");
    },
  },

  // 5. megaplay (no search — uses AniList ID directly, handled by direct lookup)
  {
    name: "megaplay",
    getSession: async (title) => {
      // megaplay has no search; skip title-based lookup
      return null;
    },
    getSources: async (_episodeId, _type, _ep, _server) => null,
  },

  // 6. animeunity
  {
    name: "animeunity",
    getSession: (title, _anilistId, episodeNumber) =>
      getSessionForProvider(
        "animeunity",
        title,
        () => searchProvider("animeunity", (q) => animeunity.search(q), title),
        (id) => animeunity.fetchAnimeInfo(id),
        episodeNumber
      ),
    getSources: async (episodeId, _type, episodeNumber, _server) => {
      const data = await (animeunity as any).fetchEpisodeSources(episodeId, undefined, episodeNumber);
      return toStreamResult(data, "animeunity");
    },
  },
];

// ─── AniSkip ─────────────────────────────────────────────────────────

/** Fetch per-episode intro/outro timestamps from AniSkip (free, no key) */
async function fetchAniSkipTimes(
  malId: number,
  episodeNumber: number
): Promise<{ intro?: { start: number; end: number }; outro?: { start: number; end: number } }> {
  try {
    const url = `https://api.aniskip.com/v2/skip-times/${malId}/${episodeNumber}?types[]=op&types[]=ed&types[]=mixed-op&types[]=mixed-ed`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return {};
    const json = await res.json();
    if (!json.found || !json.results) return {};

    let intro: { start: number; end: number } | undefined;
    let outro: { start: number; end: number } | undefined;

    for (const item of json.results) {
      const start = Math.round(item.interval.startTime);
      const end = Math.round(item.interval.endTime);
      if ((item.skipType === "op" || item.skipType === "mixed-op") && !intro) {
        intro = { start, end };
      } else if ((item.skipType === "ed" || item.skipType === "mixed-ed") && !outro) {
        outro = { start, end };
      }
    }

    return { intro, outro };
  } catch {
    return {};
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Drop DASH `.mpd` manifests: the player only supports HLS (hls.js) or
 * progressive files — no dash.js — so an `.mpd` source renders as a silent
 * 0:00 player. In practice the kickassanime `.mpd` URL was also 404-dead.
 * Checks the pathname only (query/hash ignored, case-insensitive).
 */
function isPlayableSourceUrl(url: string): boolean {
  try {
    return !new URL(url, "http://localhost").pathname.toLowerCase().endsWith(".mpd");
  } catch {
    // Unparseable URL — fall back to a query/hash-stripped suffix check.
    const path = url.split(/[?#]/)[0] ?? "";
    return !path.toLowerCase().endsWith(".mpd");
  }
}

function toStreamResult(
  data: any,
  providerId: string
): StreamResult | null {
  if (!data) {
    return null;
  }
  const rawSources: any[] = Array.isArray(data.sources) ? data.sources : [];
  const sources: StreamSource[] = rawSources
    .filter((s: any) => s?.url && isPlayableSourceUrl(String(s.url)))
    .map((s: any) => ({
      url: s.url,
      quality: s.quality || "auto",
      isM3U8: s.isM3U8 !== false,
    }));

  // Empty after filtering (e.g. only unplayable `.mpd` sources) ⇒ treat as
  // "provider produced nothing" so getStreamingSources falls through to the
  // next provider instead of short-circuiting on an unplayable payload.
  if (sources.length === 0) return null;

  const subtitles: Subtitle[] = (data.subtitles || [])
    .filter((s: any) => s?.url)
    .map((s: any) => ({
      url: s.url,
      lang: s.lang || "Unknown",
    }));

  // Extract intro/outro skip times from provider source data
  let intro: { start: number; end: number } | undefined;
  let outro: { start: number; end: number } | undefined;

  if (data.intro && typeof data.intro === "object") {
    const s = Number(data.intro.start);
    const e = Number(data.intro.end);
    if (isFinite(s) && isFinite(e) && e > s) {
      intro = { start: Math.round(s), end: Math.round(e) };
    }
  }
  if (data.outro && typeof data.outro === "object") {
    const s = Number(data.outro.start);
    const e = Number(data.outro.end);
    if (isFinite(s) && isFinite(e) && e > s) {
      outro = { start: Math.round(s), end: Math.round(e) };
    }
  }

  return {
    sources,
    subtitles,
    headers: (data.headers || {}) as Record<string, string>,
    providerId,
    intro,
    outro,
  };
}

// ─── MegaPlay direct (AniList ID) ─────────────────────────────────────

export async function getMegaPlaySession(
  anilistId: number,
  _title: string
): Promise<ProviderSession | null> {
  try {
    const info = await megaplay.fetchAnimeInfo(String(anilistId));
    const episodes = info?.episodes ?? [];
    if (!Array.isArray(episodes) || episodes.length === 0) return null;
    return { providerId: "megaplay", animeId: String(anilistId), episodes };
  } catch (err) {
    console.warn(`[providers] getMegaPlaySession(anilistId=${anilistId}) failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getMegaPlaySources(
  episodeId: string,
  type: "sub" | "dub",
  episodeNumber: number,
  malId?: number
): Promise<StreamResult | null> {
  try {
    const data = await megaplay.fetchSources(episodeId, type, episodeNumber, malId);
    const result = toStreamResult(data, "megaplay");
    return result;
  } catch (err) {
    console.warn(`[providers] getMegaPlaySources(ep=${episodeId}) failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Episode Availability Filter & Cache ─────────────────────────────

/**
 * Why an episode list is missing — the plausibility gate used to collapse all
 * three answers into an empty array, so a caller could not tell "no provider
 * answered" from "a provider answered with junk we threw away".
 *  - `ok`      a list was accepted (normal case)
 *  - `none`    no provider returned any list
 *  - `suspect` lists came back, but every one of them was rejected by the gate
 */
export type EpisodeListStatus = "ok" | "none" | "suspect";

export interface EpisodeListResult {
  episodes: Episode[];
  listStatus: EpisodeListStatus;
}

interface AvailabilityEntry {
  /**
   * The RAW, provider-selected list — deliberately WITHOUT `available` folded
   * in. `available` is derived on every read (see `applyAvailability`), which
   * is what makes the cached and fresh paths structurally incapable of
   * disagreeing: there is only one definition and the cache never stores a
   * second, stale copy of it.
   */
  list: Episode[];
  listStatus: EpisodeListStatus;
  expiresAt: number;
}

const availabilityCache = new Map<string, AvailabilityEntry>();
const AVAILABILITY_CACHE_MAX = 200;
/**
 * TTL is mandatory here: a single poisoned fetch (e.g. anikoto's lone "Full"
 * episode during a megaplay/kickassanime hiccup) used to be memoised for the
 * whole process lifetime.
 *
 * Raised from 5 minutes to 10. The old value was pinned to AniList's
 * `revalidate: 300` window, but the LIST ITSELF comes from the providers, not
 * from AniList — AniList only supplies the expected count that SCORES a list,
 * and that lookup keeps its own separate 300s cache. What a longer TTL costs
 * is a newly aired episode appearing up to 10 minutes late (providers already
 * lag a simulcast by minutes, and an episode that just aired is not watchable
 * in that window anyway); what it buys is roughly half the cold provider
 * walks — each of which is a multi-second search+info round trip, the exact
 * cost queue #8 complains about — on every detail-page mount and every
 * `/api/episodes` call.
 */
const AVAILABILITY_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * The expected count is part of the key: a list cached by an ungated caller
 * (no AniList count available) must not be served to a gated one, and vice
 * versa — they were scored under different rules.
 */
function getAvailabilityCacheKey(
  title: string,
  anilistId?: number,
  providerName?: string,
  expectedCount?: number
): string {
  return `${providerName || "auto"}::${anilistId || ""}:${expectedCount ?? ""}:${normalize(title)}`;
}

function readAvailabilityCache(key: string): AvailabilityEntry | undefined {
  const entry = availabilityCache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    availabilityCache.delete(key);
    return undefined;
  }
  return entry;
}

function writeAvailabilityCache(
  key: string,
  list: Episode[],
  listStatus: EpisodeListStatus
): void {
  availabilityCache.set(key, { list, listStatus, expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS });
  if (availabilityCache.size > AVAILABILITY_CACHE_MAX) {
    const firstKey = availabilityCache.keys().next().value;
    if (firstKey) availabilityCache.delete(firstKey);
  }
}

function isEpisodeAvailable(ep: Episode): boolean {
  if (!ep.id) return false;
  // Known-both-absent: the probe proved neither version exists.
  if (ep.hasSub === false && ep.hasDub === false) return false;
  if (!ep.number || ep.number <= 0) return false;
  // If airDate is provided and is in the future, episode is not available yet
  if (ep.airDate) {
    const airDate = new Date(ep.airDate);
    if (!isNaN(airDate.getTime()) && airDate > new Date()) {
      return false;
    }
  }
  return true;
}

/**
 * THE definition of `available`. Nothing else in the codebase may derive it.
 *
 * It used to be computed twice: once inside `getEpisodes` when the list was
 * cached (with megaplay's `hasSub`/`hasDub` still `null`), and again inside
 * `getAudioFlags` by a bolt-on override once a probe had learned the truth —
 * so the cache could say `available: true` while the response handed to the
 * caller said `false`. One pure function, applied on every read and on the
 * probe path, removes that second definition.
 */
function applyAvailability(episodes: Episode[]): Episode[] {
  return episodes.map((ep) => ({ ...ep, available: isEpisodeAvailable(ep) }));
}

// ─── Sub/Dub Availability ────────────────────────────────────────────

/**
 * Sub/dub availability per episode.
 *
 * Most providers put `hasSub`/`hasDub` on every episode they list — megaplay
 * does not: it builds its episode list from AniZip metadata and hardcodes
 * `hasSub: null, hasDub: null` (upstream comment: "we dont know"), because
 * megaplay addresses audio with a `sub`/`dub` version segment in its embed URL
 * (`/stream/ani/{anilistId}/{episode}/{sub|dub}`) instead of a per-episode flag.
 * Megaplay is our preferred provider whenever an AniList ID is available, so
 * every listed episode arrived with `hasDub: null` and the dub count was always 0.
 *
 * `probeMegaPlayAudio` recovers the flags cheaply: one GET of that embed URL per
 * (episode, version) — a 200 page whose `<title>` is "Error - MegaPlay" means
 * "no mapping for this version", anything else means the audio exists. Measured
 * ~50 ms/request at concurrency 12 (56 requests for a 28-episode title took
 * 1.2 s total), so it stays OFF the episode-list hot path: it only runs when the
 * client asks for `?audio=1`, and results are cached per AniList ID so every
 * later request — including the fast path — reuses them with zero I/O.
 *
 * Unknown stays unknown: a network failure yields `null`, never `false`, and a
 * count is only reported when every listed episode is known.
 */
const MEGAPLAY_EMBED_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0";
/** Titles with more episodes than this are not probed (cost > value). */
const AUDIO_PROBE_MAX_EPISODES = 60;
const AUDIO_PROBE_CONCURRENCY = 12;
const AUDIO_PROBE_TIMEOUT_MS = 6000;
const AUDIO_PROBE_BUDGET_MS = 8000;
const AUDIO_FLAG_CACHE_MAX = 100;

type AudioFlag = { sub: boolean | null; dub: boolean | null };

/** anilistId → episode number → verified audio flags. */
const audioFlagCache = new Map<number, Map<number, AudioFlag>>();

export interface AudioSummary {
  /** Episodes verified to carry subtitle audio — `null` when any is unknown. */
  subCount: number | null;
  /** Episodes verified to carry dub audio — `null` when any is unknown. */
  dubCount: number | null;
  /** A megaplay probe could resolve the remaining unknowns (needs AniList ID). */
  canProbe: boolean;
  /** This response actually ran the probe. */
  probed: boolean;
}

/** Light probe: does megaplay map this (episode, version)? true/false, or null if we couldn't tell. */
async function probeMegaPlayVersion(
  anilistId: number,
  episode: number,
  version: "sub" | "dub"
): Promise<boolean | null> {
  try {
    const res = await fetch(`https://megaplay.buzz/stream/ani/${anilistId}/${episode}/${version}`, {
      headers: { "User-Agent": MEGAPLAY_EMBED_UA, Referer: "https://megaplay.buzz/" },
      signal: AbortSignal.timeout(AUDIO_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // The embed answers 200 for both outcomes; the 404 page carries an Error title.
    return !/<title>\s*(Unavailable|Error)/i.test(html);
  } catch {
    return null; // timeout / network — unknown, never "no"
  }
}

/** Run `jobs` with a bounded number in flight. */
async function runPool(jobs: (() => Promise<void>)[], concurrency: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await job();
    }
  });
  await Promise.all(workers);
}

/** Probe (sub + dub) for every episode whose flags are still unknown, within a time budget. */
async function probeMegaPlayAudio(
  anilistId: number,
  episodes: Episode[]
): Promise<Map<number, AudioFlag>> {
  let cached = audioFlagCache.get(anilistId);
  if (!cached) {
    cached = new Map<number, AudioFlag>();
    if (audioFlagCache.size >= AUDIO_FLAG_CACHE_MAX) {
      const oldest = audioFlagCache.keys().next().value;
      if (oldest !== undefined) audioFlagCache.delete(oldest);
    }
    audioFlagCache.set(anilistId, cached);
  }
  const flags: Map<number, AudioFlag> = cached;

  const deadline = Date.now() + AUDIO_PROBE_BUDGET_MS;
  const jobs: (() => Promise<void>)[] = [];
  for (const ep of episodes) {
    for (const version of ["sub", "dub"] as const) {
      const known = flags.get(ep.number);
      if (known && known[version] !== null) continue;
      jobs.push(async () => {
        if (Date.now() > deadline) return; // out of budget ⇒ stays unknown
        const result = await probeMegaPlayVersion(anilistId, ep.number, version);
        if (result === null) return; // stay unknown
        const prev = flags.get(ep.number) ?? { sub: null, dub: null };
        flags.set(ep.number, version === "sub" ? { ...prev, sub: result } : { ...prev, dub: result });
      });
    }
  }

  await runPool(jobs, AUDIO_PROBE_CONCURRENCY);
  return flags;
}

function canProbeAudio(episodes: Episode[], anilistId?: number): boolean {
  if (!anilistId || episodes.length === 0) return false;
  // Probe cost is 2 requests per episode — only worth it when we can finish the set.
  if (episodes.length > AUDIO_PROBE_MAX_EPISODES) return false;
  // The probe URL is keyed by AniList ID + episode number, so it only describes
  // megaplay's own listing (it would misreport any provider with its own numbering).
  return episodes.every(
    (ep) => ep.providerId === "megaplay" && Number.isInteger(ep.number) && ep.number > 0
  );
}

function countKnown(episodes: Episode[], key: "hasSub" | "hasDub"): number | null {
  let count = 0;
  for (const ep of episodes) {
    const value = ep[key];
    if (value === null || value === undefined) return null; // one unknown ⇒ no honest total
    if (value) count++;
  }
  return count;
}

/**
 * Fold verified flags into a list. `flags` describes megaplay's listing only,
 * so another provider's episodes are never tagged with them. Pure — returns a
 * new array, never mutates (the input may be the shared availability cache).
 */
function mergeAudioFlags(list: Episode[], flags: Map<number, AudioFlag>): Episode[] {
  return list.map((ep) => {
    if (ep.providerId !== "megaplay") return ep;
    const flag = flags.get(ep.number);
    if (!flag) return ep;
    return { ...ep, hasSub: ep.hasSub ?? flag.sub, hasDub: ep.hasDub ?? flag.dub };
  });
}

/**
 * The flags any earlier `?audio=1` probe already learned for this title, with
 * zero I/O. This is the cache the module doc promised ("every later request —
 * including the fast path — reuses them"), and it is now genuinely on the fast
 * path: `getEpisodes` merges it before deriving `available`, so the plain
 * response and the probed response can no longer differ.
 */
function withKnownFlags(episodes: Episode[], anilistId?: number): Episode[] {
  const cached = anilistId ? audioFlagCache.get(anilistId) : undefined;
  if (!cached || cached.size === 0) return episodes;
  return mergeAudioFlags(episodes, cached);
}

/**
 * Resolve sub/dub flags for a freshly fetched episode list.
 *
 * Without `probe` this is pure bookkeeping (no I/O): it folds in flags an
 * earlier probe already learned and summarizes what is known. With `probe` it
 * also hits megaplay once per unknown (episode, version), up to
 * `AUDIO_PROBE_MAX_EPISODES`.
 *
 * `available` is NOT re-derived here — that is `applyAvailability`'s job, and
 * this function simply calls it after the flags are as settled as they are
 * going to get. (The old bespoke "availability override" block lived here and
 * produced a second, divergent definition; it is gone.)
 */
export async function getAudioFlags(
  episodes: Episode[],
  anilistId?: number,
  probe = false
): Promise<{ episodes: Episode[]; audio: AudioSummary }> {
  let resolved = withKnownFlags(episodes, anilistId);

  const canProbe = canProbeAudio(resolved, anilistId);
  let probed = false;
  if (probe && canProbe && anilistId) {
    const flags = await probeMegaPlayAudio(anilistId, resolved);
    resolved = mergeAudioFlags(resolved, flags);
    probed = true;
  }

  resolved = applyAvailability(resolved);

  return {
    episodes: resolved,
    audio: {
      subCount: countKnown(resolved, "hasSub"),
      dubCount: countKnown(resolved, "hasDub"),
      canProbe,
      probed,
    },
  };
}

// ─── Plausibility gate ───────────────────────────────────────────────

/**
 * Episode titles that mark a lone entry as synthetic: providers that fail to
 * resolve a real listing answer with one episode called "Full" (anikoto) or
 * an unnumbered "Episode 1". Applied to `normalize()`d titles.
 */
const GENERIC_EPISODE_TITLE_RE =
  /^(full|complete|unknown|na|video|stream|watch|online|anime|series|movie|episode|ep|part)(\s+(full|complete|episode|ep|movie|version|show|anime|series|part|\d+))*$/;

/** A one-entry list whose only episode carries a generic/absent title. */
function isSuspectSingleEpisodeList(episodes: Episode[]): boolean {
  if (episodes.length !== 1) return false;
  const title = (episodes[0]?.title ?? "").trim();
  if (!title) return true;
  return GENERIC_EPISODE_TITLE_RE.test(normalize(title));
}

/**
 * Score a candidate list against the expected episode count (when known).
 * Higher wins; `null` means "clearly wrong — never serve this".
 *
 * - exact count → `0` (unbeatable)
 * - otherwise → `-|actual - expected|`, so the closest list wins
 * - a lone episode for an anime known to have more → `null`
 *
 * Without an expected count every non-suspect list ties at `0`, so the first
 * provider in preference order still wins (previous behaviour) while suspect
 * single-"Full" lists sink to the bottom — they only get served when nothing
 * better exists.
 */
function scoreEpisodeList(episodes: Episode[], expectedCount?: number): number | null {
  if (episodes.length === 0) return null;
  if (expectedCount && expectedCount > 0) {
    if (episodes.length === 1 && expectedCount > 1) return null;
    return -Math.abs(episodes.length - expectedCount);
  }
  return isSuspectSingleEpisodeList(episodes) ? -1_000_000 : 0;
}

/** AniList's episode count for `anilistId` (fetch-cached, revalidate 300). */
async function resolveExpectedEpisodeCount(anilistId?: number): Promise<number | undefined> {
  if (!anilistId) return undefined;
  try {
    const anime = await getAnimeById(anilistId);
    return typeof anime?.episodes === "number" && anime.episodes > 0 ? anime.episodes : undefined;
  } catch {
    return undefined; // gate degrades to the suspect-title heuristic
  }
}

/** Map a provider session's raw episodes onto the shared `Episode` shape. */
function sessionToEpisodes(session: ProviderSession, providerId: string): Episode[] {
  return session.episodes
    .map((ep: any) => ({
      id: ep.id,
      number: ep.number,
      title: ep.title || undefined,
      image: ep.image || ep.img || undefined,
      providerId,
      hasDub: ep.hasDub ?? null,
      hasSub: ep.hasSub ?? null,
      airDate: ep.airDate || undefined,
    }))
    .sort((a: Episode, b: Episode) => a.number - b.number);
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Fetch the episode list for an anime by trying all providers.
 *
 * Auto mode collects candidate lists and returns the BEST one instead of the
 * first non-empty one: the count closest to `expectedCount` wins, and lists
 * that are clearly wrong (a lone "Full" episode for a multi-episode anime) are
 * rejected. `expectedCount` is AniList's episode count; when omitted it is
 * resolved internally (fetch-cached) so every caller gets the gate.
 *
 * The gate used to make rejection indistinguishable from "nothing answered" —
 * both came back as `[]` — so `listStatus` now says which of the three things
 * actually happened (`ok` / `none` / `suspect`) and the UI can say it too.
 *
 * What is cached is the RAW selected list; `available` is derived from it on
 * every read by `applyAvailability` after merging any flags a previous
 * `?audio=1` probe learned. That is what makes "cached path" and "fresh path"
 * the same computation rather than two that merely agree today.
 *
 * If `providerName` is given, only that provider is tried and its raw list is
 * returned un-gated (explicit/debug provider selection).
 */
export async function getEpisodes(
  animeTitle: string,
  anilistId?: number,
  providerName?: string,
  expectedCount?: number
): Promise<EpisodeListResult> {
  // A forced provider never compares against other lists, so don't spend an
  // AniList lookup resolving a count it will not use.
  const expected =
    expectedCount ?? (providerName ? undefined : await resolveExpectedEpisodeCount(anilistId));

  const cacheKey = getAvailabilityCacheKey(animeTitle, anilistId, providerName, expected);
  const cached = readAvailabilityCache(cacheKey);
  if (cached) {
    // Same two functions the uncached branch below runs — flags first, then
    // the single availability definition.
    return {
      episodes: applyAvailability(withKnownFlags(cached.list, anilistId)),
      listStatus: cached.listStatus,
    };
  }

  let candidateEpisodes: Episode[] = [];
  /** A list came back and the gate threw it away (feeds `suspect`). */
  let sawRejected = false;
  let listStatus: EpisodeListStatus = "none";

  // Try specific provider if requested (un-gated: exactly what it lists).
  if (providerName) {
    if (providerName === "megaplay" && anilistId) {
      const session = await getMegaPlaySession(anilistId, animeTitle);
      if (session) candidateEpisodes = sessionToEpisodes(session, "megaplay");
    } else {
      for (const provider of PROVIDERS) {
        if (provider.name !== providerName) continue;
        try {
          const session = await provider.getSession(animeTitle, anilistId);
          if (!session) continue;
          candidateEpisodes = sessionToEpisodes(session, provider.name);
          break;
        } catch (err) {
          console.warn(`[providers] getEpisodes(${providerName}) getSession failed:`, err instanceof Error ? err.message : err);
          continue;
        }
      }
    }
  } else {
    const best: { episodes: Episode[] | null; score: number } = { episodes: null, score: -Infinity };
    const consider = (session: ProviderSession | null, providerId: string): void => {
      if (!session || session.episodes.length === 0) return;
      const episodes = sessionToEpisodes(session, providerId);
      const score = scoreEpisodeList(episodes, expected);
      if (score === null) {
        sawRejected = true;
        console.warn(
          `[providers] getEpisodes: rejected implausible ${providerId} list ` +
            `(${episodes.length} ep, expected ${expected ?? "?"}) for "${animeTitle}"`
        );
        return;
      }
      if (score > best.score) {
        best.episodes = episodes;
        best.score = score;
      }
    };

    // Try megaplay first if we have an AniList ID (it's most reliable)
    if (anilistId) {
      try {
        consider(await getMegaPlaySession(anilistId, animeTitle), "megaplay");
      } catch (err) {
        console.warn(`[providers] getEpisodes megaplay failed:`, err instanceof Error ? err.message : err);
        // fall through
      }
    }

    // Walk the remaining providers and keep the BEST list — stopping at the
    // first non-empty one is what let anikoto's single "Full" episode win
    // whenever megaplay/kickassanime hiccups.
    if (best.score < 0) {
      for (const provider of PROVIDERS) {
        try {
          const session = await provider.getSession(animeTitle, anilistId);
          consider(session, provider.name);
          // `0` == exact expected count (or, with no count, any non-suspect
          // list): nothing later can beat it, so stop early.
          if (best.score >= 0) break;
        } catch (err) {
          console.warn(`[providers] getEpisodes(${provider.name}) failed:`, err instanceof Error ? err.message : err);
          continue;
        }
      }
    }

    candidateEpisodes = best.episodes ?? [];
  }

  if (candidateEpisodes.length === 0) {
    // `suspect` only when we KNOW we rejected something; otherwise nobody
    // answered at all. Not cached — an empty answer stays as cheap to retry as
    // it always was, so a title that gains a list picks it up immediately.
    return { episodes: [], listStatus: sawRejected ? "suspect" : "none" };
  }

  listStatus = "ok";
  writeAvailabilityCache(cacheKey, candidateEpisodes, listStatus);
  // Raw in, derived out — see `applyAvailability`.
  return {
    episodes: applyAvailability(withKnownFlags(candidateEpisodes, anilistId)),
    listStatus,
  };
}

// ─── Provider walk: timeouts & bounded parallelism ─────────────────────

/**
 * kaizoku-core's HTTP layer sets no timeout of its own, so a dead upstream
 * used to stall a walk until undici's ~10s connect timeout (observed:
 * KickAssAnime `ConnectTimeoutError 10000ms`). Every provider attempt is
 * therefore given one hard budget. The underlying request is not cancelled —
 * kaizoku-core exposes no AbortSignal — but the walk stops waiting for it.
 */
const PROVIDER_TIMEOUT_MS = 5_000;

/**
 * Phase 2 used to run strictly serially, so its cost was the *sum* of every
 * provider's search + info + sources. It now overlaps a small batch at a time.
 * Three rather than "all of them" is deliberate: it collapses a 6-provider
 * walk into two waves while keeping a single walk's upstream request volume
 * close to the old serial behaviour, in case a provider rate-limits us.
 */
const PHASE2_PARALLELISM = 3;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    // These handlers stay attached for the promise's whole lifetime, so a
    // rejection that lands after we already gave up is still "handled".
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Search + episode match + sources for one provider. Never throws. */
async function attemptProvider(
  provider: ProviderDef,
  animeTitle: string,
  episodeNumber: number,
  type: "sub" | "dub",
  server?: string
): Promise<StreamResult | null> {
  try {
    const session = await provider.getSession(animeTitle, undefined, episodeNumber);
    if (!session) return null;
    const targetEp = session.episodes.find((ep) => ep.number === episodeNumber);
    if (!targetEp?.id) return null;
    const result = await provider.getSources(targetEp.id, type, episodeNumber, server);
    return result ? { ...result, providerId: provider.name } : null;
  } catch (err) {
    console.warn(`[providers] ${provider.name} attempt failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** MegaPlay lookup by AniList id (it has no title search). Never throws. */
async function attemptMegaPlay(
  anilistId: number,
  animeTitle: string,
  episodeNumber: number,
  type: "sub" | "dub"
): Promise<StreamResult | null> {
  try {
    const session = await getMegaPlaySession(anilistId, animeTitle);
    if (!session) return null;
    const targetEp = session.episodes.find((ep) => ep.number === episodeNumber);
    if (!targetEp?.id) return null;
    const result = await getMegaPlaySources(targetEp.id, type, episodeNumber);
    return result ? { ...result, providerId: "megaplay" } : null;
  } catch (err) {
    console.warn(`[providers] megaplay attempt failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Run `providers` with bounded concurrency, launching them in array order, and
 * resolve with the first SUCCESS in array order — not whichever one happened to
 * finish first. A result is only returned once no earlier (higher-priority)
 * provider could still beat it, and candidates queued behind a confirmed winner
 * are never started, so a fast provider early in the list keeps the old
 * "stop as soon as we have a source" behaviour.
 */
function walkProvidersByPriority(
  providers: ProviderDef[],
  attempt: (provider: ProviderDef) => Promise<StreamResult | null>
): Promise<StreamResult | null> {
  const total = providers.length;
  if (total === 0) return Promise.resolve(null);

  // finished[i] covers "settled, success or failure"; indices still queued are
  // deliberately left unfinished so they count as "could still beat the best".
  const finished = new Array<boolean>(total).fill(false);

  return new Promise<StreamResult | null>((resolve) => {
    let settled = false;
    let nextIndex = 0;
    let inFlight = 0;
    let doneCount = 0;
    let bestIndex = -1;
    let best: StreamResult | null = null;

    const settle = (value: StreamResult | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const check = () => {
      if (settled) return;
      if (bestIndex >= 0) {
        const lowestOpen = finished.indexOf(false);
        // Nothing earlier is still running or queued ⇒ the winner can't change.
        if (lowestOpen === -1 || bestIndex < lowestOpen) settle(best);
        return;
      }
      if (doneCount === total) settle(null);
    };

    const pump = () => {
      while (!settled && inFlight < PHASE2_PARALLELISM && nextIndex < total) {
        const index = nextIndex++;
        const provider = providers[index];
        inFlight++;
        void (async () => {
          let result: StreamResult | null = null;
          try {
            result = await attempt(provider);
          } catch (err) {
            // Timeouts reject here; `attemptProvider` itself never throws.
            console.warn(
              `[providers] ${provider.name} phase2 failed:`,
              err instanceof Error ? err.message : err
            );
          }
          if (result && (bestIndex === -1 || index < bestIndex)) {
            bestIndex = index;
            best = result;
          }
          inFlight--;
          doneCount++;
          finished[index] = true;
          pump();
          check();
        })();
      }
      check();
    };

    pump();
  });
}

/**
 * Fetch streaming sources for a specific episode by chaining through all providers.
 * If `preferredProvider` is given, that provider is tried FIRST using its own episode mapping,
 * preventing cross-provider episode number mismatches.
 */
export async function getStreamingSources(
  animeTitle: string,
  episodeNumber: number,
  type: "sub" | "dub" = "sub",
  server?: string,
  anilistId?: number,
  preferredProvider?: string
): Promise<
  { sources: StreamSource[]; subtitles: Subtitle[]; headers?: Record<string, string>; providerId: string; intro?: { start: number; end: number }; outro?: { start: number; end: number } }
  | null
> {
  const tried: string[] = [];

  // ── Phase 1: Try the preferred provider first (matches episode list source) ──
  if (preferredProvider) {
    // Try megaplay if preferred
    if (preferredProvider === "megaplay" && anilistId) {
      tried.push("megaplay");
      try {
        const result = await withTimeout(
          attemptMegaPlay(anilistId, animeTitle, episodeNumber, type),
          PROVIDER_TIMEOUT_MS,
          "megaplay phase1"
        );
        if (result) return result;
      } catch (err) {
        console.warn(`[providers] megaplay phase1 failed:`, err instanceof Error ? err.message : err);
      }
    }

    // Try the named provider from PROVIDERS list
    for (const provider of PROVIDERS) {
      if (provider.name !== preferredProvider) continue;
      tried.push(provider.name);
      try {
        const result = await withTimeout(
          attemptProvider(provider, animeTitle, episodeNumber, type, server),
          PROVIDER_TIMEOUT_MS,
          `${provider.name} phase1`
        );
        if (result) return result;
      } catch (err) {
        console.warn(`[providers] ${provider.name} phase1 failed:`, err instanceof Error ? err.message : err);
      }
      break;
    }
  }

  // ── Phase 2: every remaining provider, overlapped, first success by priority ──
  const phase2 = PROVIDERS.filter(
    (provider) => !(preferredProvider && provider.name === preferredProvider)
  );
  if (phase2.length > 0) {
    tried.push(...phase2.map((p) => p.name));
    const winner = await walkProvidersByPriority(phase2, (provider) =>
      withTimeout(
        attemptProvider(provider, animeTitle, episodeNumber, type, server),
        PROVIDER_TIMEOUT_MS,
        `${provider.name} phase2`
      )
    );
    if (winner) return winner;
  }

  // ── Phase 3: Try megaplay directly with AniList ID (if not already tried) ──
  if (anilistId && preferredProvider !== "megaplay") {
    tried.push("megaplay");
    try {
      const result = await withTimeout(
        attemptMegaPlay(anilistId, animeTitle, episodeNumber, type),
        PROVIDER_TIMEOUT_MS,
        "megaplay phase3"
      );
      if (result) return result;
    } catch (err) {
      console.warn(`[providers] megaplay phase3 failed:`, err instanceof Error ? err.message : err);
    }
  }

  console.warn(`[providers] getStreamingSources("${animeTitle}", ep${episodeNumber}, ${type}) — all providers failed. Tried:`, tried);
  return null;
}

// `getAvailableProviders()` used to live here. It had ZERO callers, so it was
// dead code: the list path already picks one provider and records it per
// episode (`Episode.providerId`), which is strictly more useful than a bare
// "who has a session" list nothing rendered. Wiring it in would have added a
// SECOND full provider walk (search + info per provider, un-timed,
// un-gated) to every `/api/episodes` call for information no UI reads — the
// opposite of queue #8. Deleted rather than wired.
