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

// ─── Provider Adapters ────────────────────────────────────────────────

/**
 * Try to find anime matching `title` using a provider's `search` function.
 * Returns an ordered, deduped list of provider-specific candidate IDs:
 * all title-matching results first (original order), then `results[0]`
 * as a fallback if nothing title-matched.
 */
async function searchProvider(
  providerName: string,
  searchFn: (q: string) => Promise<any>,
  title: string
): Promise<(string | number)[]> {
  try {
    const res = await searchFn(title);
    const results = res?.results ?? res?.data ?? [];
    if (!Array.isArray(results) || results.length === 0) return [];

    const clean = normalize(title);
    const candidates: (string | number)[] = [];
    const seen = new Set<string | number>();
    const idOf = (r: any): string | number | null => r?.id ?? r?.animeId ?? null;

    for (const r of results) {
      const rName = normalize(
        typeof r.title === "string" ? r.title : r.title?.romaji || r.title?.english || ""
      );
      if (!rName.includes(clean) && !clean.includes(rName)) continue;
      const id = idOf(r);
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      candidates.push(id);
    }
    if (candidates.length > 0) return candidates;

    const fallback = idOf(results[0]);
    return fallback !== null ? [fallback] : [];
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
        () => searchProvider("allmanga", (q) => allmanga.search(q), title),
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

const availabilityCache = new Map<string, Episode[]>();
const AVAILABILITY_CACHE_MAX = 200;

function getAvailabilityCacheKey(title: string, anilistId?: number, providerName?: string): string {
  return `${providerName || "auto"}::${anilistId || ""}:${normalize(title)}`;
}

function isEpisodeAvailable(ep: Episode): boolean {
  if (!ep.id) return false;
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

function filterAvailableEpisodes(
  episodes: Episode[],
  _animeTitle: string,
  _anilistId?: number
): Episode[] {
  return episodes.map((ep) => ({
    ...ep,
    available: isEpisodeAvailable(ep),
  }));
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
 * Resolve sub/dub flags for a freshly fetched episode list.
 *
 * Without `probe` this is pure bookkeeping (no I/O): it folds in flags an
 * earlier probe already learned and summarizes what is known. With `probe` it
 * also hits megaplay once per unknown (episode, version), up to
 * `AUDIO_PROBE_MAX_EPISODES`. Returns a NEW array when flags change — the
 * caller's array may be the shared availability cache.
 */
export async function getAudioFlags(
  episodes: Episode[],
  anilistId?: number,
  probe = false
): Promise<{ episodes: Episode[]; audio: AudioSummary }> {
  const merge = (list: Episode[], flags: Map<number, AudioFlag>): Episode[] =>
    list.map((ep) => {
      // Probe results describe megaplay's listing only — never tag another
      // provider's episodes with them.
      if (ep.providerId !== "megaplay") return ep;
      const flag = flags.get(ep.number);
      if (!flag) return ep;
      return { ...ep, hasSub: ep.hasSub ?? flag.sub, hasDub: ep.hasDub ?? flag.dub };
    });

  let resolved = episodes;
  const cached = anilistId ? audioFlagCache.get(anilistId) : undefined;
  if (cached && cached.size > 0) resolved = merge(resolved, cached);

  const canProbe = canProbeAudio(resolved, anilistId);
  let probed = false;
  if (probe && canProbe && anilistId) {
    const flags = await probeMegaPlayAudio(anilistId, resolved);
    resolved = merge(resolved, flags);
    probed = true;
  }

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

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Fetch the episode list for an anime by trying all providers.
 * Filters out unavailable episodes (no sources / unstreamable).
 * Returns the first provider that successfully returns available episodes.
 * If `providerName` is given, only that provider is tried.
 */
export async function getEpisodes(
  animeTitle: string,
  anilistId?: number,
  providerName?: string
): Promise<Episode[]> {
  const cacheKey = getAvailabilityCacheKey(animeTitle, anilistId, providerName);
  const cached = availabilityCache.get(cacheKey);
  if (cached) return cached;

  let candidateEpisodes: Episode[] = [];

  // Try specific provider if requested
  if (providerName) {
    if (providerName === "megaplay" && anilistId) {
      const session = await getMegaPlaySession(anilistId, animeTitle);
      if (session) {
        candidateEpisodes = session.episodes
          .map((ep: any) => ({
            id: ep.id,
            number: ep.number,
            title: ep.title || undefined,
            image: ep.image || ep.img || undefined,
            providerId: "megaplay" as const,
            hasDub: ep.hasDub ?? null,
            hasSub: ep.hasSub ?? null,
            airDate: ep.airDate || undefined,
          }))
          .sort((a: Episode, b: Episode) => a.number - b.number);
      }
    } else {
      for (const provider of PROVIDERS) {
        if (provider.name !== providerName) continue;
        try {
          const session = await provider.getSession(animeTitle, anilistId);
          if (!session) continue;

          candidateEpisodes = session.episodes
            .map((ep: any) => ({
              id: ep.id,
              number: ep.number,
              title: ep.title || undefined,
              image: ep.image || ep.img || undefined,
              providerId: provider.name as any,
              hasDub: ep.hasDub ?? null,
              hasSub: ep.hasSub ?? null,
              airDate: ep.airDate || undefined,
            }))
            .sort((a: Episode, b: Episode) => a.number - b.number);
          break;
        } catch (err) {
          console.warn(`[providers] getEpisodes(${providerName}) getSession failed:`, err instanceof Error ? err.message : err);
          continue;
        }
      }
    }
  } else {
    // Try megaplay first if we have an AniList ID (it's most reliable)
    if (anilistId) {
      try {
        const session = await getMegaPlaySession(anilistId, animeTitle);
        if (session) {
          candidateEpisodes = session.episodes
            .map((ep: any) => ({
              id: ep.id,
              number: ep.number,
              title: ep.title || undefined,
              image: ep.image || ep.img || undefined,
              providerId: "megaplay" as const,
              hasDub: ep.hasDub ?? null,
              hasSub: ep.hasSub ?? null,
              airDate: ep.airDate || undefined,
            }))
            .sort((a: Episode, b: Episode) => a.number - b.number);
        }
      } catch (err) {
        console.warn(`[providers] getEpisodes megaplay failed:`, err instanceof Error ? err.message : err);
        // fall through
      }
    }

    // Try each provider in order if megaplay yielded no episodes
    if (candidateEpisodes.length === 0) {
      for (const provider of PROVIDERS) {
        try {
          const session = await provider.getSession(animeTitle, anilistId);
          if (!session) continue;

          candidateEpisodes = session.episodes
            .map((ep: any) => ({
              id: ep.id,
              number: ep.number,
              title: ep.title || undefined,
              image: ep.image || ep.img || undefined,
              providerId: provider.name as any,
              hasDub: ep.hasDub ?? null,
              hasSub: ep.hasSub ?? null,
              airDate: ep.airDate || undefined,
            }))
            .sort((a: Episode, b: Episode) => a.number - b.number);

          if (candidateEpisodes.length > 0) break;
        } catch (err) {
          console.warn(`[providers] getEpisodes(${provider.name}) failed:`, err instanceof Error ? err.message : err);
          continue;
        }
      }
    }
  }

  if (candidateEpisodes.length === 0) return [];

  const availableEpisodes = filterAvailableEpisodes(candidateEpisodes, animeTitle, anilistId);
  availabilityCache.set(cacheKey, availableEpisodes);
  if (availabilityCache.size > AVAILABILITY_CACHE_MAX) {
    const firstKey = availabilityCache.keys().next().value;
    if (firstKey) availabilityCache.delete(firstKey);
  }
  return availableEpisodes;
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
        const session = await getMegaPlaySession(anilistId, animeTitle);
        if (session) {
          const targetEp = session.episodes.find((ep: any) => ep.number === episodeNumber);
          if (targetEp?.id) {
            const result = await getMegaPlaySources(targetEp.id, type, episodeNumber);
            if (result) {
              return { ...result, providerId: "megaplay" };
            }
          }
        }
      } catch (err) {
        console.warn(`[providers] megaplay phase1 failed:`, err instanceof Error ? err.message : err);
      }
    }

    // Try the named provider from PROVIDERS list
    for (const provider of PROVIDERS) {
      if (provider.name !== preferredProvider) continue;
      tried.push(provider.name);
      try {
        const session = await provider.getSession(animeTitle, undefined, episodeNumber);
        if (!session) {
          continue;
        }

        const targetEp = session.episodes.find((ep: any) => ep.number === episodeNumber);
        if (!targetEp?.id) {
          continue;
        }

        const result = await provider.getSources(targetEp.id, type, episodeNumber, server);
        if (result) {
          return { ...result, providerId: provider.name };
        }
      } catch (err) {
        console.warn(`[providers] ${provider.name} phase1 failed:`, err instanceof Error ? err.message : err);
      }
      break;
    }
  }

  // ── Phase 2: Try all providers in order ──
  for (const provider of PROVIDERS) {
    // Skip if already tried as preferred
    if (preferredProvider && provider.name === preferredProvider) continue;
    tried.push(provider.name);

    try {
      const session = await provider.getSession(animeTitle, undefined, episodeNumber);
      if (!session) {
        continue;
      }

      const targetEp = session.episodes.find((ep: any) => ep.number === episodeNumber);
      if (!targetEp?.id) {
        continue;
      }

      const result = await provider.getSources(targetEp.id, type, episodeNumber, server);
      if (result) {
        return { ...result, providerId: provider.name };
      }
    } catch (err) {
      console.warn(`[providers] ${provider.name} phase2 failed:`, err instanceof Error ? err.message : err);
      continue;
    }
  }

  // ── Phase 3: Try megaplay directly with AniList ID (if not already tried) ──
  if (anilistId && preferredProvider !== "megaplay") {
    tried.push("megaplay");
    try {
      const session = await getMegaPlaySession(anilistId, animeTitle);
      if (session) {
        const targetEp = session.episodes.find((ep: any) => ep.number === episodeNumber);
        if (targetEp?.id) {
          const result = await getMegaPlaySources(targetEp.id, type, episodeNumber);
          if (result) {
            return { ...result, providerId: "megaplay" };
          }
        }
      }
    } catch (err) {
      console.warn(`[providers] megaplay phase3 failed:`, err instanceof Error ? err.message : err);
    }
  }

  console.warn(`[providers] getStreamingSources("${animeTitle}", ep${episodeNumber}, ${type}) — all providers failed. Tried:`, tried);
  return null;
}

/**
 * Fallback: try every provider with both sub and dub, returns first success.
 */
export async function getStreamingSourcesFallback(
  animeTitle: string,
  episodeNumber: number,
  anilistId?: number
): Promise<
  { sources: StreamSource[]; subtitles: Subtitle[]; headers?: Record<string, string>; providerId: string; intro?: { start: number; end: number }; outro?: { start: number; end: number } }
  | null
> {
  // Try sub first
  const subResult = await getStreamingSources(animeTitle, episodeNumber, "sub", undefined, anilistId);
  if (subResult) return subResult;

  // Try dub
  const dubResult = await getStreamingSources(animeTitle, episodeNumber, "dub", undefined, anilistId);
  if (dubResult) return dubResult;

  return null;
}

/**
 * Discover which providers have sessions available for this anime.
 * Returns provider names ordered by preference.
 */
export async function getAvailableProviders(
  animeTitle: string,
  anilistId?: number
): Promise<string[]> {
  const results: string[] = [];

  // Try megaplay first (most reliable with anilist ID)
  if (anilistId) {
    try {
      const session = await getMegaPlaySession(anilistId, animeTitle);
      if (session) results.push("megaplay");
    } catch { /* skip */ }
  }

  // Try all other providers in parallel
  const providerResults = await Promise.allSettled(
    PROVIDERS.map(async (p) => {
      const session = await p.getSession(animeTitle);
      return session ? p.name : null;
    })
  );

  for (const r of providerResults) {
    if (r.status === "fulfilled" && r.value) {
      if (!results.includes(r.value)) results.push(r.value);
    }
  }

  return results;
}
