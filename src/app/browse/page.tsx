import { Suspense } from "react";
import { headers } from "next/headers";
import { fetchInitialSearch, type InitialSearch } from "@/lib/browse";
import BrowseContent from "@/components/browse/BrowseContent";

/**
 * /browse — SERVER component.
 *
 * The page itself moved to `src/components/browse/BrowseContent.tsx` (still
 * "use client": filters, live search and the grid all live there). What stays
 * here is the request-time half: for a document load with `?q=`, page 1 of
 * the search is fetched on the server and handed down as `initialSearch`, so
 *
 *   - the SSR HTML contains the REAL results / the REAL empty state instead
 *     of a "Loading..." box (e.g. a typo query that AniList answers with an
 *     empty array renders "No results for …" in the served body), and
 *   - the client does not repeat the request it was just given.
 *
 * Client-side navigations (the header's submit `router.push`) do NOT
 * fetch here: they pass `initialSearch={null}` and BrowseContent
 * fetches client-side exactly as before — its AbortSignal is what
 * kills a superseded request, and that only exists on the client.
 * Sniffing the request is what keeps the two paths apart:
 *
 *   - browser document load → `sec-fetch-dest: document` (or no Fetch
 *     Metadata header at all, which is what curl/scripts send) → fetch;
 *   - the router's RSC fetch → `sec-fetch-dest: empty`, and Next's own
 *     `next-router-state-tree` marker as a backup → skip.
 *
 * Worst case (an old client with neither header) is a redundant server fetch
 * that the client then reuses — never a wrong result.
 */
async function isDocumentRequest(): Promise<boolean> {
  const h = await headers();
  const dest = h.get("sec-fetch-dest");
  if (dest !== null) return dest === "document";
  return !h.has("next-router-state-tree");
}

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] | undefined }>;
}) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q : "";

  let initialSearch: InitialSearch | null = null;
  if (query && (await isDocumentRequest())) {
    initialSearch = await fetchInitialSearch(query);
  }

  return (
    <Suspense
      fallback={
        <div className="max-w-7xl mx-auto px-4 py-8">
          <div className="text-center py-12 text-[var(--text-decorative)] font-mono text-sm uppercase tracking-wider">
            Loading...
          </div>
        </div>
      }
    >
      <BrowseContent initialSearch={initialSearch} />
    </Suspense>
  );
}
