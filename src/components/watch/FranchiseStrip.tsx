import Link from "next/link";

/**
 * Franchise selector for the watch page — every *watchable* entry the AniList
 * `relations` list of the title being watched points at, in one strip.
 *
 * ── Coverage ──────────────────────────────────────────────────────────────
 * A relation node is listed whenever it is an actual anime:
 *   `node.type === ANIME` → in; `MANGA`/`NOVEL` → out (they dead-link to
 *   `/anime/{id}`). When `type` is missing the `format` decides, and the CDN
 *   cover path (`/media/anime/…` vs `/media/manga/…`) is the last resort.
 * No relation *type* is dropped on its own — ADAPTATION/OTHER/CHARACTER edges
 * often point at real anime (remakes, re-cuts, crossover specials) and now
 * appear too. Everything the API returns that is an anime shows up: seasons,
 * sequels, prequels, side stories, spin-offs, alternatives, recaps, OVAs,
 * ONAs, movies, specials.
 *
 * ── Labels (// SECTIONS tab language: mono, uppercase, bordered) ─────────
 *   [S2] [TV]        Mushoku Tensei … Cour 2     ← numbered mainline season
 *   [MOVIE]          JUJUTSU KAISEN 0            ← extras keep their format
 *   [RECAP]          One Piece: Episode of Nami  ← summaries read as recaps
 * Season numbers walk the PREQUEL→SEQUEL chain: earliest known TV season of
 * the run anchors as Season 1, a title hint ("Season 3", "3rd Season")
 * re-anchors the run so a mid-franchise entry keeps its real number.
 * Chain entries that are not TV (movies/OVA prequels) keep a format badge.
 *
 * ── Weight ────────────────────────────────────────────────────────────────
 * Matches significance, mirroring EpisodeSelector rows: the current entry is
 * a solid accent chip (with ▶), mainline seasons get an accent outline +
 * tinted background, recaps/side stories/movies sit behind a quiet border.
 *
 * Order: prequels → current → sequels → rest (TV run first, then by format,
 * then release order). The strip stays horizontally scrollable.
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

interface RelationNode {
  id?: number;
  type?: string;
  format?: string | null;
  title?: { romaji?: string; english?: string } | null;
  coverImage?: { large?: string } | null;
}

interface RelationEdge {
  relationType?: string;
  node?: RelationNode | null;
}

interface FullMedia {
  /** Current entry's format — DETAIL_QUERY already selects it at the root. */
  format?: string | null;
  relations?: { edges?: RelationEdge[] | null } | null;
}

/* ── Eligibility: node type/format first, cover path only as a fallback ── */

const ANIME_FORMATS = new Set(["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"]);
const MANGA_FORMATS = new Set(["MANGA", "NOVEL", "ONE_SHOT"]);

/** AniList CDN paths are type-specific: `/media/anime/…` vs `/media/manga/…`. */
function isAnimeCover(url?: string | null): boolean {
  return Boolean(url && url.includes("/media/anime/"));
}

function isAnimeNode(node: RelationNode): boolean {
  const type = String(node.type || "").toUpperCase();
  if (type) return type === "ANIME"; // authoritative when the query provides it
  const format = String(node.format || "").toUpperCase();
  if (MANGA_FORMATS.has(format)) return false;
  if (ANIME_FORMATS.has(format)) return true;
  return isAnimeCover(node.coverImage?.large);
}

/** TV runs are the only things that earn a season number. */
function isTvLike(format: string): boolean {
  return format === "" || format === "TV" || format === "TV_SHORT";
}

/* ── Labels ─────────────────────────────────────────────────────────────── */

const FORMAT_BADGES: Record<string, string> = {
  TV: "TV",
  TV_SHORT: "TV SHORT",
  MOVIE: "MOVIE",
  OVA: "OVA",
  ONA: "ONA",
  SPECIAL: "SPECIAL",
  MUSIC: "MUSIC",
};

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

/** Summaries are recaps whatever their broadcast format says. */
const RECAP_RELATIONS = new Set(["SUMMARY"]);

function badgeFor(format: string, relation: string): { badge: string; word: string } {
  if (RECAP_RELATIONS.has(relation)) return { badge: "RECAP", word: "Recap" };
  if (FORMAT_BADGES[format]) {
    return { badge: FORMAT_BADGES[format], word: FORMAT_WORDS[format] || format };
  }
  return {
    badge: RELATION_BADGES[relation] || "ANIME",
    word: RELATION_WORDS[relation] || "Anime",
  };
}

/* ── Season chain ───────────────────────────────────────────────────────── */

const SEASON_PATTERNS = [/\bseason\s*(\d{1,2})\b/i, /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i];

/** `… Season 3` / `… 3rd Season` → 3; `null` when the title carries no hint. */
function seasonHint(title: string): number | null {
  for (const pattern of SEASON_PATTERNS) {
    const match = pattern.exec(title);
    if (match) {
      const value = parseInt(match[1], 10);
      if (value >= 1 && value <= 99) return value;
    }
  }
  return null;
}

/** Release order — AniList ids track it closely enough to order a chain. */
function byRelease(a: { id: number }, b: { id: number }): number {
  return a.id - b.id;
}

interface RawEntry {
  id: number;
  title: string;
  format: string;
  /** PREQUEL / SEQUEL / SIDE_STORY … (empty for the entry being watched). */
  relation: string;
}

/**
 * Order: prequels → current → sequels → everything else (side stories, spin
 * offs, alternatives, recaps, movies). Returns `[]` when relations are absent.
 */
export function buildFranchiseEntries(
  full: FullMedia | null | undefined,
  currentId: number,
  currentTitle: string
): FranchiseEntry[] {
  const edges = full?.relations?.edges;
  if (!Array.isArray(edges)) return [];

  const prequels: RawEntry[] = [];
  const sequels: RawEntry[] = [];
  const rest: RawEntry[] = [];
  const seen = new Set<number>([currentId]);

  for (const edge of edges) {
    const relation = String(edge?.relationType || "").toUpperCase();
    const node = edge?.node;
    if (!node?.id || seen.has(node.id)) continue;
    if (!isAnimeNode(node)) continue; // manga/novel/source material — no watch page

    const title = node.title?.english || node.title?.romaji;
    if (!title) continue;
    seen.add(node.id);

    const entry: RawEntry = {
      id: node.id,
      title,
      format: String(node.format || "").trim().toUpperCase(),
      relation,
    };

    if (relation === "PREQUEL") prequels.push(entry);
    else if (relation === "SEQUEL") sequels.push(entry);
    else rest.push(entry);
  }

  if (prequels.length + sequels.length + rest.length === 0) return [];

  prequels.sort(byRelease);
  sequels.sort(byRelease);
  // Significance first (mainline TV run), then format, then release order.
  const FORMAT_RANK: Record<string, number> = {
    TV: 0,
    TV_SHORT: 1,
    MOVIE: 2,
    ONA: 3,
    OVA: 4,
    SPECIAL: 5,
    MUSIC: 6,
  };
  rest.sort(
    (a, b) =>
      (FORMAT_RANK[a.format] ?? 7) - (FORMAT_RANK[b.format] ?? 7) || byRelease(a, b)
  );

  const currentRaw: RawEntry = {
    id: currentId,
    title: currentTitle,
    format: String(full?.format || "").trim().toUpperCase(),
    relation: "",
  };

  // The PREQUEL→SEQUEL chain, earliest first; the watched entry sits on it.
  const chain = [...prequels, currentRaw, ...sequels];

  // Number the TV entries of that chain. A title hint ("Season 3") is
  // authoritative for its slot and anchors its neighbours; without hints the
  // earliest known TV entry anchors as Season 1. Needs ≥2 TV entries to guess,
  // otherwise a lone entry would claim a season number it cannot verify.
  const tvSlots: number[] = [];
  chain.forEach((entry, index) => {
    if (isTvLike(entry.format)) tvSlots.push(index);
  });
  const numbers: (number | null)[] = tvSlots.map((index) => seasonHint(chain[index].title));

  if (numbers.some((value) => value !== null)) {
    for (let i = 1; i < numbers.length; i++) {
      if (numbers[i] === null && numbers[i - 1] !== null) numbers[i] = numbers[i - 1]! + 1;
    }
    for (let i = numbers.length - 2; i >= 0; i--) {
      if (numbers[i] === null && numbers[i + 1] !== null) numbers[i] = numbers[i + 1]! - 1;
    }
  } else if (numbers.length >= 2) {
    for (let i = 0; i < numbers.length; i++) numbers[i] = i + 1;
  }

  const seasonOf = new Map<number, number>();
  tvSlots.forEach((chainIndex, slot) => {
    const value = numbers[slot];
    if (value !== null && value >= 1) seasonOf.set(chain[chainIndex].id, value);
  });

  const toEntry = (raw: RawEntry): FranchiseEntry => {
    const isCurrent = raw.id === currentId;
    const season = seasonOf.get(raw.id);
    const chainLinked = raw.relation === "PREQUEL" || raw.relation === "SEQUEL";
    const { badge, word } = badgeFor(raw.format, raw.relation);

    const parts: string[] = [];
    if (season !== undefined) parts.push(`Season ${season}`);
    parts.push(word);
    if (RELATION_WORDS[raw.relation]) parts.push(RELATION_WORDS[raw.relation]);

    const mainLine = !isCurrent && chainLinked && isTvLike(raw.format);
    const tier = isCurrent ? "current" : season !== undefined || mainLine ? "main" : "minor";

    return {
      id: raw.id,
      title: raw.title,
      season,
      badge,
      detail: `${parts.join(" · ")} — ${raw.title}`,
      current: isCurrent,
      mainLine,
      tier,
    };
  };

  return [
    ...prequels.map(toEntry),
    toEntry(currentRaw),
    ...sequels.map(toEntry),
    ...rest.map(toEntry),
  ];
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

  // Same shell as the `// SECTIONS` tabs, so both strips read as one system.
  const chipBase =
    "flex items-center gap-2 whitespace-nowrap rounded-none border px-3 py-2 sm:px-2.5 sm:py-1 min-h-[36px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider transition-colors";

  const tierClass: Record<FranchiseEntry["tier"], string> = {
    // Current: solid accent, same read as the active episode row.
    current: "border-[var(--accent)] bg-[var(--accent)] text-black font-bold",
    // Mainline season: outlined + tinted — prominent, never louder than current.
    main: "border-[var(--accent)]/55 bg-[var(--accent)]/10 text-[var(--accent)] font-semibold hover:border-[var(--accent)] hover:bg-[var(--accent)]/20",
    // Recaps / side stories / movies: present, quiet, easy to skip past.
    minor:
      "border-[var(--accent)]/15 bg-black/30 text-[#9a9aa0] hover:border-[var(--accent)]/50 hover:bg-[var(--accent)]/10 hover:text-white",
  };

  // Season number — the "episode number" of the strip.
  const seasonClass: Record<FranchiseEntry["tier"], string> = {
    current: "shrink-0 border border-black/35 bg-black/15 px-1.5 py-0.5 text-[11px] font-bold leading-none tabular-nums text-black",
    main: "shrink-0 border border-[var(--accent)]/50 bg-[var(--accent)]/15 px-1.5 py-0.5 text-[11px] font-bold leading-none tabular-nums text-[var(--accent)]",
    minor:
      "shrink-0 border border-[var(--accent)]/30 px-1.5 py-0.5 text-[11px] font-bold leading-none tabular-nums text-[var(--accent)]/70",
  };

  // Format badge: TV / OVA / ONA / MOVIE / SPECIAL / RECAP …
  const badgeClass: Record<FranchiseEntry["tier"], string> = {
    current: "shrink-0 border border-black/25 bg-black/10 px-1.5 py-0.5 text-[9px] leading-none tracking-wider text-black/70",
    main: "shrink-0 border border-[var(--accent)]/35 px-1.5 py-0.5 text-[9px] leading-none tracking-wider text-[var(--accent)]/85",
    minor:
      "shrink-0 border border-[var(--accent)]/20 px-1.5 py-0.5 text-[9px] leading-none tracking-wider text-[var(--accent)]/55",
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

      <div className="overflow-x-auto pb-0.5">
        <div className="flex w-max gap-1.5">
          {entries.map((entry) => {
            const className = `${chipBase} ${tierClass[entry.tier]}`;

            const content = (
              <>
                {entry.season !== undefined && (
                  <span className={seasonClass[entry.tier]}>{`S${entry.season}`}</span>
                )}
                <span className={badgeClass[entry.tier]}>{entry.badge}</span>
                <span className="min-w-0 max-w-[13rem] truncate">{entry.title}</span>
                {entry.current && (
                  <span aria-hidden="true" className="shrink-0 text-[9px] leading-none">
                    &#9654;
                  </span>
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
                  <span aria-hidden="true" className="flex items-center gap-2">
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
                {content}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
