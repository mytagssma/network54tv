import { NextRequest, NextResponse } from "next/server";
import { getAudioFlags, getEpisodes, resolveExpectedEpisodeCount } from "@/lib/providers";

/**
 * `resolveExpectedEpisodeCount` (AniList's episode count, fetch-cached,
 * revalidate 300) now lives in `@/lib/providers` — this route used to keep a
 * byte-identical duplicate of it. It powers the plausibility gate inside
 * `getEpisodes`: reject clearly-wrong lists (a lone "Full" episode for a
 * multi-episode anime) and prefer the provider whose count matches.
 */

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const title = searchParams.get("title") || "";
  const id = searchParams.get("id");
  const provider = searchParams.get("provider") || undefined;
  // `audio=1` resolves unknown sub/dub flags with a megaplay probe (~1-3s).
  // Without it the response is bookkeeping only, so the episode list stays fast.
  const probeAudio = searchParams.get("audio") === "1";

  if (!title || !id) {
    return NextResponse.json({ error: "title and id required" }, { status: 400 });
  }

  const animeId = parseInt(id, 10);
  if (isNaN(animeId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    const expectedCount = await resolveExpectedEpisodeCount(animeId);
    // `listStatus` reports what the plausibility gate decided: `ok` (a list
    // was accepted), `none` (no provider answered) or `suspect` (a list came
    // back and was rejected as implausible). The empty states need it —
    // "nothing exists" and "something existed but looked wrong" are different
    // stories and used to be rendered identically.
    const { episodes, listStatus } = await getEpisodes(title, animeId, provider, expectedCount);
    const { episodes: withFlags, audio } = await getAudioFlags(episodes, animeId, probeAudio);
    // `{ episodes }` is the stable shape (watch page / availability consumers);
    // `audio` and `listStatus` are additive.
    //
    // Cache-Control: any fronting cache (CDN/edge) may serve this for 10
    // minutes and revalidate in the background for up to a day. 600s matches
    // the in-process availability cache's TTL exactly (providers.ts), so an
    // edge hit costs zero provider probes and the first revalidation after
    // expiry re-walks providers once (now in parallel, ~1–1.5s) while stale
    // copies keep serving. 86400s stale-while-revalidate: an episode list a
    // few minutes stale is far better than a spinner, and a newly aired
    // episode picks up on the next revalidation. `max-age=0` keeps BROWSERS
    // out of the way — they must always hit the server (so its in-process
    // cache stays warm) rather than serving their own stale copy.
    const res = NextResponse.json({ episodes: withFlags, audio, listStatus });
    res.headers.set("Cache-Control", "public, max-age=0, s-maxage=600, stale-while-revalidate=86400");
    return res;
  } catch (e) {
    return NextResponse.json({ error: "Failed to fetch episodes" }, { status: 500 });
  }
}
