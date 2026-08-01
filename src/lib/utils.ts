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
