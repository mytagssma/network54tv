import { NextRequest, NextResponse } from "next/server";
import { getStreamingSources, getStreamingSourcesFallback } from "@/lib/providers";

export const dynamic = "force-dynamic";

const streamCache = new Map<string, { data: any; expires: number }>();
const STREAM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const STREAM_CACHE_MAX = 100;

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

  // Check stream cache (skip cache for non-strict fallback requests)
  const cacheKey = `${title}::${episodeNumber}::${type}::${server || "any"}::${strict}::${providerId || "any"}`;
  if (streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey)!;
    if (cached.expires > Date.now()) {
      return NextResponse.json(cached.data);
    }
    streamCache.delete(cacheKey);
  }

  try {
    // Try exact type first, then fallback through all providers
    let result = await getStreamingSources(title, episodeNumber, type, server, anilistId, providerId);

    if (!strict) {
      // If specific type fails (e.g. sub for a dub-only episode), try the other type
      if (!result) {
        const otherType = type === "sub" ? "dub" : "sub";
        result = await getStreamingSources(title, episodeNumber, otherType, server, anilistId, providerId);
      }

      // Ultimate fallback: try everything
      if (!result) {
        result = await getStreamingSourcesFallback(title, episodeNumber, anilistId);
      }
    }

    if (!result) {
      return NextResponse.json({
        sources: [],
        subtitles: [],
        error: `No streaming sources available for this episode from the current providers. Try selecting a different provider.`,
        providerId,
      });
    }

    const responseData: Record<string, any> = {
      sources: result.sources,
      subtitles: result.subtitles,
      headers: result.headers || {},
      providerId: result.providerId,
    };
    // Include skip times from provider source data if available
    if (result.intro) responseData.intro = result.intro;
    if (result.outro) responseData.outro = result.outro;
    // Cache successful result
    streamCache.set(cacheKey, { data: responseData, expires: Date.now() + STREAM_CACHE_TTL });
    if (streamCache.size > STREAM_CACHE_MAX) {
      const firstKey = streamCache.keys().next().value;
      if (firstKey) streamCache.delete(firstKey);
    }
    return NextResponse.json(responseData);
  } catch (e: any) {
    return NextResponse.json(
      { sources: [], subtitles: [], error: e.message || "Failed to fetch" },
      { status: 500 }
    );
  }
}
