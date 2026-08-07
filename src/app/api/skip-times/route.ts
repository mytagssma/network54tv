import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Simple in-memory cache — skip times are stable per episode
const cache = new Map<string, { intro: { start: number; end: number } | null; outro: { start: number; end: number } | null; ts: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const malIdParam = searchParams.get("malId");
  const episodeParam = searchParams.get("episode");

  if (!malIdParam || !episodeParam) {
    return NextResponse.json({ intro: null, outro: null });
  }

  const malId = parseInt(malIdParam, 10);
  const episode = parseInt(episodeParam, 10);
  if (isNaN(malId) || isNaN(episode)) {
    return NextResponse.json({ intro: null, outro: null });
  }

  const key = `${malId}-${episode}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({ intro: cached.intro, outro: cached.outro });
  }

  try {
    const url = `https://api.aniskip.com/v2/skip-times/${malId}/${episode}?types[]=op&types[]=ed&types[]=mixed-op&types[]=mixed-ed`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      cache.set(key, { intro: null, outro: null, ts: Date.now() });
      return NextResponse.json({ intro: null, outro: null });
    }
    const json = await res.json();
    if (!json.found || !json.results) {
      cache.set(key, { intro: null, outro: null, ts: Date.now() });
      return NextResponse.json({ intro: null, outro: null });
    }

    let intro: { start: number; end: number } | null = null;
    let outro: { start: number; end: number } | null = null;

    for (const item of json.results) {
      const start = Math.round(item.interval.startTime);
      const end = Math.round(item.interval.endTime);
      if ((item.skipType === "op" || item.skipType === "mixed-op") && !intro) {
        intro = { start, end };
      } else if ((item.skipType === "ed" || item.skipType === "mixed-ed") && !outro) {
        outro = { start, end };
      }
    }

    cache.set(key, { intro, outro, ts: Date.now() });
    return NextResponse.json({ intro, outro });
  } catch {
    return NextResponse.json({ intro: null, outro: null });
  }
}
