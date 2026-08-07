import { NextRequest, NextResponse } from "next/server";
import { getStreamingSources, getStreamingSourcesFallback } from "@/lib/providers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const title = searchParams.get("title");
  const episode = searchParams.get("episode");
  const type = (searchParams.get("type") || "sub") as "sub" | "dub";
  const server = searchParams.get("server") || undefined;
  const anilistIdParam = searchParams.get("anilistId");

  if (!title || !episode) {
    return NextResponse.json({ error: "Missing title or episode" }, { status: 400 });
  }

  const episodeNumber = parseInt(episode, 10);
  if (isNaN(episodeNumber)) {
    return NextResponse.json({ error: "Invalid episode number" }, { status: 400 });
  }

  const anilistId = anilistIdParam ? parseInt(anilistIdParam, 10) : undefined;
  const strict = searchParams.get("strict") === "true";

  try {
    // Try exact type first, then fallback through all providers
    let result = await getStreamingSources(title, episodeNumber, type, server, anilistId);

    if (!strict) {
      // If specific type fails (e.g. sub for a dub-only episode), try the other type
      if (!result) {
        const otherType = type === "sub" ? "dub" : "sub";
        result = await getStreamingSources(title, episodeNumber, otherType, server, anilistId);
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
        error: "No streaming sources found from any provider",
      });
    }

    return NextResponse.json({
      sources: result.sources,
      subtitles: result.subtitles,
      headers: result.headers || {},
      providerId: result.providerId,
    });
  } catch (e: any) {
    return NextResponse.json(
      { sources: [], subtitles: [], error: e.message || "Failed to fetch" },
      { status: 500 }
    );
  }
}
