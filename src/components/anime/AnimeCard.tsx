"use client";

import Link from "next/link";

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
    <Link
      href={baseHref}
      onClick={() => onClick?.()}
      className="block bg-[var(--panel)] border border-[var(--accent)]/10 overflow-hidden
                 transition-all duration-200 hover:border-[var(--accent)]/50 hover:-translate-y-0.5
                 rounded-none accent-card-hover"
    >
      {/* Cover image */}
      <div className="aspect-[3/4] relative overflow-hidden bg-[var(--background)] rounded-none">
        {loading ? (
          <>
            {/* Diagonal 4-part pulse loading overlay */}
            <div className="absolute inset-0 z-10 pointer-events-none">
              {/* Top triangle */}
              <div
                className="diagonal-pulse-section absolute inset-0"
                style={{ clipPath: "polygon(0 0, 100% 0, 50% 50%)" }}
              />
              {/* Right triangle */}
              <div
                className="diagonal-pulse-section absolute inset-0"
                style={{ clipPath: "polygon(100% 0, 100% 100%, 50% 50%)" }}
              />
              {/* Bottom triangle */}
              <div
                className="diagonal-pulse-section absolute inset-0"
                style={{ clipPath: "polygon(0 100%, 100% 100%, 50% 50%)" }}
              />
              {/* Left triangle */}
              <div
                className="diagonal-pulse-section absolute inset-0"
                style={{ clipPath: "polygon(0 0, 0 100%, 50% 50%)" }}
              />
            </div>
            {/* Dimmed placeholder behind the pulse */}
            <div className="absolute inset-0 bg-[var(--panel)]" />
          </>
        ) : (
          <img
            src={anime.image}
            alt={anime.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        )}
      </div>

      {/* Info */}
      <div className="p-3 space-y-1">
        <h3 className="text-sm font-bold text-white line-clamp-2 leading-tight uppercase tracking-wider">
          {loading ? "\u00A0" : anime.title}
        </h3>

        {!loading && anime.genres && anime.genres.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {anime.genres.slice(0, 3).map((genre) => (
              <span
                key={genre}
                className="text-[10px] px-1.5 py-0.5 bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20 rounded-none"
              >
                {genre}
              </span>
            ))}
          </div>
        )}

        {/* Meta row: rating + episode count */}
        {!loading && hasMeta && (
          <div className="flex items-center justify-between gap-2 text-[10px] leading-none tracking-wide">
            <span className="inline-flex items-center gap-1 text-[var(--accent)] font-semibold">
              {ratingLabel && (
                <>
                  <span aria-hidden="true" className="text-[9px] leading-none">
                    ★
                  </span>
                  <span className="tabular-nums">{ratingLabel}</span>
                </>
              )}
            </span>
            <span className="text-white/50 font-medium tabular-nums whitespace-nowrap">
              {episodeLabel}
            </span>
          </div>
        )}

        {loading && (
          <>
            <div className="flex gap-1">
              <div className="h-2.5 w-12 bg-[var(--accent)]/10 rounded-none animate-pulse" />
              <div className="h-2.5 w-8 bg-[var(--accent)]/10 rounded-none animate-pulse" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="h-2.5 w-7 bg-[var(--accent)]/10 rounded-none animate-pulse" />
              <div className="h-2.5 w-9 bg-[var(--accent)]/10 rounded-none animate-pulse" />
            </div>
          </>
        )}
      </div>
    </Link>
  );
}
