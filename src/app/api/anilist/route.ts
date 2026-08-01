import { NextRequest, NextResponse } from "next/server";

const ANILIST_API = "https://graphql.anilist.co";

// Simple in-memory cache with TTL
const cache = new Map<string, { data: any; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(query: string, variables: Record<string, any>): string {
  return `${query}::${JSON.stringify(variables)}`;
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, options);
    
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const delay = retryAfter ? parseInt(retryAfter) * 1000 : Math.min(1000 * 2 ** i, 10000);
      console.warn(`AniList rate limited (429), retrying in ${delay}ms (attempt ${i + 1}/${retries + 1})`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    
    return res;
  }
  
  // If all retries exhausted, return the last response (likely still 429)
  return fetch(url, options);
}

export async function POST(req: NextRequest) {
  try {
    const { query, variables } = await req.json();

    if (!query) {
      return NextResponse.json({ error: "Missing query" }, { status: 400 });
    }

    const cacheKey = getCacheKey(query, variables);
    const cached = cache.get(cacheKey);
    
    if (cached && cached.expires > Date.now()) {
      return NextResponse.json({ data: cached.data, cached: true });
    }

    const res = await fetchWithRetry(ANILIST_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      return NextResponse.json({ error: `AniList API error: ${res.status}` }, { status: res.status });
    }

    const json = await res.json();
    if (json.errors) {
      return NextResponse.json({ error: json.errors[0]?.message }, { status: 400 });
    }

    // Cache successful response
    cache.set(cacheKey, { data: json.data, expires: Date.now() + CACHE_TTL });

    return NextResponse.json({ data: json.data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to fetch" }, { status: 500 });
  }
}