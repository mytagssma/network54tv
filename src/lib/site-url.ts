/**
 * Absolute URL of this deployment — shared by every server-side caller that
 * needs to fetch back through the app's own hardened proxy routes.
 *
 * On Vercel, VERCEL_URL is host-only (e.g. "xyz.vercel.app") — we must
 * prepend https://.
 */
export function buildSiteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) {
    const raw = process.env.VERCEL_URL.replace(/\/+$/, "");
    return raw.startsWith("http") ? raw : `https://${raw}`;
  }
  return "http://localhost:3000";
}
