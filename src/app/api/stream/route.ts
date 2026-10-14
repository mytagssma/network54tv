import { NextRequest, NextResponse } from "next/server";
import { getStreamingSources } from "@/lib/providers";
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
  storeKey: string;
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
  const strict = searchParams.get("strict") === "true";
  // Retry bypass: the player's Retry button sends `fresh=1` so a manual retry
  // is NOT served the cached failure. Without this, a failed walk is cached
  // for 90s (STREAM_FAIL_TTL) and shared across all `server` values — so for
  // 90 seconds after any failure, Retry re-ran the lookup but the route
  // answered from the same cached miss, making Retry look broken. `fresh`
  // skips the READS only; a fresh walk still writes its outcome to the cache,
  // so the next ordinary request benefits from the re-walk either way.
  const fresh = searchParams.get("fresh") === "1";

  // ── Key canonicalisation ─────────────────────────────────────────────
  // `server` only ever reaches anikoto: every other provider's `getSources`
  // takes it as `_server` and ignores it, and anikoto already falls back
  // through `[server, "hd-1", "vidstream-2"]` internally (probed: all four of
  // its servers return one identical master). So the key carries `server` only
  // for the one provider where it can change the answer — and that is only
  // known once a walk resolves. Hence two keys: `exact` first, then `canonical`.
  const baseKey = `${title}::${episodeNumber}::${type}::${strict}::${providerId || "any"}`;
  const exactKey = `${baseKey}::${server || "any"}`;
  const canonicalKey = `${baseKey}::any`;

  const exactHit = fresh ? null : readCache(exactKey);
  if (exactHit) return NextResponse.json(exactHit.data);
  if (server && !fresh) {
    const sharedHit = readCache(canonicalKey);
    // Reuse the shared entry only when the provider that produced it ignores
    // `server`; an anikoto result is server-specific. A recorded miss has
    // `resolvedProvider === null` and is shared — a walk that exhausted every
    // provider would have failed under any `server`, because anikoto retried
    // its own fallback list on the way through.
    if (sharedHit && sharedHit.resolvedProvider !== "anikoto") {
      return NextResponse.json(sharedHit.data);
    }
  }

  const runWalk = async (): Promise<WalkOutcome> => {
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
    // keeps the route self-contained for direct callers.) `strict` skips it.
    if (!strict && !result) {
      const otherType = type === "sub" ? "dub" : "sub";
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
        // Shared across `server` values (see above), hence the canonical key.
        storeKey: canonicalKey,
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

    return {
      data,
      storeKey: result.providerId === "anikoto" && server ? exactKey : canonicalKey,
      resolvedProvider: result.providerId,
    };
  };

  try {
    // ── Single-flight ──────────────────────────────────────────────────
    // The player fires several `/api/stream` calls per episode that differ
    // only in `server` (vidstream-2 / vidcloud-1 / vidstream-1) — measured as
    // 6-10 concurrent 35-51s walks doing identical upstream work. Collapsed
    // onto one walk, keyed canonically so the concurrent variants share it.
    // (Cross-server sharing during the walk itself is safe for the same reason
    // `server` is dropped from the canonical key: anikoto's servers all resolve
    // to one identical master, and no other provider reads the value.)
    let walk = inFlight.get(canonicalKey);
    if (!walk) {
      walk = runWalk()
        .then((outcome): StreamResponseBody => {
          writeCache(outcome.storeKey, {
            data: outcome.data,
            expires: Date.now() + (outcome.resolvedProvider ? STREAM_CACHE_TTL : STREAM_FAIL_TTL),
            resolvedProvider: outcome.resolvedProvider,
          });
          return outcome.data;
        })
        .finally(() => {
          inFlight.delete(canonicalKey);
        });
      inFlight.set(canonicalKey, walk);
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
