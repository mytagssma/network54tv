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
} from "kaizoku-core";
import type { Episode, StreamSource, Subtitle } from "@/types/anime";

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
 * Try to find the best-matching anime for `title` using a provider's `search` function,
 * returning the provider-specific ID.
 */
async function searchProvider(
  providerName: string,
  searchFn: (q: string) => Promise<any>,
  title: string
): Promise<string | null> {
  try {
    const res = await searchFn(title);
    const results = res?.results ?? res?.data ?? [];
    if (!Array.isArray(results) || results.length === 0) return null;

    const clean = normalize(title);
    const match = results.find((r: any) => {
      const rName = normalize(
        typeof r.title === "string" ? r.title : r.title?.romaji || r.title?.english || ""
      );
      return rName.includes(clean) || clean.includes(rName);
    }) || results[0];

    return match?.id ?? match?.animeId ?? null;
  } catch {
    return null;
  }
}

// ─── Episode Retrieval ────────────────────────────────────────────────

async function getSessionForProvider(
  providerName: string,
  title: string,
  doSearch: () => Promise<string | null>,
  doFetchInfo: (id: string) => Promise<any>
): Promise<ProviderSession | null> {
  const key = cacheKey(providerName, title);
  const cached = sessionCache.get(key);
  if (cached) return cached;

  try {
    const id = await doSearch();
    if (!id) return null;

    const info = await doFetchInfo(id);
    const episodes = info?.episodes ?? info?.data?.episodes ?? [];
    if (!Array.isArray(episodes) || episodes.length === 0) return null;

    const session: ProviderSession = { providerId: providerName, animeId: id, episodes };
    sessionCache.set(key, session);
    if (sessionCache.size > SESSION_CACHE_MAX) {
      const firstKey = sessionCache.keys().next().value;
      if (firstKey) sessionCache.delete(firstKey);
    }
    return session;
  } catch {
    return null;
  }
}

// ─── Provider Definitions ─────────────────────────────────────────────

interface ProviderDef {
  name: string;
  getSession: (title: string) => Promise<ProviderSession | null>;
  getSources: (episodeId: string, type: "sub" | "dub", episodeNumber: number, server?: string) => Promise<StreamResult | null>;
}

const PROVIDERS: ProviderDef[] = [
  // 1. anikoto — primary, has server selection
  {
    name: "anikoto",
    getSession: (title) =>
      getSessionForProvider(
        "anikoto",
        title,
        () => searchProvider("anikoto", (q) => anikoto.search(q), title),
        (id) => anikoto.fetchAnimeInfo(id)
      ),
    getSources: async (episodeId, type, _ep, server) => {
      const data = await anikoto.fetchSources(
        episodeId,
        type as any,
        (server as any) || "vidstream-2"
      );
      return toStreamResult(data, "anikoto");
    },
  },

  // 2. anizone
  {
    name: "anizone",
    getSession: (title) =>
      getSessionForProvider(
        "anizone",
        title,
        () => searchProvider("anizone", (q) => anizone.search(q), title),
        (id) => anizone.fetchAnimeInfo(id)
      ),
    getSources: async (episodeId, _type, episodeNumber, _server) => {
      const data = await anizone.fetchSources(episodeId, undefined, episodeNumber);
      return toStreamResult(data, "anizone");
    },
  },

  // 3. allmanga
  {
    name: "allmanga",
    getSession: (title) =>
      getSessionForProvider(
        "allmanga",
        title,
        () => searchProvider("allmanga", (q) => allmanga.search(q), title),
        (id) => allmanga.fetchAnimeInfo(id)
      ),
    getSources: async (episodeId, type, _ep, _server) => {
      const data = await allmanga.fetchSources(episodeId, type);
      return toStreamResult(data, "allmanga");
    },
  },

  // 4. anineko
  {
    name: "anineko",
    getSession: (title) =>
      getSessionForProvider(
        "anineko",
        title,
        () => searchProvider("anineko", (q) => anineko.search(q), title),
        (id) => anineko.fetchAnimeInfo(id)
      ),
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
    getSession: (title) =>
      getSessionForProvider(
        "animeunity",
        title,
        () => searchProvider("animeunity", (q) => animeunity.search(q), title),
        (id) => animeunity.fetchAnimeInfo(id)
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

function toStreamResult(
  data: any,
  providerId: string
): StreamResult | null {
  if (!data) return null;
  const sources: StreamSource[] = (data.sources || [])
    .filter((s: any) => s?.url)
    .map((s: any) => ({
      url: s.url,
      quality: s.quality || "auto",
      isM3U8: s.isM3U8 !== false,
    }));

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
  } catch {
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
    return toStreamResult(data, "megaplay");
  } catch {
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
          const session = await provider.getSession(animeTitle);
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
        } catch {
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
      } catch {
        // fall through
      }
    }

    // Try each provider in order if megaplay yielded no episodes
    if (candidateEpisodes.length === 0) {
      for (const provider of PROVIDERS) {
        try {
          const session = await provider.getSession(animeTitle);
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
        } catch {
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
  // ── Phase 1: Try the preferred provider first (matches episode list source) ──
  if (preferredProvider) {
    // Try megaplay if preferred
    if (preferredProvider === "megaplay" && anilistId) {
      try {
        const session = await getMegaPlaySession(anilistId, animeTitle);
        if (session) {
          const targetEp = session.episodes.find((ep: any) => ep.number === episodeNumber);
          if (targetEp?.id) {
            const result = await getMegaPlaySources(targetEp.id, type, episodeNumber);
            if (result) return { ...result, providerId: "megaplay" };
          }
        }
      } catch { /* fall through */ }
    }

    // Try the named provider from PROVIDERS list
    for (const provider of PROVIDERS) {
      if (provider.name !== preferredProvider) continue;
      try {
        const session = await provider.getSession(animeTitle);
        if (!session) continue;

        const targetEp = session.episodes.find((ep: any) => ep.number === episodeNumber);
        if (!targetEp?.id) continue;

        const result = await provider.getSources(targetEp.id, type, episodeNumber, server);
        if (result) return { ...result, providerId: provider.name };
      } catch { /* fall through */ }
      break;
    }
  }

  // ── Phase 2: Try all providers in order ──
  for (const provider of PROVIDERS) {
    // Skip if already tried as preferred
    if (preferredProvider && provider.name === preferredProvider) continue;

    try {
      const session = await provider.getSession(animeTitle);
      if (!session) continue;

      const targetEp = session.episodes.find((ep: any) => ep.number === episodeNumber);
      if (!targetEp?.id) continue;

      const result = await provider.getSources(targetEp.id, type, episodeNumber, server);
      if (result) {
        return { ...result, providerId: provider.name };
      }
    } catch {
      continue;
    }
  }

  // ── Phase 3: Try megaplay directly with AniList ID (if not already tried) ──
  if (anilistId && preferredProvider !== "megaplay") {
    try {
      const session = await getMegaPlaySession(anilistId, animeTitle);
      if (session) {
        const targetEp = session.episodes.find((ep: any) => ep.number === episodeNumber);
        if (targetEp?.id) {
          const result = await getMegaPlaySources(targetEp.id, type, episodeNumber);
          if (result) return { ...result, providerId: "megaplay" };
        }
      }
    } catch {
      // fall through
    }
  }

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
