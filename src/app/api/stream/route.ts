import { NextRequest, NextResponse } from "next/server";
import { getStreamingSources } from "@/lib/providers";
import { getAnimeById } from "@/lib/anilist";
import { formatAirsDelta, resolveEpisodeFraction } from "@/lib/anime-meta";
import type { StreamSource, Subtitle } from "@/types/anime";

export const dynamic = "force-dynamic";

/** Body every caller of this route can rely on — success or failure. */
interface StreamResponseBody {
  sources: StreamSource[];
  subtitles: Subtitle[];
  headers?: Record<string, string>;
  providerId?: string;
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
  /** Present only when nothing could be found. */
  error?: string;
}

interface StreamCacheEntry {
  /** Response body to replay verbatim (including `{ sources: [], error }`). */
  data: StreamResponseBody;
  expires: number;
  /** Provider that answered, or null when the walk found nothing. */
  resolvedProvider: string | null;
  /**
   * The `providerId` preference this walk ran under (null = no preference).
   * Used by `canServe` so an explicit choice is never answered with another
   * preference's outcome unless that outcome IS the provider it names.
   */
  requestedProvider: string | null;
}

const streamCache = new Map<string, StreamCacheEntry>();
const STREAM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes — successful lookups
// Misses are cached too, but briefly. A miss costs a full provider walk
// (measured: 19.8s for the strict two-stage chain, 54.9s through the old
// three-stage one) and only successes used to be kept — so the player re-paid
// that on every one of its ~6 requests per episode, on every retry, forever.
// 90s covers one episode's load + its dub probe + a manual provider retry,
// while still letting a title that gains sources pick them up quickly.
const STREAM_FAIL_TTL = 90 * 1000;
const STREAM_CACHE_MAX = 100;

interface WalkOutcome {
  data: StreamResponseBody;
  resolvedProvider: string | null;
}

/** Walks currently running, keyed canonically (see `server` note below). */
const inFlight = new Map<string, Promise<StreamResponseBody>>();

function readCache(key: string): StreamCacheEntry | null {
  const hit = streamCache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    streamCache.delete(key);
    return null;
  }
  return hit;
}

function writeCache(key: string, entry: StreamCacheEntry): void {
  streamCache.set(key, entry);
  if (streamCache.size > STREAM_CACHE_MAX) {
    const firstKey = streamCache.keys().next().value;
    if (firstKey) streamCache.delete(firstKey);
  }
}

/**
 * May a cache entry produced by SOME walk answer THIS request?
 *
 * Without an explicit `providerId` the answer is always yes: "any" means
 * "any working sources", and a miss that exhausted the chain is a miss for
 * everyone. With an explicit `providerId` the entry must either come from a
 * walk that ran under the SAME preference (`requestedProvider` — re-running
 * that walk replays the same fall-through), or it must have been answered by
 * the named provider itself, or it must be a full-chain miss.
 */
function canServe(entry: StreamCacheEntry, providerId?: string): boolean {
  if (!providerId) return true;
  return (
    entry.requestedProvider === providerId ||
    entry.resolvedProvider === providerId ||
    entry.resolvedProvider === null
  );
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const title = searchParams.get("title");
  const episode = searchParams.get("episode");
  const type = (searchParams.get("type") || "sub") as "sub" | "dub";
  const server = searchParams.get("server") || undefined;
  const anilistIdParam = searchParams.get("anilistId");
  const providerId = searchParams.get("providerId") || undefined;

  if (!title || !episode) {
    return NextResponse.json({ error: "Missing title or episode" }, { status: 400 });
  }

  const episodeNumber = parseInt(episode, 10);
  if (isNaN(episodeNumber)) {
    return NextResponse.json({ error: "Invalid episode number" }, { status: 400 });
  }

  const anilistId = anilistIdParam ? parseInt(anilistIdParam, 10) : undefined;
  // `strict=1` (contract shared with the player) = "requested type only, no
  // opposite-type fallback" — the stage-2 re-walk below is skipped entirely.
  // Absent (or any other value) keeps the old self-contained two-stage
  // behaviour byte-for-byte for direct callers that don't send it yet.
  const strictParam = searchParams.get("strict");
  const strict = strictParam === "1" || strictParam === "true";
  // Retry bypass: the player's Retry button sends `fresh=1` so a manual retry
  // is NOT served the cached failure. Without this, a failed walk is cached
  // for 90s (STREAM_FAIL_TTL) and shared across all `server` values — so for
  // 90 seconds after any failure, Retry re-ran the lookup but the route
  // answered from the same cached miss, making Retry look broken. `fresh`
  // skips the READS only; a fresh walk still writes its outcome to the cache,
  // so the next ordinary request benefits from the re-walk either way.
  const fresh = searchParams.get("fresh") === "1";

  // ── Aired-ness gate (refuse BEFORE any provider walk) ────────────────
  // Incident (title 196613, "Dou Po Cangqiong: Nian Fan 4"): AniList's
  // schedule is fully concrete — ep 57 aired 2026-10-18, ep 58 airs
  // 2026-10-25, … ep 62 airs 2026-11-22 — but `/api/stream?episode=62`
  // walked the provider chain and returned a REAL stream, sourced from a
  // DIFFERENT (a-year-old) numbering space of the same franchise. The
  // plausibility gate in providers.ts only scores episode-list LENGTH
  // against AniList's TOTAL, and providers happily resolve any episode
  // NUMBER they are asked for — so nothing could stop a not-yet-aired
  // episode from streaming. This gate refuses whenever AniList says the
  // requested episode exceeds what has aired, for EVERY request shape
  // (any `server` / `providerId` / `type`), before the cache read, the
  // single-flight, or the walk.
  //
  // FAIL-OPEN by design: `getAnimeById` throws on transient AniList
  // failure (it reserves `null` for confirmed misses), so the whole gate
  // is wrapped — on throw OR null the gate SKIPS entirely. A working
  // stream lookup must never be 500'd (or blocked) by the very data that
  // guards it; when the gate can't know, it lets the walk decide, exactly
  // as before.
  //
  // The refusal body is the SAME 200 JSON shape as the exhausted path
  // (`sources: []` + error) and its error STARTS WITH the Player's
  // definitive-miss prefix — `EXHAUSTED_SOURCES_ERROR` in
  // src/components/player/Player.tsx is a `startsWith` check on "No
  // streaming sources available for this episode" — so the watch page's
  // mount handoff hops to the newest playable lower episode with ZERO
  // Player changes. The Player cannot tell a gated refusal from an
  // exhausted walk, which is exactly right: both mean "this episode is
  // not playable, try lower".
  if (anilistId) {
    try {
      const anime = await getAnimeById(anilistId);
      // Confirmed-miss null → no schedule data → no verdict → skip gate.
      const fraction = anime ? resolveEpisodeFraction(anime) : null;
      // `released == null` (HIATUS/CANCELLED/unknown schedule) → we cannot
      // know what has aired → skip gate.
      if (
        anime &&
        fraction &&
        fraction.released !== null &&
        episodeNumber > fraction.released
      ) {
        const released = fraction.released;
        // Honest, status-aware explanation appended after the shared prefix.
        const explanation =
          anime.status === "RELEASING"
            ? ` — episode ${episode} hasn't aired yet. Episode ${released} is the latest; next episode airs ${formatAirsDelta(anime.nextAiringEpisode?.airingAt) ?? "soon"}.`
            : ` — only ${released} episodes have been released.`;
        // One line when the gate fires — consistent with the walk logs below.
        console.debug(
          `[stream] gate: "${title}" anilistId=${anilistId} ep${episodeNumber} > released ${released} — refusing before provider walk`
        );
        // Deliberately NOT written to the stream cache (the early return
        // happens before any cache/single-flight code): no provider walk
        // ran, so this is not a provider miss and must not occupy the 90s
        // failure-cache slot. It also keeps the gate self-healing — the
        // moment the episode actually airs, the very next request re-runs
        // the walk instead of replaying a stale "hasn't aired" verdict.
        return NextResponse.json({
          sources: [],
          subtitles: [],
          error: `No streaming sources available for this episode${explanation}`,
          providerId,
        });
      }
    } catch (e) {
      // Fail-open: never take down a working path because GATE data failed.
      console.debug(
        `[stream] gate: anilist lookup failed for ${anilistId} (${e instanceof Error ? e.message : e}) — skipping aired-ness gate`
      );
    }
  }

  // ── Key consolidation ─────────────────────────────────────────────────
  // Investigation of which params actually change the RESULT SET:
  //
  //  • `server=` — only ever reaches anikoto: every other provider's
  //    `getSources` takes it as `_server` and ignores it, and anikoto falls
  //    back through `[server, "hd-1", "vidstream-2"]` internally (probed:
  //    all of its servers return one identical master). It therefore never
  //    changes the result set, and it is DROPPED from the cache key
  //    entirely. Before this, anikoto results were stored under a
  //    server-suffixed exact key and NOT shared with the canonical one, so
  //    the same episode paid one walk per server value (measured in the dev
  //    log: "ROAD OF NARUTO" ep1 — three walks differing only in `server`).
  //
  //  • `providerId=` — only REORDERS the chain (phase 1 preference; phase
  //    2/3 still walk every provider, so a miss is a miss under any
  //    preference). It does change which provider WINS, so an explicit
  //    choice must never be answered with another preference's provider
  //    — that is enforced logically (see `canServe`) instead of by key
  //    fragmentation: results live under ONE canonical key, explicit
  //    walks additionally memoise under a per-preference key, and the
  //    canonical entry records which preference produced it. Log evidence
  //    of the old fragmentation: "Dandivine" ep1 — a providerId=kickassanime
  //    walk (3.8s) followed seconds later by a bare walk of the same
  //    episode (4.1s) that could only reach the same provider anyway.
  //
  //  • `strict` stays in the key: it DOES change the result set (stage 2
  //    may answer a sub request with dub sources), and the player relies on
  //    the key carrying it (see its warm-up comment).
  const cacheKey = `${title}::${episodeNumber}::${type}::${strict ? 1 : 0}`;
  const providerKey = providerId ? `${cacheKey}::p=${providerId}` : null;

  if (!fresh) {
    let hit: StreamCacheEntry | null = providerKey ? readCache(providerKey) : null;
    if (!hit) {
      const shared = readCache(cacheKey);
      if (shared && canServe(shared, providerId)) hit = shared;
    }
    if (hit) return NextResponse.json(hit.data);
  }

  const runWalk = async (): Promise<WalkOutcome> => {
    // One log line per ACTUAL walk (cache hits and single-flight joins never
    // reach here) — the before/after evidence trail for key consolidation
    // and for the strict stage-2 skip below.
    console.log(
      `[stream] walk start "${title}" ep${episodeNumber} ${type} strict=${strict ? 1 : 0} providerId=${providerId || "any"} server=${server || "any"}`
    );

    // Stage 1 — the requested type.
    let result = await getStreamingSources(
      title,
      episodeNumber,
      type,
      server,
      anilistId,
      providerId
    );

    // Stage 2 — the other type, so a dub-only episode still answers a
    // `type=sub` request. (The player runs its own `type=dub` probe too; this
    // keeps the route self-contained for direct callers.) `strict=1` skips
    // it: the request asked for ONE type and the player already probes the
    // other itself, so without this a miss cost TWO full provider walks.
    if (!strict && !result) {
      const otherType = type === "sub" ? "dub" : "sub";
      console.log(
        `[stream] walk stage2 opposite-type re-walk "${title}" ep${episodeNumber} ${otherType}`
      );
      result = await getStreamingSources(
        title,
        episodeNumber,
        otherType,
        server,
        anilistId,
        providerId
      );
    }

    // Stage 3 (`getStreamingSourcesFallback`) is gone. It re-ran sub and dub
    // with `server`/`providerId` dropped, which cannot surface a result the two
    // stages above miss: `providerId` only *reorders* the chain (Phase 2 still
    // walks every provider), `server` is anikoto-only and anikoto already
    // retries its own list, and both types are covered by stages 1-2. It cost
    // 54.9s per request against 19.8s without it — and, being a miss, was
    // never cached, so it was paid on every single request.
    if (!result) {
      return {
        data: {
          sources: [],
          subtitles: [],
          error: `No streaming sources available for this episode from the current providers. Try selecting a different provider.`,
          providerId,
        },
        resolvedProvider: null,
      };
    }

    const data: StreamResponseBody = {
      sources: result.sources,
      subtitles: result.subtitles,
      headers: result.headers || {},
      providerId: result.providerId,
    };
    // Include skip times from provider source data if available
    if (result.intro) data.intro = result.intro;
    if (result.outro) data.outro = result.outro;

    return { data, resolvedProvider: result.providerId };
  };

  try {
    // ── Single-flight ──────────────────────────────────────────────────
    // The player fires several `/api/stream` calls per episode that differ
    // only in `server` (vidstream-2 / vidcloud-1 / vidstream-1) — measured as
    // 6-10 concurrent 35-51s walks doing identical upstream work. Collapsed
    // onto one walk, keyed canonically so the concurrent variants share it.
    // The key deliberately matches the pre-consolidation canonical key
    // (preference included, server excluded): walk SEMANTICS are unchanged,
    // only the cache read/write layer was consolidated.
    const walkKey = `${cacheKey}::${providerId || "any"}`;
    let walk = inFlight.get(walkKey);
    if (!walk) {
      walk = runWalk()
        .then((outcome): StreamResponseBody => {
          const entry: StreamCacheEntry = {
            data: outcome.data,
            expires: Date.now() + (outcome.resolvedProvider ? STREAM_CACHE_TTL : STREAM_FAIL_TTL),
            resolvedProvider: outcome.resolvedProvider,
            requestedProvider: providerId ?? null,
          };
          // Explicit walks are valid for "any" readers (any working sources
          // answers "any"), so the canonical key takes every walk's outcome;
          // the per-preference key additionally keeps repeat explicit choices
          // stable so alternating preferences can't evict each other.
          writeCache(cacheKey, entry);
          if (providerKey) writeCache(providerKey, entry);
          return outcome.data;
        })
        .finally(() => {
          inFlight.delete(walkKey);
        });
      inFlight.set(walkKey, walk);
    }
    return NextResponse.json(await walk);
  } catch (e) {
    // Deliberately not cached: a throw here is an unexpected failure rather
    // than a provider saying "nothing here", and sticking it for 90s would
    // mask a transient fault.
    return NextResponse.json(
      { sources: [], subtitles: [], error: e instanceof Error && e.message ? e.message : "Failed to fetch" },
      { status: 500 }
    );
  }
}
