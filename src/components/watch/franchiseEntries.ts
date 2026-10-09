/**
 * Franchise ENTRY MODEL — the projection of the shared resolver's canonical
 * list (`getFranchiseItems()`, `src/lib/franchise.ts`) onto what the UI shows,
 * plus the TWO SORT MODES the watch page's `// Franchise` strip offers.
 *
 * Deliberately React-free and marked by nothing: the server watch page calls
 * `buildFranchiseEntries()` while the strip (a client component) and the
 * player drawer consume the result — so this module has to be importable from
 * BOTH sides of the client boundary. Only the persistence hook lives
 * elsewhere (`@/hooks/useFranchiseSort`).
 *
 * ── Labels (// SECTIONS tab language: mono, uppercase, bordered) ─────────
 *   [S2] [TV]        Mushoku Tensei … Cour 2     ← numbered mainline season
 *   [MOVIE]          JUJUTSU KAISEN 0            ← extras keep their format
 *   [RECAP]          One Piece: Episode of Nami  ← summaries read as recaps
 * Season numbers are computed once, in the shared resolver, along the
 * PREQUEL→SEQUEL chain through the watched entry (the earliest known TV
 * season anchors as Season 1, a title hint like "Season 3" re-anchors the
 * run, a split-cour "Part 2"/"Cour 2" inherits its predecessor's number).
 * Chain entries that are not TV (movies/OVA prequels) keep a format badge.
 *
 * ── Order ────────────────────────────────────────────────────────────────
 * The resolver's canonical order (prequels → current → sequels → rest: TV run
 * first, then by format, then release order) is the DEFAULT sort; Time is a
 * pure re-ordering of that same set, computed here so the strip and the
 * player's drawer can never drift apart.
 */

import {
  FRANCHISE_FORMAT_BADGES,
  isTvLikeFormat,
  RECAP_RELATION_TYPES,
  type FranchiseItem,
} from "@/lib/franchise";

export interface FranchiseEntry {
  id: number;
  title: string;
  /** Numbered season along the PREQUEL→SEQUEL chain (`1`, `2`, …). */
  season?: number;
  /** Short badge shown before the title: `TV` / `MOVIE` / `OVA` / `RECAP` … */
  badge: string;
  /** Full spoken/hover label: `Season 2 · TV series · sequel — Title`. */
  detail: string;
  /** Raw AniList format (`TV`, `ONA`, …). */
  format: string;
  /** First air/release date as `YYYYMMDD` — the Time sort's key; may be missing. */
  startDate?: number;
  /** The entry being watched — rendered as an active, non-link chip. */
  current: boolean;
  /** Mainline TV season — safe to deep-link straight to episode 1. */
  mainLine: boolean;
  /** Visual weight: current / mainline season / extra (recap, side, movie). */
  tier: "current" | "main" | "minor";
}

/* ── Labels ─────────────────────────────────────────────────────────────── */

/** Spoken form of each format — the chips themselves use the shared badges. */
const FORMAT_WORDS: Record<string, string> = {
  TV: "TV series",
  TV_SHORT: "TV short",
  MOVIE: "Movie",
  OVA: "OVA",
  ONA: "ONA",
  SPECIAL: "Special",
  MUSIC: "Music video",
};

/** Only used when a node ships no `format` — spelled out, never cryptic codes. */
const RELATION_BADGES: Record<string, string> = {
  PREQUEL: "PREQUEL",
  SEQUEL: "SEQUEL",
  SIDE_STORY: "SIDE STORY",
  SPIN_OFF: "SPIN-OFF",
  ALTERNATIVE: "ALTERNATIVE",
  ALTERNATIVE_VERSION: "ALTERNATIVE",
  SUMMARY: "RECAP",
  PARENT_SERIES: "PARENT SERIES",
  CHARACTER: "CAMEO",
  PREVIEW: "PREVIEW",
  CONTAINS: "EXTRA",
  OTHER: "RELATED",
};

const RELATION_WORDS: Record<string, string> = {
  PREQUEL: "prequel",
  SEQUEL: "sequel",
  SIDE_STORY: "side story",
  SPIN_OFF: "spin-off",
  ALTERNATIVE: "alternative",
  ALTERNATIVE_VERSION: "alternative version",
  SUMMARY: "recap",
  PARENT_SERIES: "parent series",
  CHARACTER: "crossover",
  PREVIEW: "preview",
  CONTAINS: "extra",
  OTHER: "related",
  ADAPTATION: "adaptation",
  SOURCE: "source material",
};

/** Chip + spoken label: recap edge wins, then format, then the relation code. */
function badgeFor(format: string, relation: string): { badge: string; word: string } {
  if (RECAP_RELATION_TYPES.has(relation)) return { badge: "RECAP", word: "Recap" };
  if (FRANCHISE_FORMAT_BADGES[format]) {
    return { badge: FRANCHISE_FORMAT_BADGES[format], word: FORMAT_WORDS[format] || format };
  }
  return {
    badge: RELATION_BADGES[relation] || "ANIME",
    word: RELATION_WORDS[relation] || "Anime",
  };
}

/* ── Entries ────────────────────────────────────────────────────────────── */

/**
 * Map the shared resolver's canonical list onto the UI's `FranchiseEntry`
 * shape. Everything meaningful is already decided upstream by
 * `getFranchiseItems()` — membership (no manga/novel, no MUSIC, no
 * PREVIEW/CHARACTER edges), order (prequels → current → sequels → rest),
 * season numbers along the PREQUEL→SEQUEL chain and the bucket each entry
 * sits in — so this is a pure projection: same set, same numbers, same order
 * as the detail page's row. Only `format`/`startDate` are carried through
 * untouched for the sorts below.
 */
export function buildFranchiseEntries(
  items: FranchiseItem[],
  currentId: number
): FranchiseEntry[] {
  return items.map((item): FranchiseEntry => {
    const isCurrent = item.id === currentId;
    const recap = RECAP_RELATION_TYPES.has(item.relation);
    const { badge: formatBadge, word } = badgeFor(item.format, item.relation);

    // On the chain (prequel/sequel of the watched entry) — the resolver's
    // bucket beats the raw discovery edge, which may just read "OTHER" when
    // the member was reached through the source-material hub.
    const chainLinked = item.bucket === "prequel" || item.bucket === "sequel";
    const linkWord =
      item.bucket === "prequel" ? "prequel" : item.bucket === "sequel" ? "sequel" : undefined;

    const parts: string[] = [];
    if (item.season !== undefined) parts.push(`Season ${item.season}`);
    parts.push(word);
    // "recap" would just repeat the badge word; other edges add the link kind.
    const relationWord = linkWord || (recap ? undefined : RELATION_WORDS[item.relation]);
    if (relationWord) parts.push(relationWord);

    // Badge ladder mirrors the detail row: numbered season (rendered as the
    // chip), then chain position, then format / relation code.
    const badge = !recap && item.season === undefined && linkWord
      ? linkWord.toUpperCase()
      : formatBadge;

    // On the chain and a TV run → the strip may deep-link straight to ep 1.
    const mainLine = !isCurrent && chainLinked && isTvLikeFormat(item.format);
    const tier = isCurrent
      ? "current"
      : item.season !== undefined || mainLine
        ? "main"
        : "minor";

    return {
      id: item.id,
      title: item.title,
      season: item.season,
      badge,
      detail: `${parts.join(" · ")} — ${item.title}`,
      format: item.format,
      startDate: item.startDate,
      current: isCurrent,
      mainLine,
      tier,
    };
  });
}

/* ── Sort modes ─────────────────────────────────────────────────────────── */

/**
 * The strip's two orders (also honored by the player's series dropdown):
 *
 *  - `default`  the resolver's canonical order — prequels → the entry you're
 *               watching → sequels → the rest (TV run first, format, release).
 *               The first entry, so a fresh visitor never sees anything move.
 *  - `time`     chronological by air/release start date; unknown dates last;
 *               ties (and unknowns) fall back to the default order, so the
 *               list is always stable.
 *
 * A third mode used to live here; a stored `"type"` from that era is no
 * longer a valid mode and falls back to `default` (see `isFranchiseSortMode`).
 */
export type FranchiseSortMode = "default" | "time";

/** Modes in control order — `label` is the button text, `title` the tooltip. */
export const FRANCHISE_SORTS: ReadonlyArray<{
  id: FranchiseSortMode;
  label: string;
  title: string;
}> = [
  {
    id: "default",
    label: "Default",
    title: "Default / best order — prequels, the entry you're watching, sequels, then the rest",
  },
  {
    id: "time",
    label: "Time",
    title: "Chronological — earliest air/release date first, unknown dates last",
  },
];

export function isFranchiseSortMode(value: unknown): value is FranchiseSortMode {
  // Deliberately strict: anything else (a retired mode, garbage) reads as
  // `default`, so a stale `localStorage` value can never produce an order
  // the UI has no button for.
  return value === "default" || value === "time";
}

/** One block of the ordered list; `label` is a group header (`null` = flat). */
export interface FranchiseGroup {
  /** Group header text (`"TV"`, `"Movie"`, …); `null` in the flat modes. */
  label: string | null;
  entries: FranchiseEntry[];
}

/** After every real `YYYYMMDD` — unknown dates sort last, never first. */
const UNKNOWN_DATE = 99_999_999;

function timeKey(entry: FranchiseEntry): number {
  return typeof entry.startDate === "number" && entry.startDate > 0
    ? entry.startDate
    : UNKNOWN_DATE;
}

/**
 * Apply `mode` to the (already default-ordered) entries. Never mutates the
 * input; every comparison falls back to the default index, so the sort is
 * stable no matter which dates are missing. Unknown modes read as `default`
 * — `useFranchiseSort` already normalizes stored values, this is the belt to
 * that pair of braces.
 */
export function franchiseSortGroups(
  entries: FranchiseEntry[],
  mode: FranchiseSortMode
): FranchiseGroup[] {
  // Default position = the tie-breaker for the Time sort.
  const indexed = entries.map((entry, index) => ({ entry, index }));

  if (mode === "time") {
    const byTime = (a: (typeof indexed)[number], b: (typeof indexed)[number]) =>
      timeKey(a.entry) - timeKey(b.entry) || a.index - b.index;
    return [{ label: null, entries: indexed.slice().sort(byTime).map((item) => item.entry) }];
  }

  return [{ label: null, entries }];
}
