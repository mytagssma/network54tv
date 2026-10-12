import { NextRequest, NextResponse } from "next/server";

const ANILIST_API = "https://graphql.anilist.co";

// Simple in-memory cache with TTL — the L1 / warm-instance layer. On Vercel
// every cold serverless invocation starts empty, so this Map only helps
// within one warm instance; the CDN (see GET_CACHE_CONTROL below) is the
// layer that actually serves repeat queries there.
const cache = new Map<string, { data: any; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const ANILIST_CACHE_MAX = 500;

// CDN policy for GET responses (Vercel's edge honours s-maxage on function
// responses, so a repeat URL never reaches a serverless invocation):
//
//   s-maxage=86400 (24h) — AniList media metadata and the result set of a
//     fixed query+variables are stable on a day scale; a one-day-old
//     snapshot is an acceptable price for skipping cold starts + upstream
//     round-trips entirely.
//   stale-while-revalidate=604800 (7d) — once older than 24h the edge keeps
//     answering from the snapshot while refreshing in the background, so
//     users never block on AniList unless the edge could not revalidate for
//     a full week (at which point the data would be visibly stale anyway).
//
// POST responses are never given cache headers: POST is kept only for
// compatibility and is not a cacheable method. Errors and stale fallbacks
// get their own headers (see below) so a failure is never frozen in the CDN
// for a day.
const GET_CACHE_CONTROL = "public, s-maxage=86400, stale-while-revalidate=604800";
// Upstream failed but L1 still had an expired copy: serve it, but only cache
// briefly at the edge so recovery is quick.
const GET_STALE_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=600";
const NO_STORE = "no-store";

function getCacheKey(query: string, variables: Record<string, any>): string {
  return `${query}::${JSON.stringify(variables)}`;
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 3, signal?: AbortSignal): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    // A superseded query aborts the client's request; the
    // upstream POST must die with it instead of running (and retrying) to
    // completion — otherwise every submit in quick succession leaves an
    // orphaned request piling up against AniList.
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const res = await fetch(url, { ...options, signal });

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const delay = retryAfter ? parseInt(retryAfter) * 1000 : Math.min(1000 * 2 ** i, 10000);
      console.warn(`AniList rate limited (429), retrying in ${delay}ms (attempt ${i + 1}/${retries + 1})`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    return res;
  }

  // If all retries exhausted, return the last response
  return fetch(url, { ...options, signal });
}

/**
 * One AniList round-trip with L1 caching, shared by POST (compatibility) and
 * GET (CDN-cacheable). `cdnCacheable` marks the response as a GET success so
 * the right Cache-Control is attached; POST responses stay header-free.
 */
async function runQuery(
  query: string,
  variables: Record<string, unknown>,
  cdnCacheable: boolean,
  signal?: AbortSignal
): Promise<NextResponse> {
  const cacheKey = getCacheKey(query, variables);
  const cached = cache.get(cacheKey);

  if (cached && cached.expires > Date.now()) {
    // L1 hit — on GET this is still a 200 and therefore CDN-cacheable.
    return NextResponse.json(
      { data: cached.data, cached: true },
      { headers: cdnCacheable ? { "Cache-Control": GET_CACHE_CONTROL } : undefined }
    );
  }

  const res = await fetchWithRetry(ANILIST_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: "https://anilist.co",
      Referer: "https://anilist.co/",
    },
    body: JSON.stringify({ query, variables }),
  }, 3, signal);

  if (!res.ok) {
    // Serve stale cache if available — briefly CDN-cacheable, never a day.
    const stale = cache.get(cacheKey);
    if (stale) {
      return NextResponse.json(
        { data: stale.data, stale: true },
        { headers: cdnCacheable ? { "Cache-Control": GET_STALE_CACHE_CONTROL } : undefined }
      );
    }
    return NextResponse.json(
      { error: `AniList API error: ${res.status}` },
      { status: res.status, headers: cdnCacheable ? { "Cache-Control": NO_STORE } : undefined }
    );
  }

  const json = await res.json();
  if (json.errors) {
    return NextResponse.json(
      { error: json.errors[0]?.message },
      { status: 400, headers: cdnCacheable ? { "Cache-Control": NO_STORE } : undefined }
    );
  }

  // Cache successful response
  cache.set(cacheKey, { data: json.data, expires: Date.now() + CACHE_TTL });
  if (cache.size > ANILIST_CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }

  return NextResponse.json(
    { data: json.data },
    { headers: cdnCacheable ? { "Cache-Control": GET_CACHE_CONTROL } : undefined }
  );
}

export async function POST(req: NextRequest) {
  let requestBody: any = {};
  try {
    requestBody = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { query, variables = {} } = requestBody;

  if (!query) {
    return NextResponse.json({ error: "Missing query" }, { status: 400 });
  }

  // Unchanged behaviour: no cache headers — POST is kept for compatibility
  // only and is not a cacheable method.
  return runQuery(query, variables, false, req.signal);
}

/**
 * CDN-cacheable twin of POST. Same contract and same response bodies, but
 * addressable by URL (`?payload=` = URL-encoded JSON of {query, variables}),
 * so Vercel's edge can serve repeats without a serverless invocation. The
 * GraphQL document is fixed text per caller and variables are small — the
 * worst observed URL is ~2.2KB (SEARCH_QUERY), far under URL limits.
 */
export async function GET(req: NextRequest) {
  const payload = req.nextUrl.searchParams.get("payload");
  if (!payload) {
    return NextResponse.json({ error: "Missing payload" }, { status: 400, headers: { "Cache-Control": NO_STORE } });
  }

  let parsed: { query?: unknown; variables?: unknown } | null = null;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400, headers: { "Cache-Control": NO_STORE } });
  }

  const query = typeof parsed?.query === "string" ? parsed.query : "";
  const rawVariables = parsed?.variables;
  const variables: Record<string, unknown> =
    rawVariables && typeof rawVariables === "object"
      ? (rawVariables as Record<string, unknown>)
      : {};
  if (!query) {
    return NextResponse.json({ error: "Missing query" }, { status: 400, headers: { "Cache-Control": NO_STORE } });
  }

  return runQuery(query, variables, true, req.signal);
}
