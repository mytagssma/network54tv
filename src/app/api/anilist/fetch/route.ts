import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

/**
 * Generic fetch proxy used by kaizoku-core's internal AniList client.
 *
 * kaizoku-core sends:
 *   POST /api/anilist/fetch
 *   Body: { url, method, headers, body }
 *
 * This route adds Origin + Referer headers and forwards the request —
 * faithfully and transparently (same status + raw body + content-type out as
 * the upstream produced), because EVERY AniList call kaizoku-core makes
 * (megaplay sessions, anineko resolves, …) lands here and is parsed as a raw
 * GraphQL passthrough. It is deliberately NOT redirected at /api/anilist:
 * that route answers a different contract ({ data } envelopes, its own
 * caching policy), while this one must stay a byte-level forwarder.
 *
 * Hardening (it used to be a bare one-shot forwarder, so every 429 or
 * transient network blip walked straight into a provider failure — the five
 * logged `POST /api/anilist/fetch 429` + megaplay-collapse sequences were
 * exactly this):
 *
 *  - L1 Map cache keyed by a hash of (method, url, body) — the GraphQL
 *    document + variables fully determine the answer; headers are excluded
 *    because they are fixed browser-like values that don't vary the result.
 *    TTL 5 minutes, cap 500 (same pattern as /api/anilist).
 *  - AbortSignal timeout (~10s) per attempt.
 *  - 2 retries on 429 / network errors with backoff, honouring Retry-After
 *    when the upstream sends it (capped so a 60s header can't wedge the
 *    request; the retry still happens and the stale layer below rescues).
 *  - An expired L1 entry is served as STALE when every retry has failed, so
 *    a rate-limit window degrades to "slightly old data" instead of a
 *    provider miss.
 */

const FETCH_TIMEOUT_MS = 10_000;
/** Retries AFTER the first attempt, on 429 / network failure only. */
const RETRY_ATTEMPTS = 2;
/** Backoff before retry i (0-based) when the upstream sent no Retry-After. */
const RETRY_BACKOFF_MS = [400, 1200];
/** Upper bound on any single retry wait (Retry-After may ask for a minute). */
const RETRY_WAIT_CAP_MS = 5_000;

interface CachedFetch {
  text: string;
  contentType: string;
  expiresAt: number;
}

const l1Cache = new Map<string, CachedFetch>();
const L1_TTL_MS = 5 * 60 * 1000;
const L1_CACHE_MAX = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashKey(method: string, url: string, reqBody: unknown): string {
  return createHash("sha256")
    .update(method)
    .update("\n")
    .update(url)
    .update("\n")
    .update(typeof reqBody === "string" ? reqBody : JSON.stringify(reqBody ?? null))
    .digest("hex");
}

/** Retry-After as milliseconds — seconds or HTTP-date forms — or null. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cachedResponse(entry: CachedFetch, cacheState: "hit" | "stale"): NextResponse {
  return new NextResponse(entry.text, {
    status: 200,
    headers: { "Content-Type": entry.contentType, "X-Cache": cacheState },
  });
}

export async function POST(req: NextRequest) {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { url, method, headers, body: reqBody } = isRecord(parsed)
    ? (parsed as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown })
    : {};
  if (typeof url !== "string" || !url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }
  const httpMethod = typeof method === "string" && method ? method : "POST";

  // Block private/internal IPs (SSRF protection)
  try {
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname;
    if (
      host === "localhost" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("172.") ||
      host === "169.254.169.254"
    ) {
      return NextResponse.json({ error: "Blocked" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  // Forward with browser-like headers (caller headers first, our anti-block
  // overrides win — same precedence as before).
  const fwdHeaders: Record<string, string> = {
    ...(isRecord(headers)
      ? Object.fromEntries(
          Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")
        )
      : {}),
    Origin: "https://anilist.co",
    Referer: "https://anilist.co/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };

  // ── L1 read ────────────────────────────────────────────────────────────
  // Expired entries are deliberately NOT deleted here — they are the stale
  // fallback for the final-failure path below.
  const cacheKey = hashKey(httpMethod, url, reqBody);
  const cached = l1Cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cachedResponse(cached, "hit");
  }

  // ── Upstream fetch with bounded retries ───────────────────────────────
  let attempts = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: httpMethod,
        headers: fwdHeaders,
        // Passed through exactly as received (kaizoku-core sends string
        // bodies); the cast keeps the transparent-forwarder behaviour without
        // an `any`.
        body: (reqBody || undefined) as BodyInit | undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      // Network failure / timeout — retryable. The caller's own abort is the
      // one thing that must not be retried.
      if (req.signal?.aborted) throw err;
      if (attempts >= RETRY_ATTEMPTS) {
        if (cached) return cachedResponse(cached, "stale");
        console.warn(
          `[anilist/fetch] upstream unreachable after ${RETRY_ATTEMPTS + 1} attempts:`,
          err instanceof Error ? err.message : err
        );
        return NextResponse.json(
          { error: "Upstream unreachable" },
          { status: 502, headers: { "X-Cache": "miss" } }
        );
      }
      const wait = RETRY_BACKOFF_MS[attempts] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
      console.warn(
        `[anilist/fetch] network error, retry ${attempts + 1}/${RETRY_ATTEMPTS} in ${wait}ms:`,
        err instanceof Error ? err.message : err
      );
      await sleep(wait);
      attempts++;
      continue;
    }

    if (res.status === 429 && attempts < RETRY_ATTEMPTS) {
      const asked = retryAfterMs(res);
      const wait = Math.min(asked ?? RETRY_BACKOFF_MS[attempts] ?? 1000, RETRY_WAIT_CAP_MS);
      console.warn(
        `[anilist/fetch] rate limited (429), retry ${attempts + 1}/${RETRY_ATTEMPTS} in ${wait}ms` +
          (asked !== null ? " (Retry-After honoured, capped)" : "")
      );
      await res.text().catch(() => ""); // drain so the socket is released
      await sleep(wait);
      attempts++;
      continue;
    }

    // Final response — including a 429 that outlasted its retries.
    const text = await res.text().catch(() => "");
    if (!res.ok && res.status === 429 && cached) {
      // Rate limit window outlived every retry: an expired L1 copy beats a
      // provider-visible failure.
      return cachedResponse(cached, "stale");
    }
    if (res.ok) {
      l1Cache.set(cacheKey, {
        text,
        contentType: res.headers.get("content-type") || "application/json",
        expiresAt: Date.now() + L1_TTL_MS,
      });
      if (l1Cache.size > L1_CACHE_MAX) {
        const oldest = l1Cache.keys().next().value;
        if (oldest !== undefined) l1Cache.delete(oldest);
      }
    }

    // Pass through status + content type (transparent forwarder)
    const contentType = res.headers.get("content-type") || "application/json";
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": contentType, "X-Cache": "miss" },
    });
  }
}
