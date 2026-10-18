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
}

interface AnimeCardProps {
  anime: AnimeCardAnime;
  href?: string;
  loading?: boolean;
  /**
   * Home's Latest Releases feed only: adds the play strip on the cover,
   * deep-linking to the latest RELEASED episode (/anime/{id}/watch/{n}).
   * The strip NAMES the episode ("Play episode N") only when N is settled
   * fact — a FINISHED, fully released run, whose number can't lag the
   * providers. For anything still airing the number is AniList-schedule-
   * derived and routinely leads the uploads around air time, so the strip
   * promises no number ("Play latest") and the watch page's mount-time
   * stream handoff resolves the newest actually-playable episode.
   * Browse/search/detail grids never pass it and render exactly as before.
   */
  playLatest?: boolean;
  onClick?: () => void;
}

/**
 * Latest RELEASED episode behind the opt-in `playLatest` strip, or null when
 * nothing has aired yet (those cards render no strip). Whenever the total is
 * known, `resolveEpisodeFraction` owns the math so the strip and the `3/12 EP`
 * badge can never disagree about what has aired (episode 3 in that example).
 * The one case it can't cover: a mid-run total AniList hasn't announced yet
 * (episodes null) — the badge then shows nothing, but the next schedule
 * entry alone still pins down what has aired:
 *
 *   total known     → `resolveEpisodeFraction().released`
 *                      (FINISHED → the full run; a next schedule entry → its
 *                      episode − 1; NOT_YET_RELEASED → 0 → null here)
 *   total unknown   → nextAiringEpisode.episode − 1, but only when that
 *                      entry is ≥ 2 — episode 1 means the premiere is still
 *                      ahead, so there is nothing to play
 *   neither case    → null
 */
function latestReleasedEpisode(anime: AnimeCardAnime): number | null {
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

/**
 * May the strip PROMISE the derived episode number ("Play episode 57")?
 *
 * The number above is AniList schedule truth, not provider truth: for a
 * still-airing run the newest "released" episode routinely has no stream
 * yet (the classic latest-episode lag — the card can't cheaply know; a
 * stream walk per home card is infeasible). So the strip only names a
 * number when the run is over: FINISHED with the total fully released,
 * where every episode is as streamable as it will ever be. Everything
 * else says "Play latest" and lets the watch page's mount-time stream
 * handoff pick the newest episode that actually plays. The LINK still
 * targets the derived episode either way — the handoff is what saves it.
 */
function stripNamesEpisode(anime: AnimeCardAnime): boolean {
  const fraction = resolveEpisodeFraction(anime);
  return (
    anime.status === "FINISHED" &&
    fraction !== null &&
    fraction.released !== null &&
    fraction.released >= fraction.total
  );
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
  // …and it only NAMES that episode when the number is settled fact
  // (FINISHED run, fully released). Schedule-derived numbers for still-
  // airing runs can lead the providers, so those strips say "Play latest"
  // — see `stripNamesEpisode`. The link target is the same derived
  // episode in both cases; the watch page's mount-time stream handoff
  // corrects it if providers haven't caught up.
  const stripSaysNumber = playEpisode !== null && stripNamesEpisode(anime);

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
            aria-label={
              stripSaysNumber
                ? `Play episode ${playEpisode} of ${anime.title}`
                : `Play the latest episode of ${anime.title}`
            }
            className="label-micro absolute inset-x-0 bottom-0 z-10 flex items-center gap-1.5
                       bg-gradient-to-t from-black/95 via-black/60 to-transparent
                       px-2.5 pt-8 pb-2 font-medium tabular-nums text-white
                       transition-colors group-hover:text-[var(--accent)]
                       focus-visible:text-[var(--accent)]"
          >
            <span aria-hidden="true" className="text-[var(--accent)]">▶</span>
            {stripSaysNumber ? <>Play episode {playEpisode}</> : "Play latest"}
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
