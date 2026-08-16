import { NextRequest, NextResponse } from "next/server";
import { getEpisodes } from "@/lib/providers";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const title = searchParams.get("title") || "";
  const id = searchParams.get("id");
  const provider = searchParams.get("provider") || undefined;

  if (!title || !id) {
    return NextResponse.json({ error: "title and id required" }, { status: 400 });
  }

  const animeId = parseInt(id, 10);
  if (isNaN(animeId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    const episodes = await getEpisodes(title, animeId, provider);
    return NextResponse.json({ episodes });
  } catch (e) {
    return NextResponse.json({ error: "Failed to fetch episodes" }, { status: 500 });
  }
}
