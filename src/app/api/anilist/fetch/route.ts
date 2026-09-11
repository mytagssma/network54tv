import { NextRequest, NextResponse } from "next/server";

/**
 * Generic fetch proxy used by kaizoku-core's internal AniList client.
 *
 * kaizoku-core sends:
 *   POST /api/anilist/fetch
 *   Body: { url, method, headers, body }
 *
 * This route adds Origin + Referer headers and forwards the request.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { url, method = "POST", headers = {}, body: reqBody } = body;
  if (!url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  // Block private/internal IPs (SSRF protection)
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (
      host === "localhost" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("172.") ||
      host === "169.254.169.254"
    ) {
      return NextResponse.json({ error: "Blocked" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  // Forward with browser-like headers
  const fwdHeaders: Record<string, string> = {
    ...headers,
    Origin: "https://anilist.co",
    Referer: "https://anilist.co/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };

  const res = await fetch(url, {
    method,
    headers: fwdHeaders,
    body: reqBody || undefined,
  });

  // Pass through status + content type
  const contentType = res.headers.get("content-type") || "application/json";
  const text = await res.text();

  return new NextResponse(text, {
    status: res.status,
    headers: { "Content-Type": contentType },
  });
}
