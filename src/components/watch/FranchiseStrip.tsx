import Link from "next/link";
import {
  FRANCHISE_FORMAT_BADGES,
  isTvLikeFormat,
  RECAP_RELATION_TYPES,
  type FranchiseItem,
} from "@/lib/franchise";

/**
 * Franchise selector for the watch page — every *watchable* franchise entry,
 * resolved by `getFranchiseItems()` (`src/lib/franchise.ts`): a bounded
 * transitive walk over the AniList relation graph, so seasons that are only
 * linked through *other* entries (Dr. STONE seasons 3/4 …) show up here just
 * like they do on the detail page row — and manga/novel, MUSIC (PVs, music
 * videos) and PREVIEW/CHARACTER edges never do.
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
 * ── Weight ────────────────────────────────────────────────────────────────
 * Rows, not chips: the selector is a responsive grid of large buttons that
 * borrow the episode list's visual language (`EpisodeList` /
 * `EpisodeSelector`) — `bg-[#131318]`, a 2px accent rail down the left edge
 * (`border-l-2 border-[var(--accent)]/30`, solid while active), mono chips up
 * front, the title filling the middle, a chevron on the right. The current
 * entry is the only solid one (accent fill + ▶) and never a link; mainline
 * seasons are tinted + railed louder; recaps/side stories/movies stay quiet.
 *
 * Order: prequels → current → sequels → rest (TV run first, then by format,
 * then release order) — the resolver's canonical order, shared with the
 * detail page. One column on phones, two from `sm`, three from `xl`.
 */

export interface FranchiseEntry {
  id: number;
  title: string;
  /** Numbered season along the PREQUEL→SEQUEL chain (`1`, `2`, …). */
  season?: number;
  /** Short badge shown before the title: `TV` / `MOVIE` / `OVA` / `RECAP` … */
  badge: string;
  /** Full spoken/hover label: `Season 2 · TV series · sequel — Title`. */
  detail: string;
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
 * Map the shared resolver's canonical list onto the strip's `FranchiseEntry`
 * shape. Everything meaningful is already decided upstream by
 * `getFranchiseItems()` — membership (no manga/novel, no MUSIC, no
 * PREVIEW/CHARACTER edges), order (prequels → current → sequels → rest),
 * season numbers along the PREQUEL→SEQUEL chain and the bucket each entry
 * sits in — so this is a pure projection: same set, same numbers, same order
 * as the detail page's row.
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
      current: isCurrent,
      mainLine,
      tier,
    };
  });
}

/* ── Strip ──────────────────────────────────────────────────────────────── */

interface FranchiseStripProps {
  entries: FranchiseEntry[];
  provider?: string;
}

export default function FranchiseStrip({ entries, provider }: FranchiseStripProps) {
  // Only the current entry (or nothing) → nothing to switch to.
  if (entries.length < 2) return null;

  const providerQs = provider ? `?provider=${provider}` : "";

  // One large selection button — same skeleton as the episode list rows:
  // 2px accent rail, mono chips, filling title, trailing chevron. Tall enough
  // (56px) to read as a target on touch, wide enough to scan in a grid.
  const rowBase =
    "group flex min-h-[56px] w-full items-center gap-3 border-l-2 px-3 py-3 sm:px-4 text-left transition-colors rounded-none";

  const tierClass: Record<FranchiseEntry["tier"], string> = {
    // Current: solid accent, same read as the active episode row — no link.
    current: "border-l-[var(--accent)] bg-[var(--accent)] text-black",
    // Mainline season: railed + tinted — prominent, never louder than current.
    main: "border-l-[var(--accent)]/60 bg-[var(--accent)]/10 text-white hover:border-l-[var(--accent)] hover:bg-[var(--accent)]/20",
    // Recaps / side stories / movies: quiet rail on the list's own surface.
    minor:
      "border-l-[var(--accent)]/30 bg-[#131318] text-[#9a9aa0] hover:border-l-[var(--accent)] hover:bg-[#1a1a20] hover:text-white",
  };

  // Season number — the "episode number" of the row.
  const seasonClass: Record<FranchiseEntry["tier"], string> = {
    current: "shrink-0 border border-black/35 bg-black/15 px-1.5 py-1 text-[11px] font-bold leading-none tabular-nums text-black",
    main: "shrink-0 border border-[var(--accent)]/50 bg-[var(--accent)]/15 px-1.5 py-1 text-[11px] font-bold leading-none tabular-nums text-[var(--accent)]",
    minor:
      "shrink-0 border border-[var(--accent)]/30 px-1.5 py-1 text-[11px] font-bold leading-none tabular-nums text-[var(--accent)]/70",
  };

  // Format badge: TV / OVA / ONA / MOVIE / SPECIAL / RECAP …
  const badgeClass: Record<FranchiseEntry["tier"], string> = {
    current: "shrink-0 border border-black/25 bg-black/10 px-1.5 py-1 text-[9px] leading-none tracking-wider text-black/70",
    main: "shrink-0 border border-[var(--accent)]/35 px-1.5 py-1 text-[9px] leading-none tracking-wider text-[var(--accent)]/85",
    minor:
      "shrink-0 border border-[var(--accent)]/20 px-1.5 py-1 text-[9px] leading-none tracking-wider text-[var(--accent)]/55",
  };

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold text-[var(--accent)] uppercase tracking-wider shrink-0">
          // Franchise
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-wider text-[#6b6b70] shrink-0 tabular-nums">
          {entries.length - 1} related
        </span>
      </div>

      {/* Chunky rows — 1 col on phones, 2 from sm, 3 from xl (the episode
          grid's breakpoints), so the set is fully visible without scrolling. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-1.5 sm:gap-2">
        {entries.map((entry) => {
          const className = `${rowBase} ${tierClass[entry.tier]}`;

          const content = (
            <>
              <span className="flex shrink-0 items-center gap-1.5">
                {entry.season !== undefined && (
                  <span className={seasonClass[entry.tier]}>{`S${entry.season}`}</span>
                )}
                <span className={badgeClass[entry.tier]}>{entry.badge}</span>
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] sm:text-sm">
                {entry.title}
              </span>
              {entry.current ? (
                <span aria-hidden="true" className="shrink-0 text-[11px] leading-none">
                  &#9654;
                </span>
              ) : (
                <svg
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-[#6b6b70] transition-colors group-hover:text-[var(--accent)]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              )}
            </>
          );

          if (entry.current) {
            return (
              <span
                key={entry.id}
                aria-current="page"
                title={entry.detail}
                className={className}
              >
                {/* Verbose label for screen readers; the chips stay visual. */}
                <span className="sr-only">{entry.detail}</span>
                <span aria-hidden="true" className="flex w-full items-center gap-3">
                  {content}
                </span>
              </span>
            );
          }

          const href = entry.mainLine
            ? `/anime/${entry.id}/watch/1${providerQs}`
            : `/anime/${entry.id}${providerQs}`;

          return (
            <Link
              key={entry.id}
              href={href}
              title={entry.detail}
              aria-label={entry.detail}
              className={className}
            >
              <span aria-hidden="true" className="flex w-full items-center gap-3">
                {content}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
