import { NextRequest, NextResponse } from "next/server";
import { searchSubtitles, downloadSubtitle } from "@/lib/opensubtitles";

/**
 * GET /api/opensubtitles
 *
 * Search mode (params):
 *   query          — anime title (fallback)
 *   imdb_id        — IMDB ID without "tt" prefix
 *   parent_imdb_id — series IMDB ID (for TV, use with season_number + episode_number)
 *   season_number
 *   episode_number
 *   languages      — comma-separated ISO codes (default "en")
 *
 * Download mode (params):
 *   file_id        — ID from search result
 *   sub_format     — "vtt" (default) | "srt"
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // ── Download mode ────────────────────────────────────────────────────
  const fileId = searchParams.get("file_id");
  if (fileId) {
    try {
      const format = (searchParams.get("sub_format") ?? "vtt") as "vtt" | "srt";
      const result = await downloadSubtitle(parseInt(fileId, 10), format);

      return new NextResponse(result.content, {
        headers: {
          "Content-Type": format === "vtt" ? "text/vtt; charset=utf-8" : "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=86400, s-maxage=86400",
          "X-Subtitle-FileName": encodeURIComponent(result.fileName),
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Download failed";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  // ── Search mode ──────────────────────────────────────────────────────
  const query = searchParams.get("query");
  const imdbId = searchParams.get("imdb_id");
  const parentImdbId = searchParams.get("parent_imdb_id");
  const seasonNumber = searchParams.get("season_number");
  const episodeNumber = searchParams.get("episode_number");
  const languages = searchParams.get("languages") ?? "en";

  // Need at least one search criterion
  if (!query && !imdbId && !parentImdbId) {
    return NextResponse.json(
      { error: "Provide query, imdb_id, or parent_imdb_id" },
      { status: 400 }
    );
  }

  try {
    const results = await searchSubtitles({
      query: query || undefined,
      imdb_id: imdbId ? parseInt(imdbId, 10) : undefined,
      parent_imdb_id: parentImdbId ? parseInt(parentImdbId, 10) : undefined,
      season_number: seasonNumber ? parseInt(seasonNumber, 10) : undefined,
      episode_number: episodeNumber ? parseInt(episodeNumber, 10) : undefined,
      languages,
    });

    return NextResponse.json({ results });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
