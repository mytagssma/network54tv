"use client";

import CardShell from "./CardShell";
import type { Anime } from "@/types/anime";

interface UpcomingCardProps {
  anime: Anime;
  loading?: boolean;
  onClick?: () => void;
}

// Labelled months for the "Airs …" meta line (UTC — the YYYYMMDD key the
// mapper builds is date-only, so the local timezone must not shift it).
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const SEASON_LABELS: Record<string, string> = {
  WINTER: "Winter",
  SPRING: "Spring",
  SUMMER: "Summer",
  FALL: "Fall",
};

/** "MOVIE" → "Movie", "TV"/"OVA"/"ONA" kept as-is — mirrors the detail labels. */
function formatLabel(format?: string): string {
  const raw = String(format || "").toUpperCase();
  // AniList leaves `format` null on some not-yet-released entries — fall back
  // to the status chip so the slot always says why the card is here.
  if (!raw) return "Upcoming";
  if (raw === "TV" || raw === "OVA" || raw === "ONA") return raw;
  if (raw === "MOVIE") return "Movie";
  if (raw === "TV_SHORT") return "TV Short";
  if (raw === "SPECIAL") return "Special";
  if (raw === "MUSIC") return "Music";
  return raw.charAt(0) + raw.slice(1).toLowerCase();
}

/**
 * "Airs Oct 20" (year only when it is not the current one) from the premiere
 * date, falling back to the release season label ("Fall 2026") when the date
 * is unknown, and null when neither exists.
 */
function airsLabel(anime: Anime): string | null {
  if (typeof anime.startDate === "number" && anime.startDate > 0) {
    const year = Math.floor(anime.startDate / 10000);
    const month = Math.floor((anime.startDate % 10000) / 100);
    const day = anime.startDate % 100;
    const monthLabel = MONTH_LABELS[month - 1];
    if (monthLabel) {
      const suffix = year === new Date().getFullYear() ? "" : `, ${year}`;
      return `Airs ${monthLabel} ${day}${suffix}`;
    }
  }
  if (anime.season && anime.seasonYear) {
    const season = SEASON_LABELS[anime.season.toUpperCase()] || anime.season;
    return `${season} ${anime.seasonYear}`;
  }
  return null;
}

/**
 * Upcoming anime card — the same anatomy as `AnimeCard` (cover → fixed
 * 2-line title → genre chips → meta row pinned to the bottom), with the
 * score/episode meta swapped for the format chip and the "Airs …" line the
 * browse Upcoming section needs (queue#10).
 */
export default function UpcomingCard({ anime, loading, onClick }: UpcomingCardProps) {
  const airs = airsLabel(anime);

  return (
    <CardShell
      href={`/anime/${anime.id}`}
      onClick={onClick}
      loading={loading}
      image={anime.coverImage}
      alt={anime.title}
      title={anime.title}
      genres={anime.genres}
    >
      {/* Meta row: format/status chip left, premiere line right — pinned to
          the bottom so rows line up across the grid, like AnimeCard's ★/EP */}
      {!loading && (
        <div className="mt-auto flex items-baseline justify-between gap-2 pt-1 text-[10px] leading-none tracking-wide">
          <span className="px-1.5 py-0.5 bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20 rounded-none font-medium whitespace-nowrap">
            {formatLabel(anime.format)}
          </span>
          {airs && (
            <span className="text-white/50 font-medium tabular-nums whitespace-nowrap">
              {airs}
            </span>
          )}
        </div>
      )}
    </CardShell>
  );
}
