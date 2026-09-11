import { NextRequest, NextResponse } from "next/server";
import fallbackData from "@/lib/anilist-fallback.json";

const ANILIST_API = "https://graphql.anilist.co";

// Simple in-memory cache with TTL
const cache = new Map<string, { data: any; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const ANILIST_CACHE_MAX = 500;

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

function getLocalFallback(query: string, variables: Record<string, any>) {
  if (query.includes("Media(id:") || query.includes("id: $id") || variables.id) {
    const idStr = String(variables.id);
    const media = (fallbackData.mediaMap as any)[idStr] || fallbackData.trending[0];
    return { Media: media };
  }
  
  if (query.includes("airingSchedules")) {
    return {
      Page: {
        airingSchedules: fallbackData.recentlyAired,
        pageInfo: { total: fallbackData.recentlyAired.length, currentPage: 1, lastPage: 1, hasNextPage: false }
      }
    };
  }
  
  if (query.includes("sort: TRENDING_DESC") || query.includes("TRENDING_DESC")) {
    return {
      Page: {
        media: fallbackData.trending,
        pageInfo: { total: fallbackData.trending.length, currentPage: 1, lastPage: 1, hasNextPage: false }
      }
    };
  }
  
  if (query.includes("sort: POPULARITY_DESC") || query.includes("POPULARITY_DESC")) {
    return {
      Page: {
        media: fallbackData.popular,
        pageInfo: { total: fallbackData.popular.length, currentPage: 1, lastPage: 1, hasNextPage: false }
      }
    };
  }
  
  if (variables.search) {
    const q = variables.search.toLowerCase();
    const matched = [...fallbackData.trending, ...fallbackData.popular].filter(m => 
      m.title?.romaji?.toLowerCase().includes(q) || 
      m.title?.english?.toLowerCase().includes(q) ||
      m.title?.native?.toLowerCase().includes(q)
    );
    const seen = new Set();
    const uniqueMatched = matched.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    return {
      Page: {
        media: uniqueMatched,
        pageInfo: { total: uniqueMatched.length, currentPage: 1, lastPage: 1, hasNextPage: false }
      }
    };
  }
  
  const allMedia = [...fallbackData.trending, ...fallbackData.popular];
  const seen = new Set();
  const uniqueMedia = allMedia.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  return {
    Page: {
      media: uniqueMedia,
      pageInfo: { total: uniqueMedia.length, currentPage: 1, lastPage: 1, hasNextPage: false }
    }
  };
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

  const cacheKey = getCacheKey(query, variables);
  const cached = cache.get(cacheKey);
  
  if (cached && cached.expires > Date.now()) {
    return NextResponse.json({ data: cached.data, cached: true });
  }

  try {
    const res = await fetchWithRetry(ANILIST_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://anilist.co",
        Referer: "https://anilist.co/",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      // Upstream failure (e.g. AniList outage) — serve stale cache if we have it
      const stale = cache.get(cacheKey);
      if (stale) {
        return NextResponse.json({ data: stale.data, stale: true });
      }
      
      const fallback = getLocalFallback(query, variables);
      return NextResponse.json({ data: fallback, fallback: true });
    }

    const json = await res.json();
    if (json.errors) {
      // If it contains "temporarily disabled" or similar, use fallback
      const isOutage = json.errors.some((e: any) => 
        e.message?.toLowerCase().includes("disabled") || 
        e.message?.toLowerCase().includes("stability")
      );
      if (isOutage) {
        const fallback = getLocalFallback(query, variables);
        return NextResponse.json({ data: fallback, fallback: true });
      }
      return NextResponse.json({ error: json.errors[0]?.message }, { status: 400 });
    }

    // Cache successful response
    cache.set(cacheKey, { data: json.data, expires: Date.now() + CACHE_TTL });
    if (cache.size > ANILIST_CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }

    return NextResponse.json({ data: json.data });
  } catch (e: any) {
    const fallback = getLocalFallback(query, variables);
    return NextResponse.json({ data: fallback, fallback: true });
  }
}