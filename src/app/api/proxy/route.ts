import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxies streaming requests with proper headers (Referer, Origin) that
 * the CDN requires but browsers won't send when loading HLS segments.
 *
 * For m3u8 manifests: rewrites all segment/sub-playlist URLs to also go
 * through this proxy so every request carries the required headers.
 *
 * For binary segments (.ts, .aac, etc.): passes through as-is with headers.
 *
 * Usage:
 *   /api/proxy?url=https://megap.kotocdn.site/.../master.m3u8
 *   &referer=https://megaplay.buzz/&origin=https://megaplay.buzz
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const encodedUrl = searchParams.get("url");
  const referer = searchParams.get("referer") || "https://megaplay.buzz/";
  const origin = searchParams.get("origin") || "https://megaplay.buzz";

  if (!encodedUrl) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  try {
    const decodedUrl = decodeURIComponent(encodedUrl);
    const requestHeaders: Record<string, string> = {
      Referer: referer,
      Origin: origin,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    };

    const upstream = await fetch(decodedUrl, { headers: requestHeaders });

    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Upstream returned ${upstream.status}`, url: decodedUrl },
        { status: 502 }
      );
    }

    const contentType = upstream.headers.get("content-type") || "";
    const isM3u8 =
      contentType.includes("m3u8") ||
      contentType.includes("vnd.apple.mpegurl") ||
      decodedUrl.includes(".m3u8");

    // ── Pass through binary (TS, AAC, subtitles, etc.) ──
    if (!isM3u8) {
      const buffer = Buffer.from(await upstream.arrayBuffer());
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": contentType || "application/octet-stream",
          "Content-Length": String(buffer.length),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // ── Parse m3u8 and rewrite URLs ──
    const text = await upstream.text();
    const baseUrl = decodedUrl.substring(0, decodedUrl.lastIndexOf("/") + 1);
    const ourOrigin = `${req.nextUrl.protocol}//${req.nextUrl.host}`;

    const rewritten = text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        // Keep comments, tags, empty lines as-is
        if (trimmed.startsWith("#") || trimmed === "") return line;

        const absoluteUrl = trimmed.startsWith("http")
          ? trimmed
          : new URL(trimmed, baseUrl).toString();

        const proxyParams = new URLSearchParams({
          url: absoluteUrl,
          referer,
          origin,
        });
        return `${ourOrigin}/api/proxy?${proxyParams}`;
      })
      .join("\n");

    return new NextResponse(rewritten, {
      headers: {
        "Content-Type": contentType || "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
        "X-Proxy": "n54tv",
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Proxy error" },
      { status: 500 }
    );
  }
}
