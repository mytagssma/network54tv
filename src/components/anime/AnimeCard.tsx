"use client";

import Link from "next/link";
import CardShell from "./CardShell";
import { resolveEpisodeFraction } from "@/lib/anime-meta";

interface AnimeCardAnime {
  id: number;
  title: string;
  image: string;
  genres?: string[];
  /** AniList averageScore, 0–100 */
  rating?: number;
  /** Total episode count */
  episodes?: number;
  /** AniList MediaStatus ("FINISHED" | "RELEASING" | "NOT_YET_RELEASED" | …) */
  status?: string;
  /** AniList next schedule entry — the next NOT-yet-aired episode. */
  nextAiringEpisode?: { airingAt?: number; episode?: number };
  /** The exact episode that just aired (home feed's schedule row). */
  latestAiredEpisode?: number;
}

interface AnimeCardProps {
  anime: AnimeCardAnime;
  href?: string;
  loading?: boolean;
  /**
   * Home's Latest Releases feed only: adds the play strip on the cover,
   * deep-linking to the latest RELEASED episode (/anime/{id}/watch/{n}).
   * The strip always names that episode number — it is AniList schedule
   * truth (the home feed supplies the EXACT aired episode from its
   * airing-schedule row; browse/search fall back to nextAiringEpisode − 1).
   * When a provider hasn't uploaded the newest episode yet, the watch page's
   * mount-time stream handoff plays the newest one that actually streams.
   * Browse/search/detail grids never pass it and render exactly as before.
   */
  playLatest?: boolean;
  onClick?: () => void;
}

/**
 * Latest RELEASED episode behind the opt-in `playLatest` strip, or null when
 * nothing has aired yet (those cards render no strip).
 *
 * AniList already knows the exact aired episode; the only job here is to pick
 * the most precise source and read it. The home feed is the most precise: its
 * card carries `latestAiredEpisode`, the `episode` field of the very
 * airing-schedule row that put the title in "Latest Releases" (TIME_DESC), so
 * it is the number that just aired. Surfaces without it (browse/search) fall
 * back to `resolveEpisodeFraction`, which reads `nextAiringEpisode − 1`. These
 * are all AniList SCHEDULE truth — the strip promises that number, and the
 * watch page's mount-time stream handoff covers the transient case where a
 * provider hasn't uploaded it yet.
 *
 *   latestAiredEpisode present → that exact number
 *   total known                → `resolveEpisodeFraction().released`
 *                                 (FINISHED → the full run; a next schedule
 *                                 entry → its episode − 1; NOT_YET_RELEASED →
 *                                 0 → null here)
 *   total unknown              → nextAiringEpisode.episode − 1, but only when
 *                                 that entry is ≥ 2 — episode 1 means the
 *                                 premiere is still ahead, nothing to play
 *   neither case               → null
 */
function latestReleasedEpisode(anime: AnimeCardAnime): number | null {
  // The home feed's exact aired episode — the number that actually just
  // aired — wins over any re-derivation.
  if (
    typeof anime.latestAiredEpisode === "number" &&
    Number.isFinite(anime.latestAiredEpisode) &&
    anime.latestAiredEpisode >= 1
  ) {
    return anime.latestAiredEpisode;
  }
  const fraction = resolveEpisodeFraction(anime);
  if (fraction) {
    return fraction.released !== null && fraction.released >= 1 ? fraction.released : null;
  }
  const nextEpisode = anime.nextAiringEpisode?.episode;
  if (typeof nextEpisode === "number" && Number.isFinite(nextEpisode) && nextEpisode >= 2) {
    return nextEpisode - 1;
  }
  return null;
}

export default function AnimeCard({ anime, href, loading, playLatest, onClick }: AnimeCardProps) {
  const baseHref = href ?? `/anime/${anime.id}`;

  // AniList averageScore is 0–100 → render as e.g. 8.5
  const ratingLabel =
    typeof anime.rating === "number" && Number.isFinite(anime.rating) && anime.rating > 0
      ? (anime.rating / 10).toFixed(1)
      : null;
  // Episode badge — only when the total is known (finite > 0), else no badge.
  // When the run is NOT fully released, show released/total as well:
  // `3/12 EP` (3 aired of 12). A fully released run keeps the plain `12 EP`.
  // The math lives in `resolveEpisodeFraction` (src/lib/anime-meta.ts) so the
  // detail page and watch header derive the exact same badge — output here is
  // byte-identical to the inline version this was extracted from.
  const episodeLabel = resolveEpisodeFraction(anime)?.label ?? null;
  const hasMeta = Boolean(ratingLabel || episodeLabel);
  // The play strip rides the REAL cover only — while a card is navigating
  // (loading skeleton), `playLatest` yields nothing, same as the meta row.
  const playEpisode = playLatest && !loading ? latestReleasedEpisode(anime) : null;

  return (
    <CardShell
      href={baseHref}
      onClick={onClick}
      loading={loading}
      image={anime.image}
      alt={anime.title}
      title={anime.title}
      genres={anime.genres}
      coverOverlay={
        playEpisode === null ? null : (
          <Link
            href={`/anime/${anime.id}/watch/${playEpisode}`}
            // A SIBLING of the card's detail link, never nested inside it:
            // HTML forbids <a> in <a> (and React/Next flag the nesting as a
            // hydration error). CardShell's title link is the "stretched
            // link" — its ::after covers the whole card at z-auto while this
            // strip sits at z-10 above it — so a click or Enter here
            // navigates ONLY to /watch/{n} (the detail link's onClick never
            // runs, so no stopPropagation is needed), and a click anywhere
            // else on the card opens /anime/{id}. It stays a real anchor, so
            // modifier-clicks and "open in new tab" work natively;
            // globals.css draws the focus ring.
            aria-label={`Play episode ${playEpisode} of ${anime.title}`}
            className="label-micro absolute inset-x-0 bottom-0 z-10 flex items-center gap-1.5
                       bg-gradient-to-t from-black/95 via-black/60 to-transparent
                       px-2.5 pt-8 pb-2 font-medium tabular-nums text-white
                       transition-colors group-hover:text-[var(--accent)]
                       focus-visible:text-[var(--accent)]"
          >
            <span aria-hidden="true" className="text-[var(--accent)]">▶</span>
            Play episode {playEpisode}
          </Link>
        )
      }
    >
      {/* Meta row: ★ score and episode count share one baseline; pinned to
          the bottom of the card so rows line up across the grid */}
      {!loading && hasMeta && (
        <div className="mt-auto flex items-baseline justify-between gap-2 pt-1 text-[10px] leading-none tracking-wide">
          <span className="inline-flex items-baseline gap-1 text-[var(--accent)] font-semibold">
            {ratingLabel && (
              <>
                <span aria-hidden="true">★</span>
                <span className="tabular-nums">{ratingLabel}</span>
              </>
            )}
          </span>
          <span className="text-white/50 font-medium tabular-nums whitespace-nowrap">
            {episodeLabel}
          </span>
        </div>
      )}
    </CardShell>
  );
}
