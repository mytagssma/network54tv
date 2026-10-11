import { searchAnime } from "@/lib/anilist";
import type { Anime } from "@/types/anime";

// Shared between the /browse SERVER page (its first-paint fetch) and the
// browse CLIENT component — a plain module on purpose: importing these from
// a "use client" file would hand the server a client reference instead of
// the value.
//
// Fixed AniList page sizes: the fill logic (useLastRowFill / createPageBuffer)
// never changes `perPage`, it only decides how many *visible* cards a fetch
// hands to the grid, so page arithmetic stays aligned between the server's
// first page and the client's continuation pages. The two MUST be the same
// number or page 2 would overlap page 1.
export const SEARCH_PER_PAGE = 24;
export const LANDING_PER_PAGE = 12;

/** First search page the server renders for a hard load of /browse?q=… */
export interface InitialSearch {
  /** The `q` this data belongs to — the client refuses it for any other query. */
  query: string;
  media: Anime[];
  hasNextPage: boolean;
}

/**
 * Server-side twin of the browse page's initial `searchAnimeClient` call:
 * same function (`searchAnime` → executeSearch), same page 1 / perPage / no
 * filters, so what the HTML ships is exactly what the client would have
 * fetched. A failure yields `null` and the client falls back to its own
 * fetch — the SSR shell then shows its loading state as before.
 */
export async function fetchInitialSearch(query: string): Promise<InitialSearch | null> {
  if (!query) return null;
  try {
    const data = await searchAnime(query, 1, SEARCH_PER_PAGE);
    return { query, media: data.media, hasNextPage: data.hasNextPage };
  } catch {
    return null;
  }
}
