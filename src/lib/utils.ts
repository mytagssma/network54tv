export function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(" ");
}

export function formatSeason(season?: string): string {
  if (!season) return "";
  const s = season.charAt(0).toUpperCase() + season.slice(1).toLowerCase();
  return s;
}

export function stripHtml(html?: string): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "");
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "...";
}

/**
 * Build a proxy URL that adds required headers upstream.
 *
 * Header precedence:
 *   1. Explicit `headers` Referer/Origin supplied by the stream provider
 *   2. Derived from the target URL's own host (e.g. https://hls.krussdomi.com)
 *      — a hardcoded default referer would be rejected by every other CDN
 */
export function proxyUrl(
  rawUrl: string,
  headers?: Record<string, string> | null
): string {
  let derivedOrigin = "";
  try {
    const host = new URL(rawUrl).host;
    if (host) derivedOrigin = `https://${host}`;
  } catch {
    // unparseable (e.g. blob:) — fall through to the legacy default below
  }
  const referer =
    headers?.["Referer"] ||
    headers?.["referer"] ||
    (derivedOrigin ? `${derivedOrigin}/` : "https://megaplay.buzz/");
  const origin =
    headers?.["Origin"] ||
    headers?.["origin"] ||
    derivedOrigin ||
    "https://megaplay.buzz";
  const params = new URLSearchParams({ url: rawUrl, referer, origin });
  return `/api/proxy?${params}`;
}
