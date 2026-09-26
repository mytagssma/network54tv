import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

/**
 * Proxies streaming requests with proper headers (Referer, Origin) that
 * the CDN requires but browsers won't send when loading HLS segments.
 *
 * The video element uses crossOrigin="anonymous" (required for MSE/hls.js),
 * so ALL segment loads must go through this proxy — the CDN domains don't
 * send CORS headers, which would cause browser requests to fail silently.
 *
 * For m3u8 manifests: rewrites all segment/sub-playlist URLs to go through
 * this proxy so every request carries the required headers + CORS.
 *
 * For binary segments (.ts, .aac, etc.): streams through with proper headers.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const encodedUrl = searchParams.get("url");
  const referer = searchParams.get("referer") || "https://megaplay.buzz/";
  const origin = searchParams.get("origin") || "https://megaplay.buzz";

  if (!encodedUrl) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  let decodedUrl = "";
  try {
    decodedUrl = decodeURIComponent(encodedUrl);

    // SSRF protection: validate URL scheme and block private/internal hosts
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(decodedUrl);
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return NextResponse.json({ error: "Only http/https URLs allowed" }, { status: 400 });
    }
    const hostname = parsedUrl.hostname;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("172.") ||
      hostname === "169.254.169.254" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ) {
      return NextResponse.json({ error: "Internal URLs not allowed" }, { status: 403 });
    }

    const looksLikeM3u8 = decodedUrl.includes(".m3u8");
    const requestHeaders: Record<string, string> = {
      Referer: referer,
      Origin: origin,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    };

    // Byte-range requests (progressive seeking) must be relayed upstream so we
    // can pass back a real 206 + Content-Range. Manifests never need it.
    const rangeHeader = req.headers.get("range");
    if (!looksLikeM3u8 && rangeHeader) {
      requestHeaders["Range"] = rangeHeader;
    }

    // Bound the upstream wait: a dead CDN must surface as a 504 instead of
    // hanging the player's request forever.
    const upstream = await fetch(decodedUrl, {
      headers: requestHeaders,
      signal: AbortSignal.timeout(10000),
    });

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
      looksLikeM3u8;

    // ── Pass through binary (TS, AAC, subtitles, etc.) using a streaming
    //    pipe so we don't buffer the entire segment in serverless memory.
    if (!isM3u8) {
      const cacheHeaders: Record<string, string> = {
        "Content-Type": contentType || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
        // Progressive seeking relies on range support being advertised.
        "Accept-Ranges": "bytes",
      };

      // Relay the upstream 206 + Content-Range for byte-range requests.
      const contentRange = upstream.headers.get("content-range");
      if (contentRange) cacheHeaders["Content-Range"] = contentRange;

      // Only forward Content-Length when fetch() handed us the body verbatim.
      // With an upstream Content-Encoding the body has already been
      // decompressed, so the compressed length would promise bytes that never
      // arrive and the browser would hang waiting for them.
      const contentLength = upstream.headers.get("content-length");
      const contentEncoding = upstream.headers.get("content-encoding");
      if (contentLength && !contentEncoding) {
        cacheHeaders["Content-Length"] = contentLength;
      }

      return new NextResponse(upstream.body, {
        status: upstream.status,
        headers: cacheHeaders,
      });
    }

    // ── Parse m3u8 and rewrite ALL URLs to go through the proxy ──
    // Required because the video element has crossOrigin="anonymous" and CDN
    // domains don't send CORS headers — segments loaded directly would be
    // blocked by the browser's CORS enforcement.
    const text = await upstream.text();
    const baseUrl = decodedUrl.substring(0, decodedUrl.lastIndexOf("/") + 1);
    const ourOrigin = `${req.nextUrl.protocol}//${req.nextUrl.host}`;

    const rewritten = text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed === "") return line;

        // If it starts with "#", it's a tag/comment.
        // If it has URI="..." or URI=..., we need to rewrite that URI so that it goes through the proxy too.
        if (trimmed.startsWith("#")) {
          return trimmed.replace(/URI=\"([^\"]+)\"/gi, (match, uri) => {
            const absoluteUrl = uri.startsWith("http")
              ? uri
              : new URL(uri, baseUrl).toString();
            const proxyParams = new URLSearchParams({
              url: absoluteUrl,
              referer,
              origin,
            });
            return `URI="${ourOrigin}/api/proxy?${proxyParams}"`;
          });
        }

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
    // AbortSignal.timeout(10000) fired — the CDN never answered.
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      return NextResponse.json(
        { error: "Upstream timed out", url: decodedUrl },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { error: e.message || "Proxy error" },
      { status: 500 }
    );
  }
}
