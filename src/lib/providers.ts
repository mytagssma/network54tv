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
  anibd,
  animesogo,
  twodhive,
  configure,
} from "kaizoku-core";
import type { Episode, StreamSource, Subtitle } from "@/types/anime";
import { getAnimeById, getAnimeFull } from "@/lib/anilist";
import { resolveEpisodeFraction } from "@/lib/anime-meta";
import { buildSiteUrl } from "@/lib/site-url";
import { extractBabaStream } from "@/lib/babastream";

// ─── Wire scrape proxy for Cloudflare-protected providers ──────────────
// kaizoku-core reads SCRAPE_PROXY_URL/SCRAPE_PROXY_KEY from env automatically,
// but we call configure() explicitly to ensure it's set before any provider runs.
const scrapeProxyUrl = process.env.SCRAPE_PROXY_URL;
const scrapeProxyKey = process.env.SCRAPE_PROXY_KEY;

// Point kaizoku-core's internal AniList client to our proxy (adds Origin header
// to bypass AniList's server-IP block). The /api/anilist/fetch route forwards
// with browser-like headers. buildSiteUrl lives in @/lib/site-url (shared with
// lib/anilist's server-side GraphQL routing).
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
  return (
    s
      .toLowerCase()
      // Multiplication glyphs in romaji titles ("HUNTER×HUNTER", "SPY×FAMILY")
      // are the letter x on every provider's side — map them to a SPACED x
      // BEFORE the strip below, or the words glue together ("hunterhunter")
      // and no provider search hit can ever match them.
      .replace(/[×✕✖]/g, " x ")
      .replace(/[^a-z0-9\s]/g, "")
      // Collapse the spaces the glyph map may have doubled ("a× b" → "a x  b").
      .replace(/\s+/g, " ")
      .trim()
  );
}

// ─── Negative cache ──────────────────────────────────────────────────
//
// Some upstream calls fail UNCONDITIONALLY for a given anime and re-pay
// their full cost on every single provider walk: animeunity's search
// answers 403 to every query (bot wall — measured ~50×/session in the dev
// log), anineko's resolveSeries scrapes AniList + AniZip + several
// catalogue searches before concluding "match not found" for titles it
// simply doesn't carry (~66×), and megaplay's session fetch rides
// AniList's rate limiter (the 429s in the log). A short-lived "this
// failed recently" marker keyed per anime stops the repeat payment
// WITHOUT touching node_modules; a success clears the marker, so a
// provider that recovers is consulted again on the next walk.
const negativeCache = new Map<string, number>(); // key → expiresAt
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_CACHE_MAX = 500;

/** Scope-guarded key: `${scope}::${anilistId}:${normalized title}`. */
function negativeCacheKey(scope: string, title: string, anilistId?: number): string {
  return `${scope}::${anilistId ?? ""}:${normalize(title)}`;
}

function isNegativelyCached(key: string): boolean {
  const expiresAt = negativeCache.get(key);
  if (expiresAt === undefined) return false;
  if (Date.now() >= expiresAt) {
    negativeCache.delete(key);
    return false;
  }
  return true;
}

function rememberNegative(key: string): void {
  negativeCache.set(key, Date.now() + NEGATIVE_CACHE_TTL_MS);
  if (negativeCache.size > NEGATIVE_CACHE_MAX) {
    const oldest = negativeCache.keys().next().value;
    if (oldest !== undefined) negativeCache.delete(oldest);
  }
}

function forgetNegative(key: string): void {
  negativeCache.delete(key);
}

/**
 * Token-level Jaccard similarity between two (already normalizable) titles.
 * Used to decide whether a lone search hit still looks like the requested
 * anime — e.g. the trailing year in "HUNTER×HUNTER (2011)" against a
 * provider's bare "Hunter x Hunter", or a romaji query against an English
 * display title (the substring test above misses while the anime matches).
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
  // Romaji "×" titles ("HUNTER×HUNTER", "SPY×FAMILY") are indexed on provider
  // search endpoints in the letter-x form — query that form FIRST so the
  // (slower, multi-second) provider search isn't spent on a query that
  // returns nothing. The raw form stays as a fallback. Matching below runs
  // on normalized names either way, so this only affects which query reaches
  // the provider, never how hits are scored.
  const xForm = title
    .replace(/[×✕✖]/g, " x ")
    .replace(/\s+/g, " ")
    .trim();
  if (xForm !== title) {
    variants.length = 0;
    push(xForm);
    push(title);
  }
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
  idOfResult?: (r: any) => string | number | null,
  negativeKey?: string
): Promise<(string | number)[]> {
  try {
    // A recently-cached unconditional failure (see the negative cache
    // section) is not worth re-paying — treat it as "this provider has
    // nothing for this anime" until the marker expires.
    if (negativeKey && isNegativelyCached(negativeKey)) {
      console.warn(
        `[providers] searchProvider(${providerName}) skipped — recent failure is negative-cached for "${title}"`
      );
      return [];
    }
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
      // The upstream ANSWERED — any earlier failure marker for this key is
      // obsolete, even when this answer itself carries no candidates.
      if (negativeKey) forgetNegative(negativeKey);
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
    // Only the UNCONDITIONAL block (403) is worth remembering — a transient
    // blip (timeout / reset) should be retried on the very next walk.
    if (
      negativeKey &&
      /(?:^|\D)403(?:\D|$)|Forbidden/i.test(err instanceof Error ? err.message : String(err))
    ) {
      rememberNegative(negativeKey);
    }
    return [];
  }
}

// ─── Episode Retrieval ────────────────────────────────────────────────

// ─── Episode-number normalization (AniZip) ───────────────────────────
//
// Providers number the SAME episode differently: a season-2 entry is listed
// 1..N on one site, 171.. (TVDB absolute) on another, and the numbering the
// watch page serves is yet another one. An exact `ep.number === episodeNumber`
// find therefore misses on a provider that carries the episode under a
// sibling number, and the walk reports NO STREAM FOUND for an episode that
// exists.
//
// The mapping reused here is AniZip's — the very document kaizoku-core already
// fetches to BUILD megaplay's and allmanga's episode lists
// (`https://api.ani.zip/mappings?anilist_id=`; see megaplay.js/allmanga.js in
// node_modules/kaizoku-core). Per episode it states the key the list is built
// from, the season-local number (`seasonNumber`/`episodeNumber`) and the
// absolute number (`absoluteEpisodeNumber`), so a number can be translated
// between schemes without inventing an offset.

interface AniZipEpisode {
  seasonNumber?: number;
  episodeNumber?: number;
  absoluteEpisodeNumber?: number;
  airDate?: string;
  airdate?: string;
  title?: Record<string, string | undefined> | null;
}

interface AniZipMapping {
  episodes: Record<string, AniZipEpisode | undefined>;
}

const anizipCache = new Map<number, { data: AniZipMapping | null; expiresAt: number }>();
const ANIZIP_CACHE_MAX = 50;
/** A found mapping is stable; a miss (new/unknown id, upstream blip) retries soon. */
const ANIZIP_TTL_OK_MS = 10 * 60 * 1000;
const ANIZIP_TTL_MISS_MS = 60 * 1000;

async function getAniZipMapping(anilistId: number): Promise<AniZipMapping | null> {
  const cached = anizipCache.get(anilistId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  let data: AniZipMapping | null = null;
  try {
    const res = await fetch(`https://api.ani.zip/mappings?anilist_id=${anilistId}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const json = await res.json();
      if (json && typeof json === "object" && json.episodes && typeof json.episodes === "object") {
        data = json as AniZipMapping;
      }
    }
  } catch {
    data = null; // network/timeout — degrade to "no normalization", never throw
  }
  if (anizipCache.size >= ANIZIP_CACHE_MAX) {
    const oldest = anizipCache.keys().next().value;
    if (oldest !== undefined) anizipCache.delete(oldest);
  }
  anizipCache.set(anilistId, {
    data,
    expiresAt: Date.now() + (data ? ANIZIP_TTL_OK_MS : ANIZIP_TTL_MISS_MS),
  });
  return data;
}

/** Lowercased alphanumerics only, so "Action Kamen VS" ≡ "actionkamenvs". */
function normalizeEpisodeTitle(s?: string | null): string {
  return typeof s === "string" ? s.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

/** Every language variant AniZip ships for an episode, normalized. */
function anizipTitleVariants(ep: AniZipEpisode): string[] {
  const title = ep.title;
  if (!title || typeof title !== "object") return [];
  return Object.values(title).map(normalizeEpisodeTitle).filter(Boolean);
}

/** `YYYY-MM-DD` of an AniZip episode, or null when it carries no date. */
function anizipAirDate(ep: AniZipEpisode): string | null {
  const raw =
    typeof ep.airDate === "string" && ep.airDate
      ? ep.airDate
      : typeof ep.airdate === "string" && ep.airdate
        ? ep.airdate
        : null;
  return raw ? raw.slice(0, 10) : null;
}

/**
 * Loose shape of a raw provider episode — upstream payloads vary, so every
 * field is optional; the normalizer only reads these.
 */
interface RawEpisode {
  id?: string | number | null;
  number?: number;
  title?: string | null;
  airDate?: string | null;
  aired?: string | null;
  airdate?: string | null;
}

/** `YYYY-MM-DD` of a provider episode (same shape AniZip uses), or null. */
function episodeAirDate(ep: RawEpisode | undefined | null): string | null {
  const raw = ep?.airDate ?? ep?.aired ?? ep?.airdate;
  return typeof raw === "string" && raw ? raw.slice(0, 10) : null;
}

interface EpisodeNumberCandidate {
  /** The number the provider lists this episode under. */
  number: number;
  /** The AniZip episode the REQUESTED number refers to (identity anchor). */
  target: AniZipEpisode;
  via: "absolute" | "season-local" | "key";
}

/**
 * Numbers a provider might list the requested episode under, derived from the
 * AniZip mapping of `anilistId` — never from an inferred offset:
 *  - requested-as-key (the watch page numbering) → the episode's absolute
 *    number and its season-local number;
 *  - requested-as-absolute → the mapping key and the season-local number.
 * The requested number itself is excluded (the caller already tried it).
 */
function anizipCandidateNumbers(requested: number, mapping: AniZipMapping): EpisodeNumberCandidate[] {
  const candidates = new Map<number, { target: AniZipEpisode; via: EpisodeNumberCandidate["via"] }>();
  const add = (
    num: unknown,
    target: AniZipEpisode,
    via: EpisodeNumberCandidate["via"]
  ): void => {
    if (typeof num !== "number" || !Number.isInteger(num) || num <= 0 || num === requested) return;
    if (!candidates.has(num)) candidates.set(num, { target, via });
  };

  const byKey = mapping.episodes[String(requested)];
  if (byKey) {
    add(byKey.absoluteEpisodeNumber, byKey, "absolute");
    add(byKey.episodeNumber, byKey, "season-local");
  }
  for (const [key, ep] of Object.entries(mapping.episodes)) {
    if (!ep || ep.absoluteEpisodeNumber !== requested) continue;
    add(Number(key), ep, "key");
    add(ep.episodeNumber, ep, "season-local");
  }
  return [...candidates.entries()].map(([number, c]) => ({ number, ...c }));
}

/**
 * Identity proof that a provider episode IS a given AniZip episode: its title
 * (any language AniZip ships) equals the provider's title, or its air date is
 * the provider episode's ONLY matching air date in the whole listing. A
 * translation whose candidate fails this is a number collision, not a match.
 */
function verifyAgainstAniZip(
  ep: RawEpisode | undefined,
  target: AniZipEpisode,
  episodes: RawEpisode[]
): "title" | "airdate" | null {
  const providerTitle = normalizeEpisodeTitle(ep?.title);
  if (providerTitle && anizipTitleVariants(target).includes(providerTitle)) return "title";

  const targetDate = anizipAirDate(target);
  const epDate = episodeAirDate(ep);
  if (targetDate && epDate && targetDate === epDate) {
    // Same air date alone is only decisive when the listing has a single
    // episode that day — otherwise the candidate is one of several and the
    // normalization is ambiguous.
    const sameDay = episodes.filter((e) => episodeAirDate(e) === targetDate);
    if (sameDay.length === 1) return "airdate";
  }
  return null;
}

/**
 * Exact-match MISS → try a SAFE normalized match against the AniZip mapping.
 *
 * Returns the provider episode only when the match is CONFIDENT:
 *  - the requested number translates to exactly ONE number the listing
 *    carries (several candidates ⇒ ambiguous ⇒ null), AND
 *  - that episode proves it is the same episode by title or unique air date.
 * Anything else returns null — exactly like before — so a wrong episode is
 * never played.
 */
async function normalizedEpisodeMatch(
  episodes: RawEpisode[],
  requested: number,
  anilistId: number | undefined,
  providerName: string,
  opts: { logUse: boolean; logReject: boolean }
): Promise<RawEpisode | null> {
  if (!anilistId || !Number.isInteger(requested) || !Array.isArray(episodes) || episodes.length === 0) {
    return null;
  }
  const mapping = await getAniZipMapping(anilistId);
  if (!mapping) return null;

  const candidates = anizipCandidateNumbers(requested, mapping).filter((c) =>
    episodes.some((e) => e?.number === c.number && e?.id)
  );
  if (candidates.length === 0) return null;

  if (candidates.length > 1) {
    if (opts.logReject) {
      console.warn(
        `[providers] ${providerName}: ep${requested} normalization REJECTED as ambiguous ` +
          `(anilistId=${anilistId} maps to listed episodes ${candidates.map((c) => c.number).join(", ")})`
      );
    }
    return null;
  }

  const candidate = candidates[0];
  const ep = episodes.find((e) => e?.number === candidate.number);
  const verifiedBy = verifyAgainstAniZip(ep, candidate.target, episodes);
  if (!verifiedBy) {
    if (opts.logReject) {
      console.warn(
        `[providers] ${providerName}: ep${requested} → ep${candidate.number} normalization REJECTED ` +
          `(anilistId=${anilistId}, via ${candidate.via}) — title/air date do not prove the same episode`
      );
    }
    return null;
  }

  if (opts.logUse) {
    console.warn(
      `[providers] ${providerName}: normalized ep${requested} → ep${candidate.number} ` +
        `(anilistId=${anilistId}, via ${candidate.via}, verified by ${verifiedBy})`
    );
  }
  // The candidate filter above only keeps episodes with an `id`, so `ep` is
  // defined here; `?? null` keeps the return type honest anyway.
  return ep ?? null;
}

/**
 * Alternate search titles for `anilistId` — AniList's english name plus
 * synonyms, which is where Chinese anime usually carry the name catalogues
 * actually use ("Zhu Xian Final" ↔ "Jade Dynasty 4"). Only consulted AFTER a
 * primary-title search already came up empty (see `getSessionForProvider`),
 * so the normal path pays nothing. Capped at 3 to bound per-provider search
 * volume.
 *
 * Memoized per AniList id: this runs once per search-provider attempt, so
 * without a cache a single miss-title walk fires 6+ AniList fetches — a
 * measured burst that tripped upstream 429s, and each 429 costs ~10s in
 * proxy retries (walks collapsed to 42s). Failures memoize too, but for only
 * 60s so a transient blip doesn't silence alternates for 10 minutes.
 */
const altTitleCache = new Map<number, { titles: string[]; at: number }>();
const ALT_TTL_OK_MS = 10 * 60_000;
const ALT_TTL_FAIL_MS = 60_000;

async function searchAltTitles(anilistId: number): Promise<string[]> {
  const now = Date.now();
  const hit = altTitleCache.get(anilistId);
  if (hit) {
    const ttl = hit.titles.length > 0 ? ALT_TTL_OK_MS : ALT_TTL_FAIL_MS;
    if (now - hit.at < ttl) return hit.titles;
  }
  try {
    const full = await getAnimeFull(anilistId);
    const seen = new Set<string>();
    const alts: string[] = [];
    const push = (v: unknown): void => {
      if (typeof v !== "string" || !v.trim()) return;
      const n = normalize(v);
      if (!n || seen.has(n)) return;
      seen.add(n);
      alts.push(v.trim());
    };
    push(full?.title?.english);
    for (const s of full?.synonyms ?? []) push(s);
    const titles = alts.slice(0, 3);
    altTitleCache.set(anilistId, { titles, at: now });
    return titles;
  } catch {
    // transient AniList failure — the primary title already failed anyway
    altTitleCache.set(anilistId, { titles: [], at: now });
    return [];
  }
}

async function getSessionForProvider(
  providerName: string,
  title: string,
  doSearch: (t: string) => Promise<(string | number)[]>,
  doFetchInfo: (id: string) => Promise<any>,
  episodeNumber?: number,
  anilistId?: number
): Promise<ProviderSession | null> {
  const key = cacheKey(providerName, title);
  const cached = sessionCache.get(key);
  if (cached) {
    // Only trust the cache if it can serve the requested episode — a cached
    // "Part 1" session (e.g. 11 eps) must not poison an ep-12 request.
    // "Serve" includes a verified normalized match (see `normalizedEpisodeMatch`),
    // so a cached sibling-numbered listing is not re-searched for nothing.
    const cachedOk =
      episodeNumber === undefined ||
      (Array.isArray(cached.episodes) &&
        (cached.episodes.some((e: any) => e?.number === episodeNumber) ||
          (await normalizedEpisodeMatch(cached.episodes, episodeNumber, anilistId, providerName, {
            logUse: false,
            logReject: false,
          })) !== null));
    if (cachedOk) return cached;
    // else fall through to re-search
  }

  try {
    let ids = await doSearch(title);
    // Primary title empty ⇒ retry with AniList's english name/synonyms for
    // the same media. Donghua catalogues split along pinyin↔English names
    // (AniList romaji "Zhu Xian Final", catalogue "Jade Dynasty 4"), so a
    // title-keyed search with only the romaji can never hit. On a miss only —
    // a primary hit skips this entirely.
    if (ids.length === 0 && anilistId) {
      const primaryNorm = normalize(title);
      for (const alt of await searchAltTitles(anilistId)) {
        if (normalize(alt) === primaryNorm) continue; // english==romaji row
        ids = await doSearch(alt);
        if (ids.length > 0) break;
      }
    }
    if (ids.length === 0) return null;

    for (const id of ids) {
      const info = await doFetchInfo(String(id));
      const episodes = info?.episodes ?? info?.data?.episodes ?? [];
      if (!Array.isArray(episodes) || episodes.length === 0) continue;
      if (episodeNumber !== undefined) {
        // Exact number first; a VERIFIED normalized match (same episode under a
        // sibling numbering — see `normalizedEpisodeMatch`) also qualifies. A
        // session that can serve neither keeps its old rejection here, so the
        // "Part 1"-listing guard above is unchanged in strength.
        const hasEpisode =
          episodes.some((e: any) => e?.number === episodeNumber) ||
          (await normalizedEpisodeMatch(episodes, episodeNumber, anilistId, providerName, {
            logUse: false,
            logReject: true,
          })) !== null;
        if (!hasEpisode) continue;
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
  /**
   * Optional escape hatch for providers whose LIST lags their own STREAM
   * backends: called only when the session exists but neither an exact
   * number match nor `normalizedEpisodeMatch` produced an episode id.
   * Returning an id lets `getSources` run anyway (the provider decides
   * whether that id is meaningful upstream); returning null keeps the
   * conservative skip.
   */
  resolveEpisodeId?: (session: ProviderSession, episodeNumber: number) => string | null;
}

const PROVIDERS: ProviderDef[] = [
  // 1. kickassanime — primary high-quality provider with multi-subtitle support
  {
    name: "kickassanime",
    getSession: (title, anilistId, episodeNumber) =>
      getSessionForProvider(
        "kickassanime",
        title,
        (t) => searchProvider("kickassanime", (q) => kickassanime.search(q), t),
        (id) => kickassanime.fetchAnimeInfo(id),
        episodeNumber,
        anilistId
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
    getSession: (title, anilistId, episodeNumber) =>
      getSessionForProvider(
        "anikoto",
        title,
        (t) => searchProvider("anikoto", (q) => anikoto.search(q), t),
        (id) => anikoto.fetchAnimeInfo(id),
        episodeNumber,
        anilistId
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
    getSession: (title, anilistId, episodeNumber) =>
      getSessionForProvider(
        "anizone",
        title,
        (t) => searchProvider("anizone", (q) => anizone.search(q), t),
        (id) => anizone.fetchAnimeInfo(id),
        episodeNumber,
        anilistId
      ),
    getSources: async (episodeId, _type, episodeNumber, _server) => {
      const data = await anizone.fetchSources(episodeId, undefined, episodeNumber);
      return toStreamResult(data, "anizone");
    },
  },

  // 3. allmanga
  {
    name: "allmanga",
    getSession: (title, anilistId, episodeNumber) =>
      getSessionForProvider(
        "allmanga",
        title,
        (t) =>
          searchProvider(
            "allmanga",
            (q) => allmanga.search(q),
            t,
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
        episodeNumber,
        anilistId
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
      // "match not found" is UNCONDITIONAL for titles anineko doesn't carry
      // — and reaching that conclusion costs AniList + AniZip + several
      // catalogue scrapes (measured ~66 repeats/session in the dev log).
      // Remember it for 10 min; a success clears the marker.
      const negKey = negativeCacheKey("anineko-resolve", title, anilistId);
      if (isNegativelyCached(negKey)) {
        console.warn(
          `[providers] anineko getSession skipped — recent "match not found" is negative-cached for anilistId=${anilistId}`
        );
        return null;
      }
      try {
        const info = await anineko.fetchAnimeInfo(String(anilistId));
        const episodes = info?.episodes ?? [];
        if (!Array.isArray(episodes) || episodes.length === 0) return null;
        forgetNegative(negKey);
        const session: ProviderSession = { providerId: "anineko", animeId: String(anilistId), episodes };
        sessionCache.set(cacheKeyStr, session);
        return session;
      } catch (err) {
        console.warn(`[providers] anineko getSession("${title}", anilistId=${anilistId}) failed:`, err instanceof Error ? err.message : err);
        if (err instanceof Error && /match not found/i.test(err.message)) {
          rememberNegative(negKey);
        }
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

  // 6. anibd — Chinese-anime (donghua) catalogue keyed on the AniList id
  // directly (no title search), on an independent stream backend. Covers
  // established donghua megaplay sometimes lacks; sub-only in practice.
  {
    name: "anibd",
    getSession: async (title, anilistId) => {
      if (!anilistId) return null;
      const cacheKeyStr = cacheKey("anibd", title);
      const cached = sessionCache.get(cacheKeyStr);
      if (cached) return cached;
      try {
        const episodes = await anibd.fetchEpisodes(anilistId);
        if (!Array.isArray(episodes) || episodes.length === 0) return null;
        const session: ProviderSession = { providerId: "anibd", animeId: String(anilistId), episodes };
        sessionCache.set(cacheKeyStr, session);
        if (sessionCache.size > SESSION_CACHE_MAX) {
          const firstKey = sessionCache.keys().next().value;
          if (firstKey) sessionCache.delete(firstKey);
        }
        return session;
      } catch (err) {
        console.warn(`[providers] anibd getSession("${title}", anilistId=${anilistId}) failed:`, err instanceof Error ? err.message : err);
        return null;
      }
    },
    getSources: async (episodeId, type) => {
      // No dub track exists (single S-sub server) — decline instead of
      // serving the sub for a dub request so the walk keeps looking.
      if (type === "dub") return null;
      const data = await anibd.fetchSources(episodeId);
      return toStreamResult(data, "anibd");
    },
  },

  // 7. 2dhive — MAL-keyed catalogue with the strongest donghua coverage we
  // measured (8/8 evergreen + titles megaplay's AniList-id mapping lags on).
  // Its session lookup converts AniList→MAL internally, so the entry is
  // still anilist-keyed at the walk level.
  {
    name: "2dhive",
    getSession: async (title, anilistId) => {
      if (!anilistId) return null;
      const cacheKeyStr = cacheKey("2dhive", title);
      const cached = sessionCache.get(cacheKeyStr);
      if (cached) return cached;
      // "No MAL id mapped …" is UNCONDITIONAL for titles without a MAL row
      // (brand-new airing entries) — re-paying AniList + their catalogue on
      // every walk adds up; remember for 10 min, a success clears it.
      const negKey = negativeCacheKey("2dhive-resolve", title, anilistId);
      if (isNegativelyCached(negKey)) {
        console.warn(`[providers] 2dhive getSession skipped — recent miss is negative-cached for anilistId=${anilistId}`);
        return null;
      }
      try {
        const info = await twodhive.fetchAnimeInfo(anilistId);
        const episodes = info?.episodes ?? [];
        if (!Array.isArray(episodes) || episodes.length === 0) return null;
        forgetNegative(negKey);
        const session: ProviderSession = { providerId: "2dhive", animeId: String(anilistId), episodes };
        sessionCache.set(cacheKeyStr, session);
        if (sessionCache.size > SESSION_CACHE_MAX) {
          const firstKey = sessionCache.keys().next().value;
          if (firstKey) sessionCache.delete(firstKey);
        }
        return session;
      } catch (err) {
        console.warn(`[providers] 2dhive getSession("${title}", anilistId=${anilistId}) failed:`, err instanceof Error ? err.message : err);
        if (err instanceof Error && /No MAL id/i.test(err.message)) rememberNegative(negKey);
        return null;
      }
    },
    getSources: async (episodeId, type) => {
      // kaizoku-core skips BabaStream — its proof-of-work needs worker_threads,
      // which Cloudflare Workers cannot use — but Baba is 2dhive's OWN default
      // server (`defaultServer: "babastream"` on their episode page) and the
      // backend that carries titles megaplay + hianime miss (measured: AiPri
      // ep29, BTTH4 ep62 resolve there while both wired paths report "no
      // stream"). We run on Node, so on the primary's throw, try Baba before
      // giving the provider up. Definitive misses are negative-cached inside
      // extractBabaStream — the proof-of-work makes re-paying for a miss
      // absurd — while network failures stay transient and fall through to
      // the provider error the walk already logs.
      try {
        const data = await twodhive.fetchSources(episodeId, type);
        return toStreamResult(data, "2dhive");
      } catch (primaryErr) {
        const [malRaw, epRaw] = String(episodeId).split("/");
        const malId = Number(malRaw);
        const epNum = Number(epRaw);
        if (Number.isFinite(malId) && Number.isFinite(epNum)) {
          try {
            const baba = await extractBabaStream(
              `https://babastream.top/embed/${malId}/${epNum}/${type}`
            );
            if (baba) return toStreamResult(baba, "2dhive");
          } catch (babaErr) {
            console.warn(
              `[providers] 2dhive baba fallback (MAL ${malId} ep${epNum} ${type}) failed:`,
              babaErr instanceof Error ? babaErr.message : babaErr
            );
          }
        }
        throw primaryErr;
      }
    },
    // 2dhive's list is the SERIES PAGE's `totalEpisodes`, which lags its own
    // stream backends (measured: page said 60 while BabaStream served ep62 of
    // BTTH4). Ids are "<malId>/<ep>", so a TAIL miss — a request beyond the
    // listed maximum — is synthesised from any listed id's prefix rather than
    // skipping the provider before the BabaStream fallback can even run.
    // In-range misses keep the normal match verdict: those are numbering
    // questions, not lag.
    resolveEpisodeId: (session, episodeNumber) => {
      const first = session.episodes[0]?.id;
      if (!first || !first.includes("/")) return null;
      const maxListed = session.episodes.reduce((max, ep) => Math.max(max, ep.number), 0);
      if (episodeNumber <= maxListed) return null;
      const prefix = first.slice(0, first.indexOf("/"));
      return `${prefix}/${episodeNumber}`;
    },
  },

  // 8. animesogo — gogo-style, TITLE-search keyed: measured recovering every
  // currently-airing donghua the AniList-id-keyed backends miss (new titles
  // are findable by name before their id mappings propagate upstream).
  {
    name: "animesogo",
    getSession: (title, anilistId, episodeNumber) =>
      getSessionForProvider(
        "animesogo",
        title,
        (t) => searchProvider("animesogo", (q) => animesogo.search(q), t),
        (id) => animesogo.fetchAnimeInfo(id),
        episodeNumber,
        anilistId
      ),
    getSources: async (episodeId, type) => {
      const data = await animesogo.fetchSources(episodeId, type);
      return toStreamResult(data, "animesogo");
    },
  },

  // 9. animeunity
  {
    name: "animeunity",
    getSession: (title, anilistId, episodeNumber) =>
      getSessionForProvider(
        "animeunity",
        title,
        (t) =>
          searchProvider(
            "animeunity",
            (q) => animeunity.search(q),
            t,
            undefined,
            // animeunity's archivio answers 403 to every query from this IP
            // (bot wall) — measured ~50 identical 403s per dev session. The
            // marker skips the walk-level search for 10 min; any success
            // clears it (see the negative cache section). Keyed per candidate
            // title so an alternate-title retry isn't skipped under the
            // primary title's marker (and vice versa).
            negativeCacheKey("animeunity-search", t, anilistId)
          ),
        (id) => animeunity.fetchAnimeInfo(id),
        episodeNumber,
        anilistId
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

/**
 * Drop provider-site bumper clips. Some KickAssAnime servers (e.g. CatStream)
 * resolve their player "manifest" to the site's own `intro.mp4` — a ~10KB
 * black bumper that played as a ~20-second blank "episode". No legitimate
 * stream lives at these paths: real sources are `.m3u8` manifests or
 * full-length progressive files elsewhere on the CDN. Pathname-only check
 * (query/hash ignored) so tokenized URLs still match.
 */
function isBumperSourceUrl(url: string): boolean {
  let path = url;
  try {
    path = new URL(url, "http://localhost").pathname;
  } catch {
    path = url.split(/[?#]/)[0] ?? url;
  }
  return /(^|\/)(intro|outro|preview|trailer|bumper)(?:[-._ ]?\d+)?\.(mp4|webm|m3u8|mkv)$/i.test(
    path
  );
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
    .filter(
      (s: any) =>
        s?.url && isPlayableSourceUrl(String(s.url)) && !isBumperSourceUrl(String(s.url))
    )
    .map((s: any) => ({
      url: s.url,
      quality: s.quality || "auto",
      isM3U8: s.isM3U8 !== false,
    }));

  // Empty after filtering (e.g. only unplayable `.mpd` sources, or only a
  // provider-site bumper clip) ⇒ treat as "provider produced nothing" so
  // getStreamingSources falls through to the next provider instead of
  // short-circuiting on an unplayable payload.
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

/**
 * MegaPlay session by AniList ID — the one provider with no search.
 *
 * Successful sessions are written into the SHARED `sessionCache` (keyed by
 * AniList ID, the only namespace megaplay addresses its catalogue by), with
 * the same eviction semantics `getSessionForProvider` uses. Until now this
 * function cached NOTHING, so every cold stream walk re-ran
 * megaplay.fetchAnimeInfo — an uncached AniList POST through
 * /api/anilist/fetch plus an AniZip fetch, serially, which is exactly where
 * the logged 429s originate.
 *
 * Like `getSessionForProvider`, a cached listing is only trusted when it can
 * serve the requested `episodeNumber` (exact number or a verified AniZip
 * normalized match) — otherwise the list is re-fetched so a newly aired
 * episode is never held back by a months-old cached listing.
 *
 * Failures are NOT stored in `sessionCache`: a thrown 429/network failure
 * goes through the negative cache instead (below), and an EMPTY listing is
 * simply returned as null so a future walk retries it for free.
 */
export async function getMegaPlaySession(
  anilistId: number,
  _title: string,
  episodeNumber?: number
): Promise<ProviderSession | null> {
  const cacheKeyStr = `megaplay::id:${anilistId}`;
  // Positive entries are keyed by the AniList ID alone (megaplay addresses
  // its catalogue only by ID, and one anime answers under several title
  // spellings — the log shows id 162561 under both "NARUTO×NINKU" and
  // "NARUTO (2026)"); the negative marker follows the shared title+id
  // convention of the negative cache section.
  const negKey = negativeCacheKey("megaplay-session", _title, anilistId);

  const cached = sessionCache.get(cacheKeyStr);
  if (cached) {
    // Only trust the cache if it can serve the requested episode — a cached
    // listing that predates a newly aired episode must not poison the walk.
    const cachedOk =
      episodeNumber === undefined ||
      (Array.isArray(cached.episodes) &&
        (cached.episodes.some((ep) => ep?.number === episodeNumber) ||
          (await normalizedEpisodeMatch(cached.episodes, episodeNumber, anilistId, "megaplay", {
            logUse: false,
            logReject: false,
          })) !== null));
    if (cachedOk) return cached;
    // else fall through to re-fetch
  }

  if (isNegativelyCached(negKey)) {
    console.warn(
      `[providers] getMegaPlaySession(anilistId=${anilistId}) skipped — recent failure is negative-cached`
    );
    return null;
  }

  try {
    const info = await megaplay.fetchAnimeInfo(String(anilistId));
    const episodes = info?.episodes ?? [];
    if (!Array.isArray(episodes) || episodes.length === 0) return null;
    forgetNegative(negKey);
    const session: ProviderSession = { providerId: "megaplay", animeId: String(anilistId), episodes };
    sessionCache.set(cacheKeyStr, session);
    if (sessionCache.size > SESSION_CACHE_MAX) {
      const firstKey = sessionCache.keys().next().value;
      if (firstKey) sessionCache.delete(firstKey);
    }
    // The refreshed listing stays cached for the episodes it DOES carry, but
    // a request it still cannot serve is rejected here — same rejection
    // shape `getSessionForProvider` applies.
    if (
      episodeNumber !== undefined &&
      !session.episodes.some((ep) => ep?.number === episodeNumber) &&
      (await normalizedEpisodeMatch(session.episodes, episodeNumber, anilistId, "megaplay", {
        logUse: false,
        logReject: false,
      })) === null
    ) {
      return null;
    }
    return session;
  } catch (err) {
    console.warn(`[providers] getMegaPlaySession(anilistId=${anilistId}) failed:`, err instanceof Error ? err.message : err);
    // Remember the UNCONDITIONAL failure classes only: AniList 429s (the
    // "AniList Error: 429" shape kaizoku-core throws through the proxy) and
    // network/timeout failures of the fetch chain. Anything else stays
    // non-cached so a genuine bug keeps being re-paid and re-logged.
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /(?:^|\D)429(?:\D|$)|Too Many Requests|fetch failed|network|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|abort/i.test(
        msg
      )
    ) {
      rememberNegative(negKey);
    }
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
  } catch (err) {
    // "embed unavailable" is megaplay's definitive "no mapping for this
    // anilist id/episode" answer (their Error page), not a transient blip —
    // do not retry it.
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
  // (The old `hasSub === false && hasDub === false → false` clause is gone:
  // those flags describe MEGAPLAY'S EMBED MAPPING ONLY — the probe is keyed by
  // megaplay's own URL space — while availability is a title-level question
  // the walk answers with ANY provider. Measured on Beyond Time's Gaze 2
  // (anilistId 213356): megaplay listed all 52 episodes but its embeds
  // answered "Error" for every one, the audio probe recorded both-false
  // everywhere, and the drawer went N/A + INERT for the whole title — while
  // anikoto streamed eps 1..10+ fine and even ep 1's own row was greyed.
  // Inert rows also block the next-episode handoff, so one provider's ingest
  // lag silenced a fully watchable show. Audio flags stay audio information
  // (the counts, the dub-toggle gate) — never a verdict on whether a row can
  // play.)
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
 *
 * It runs in two passes:
 *
 *  1. The per-episode `isEpisodeAvailable(ep)` verdict, applied unchanged to
 *     every episode (id present, positive number, no FUTURE airDate). Audio
 *     flags deliberately play no part — they describe megaplay's embed
 *     mapping, not whether the walk can serve the row (see the function's own
 *     comment for the measured counter-example).
 *  2. A LIST-LEVEL un-aired sweep, because the per-episode verdict is
 *     necessarily optimistic: AniZip ships airDates only for the next couple
 *     of episodes of an airing title and then stops, so episodes 5..12 of a
 *     12-episode cour arrive with `airDate: null` plus a real id and sail
 *     through pass 1 as `available: true`. The reliable signal is therefore
 *     relative to the list itself: `maxAiredNumber` = the highest episode
 *     number whose `airDate` parses to a valid date <= now. Any episode with
 *     `number > maxAiredNumber` and a null/unparseable `airDate` cannot have
 *     aired yet → force `available: false`. (Episodes with a FUTURE airDate
 *     are already `false` via pass 1; episodes at or below `maxAiredNumber`
 *     keep their per-episode result.)
 *
 * The guard that makes pass 2 safe by construction: it only runs when the
 * list contains at least ONE past airDate (`maxAiredNumber` stays 0
 * otherwise, and we return early). A provider that ships no airDates at all
 * is untouched — with no evidence of what has aired, pass 2 has nothing to
 * prove and asserts nothing. Only finite, positive episode numbers
 * participate; missing/invalid numbers are ignored on both sides of the
 * comparison.
 */
function applyAvailability(episodes: Episode[]): Episode[] {
  const perEpisode = episodes.map((ep) => ({ ...ep, available: isEpisodeAvailable(ep) }));

  // Pass 2 — list-level un-aired sweep (rationale in the doc comment above).
  const now = Date.now();
  let maxAiredNumber = 0;
  for (const ep of perEpisode) {
    if (!Number.isFinite(ep.number) || ep.number <= 0) continue;
    if (!ep.airDate) continue;
    const airedAt = new Date(ep.airDate).getTime();
    if (!Number.isFinite(airedAt)) continue;
    if (airedAt <= now && ep.number > maxAiredNumber) maxAiredNumber = ep.number;
  }
  // No past airDate anywhere ⇒ the provider ships none (or only future ones);
  // there is no evidence of what has aired, so leave pass 1's results alone.
  if (maxAiredNumber <= 0) return perEpisode;

  return perEpisode.map((ep) => {
    if (!Number.isFinite(ep.number) || ep.number <= 0) return ep;
    if (ep.number <= maxAiredNumber) return ep;
    // A parseable airDate (necessarily in the future here) is pass 1's job.
    if (ep.airDate && Number.isFinite(new Date(ep.airDate).getTime())) return ep;
    // number > maxAiredNumber with no usable airDate ⇒ un-aired.
    return { ...ep, available: false };
  });
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
// 12 → 6: the probe's burst competes with live walks for the same upstream —
// a 52-episode title fires 104 embed requests, and at concurrency 12 that
// tripped megaplay's per-IP rate limit, after which megaplay, anikoto and
// animesogo (all backed by megaplay embeds) 429'd for the following ~minute.
// Halving the burst keeps the whole set inside the 8s budget at ~3× latency
// per request while leaving headroom for concurrent stream resolution.
const AUDIO_PROBE_CONCURRENCY = 6;
const AUDIO_PROBE_TIMEOUT_MS = 6000;
const AUDIO_PROBE_BUDGET_MS = 8000;
const AUDIO_FLAG_CACHE_MAX = 100;

type AudioFlag = { sub: boolean | null; dub: boolean | null };

/** anilistId → episode number → verified audio flags. */
const audioFlagCache = new Map<number, { flags: Map<number, AudioFlag>; at: number }>();
/**
 * TTL is mandatory: a FALSE here only means "megaplay's embed said no AT PROBE
 * TIME" — megaplay ingests titles gradually, and a probe that ran during an
 * embed outage recorded both-false for an entire 52-episode title. Entries
 * therefore expire after 30 min so the next `?audio=1` re-probes honestly;
 * re-learning TRUEs is just as cheap as the first run.
 */
const AUDIO_FLAG_TTL_MS = 30 * 60 * 1000;

function readAudioFlags(anilistId: number): Map<number, AudioFlag> | undefined {
  const entry = audioFlagCache.get(anilistId);
  if (!entry) return undefined;
  if (Date.now() - entry.at >= AUDIO_FLAG_TTL_MS) {
    audioFlagCache.delete(anilistId);
    return undefined;
  }
  return entry.flags;
}

/** Insert-or-refresh the per-title entry, returning its flag map. */
function audioFlagsEntry(anilistId: number): Map<number, AudioFlag> {
  const existing = readAudioFlags(anilistId);
  if (existing) return existing;
  const flags = new Map<number, AudioFlag>();
  if (audioFlagCache.size >= AUDIO_FLAG_CACHE_MAX) {
    const oldest = audioFlagCache.keys().next().value;
    if (oldest !== undefined) audioFlagCache.delete(oldest);
  }
  audioFlagCache.set(anilistId, { flags, at: Date.now() });
  return flags;
}

/**
 * Record one verified flag. The ONLY writers are the megaplay embed probe and
 * `recordStreamSuccess` below — the cache can only ever hold evidence.
 */
function rememberAudioFlag(
  anilistId: number,
  episode: number,
  version: "sub" | "dub",
  value: boolean
): void {
  const flags = audioFlagsEntry(anilistId);
  const prev = flags.get(episode) ?? { sub: null, dub: null };
  flags.set(episode, version === "sub" ? { ...prev, sub: value } : { ...prev, dub: value });
}

/**
 * A served megaplay stream is the strongest possible flag evidence — record it
 * so a probe's transient "Error" verdicts (ingest lag, embed outages) heal on
 * the first successful play instead of sticking until the TTL. Megaplay-only:
 * the probe's URL space and this cache describe megaplay's listing, so another
 * provider's success proves nothing here.
 */
function recordStreamSuccess(
  anilistId: number | undefined,
  episode: number | undefined,
  version: "sub" | "dub",
  providerId: string
): void {
  if (!anilistId || !episode || providerId !== "megaplay") return;
  rememberAudioFlag(anilistId, episode, version, true);
}

export interface AudioSummary {
  /**
   * Episodes VERIFIED to carry subtitle audio — `null` only when not a
   * single sub flag in the list is known. When SOME flags are known this is
   * the count of confirmed ones (see `subOfTotal`).
   */
  subCount: number | null;
  /** Same rule, independently, for dub audio. */
  dubCount: number | null;
  /**
   * Present only when SOME (but not all) of the list's sub flags are known:
   * `subCount` is then a confirmed-subset count out of `episodes.length`
   * episodes, not a total. Absent when everything was resolved (or nothing
   * was) — the shared partial-tally contract.
   */
  subOfTotal?: number;
  /** Same rule, independently, for dub audio. */
  dubOfTotal?: number;
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
  const flags = audioFlagsEntry(anilistId);

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
        rememberAudioFlag(anilistId, ep.number, version, result);
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
 * Per-audio-type tally under the shared contract (independent rules per
 * type):
 *  - all flags known  → `count` = #true, no `ofTotal`;
 *  - SOME known       → `count` = #true so far, `ofTotal` = episodes.length
 *                       (the caller knows it is a confirmed SUBSET);
 *  - NONE known       → `count` = null, no `ofTotal`.
 */
function audioCountSummary(
  episodes: Episode[],
  key: "hasSub" | "hasDub"
): { count: number | null; ofTotal?: number } {
  let unknown = 0;
  let trues = 0;
  for (const ep of episodes) {
    const value = ep[key];
    if (value === null || value === undefined) {
      unknown++;
      continue;
    }
    if (value) trues++;
  }
  if (unknown === 0) {
    // Every flag is known ⇒ `countKnown` cannot answer null here; `trues` is
    // the same number it computes, used only to keep the type honest.
    return { count: countKnown(episodes, key) ?? trues };
  }
  if (unknown === episodes.length) return { count: null };
  return { count: trues, ofTotal: episodes.length };
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
  const cached = anilistId ? readAudioFlags(anilistId) : undefined;
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
  // Aired-ness sweep AFTER the single availability definition: this function
  // re-derives `available` from scratch on every read (that is
  // `applyAvailability`'s contract), so a mark set by `getEpisodes`'s return
  // would be ERASED here before reaching every composed caller — the
  // /api/episodes route, the detail page and the watch page all run
  // getEpisodes → getAudioFlags. Re-applying the (memoized, fail-open) sweep
  // keeps the final value gated; rationale and incident in `withAiredGate`.
  resolved = await withAiredGate(resolved, anilistId);

  // Per-audio-type tallies under the shared contract (see
  // `audioCountSummary`): rules are independent per type, and an
  // `*OfTotal` field appears only for the SOME-known state.
  const sub = audioCountSummary(resolved, "hasSub");
  const dub = audioCountSummary(resolved, "hasDub");
  const audio: AudioSummary = {
    subCount: sub.count,
    dubCount: dub.count,
    canProbe,
    probed,
  };
  if (sub.ofTotal !== undefined) audio.subOfTotal = sub.ofTotal;
  if (dub.ofTotal !== undefined) audio.dubOfTotal = dub.ofTotal;

  return {
    episodes: resolved,
    audio,
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

/**
 * AniList's episode count for `anilistId` (fetch-cached, revalidate 300).
 * Exported so `/api/episodes` resolves the SAME value instead of keeping a
 * duplicated copy (it used to — same body, second definition).
 */
export async function resolveExpectedEpisodeCount(anilistId?: number): Promise<number | undefined> {
  if (!anilistId) return undefined;
  try {
    const anime = await getAnimeById(anilistId);
    return typeof anime?.episodes === "number" && anime.episodes > 0 ? anime.episodes : undefined;
  } catch {
    return undefined; // gate degrades to the suspect-title heuristic
  }
}

/**
 * ─── Aired-ness sweep ─────────────────────────────────────────────────
 *
 * Force `available: false` on every episode AniList says has NOT aired yet
 * (`number > released`, where `released` comes from the SAME
 * `resolveEpisodeFraction` the cards and badges use — one vocabulary).
 *
 * WHY (concrete incident, title 196613 "Dou Po Cangqiong: Nian Fan 4"):
 * AniList's schedule is fully concrete — ep 57 aired 2026-10-18, ep 58 airs
 * 2026-10-25, … ep 62 airs 2026-11-22 — but the SYNTHETIC provider lists
 * (the ones built from the AniList total rather than a real listing) enumerate
 * ALL 62 episodes and mark every row playable, because a row with an id and a
 * positive number passes `isEpisodeAvailable` and AniZip ships airDates only
 * for the next couple of episodes (so pass 2 of `applyAvailability` has no
 * evidence for the tail either). The result: not-yet-aired episodes rendered
 * as watchable on detail + watch, and — far worse — the /api/stream walk then
 * "resolved" a real stream for them from a DIFFERENT, year-old numbering
 * space of the same franchise (episode 62 served content the real episode 62
 * won't have until Nov 22). The plausibility gate (`scoreEpisodeList`) cannot
 * catch this: it only scores list LENGTH against AniList's TOTAL, and a
 * synthetic list of the right length still ends in episodes that haven't
 * aired. Only AniList's schedule knows where "released" ends — so this sweep
 * consults it (same memoized `getAnimeById` the expected-count gate already
 * resolves, so in the composed getEpisodes → getAudioFlags path there is no
 * extra upstream cost) and greys out the tail. Rows stay LISTED (renumbering
 * or dropping them would desync provider numbering and the next-episode
 * handoff) — they render as upcoming/unplayable via the existing
 * `available === false` UI.
 *
 * Applied on the VALUE RETURNED TO CALLERS only — never inside the
 * availability cache entry: the cache key already encodes `expectedCount`
 * and holds the raw selected list, and the cached shape must stay identical
 * for every reader regardless of when the sweep last ran (an episode that
 * airs mid-TTL must flip to available without a provider re-walk).
 *
 * FAIL-OPEN by design: AniList data failure (throw — `getAnimeById`
 * deliberately throws on transient upstream errors and returns `null` only
 * for confirmed misses) or an unknown `released` (HIATUS / CANCELLED /
 * no-schedule statuses resolve to `null`) → the list comes back UNMARKED,
 * exactly as before this sweep existed. A working listing must never be
 * taken down by the data that guards it.
 */
async function withAiredGate(episodes: Episode[], anilistId?: number): Promise<Episode[]> {
  if (!anilistId || episodes.length === 0) return episodes;
  let released: number | null = null;
  try {
    const anime = await getAnimeById(anilistId);
    // `resolveEpisodeFraction` yields null when the total is unknown — that
    // too is "no verdict", handled by the `released === null` check below.
    released = anime ? (resolveEpisodeFraction(anime)?.released ?? null) : null;
  } catch {
    return episodes; // fail-open: gate data failure never changes the list
  }
  if (released === null) return episodes; // unknown schedule → no verdict
  return episodes.map((ep) =>
    Number.isFinite(ep.number) && ep.number > released ? { ...ep, available: false } : ep
  );
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
    // the single availability definition — plus the aired-ness sweep on the
    // RETURNED value only (the cache entry itself stays raw/ungated; see
    // `withAiredGate` for why, and note `getAudioFlags` re-applies the same
    // sweep after its own `applyAvailability` re-derivation).
    return {
      episodes: await withAiredGate(
        applyAvailability(withKnownFlags(cached.list, anilistId)),
        anilistId
      ),
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

    // Fire every probe CONCURRENTLY, then WALK THE RESULTS IN THE ORIGINAL
    // SERIAL ORDER, awaiting one slot at a time and stopping at the first
    // `best.score >= 0` — the serial walk's early-break, now without paying
    // for the probes that come after it: they were already started, but
    // nobody waits for them (their results and warnings land whenever they
    // settle; each probe carries its own rejection→warn→null conversion, so
    // a straggler can never surface as an unhandled rejection). That makes
    // cold latency ≈ max(the probes up to the winner) instead of sum(all
    // probes up to the winner): ~max(probe) when the walk used to run deep
    // through misses, and ≈ the old serial cost when an early provider
    // (megaplay) wins outright. Awaiting slots in plan order is what keeps
    // the winner IDENTICAL to the serial walk: strict `>` tie-breaking
    // (first in preference order wins a tie, and `0` is the maximum score,
    // so the first exact/non-suspect list still beats everything after it),
    // the same `sawRejected` accounting, and the same plausibility gate.
    // Trade-off ("upstream blast", deliberate): every provider is hit on
    // every cold walk even when an early winner makes their answers
    // irrelevant — that's the price of never summing misses again.
    const plan: { name: string; probe: Promise<ProviderSession | null> }[] = [];
    if (anilistId) {
      plan.push({
        name: "megaplay",
        probe: getMegaPlaySession(anilistId, animeTitle).catch((err) => {
          console.warn(`[providers] getEpisodes(megaplay) failed:`, err instanceof Error ? err.message : err);
          return null;
        }),
      });
    }
    for (const provider of PROVIDERS) {
      if (anilistId && provider.name === "megaplay") continue; // already in the plan
      plan.push({
        name: provider.name,
        probe: provider.getSession(animeTitle, anilistId).catch((err) => {
          console.warn(`[providers] getEpisodes(${provider.name}) failed:`, err instanceof Error ? err.message : err);
          return null;
        }),
      });
    }
    for (let i = 0; i < plan.length; i++) {
      const session = await plan[i].probe; // never rejects (see above)
      try {
        consider(session, plan[i].name);
      } catch (err) {
        console.warn(`[providers] getEpisodes(${plan[i].name}) failed:`, err instanceof Error ? err.message : err);
        continue;
      }
      // `0` == exact expected count (or, with no count, any non-suspect
      // list): nothing later can beat it — stop WITHOUT waiting for the
      // stragglers still in flight (the serial walk's early break).
      if (best.score >= 0) break;
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
  // Raw in, derived out — see `applyAvailability`. The cache entry above
  // keeps the RAW selected list; only this returned value carries
  // availability, and it is additionally swept for not-yet-aired episodes
  // (see `withAiredGate` — the concrete failure it prevents: synthetic
  // lists enumerate the AniList TOTAL and mark everything playable, which
  // shipped not-yet-aired episodes of title 196613 as watchable while
  // providers then served wrong-numbering-space content for them).
  return {
    episodes: await withAiredGate(
      applyAvailability(withKnownFlags(candidateEpisodes, anilistId)),
      anilistId
    ),
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
// 12s, up from 5s. The search-based providers (kickassanime/anikoto/anizone/
// allmanga/anineko/animeunity) each need THREE sequential HTTP round trips —
// search → info → sources — inside this one budget, and 5s killed them on any
// slow or cold upstream: one dev session logged 46 timeouts (allmanga 23,
// kickassanime 12, anizone 8), i.e. those providers had stopped contributing
// entirely and every walk burned the clock before megaplay saved it. 12s
// covers the three-trip path with headroom; the walk still bounded overall by
// the phase-2 parallelism and by megaplay-first below.
const PROVIDER_TIMEOUT_MS = 12_000;

/**
 * Per-provider budget overrides. The 2dhive attempt now carries the
 * BabaStream fallback — its own doomed megaplay+hianime tries PLUS a
 * proof-of-work (80 sha256 proofs over workers) and four round trips — which
 * measured 4–14s on top of the primary. The flat 12s budget killed the
 * fallback mid-solve (`2dhive phase3 exceeded 12000ms` while AiPri ep29 was
 * demonstrably resolvable), so 2dhive gets a budget that covers its real
 * chain; everything else keeps the measured 12s.
 */
const PROVIDER_TIMEOUT_OVERRIDES: Readonly<Record<string, number>> = {
  "2dhive": 30_000,
};

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
  server?: string,
  anilistId?: number
): Promise<StreamResult | null> {
  try {
    const session = await provider.getSession(animeTitle, anilistId, episodeNumber);
    if (!session) return null;
    // Exact match first; a verified AniZip-anchored number translation only
    // when the exact one misses (see `normalizedEpisodeMatch`).
    let targetEp = session.episodes.find((ep) => ep.number === episodeNumber);
    if (!targetEp?.id) {
      targetEp = await normalizedEpisodeMatch(session.episodes, episodeNumber, anilistId, provider.name, {
        logUse: true,
        logReject: true,
      });
    }
    // List miss → the provider may still know the episode by its own keying
    // (2dhive's series-page total lags its backends — see resolveEpisodeId).
    const fallbackId = targetEp?.id ? null : provider.resolveEpisodeId?.(session, episodeNumber) ?? null;
    const sourceId = targetEp?.id ?? fallbackId;
    if (!sourceId) return null;
    // Sources are requested under the PROVIDER'S number: anizone/animeunity
    // pass it back upstream, and for exact matches it equals `episodeNumber`.
    const result = await provider.getSources(sourceId, type, targetEp?.number ?? episodeNumber, server);
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
    // Pass the episode so a cached listing that predates a newly aired
    // episode is refreshed instead of blocking the walk (see above).
    const session = await getMegaPlaySession(anilistId, animeTitle, episodeNumber);
    if (!session) return null;
    // Exact match first; verified AniZip translation only on an exact miss.
    let targetEp = session.episodes.find((ep) => ep.number === episodeNumber);
    if (!targetEp?.id) {
      targetEp = await normalizedEpisodeMatch(session.episodes, episodeNumber, anilistId, "megaplay", {
        logUse: true,
        logReject: true,
      });
    }
    if (!targetEp?.id) return null;
    // MegaPlay addresses its embed by ITS list number (`/stream/ani/{id}/{ep}`),
    // so a normalized match must pass the matched number, not the requested one.
    const result = await getMegaPlaySources(targetEp.id, type, targetEp.number);
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

// ─── Per-title provider quarantine ────────────────────────────────────
// Some backends serve a *mislabeled* file for a given AniList ID: the request
// succeeds and returns playable sources, but the video is a DIFFERENT series'
// episode (content-identity corruption). Because the stream walk stops at the
// first provider that returns any `sources`, a corrupt catalogue entry always
// wins over later providers that would serve the correct episode — so the only
// safe remedy is to refuse the corrupt (or unverifiable) provider for that
// specific title before any network call is made. This map is data, not
// code: add/remove entries after manual verification (subtitle VTT text is the
// preferred verification method), and honor `reviewAfter` so temporary
// quarantines from upstream day-0 batch drops don't silently rot.
const PROVIDER_QUARANTINE: Record<string, { providers: string[]; note: string; since: string; reviewAfter: string }> = {
  "195539": {
    providers: ["megaplay", "kickassanime", "animesogo", "2dhive", "animeunity", "anikoto"],
    note: "Day-0 batch drop mislabeled upstream: nexabloom (megaplay/animesogo/2dhive/anikoto) and krussdomi (kickassanime) both map AniList 195539 to a wrong-series file; animeunity unverifiable (0 subs). anikoto is a further nexabloom facade serving a DIFFERENT wrong file (a Tokyo 'Mejiro' train scene). Verified via subtitle VTT 2026-10-21.",
    since: "2026-10-21",
    reviewAfter: "2026-11-04",
  },
};

/**
 * True when `providerId` is barred from serving `anilistId` because its
 * catalogue is known (or suspected) to map that ID to the wrong series' video.
 * Callers must check this BEFORE any provider network call.
 */
function isProviderQuarantined(anilistId: number | undefined, providerId: string): boolean {
  if (anilistId === undefined) return false;
  const entry = PROVIDER_QUARANTINE[String(anilistId)];
  return entry ? entry.providers.includes(providerId) : false;
}

/**
 * Fetch streaming sources for a specific episode by chaining through all providers.
 * If `preferredProvider` is given, that provider is tried FIRST using its own episode mapping,
 * preventing cross-provider episode number mismatches.
 */
async function walkStreamingSources(
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
    // (Quarantined provider short-circuits here, before any network call.)
    if (preferredProvider === "megaplay" && anilistId) {
      if (isProviderQuarantined(anilistId, "megaplay")) {
        console.warn(`[providers] skipping megaplay phase1 for anilist ${anilistId}: provider quarantined`);
      } else {
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
    }

    // Try the named provider from PROVIDERS list
    for (const provider of PROVIDERS) {
      if (provider.name !== preferredProvider) continue;
      // Quarantined for this title — skip before any network call.
      if (isProviderQuarantined(anilistId, provider.name)) {
        console.warn(`[providers] skipping ${provider.name} phase1 for anilist ${anilistId}: provider quarantined`);
        continue;
      }
      tried.push(provider.name);
      try {
        const result = await withTimeout(
          attemptProvider(provider, animeTitle, episodeNumber, type, server, anilistId),
          PROVIDER_TIMEOUT_OVERRIDES[provider.name] ?? PROVIDER_TIMEOUT_MS,
          `${provider.name} phase1`
        );
        if (result) return result;
      } catch (err) {
        console.warn(`[providers] ${provider.name} phase1 failed:`, err instanceof Error ? err.message : err);
      }
      break;
    }
  }

  // ── Phase 2: megaplay, DIRECTLY by AniList ID (if we have one) ──
  // Megaplay needs NO search — it takes the AniList ID straight to
  // `fetchAnimeInfo`/`fetchSources`, so it is both the FASTEST and, empirically,
  // the most reliable provider (getEpisodes already prefers it for the same
  // reason — see the "Try megaplay first" comment there). It used to sit at
  // index 5 of PROVIDERS and only run in a Phase 3 AFTER the search-based
  // walk, so every lookup burned up to ~25s of provider timeouts before
  // reaching the one provider most likely to answer. Moved ahead of the walk.
  if (anilistId && preferredProvider !== "megaplay" && !isProviderQuarantined(anilistId, "megaplay")) {
    tried.push("megaplay");
    try {
      const result = await withTimeout(
        attemptMegaPlay(anilistId, animeTitle, episodeNumber, type),
        PROVIDER_TIMEOUT_MS,
        "megaplay phase2"
      );
      if (result) return result;
    } catch (err) {
      console.warn(`[providers] megaplay phase2 failed:`, err instanceof Error ? err.message : err);
    }
  } else if (anilistId && preferredProvider !== "megaplay") {
    // Quarantined for this title — skip before any network call.
    console.warn(`[providers] skipping megaplay phase2 for anilist ${anilistId}: provider quarantined`);
  }

  // ── Phase 3: every remaining search-based provider, overlapped, first success by priority ──
  // megaplay is excluded: it has no search path (its PROVIDERS entry is a
  // null stub) and was already tried above by AniList ID.
  // Quarantined providers are also excluded, before any of them enter `tried`.
  for (const provider of PROVIDERS) {
    if (
      provider.name !== "megaplay" &&
      !(preferredProvider && provider.name === preferredProvider) &&
      isProviderQuarantined(anilistId, provider.name)
    ) {
      console.warn(`[providers] skipping ${provider.name} phase3 for anilist ${anilistId}: provider quarantined`);
    }
  }
  const phase3 = PROVIDERS.filter(
    (provider) =>
      provider.name !== "megaplay" &&
      !(preferredProvider && provider.name === preferredProvider) &&
      // Quarantined for this title — never enter `tried` or the walk.
      !isProviderQuarantined(anilistId, provider.name)
  );
  if (phase3.length > 0) {
    tried.push(...phase3.map((p) => p.name));
    const winner = await walkProvidersByPriority(phase3, (provider) =>
      withTimeout(
        attemptProvider(provider, animeTitle, episodeNumber, type, server, anilistId),
        PROVIDER_TIMEOUT_OVERRIDES[provider.name] ?? PROVIDER_TIMEOUT_MS,
        `${provider.name} phase3`
      )
    );
    if (winner) return winner;
  }

  console.warn(`[providers] getStreamingSources("${animeTitle}", ep${episodeNumber}, ${type}) — all providers failed. Tried:`, tried);
  return null;
}

/**
 * Public entry — the walk itself plus one bookkeeping step on the way out: a
 * SUCCESSFUL megaplay serve records the played version as a verified audio
 * flag, so a probe that ran during a megaplay embed outage (which records
 * "no sub, no dub" for every episode it touches) heals for the played row as
 * soon as the viewer actually plays it, instead of only at TTL expiry.
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
  const result = await walkStreamingSources(animeTitle, episodeNumber, type, server, anilistId, preferredProvider);
  if (result) recordStreamSuccess(anilistId, episodeNumber, type, result.providerId);
  return result;
}

// `getAvailableProviders()` used to live here. It had ZERO callers, so it was
// dead code: the list path already picks one provider and records it per
// episode (`Episode.providerId`), which is strictly more useful than a bare
// "who has a session" list nothing rendered. Wiring it in would have added a
// SECOND full provider walk (search + info per provider, un-timed,
// un-gated) to every `/api/episodes` call for information no UI reads — the
// opposite of queue #8. Deleted rather than wired.
