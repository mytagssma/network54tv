/**
 * ─── One vocabulary for anime metadata ──────────────────────────────────
 *
 * The detail page, the watch header and the cards used to each derive their
 * own episode counts, statuses and formats — `3/12 EP` on a card next to a
 * bare `28 ep` badge and a raw `TV_SHORT` chip two clicks away. This module is
 * the single place those values are derived and humanized, extracted verbatim
 * from `AnimeCard` (the fraction math, pixel-identical output) and from
 * `UpcomingCard`'s label pattern (status/format/premiere language).
 *
 * Pure functions, no "use client": server pages and client cards render the
 * same strings.
 */

/** The input every helper here needs — a structural subset of `Anime`. */
export interface AnimeMetaSource {
  /** Total episode count from AniList (null/undefined = unknown). */
  episodes?: number | null;
  /** AniList MediaStatus ("FINISHED" | "RELEASING" | "NOT_YET_RELEASED" | …). */
  status?: string | null;
  /** AniList MediaFormat ("TV" | "TV_SHORT" | "MOVIE" | …). */
  format?: string | null;
  /** AniList next schedule entry — the next NOT-yet-aired episode. */
  nextAiringEpisode?: { airingAt?: number; episode?: number } | null;
  /** Premiere date as YYYYMMDD (from AniList startDate { year month day }). */
  startDate?: number | null;
}

/** AniList MediaStatus → the one humanized label every surface renders. */
export const STATUS_LABEL_MAP: Record<string, string> = {
  FINISHED: "Finished",
  RELEASING: "Airing",
  CANCELLED: "Cancelled",
  NOT_YET_RELEASED: "Upcoming",
};

/**
 * AniList MediaFormat → humanized label. A null format (AniList leaves it
 * unset on some not-yet-released entries) reads "Upcoming" — the same slot
 * filler `UpcomingCard` uses. Unknown formats fall back to the capitalized
 * raw value ("NOVEL" → "Novel"), mirroring UpcomingCard's fallback.
 */
export const FORMAT_LABEL_MAP: Record<string, string> = {
  TV: "TV",
  TV_SHORT: "TV Short",
  MOVIE: "Movie",
  OVA: "OVA",
  ONA: "ONA",
  SPECIAL: "Special",
  MUSIC: "Music",
};

/**
 * Status badge text: mapped when known, otherwise the raw enum with its
 * underscores removed (e.g. `HIATUS` keeps rendering as before — the badge
 * uppercases it either way).
 */
export function statusLabel(status?: string | null): string {
  if (!status) return "";
  return STATUS_LABEL_MAP[status] ?? status.replace(/_/g, " ");
}

/** Format badge text — see `FORMAT_LABEL_MAP` for the null/unknown cases. */
export function formatLabel(format?: string | null): string {
  const raw = String(format || "").toUpperCase();
  if (!raw) return "Upcoming";
  return FORMAT_LABEL_MAP[raw] ?? raw.charAt(0) + raw.slice(1).toLowerCase();
}

export interface EpisodeFraction {
  /** Total episode count — always finite > 0 when this resolves. */
  total: number;
  /** Episodes released so far; null = unknown (HIATUS / CANCELLED / …). */
  released: number | null;
  /** Card badge language: `3/12 EP` while airing, plain `12 EP` once done. */
  label: string;
}

/**
 * Released/total episode fraction — extracted from `AnimeCard`'s badge math,
 * so every surface that shows a count shows the SAME count:
 *
 *   FINISHED          → released = total            (`12 EP`)
 *   nextAiringEpisode → released = episode - 1, clamped to [0, total]
 *                       (AniList's next entry is the next NOT-yet-aired
 *                       episode, so minus one is what has aired)
 *   NOT_YET_RELEASED  → released = 0                (`0/12 EP`)
 *   anything else     → released = null             (plain `12 EP`)
 *   total unknown     → null (caller renders no badge at all)
 */
export function resolveEpisodeFraction(anime: AnimeMetaSource): EpisodeFraction | null {
  const total =
    typeof anime.episodes === "number" && Number.isFinite(anime.episodes) && anime.episodes > 0
      ? anime.episodes
      : null;
  if (total === null) return null;

  let released: number | null = null;
  if (anime.status === "FINISHED") {
    released = total;
  } else {
    const nextEpisode = anime.nextAiringEpisode?.episode;
    if (typeof nextEpisode === "number" && Number.isFinite(nextEpisode) && nextEpisode >= 1) {
      released = Math.min(Math.max(nextEpisode - 1, 0), total);
    } else if (anime.status === "NOT_YET_RELEASED") {
      released = 0;
    }
  }

  const label =
    released === null || released >= total ? `${total} EP` : `${released}/${total} EP`;
  return { total, released, label };
}

/** Labelled months for the "Airs …" line (UTC-safe: YYYYMMDD arithmetic). */
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * "Airs Oct 20" (year appended only when it is not the current one) from a
 * YYYYMMDD premiere date — the detail page's `NOT_YET_RELEASED` badge, in the
 * language UpcomingCard already speaks. Null when the date is unknown.
 */
export function formatAirsDate(startDate?: number | null): string | null {
  if (typeof startDate !== "number" || !Number.isFinite(startDate) || startDate <= 0) return null;
  const year = Math.floor(startDate / 10000);
  const month = Math.floor((startDate % 10000) / 100);
  const day = startDate % 100;
  const monthLabel = MONTH_LABELS[month - 1];
  if (!monthLabel || !day) return null;
  const suffix = year === new Date().getFullYear() ? "" : `, ${year}`;
  return `Airs ${monthLabel} ${day}${suffix}`;
}

/**
 * Quiet countdown for a schedule entry: "in 3d" / "in 5h" / "in 12m" / "now".
 * `airingAt` is AniList epoch seconds; a missing/invalid value and any moment
 * already reached both read "now".
 */
export function formatAirsDelta(airingAt?: number | null, now = Date.now()): string | null {
  if (typeof airingAt !== "number" || !Number.isFinite(airingAt)) return null;
  const deltaMs = airingAt * 1000 - now;
  if (deltaMs <= 60_000) return "now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}
