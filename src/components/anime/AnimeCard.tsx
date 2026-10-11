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
  const episodeLabel =
    typeof anime.episodes === "number" && anime.episodes > 0 ? `${anime.episodes} EP` : null;
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
