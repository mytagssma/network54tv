import { NextRequest, NextResponse } from "next/server";
import { getAudioFlags, getEpisodes } from "@/lib/providers";

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
    const episodes = await getEpisodes(title, animeId, provider);
    const { episodes: withFlags, audio } = await getAudioFlags(episodes, animeId, probeAudio);
    // `{ episodes }` is the stable shape (watch page / availability consumers);
    // `audio` is additive.
    return NextResponse.json({ episodes: withFlags, audio });
  } catch (e) {
    return NextResponse.json({ error: "Failed to fetch episodes" }, { status: 500 });
  }
}
