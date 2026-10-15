"use client";

import CardShell from "./CardShell";

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
  onClick?: () => void;
}

export default function AnimeCard({ anime, href, loading, onClick }: AnimeCardProps) {
  const baseHref = href ?? `/anime/${anime.id}`;

  // AniList averageScore is 0–100 → render as e.g. 8.5
  const ratingLabel =
    typeof anime.rating === "number" && Number.isFinite(anime.rating) && anime.rating > 0
      ? (anime.rating / 10).toFixed(1)
      : null;
  // Episode badge — only when the total is known (finite > 0), else no badge.
  // When the run is NOT fully released, show released/total as well:
  // `3/12 EP` (3 aired of 12). A fully released run keeps the plain `12 EP`.
  const total =
    typeof anime.episodes === "number" && Number.isFinite(anime.episodes) && anime.episodes > 0
      ? anime.episodes
      : null;
  // Released count so far; null = unknown (RELEASING without a schedule entry,
  // HIATUS, CANCELLED, missing status). AniList's nextAiringEpisode is the next
  // NOT-yet-aired episode, so `episode - 1` is what has aired.
  let released: number | null = null;
  if (total !== null) {
    const nextEpisode = anime.nextAiringEpisode?.episode;
    if (anime.status === "FINISHED") {
      released = total;
    } else if (typeof nextEpisode === "number" && Number.isFinite(nextEpisode) && nextEpisode >= 1) {
      released = Math.min(Math.max(nextEpisode - 1, 0), total);
    } else if (anime.status === "NOT_YET_RELEASED") {
      released = 0;
    }
  }
  const episodeLabel =
    total === null
      ? null
      : released === null || released >= total
        ? `${total} EP`
        : `${released}/${total} EP`;
  const hasMeta = Boolean(ratingLabel || episodeLabel);

  return (
    <CardShell
      href={baseHref}
      onClick={onClick}
      loading={loading}
      image={anime.image}
      alt={anime.title}
      title={anime.title}
      genres={anime.genres}
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
