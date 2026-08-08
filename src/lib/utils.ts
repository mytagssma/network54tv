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

/** Build a proxy URL that adds required headers upstream */
export function proxyUrl(rawUrl: string, headers?: Record<string, string>): string {
  const referer =
    headers?.["Referer"] || headers?.["referer"] || "https://megaplay.buzz/";
  const origin =
    headers?.["Origin"] || headers?.["origin"] || "https://megaplay.buzz";
  const params = new URLSearchParams({ url: rawUrl, referer, origin });
  return `/api/proxy?${params}`;
}
