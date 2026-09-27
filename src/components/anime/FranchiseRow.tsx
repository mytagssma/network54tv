import Link from "next/link";

/**
 * Franchise row on the anime detail page — every related *anime* entry from
 * the AniList `relations` list of the title being viewed, as one compact
 * horizontally-scrolling row of small covers (Netflix "More Like This"
 * density), clearly smaller than the main card grid.
 *
 * ── Coverage ──────────────────────────────────────────────────────────────
 * `node.type` is authoritative when the query provides it: `ANIME` in,
 * `MANGA`/`NOVEL` out (they would dead-link to `/anime/{id}`). Without
 * `type`, the node `format` decides, then the AniList CDN cover path
 * (`/media/anime/…` vs `/media/manga/…`) is the last resort. Entries with
 * no usable title or cover are dropped, as is the title being viewed.
 *
 * ── Badge ladder (mono, uppercase, one per card) ─────────────────────────
 *   S3   title hint ("Season 3" / "3rd Season") on a TV-like entry
 *   PRE  prequel edge              SEQ  sequel edge
 *   OVA / ONA / MOVIE / TV / SPECIAL … when the query ships `format`
 *   SIDE / RECAP / ALT / RELATED … otherwise, the relation code
 *
 * Order: prequels → sequels → rest (mainline TV first), release order
 * (AniList ids) within each bucket. The section renders nothing when no
 * entry qualifies, so a standalone title shows no heading either.
 */

export interface FranchiseRowProps {
  /** Raw DETAIL_QUERY media from `getAnimeFull(id)` — relations included. */
  media: unknown;
  /** The title being viewed — excluded from the row. */
  currentId: number;
}

/* ── Raw relation shapes (DETAIL_QUERY, tolerant of optional fields) ───── */

interface RelationNode {
  id?: number;
  type?: string | null;
  format?: string | null;
  title?: { romaji?: string | null; english?: string | null } | null;
  coverImage?: { large?: string | null } | null;
}

interface RelationEdge {
  relationType?: string | null;
  node?: RelationNode | null;
}

interface FullMedia {
  relations?: { edges?: RelationEdge[] | null } | null;
}

interface FranchiseItem {
  id: number;
  title: string;
  cover: string;
  /** `S2` / `PRE` / `SEQ` / `OVA` / `MOVIE` / `RECAP` … */
  badge: string;
  /** Uppercased node format, `""` when the query didn't select it. */
  format: string;
}

/* ── Eligibility: node type first, then format, then cover path ────────── */

const ANIME_FORMATS = new Set(["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"]);
const MANGA_FORMATS = new Set(["MANGA", "NOVEL", "ONE_SHOT"]);

/** AniList CDN paths are type-specific: `/media/anime/…` vs `/media/manga/…`. */
function isAnimeCover(url?: string | null): boolean {
  return Boolean(url && url.includes("/media/anime/"));
}

function isAnimeNode(node: RelationNode): boolean {
  const type = String(node.type || "").trim().toUpperCase();
  if (type) return type === "ANIME"; // authoritative when the query provides it
  const format = String(node.format || "").trim().toUpperCase();
  if (MANGA_FORMATS.has(format)) return false;
  if (ANIME_FORMATS.has(format)) return true;
  return isAnimeCover(node.coverImage?.large); // last resort
}

/* ── Badges ─────────────────────────────────────────────────────────────── */

const FORMAT_BADGES: Record<string, string> = {
  TV: "TV",
  TV_SHORT: "TV SHORT",
  MOVIE: "MOVIE",
  OVA: "OVA",
  ONA: "ONA",
  SPECIAL: "SPECIAL",
  MUSIC: "MUSIC",
};

/** Compact relation codes for entries that aren't a prequel/sequel. */
const RELATION_BADGES: Record<string, string> = {
  SIDE_STORY: "SIDE",
  SPIN_OFF: "SPIN-OFF",
  ALTERNATIVE: "ALT",
  ALTERNATIVE_VERSION: "ALT",
  SUMMARY: "RECAP",
  PARENT_SERIES: "PARENT",
  CHARACTER: "CAMEO",
  PREVIEW: "PREVIEW",
  CONTAINS: "EXTRA",
  ADAPTATION: "ADAPT",
  SOURCE: "SOURCE",
  OTHER: "RELATED",
};

const SEASON_PATTERNS = [/\bseason\s*(\d{1,2})\b/i, /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i];

/** `… Season 3` / `… 3rd Season` → "S3"; `null` when the title carries no hint. */
function seasonHint(title: string): string | null {
  for (const pattern of SEASON_PATTERNS) {
    const match = pattern.exec(title);
    if (match) {
      const value = parseInt(match[1], 10);
      if (value >= 1 && value <= 99) return `S${value}`;
    }
  }
  return null;
}

/**
 * Badge ladder: season-number hint → prequel/sequel edge → format →
 * relation code. Only TV-like entries may claim a season number from their
 * title (a movie titled "…Season 2" would be a coincidence, not a season).
 */
function badgeFor(title: string, format: string, relation: string): string {
  const tvLike = !format || format === "TV" || format === "TV_SHORT";
  if (tvLike) {
    const hint = seasonHint(title);
    if (hint) return hint;
  }
  if (relation === "PREQUEL") return "PRE";
  if (relation === "SEQUEL") return "SEQ";
  if (format) return FORMAT_BADGES[format] || format;
  if (relation) return RELATION_BADGES[relation] || relation.replace(/_/g, " ");
  return "RELATED";
}

/* ── Parser: dedupe → filter → bucket → order ──────────────────────────── */

/** Release order — AniList ids track it closely enough to order a run. */
function byRelease(a: FranchiseItem, b: FranchiseItem): number {
  return a.id - b.id;
}

/** Mainline TV first, then movie/ONA/OVA/specials, then release order. */
const FORMAT_RANK: Record<string, number> = {
  TV: 0,
  TV_SHORT: 1,
  MOVIE: 2,
  ONA: 3,
  OVA: 4,
  SPECIAL: 5,
  MUSIC: 6,
};

function buildFranchiseEntries(media: unknown, currentId: number): FranchiseItem[] {
  const edges = (media as FullMedia | null | undefined)?.relations?.edges;
  if (!Array.isArray(edges)) return [];

  const prequels: FranchiseItem[] = [];
  const sequels: FranchiseItem[] = [];
  const rest: FranchiseItem[] = [];
  const seen = new Set<number>([currentId]);

  for (const edge of edges) {
    const relation = String(edge?.relationType || "").trim().toUpperCase();
    const node = edge?.node;
    if (typeof node?.id !== "number" || seen.has(node.id)) continue;
    if (!isAnimeNode(node)) continue; // manga/novel/source material — no page here

    const title = (node.title?.english || node.title?.romaji || "").trim();
    const cover = node.coverImage?.large;
    if (!title || !cover) continue; // nothing to show, nothing to link
    seen.add(node.id); // first edge wins when the API repeats a target

    const format = String(node.format || "").trim().toUpperCase();
    const entry: FranchiseItem = {
      id: node.id,
      title,
      cover,
      badge: badgeFor(title, format, relation),
      format,
    };

    if (relation === "PREQUEL") prequels.push(entry);
    else if (relation === "SEQUEL") sequels.push(entry);
    else rest.push(entry);
  }

  if (prequels.length + sequels.length + rest.length === 0) return [];

  prequels.sort(byRelease);
  sequels.sort(byRelease);
  rest.sort(
    (a, b) => (FORMAT_RANK[a.format] ?? 7) - (FORMAT_RANK[b.format] ?? 7) || byRelease(a, b)
  );
  return [...prequels, ...sequels, ...rest];
}

/* ── Row ────────────────────────────────────────────────────────────────── */

export default function FranchiseRow({ media, currentId }: FranchiseRowProps) {
  const entries = buildFranchiseEntries(media, currentId);
  if (entries.length === 0) return null;

  return (
    <section className="mb-10" aria-label="Same franchise">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-lg font-semibold text-[var(--accent)] uppercase tracking-wider">
          // Same Franchise
        </h2>
        <span className="shrink-0 font-mono text-[10px] uppercase tabular-nums tracking-wider text-[#6b6b70]">
          {entries.length} related
        </span>
      </div>

      {/* Bleeds into the container's px-4 gutters on mobile (body clips x),
          sits flush with the grid from md up. */}
      <div className="-mx-4 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
        <ul className="flex w-max gap-3">
          {entries.map((entry) => (
            <li key={entry.id} className="shrink-0">
              <Link
                href={`/anime/${entry.id}`}
                title={entry.title}
                className="group block w-[112px] outline-none"
              >
                <div className="relative aspect-[3/4] overflow-hidden border border-[var(--accent)]/10 bg-[var(--panel)] transition-colors duration-200 group-hover:border-[var(--accent)]/60 group-focus-visible:border-[var(--accent)]/60">
                  <img
                    src={entry.cover}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  <span className="absolute left-1 top-1 border border-[var(--accent)]/40 bg-black/70 px-1 py-0.5 font-mono text-[9px] uppercase leading-none tracking-wider text-[var(--accent)]">
                    {entry.badge}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-2 min-h-[2.5em] break-words text-[11px] font-medium uppercase leading-tight tracking-wide text-white/75 transition-colors group-hover:text-[var(--accent)] group-focus-visible:text-[var(--accent)]">
                  {entry.title}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
