import Link from "next/link";

/**
 * Franchise / season selector for the watch page.
 *
 * Reads the AniList `relations` edges that `getAnimeFull()` already returns
 * (DETAIL_QUERY — read-only, anilist.ts is not touched) and renders them as a
 * compact, horizontally scrollable pill strip in the `// SECTIONS` style.
 *
 * Data notes:
 * - DETAIL_QUERY fetches only `node { id title coverImage }` + `relationType`
 *   (no `type`/`format`), so per-entry format badges (TV/OVA/ONA) are not
 *   available. Entries are instead identified by relation type (PRE/SEQ/SIDE…)
 *   plus their title, which carries "Season 2"/"Part 2" text when it exists.
 * - Non-anime nodes are filtered out by cover path (`/media/anime/cover/…`):
 *   sources/adaptations are manga and would 404 on `/anime/{id}`.
 */

export interface FranchiseEntry {
  id: number;
  title: string;
  /** Short mono chip: PRE / SEQ / SIDE / NOW … */
  code: string;
  /** The entry currently being watched — rendered as an active, non-link pill. */
  current: boolean;
  /** PREQUEL/SEQUEL: main line, safe to deep-link straight to episode 1. */
  mainLine: boolean;
}

interface RelationEdge {
  relationType?: string;
  node?: {
    id?: number;
    title?: { romaji?: string; english?: string } | null;
    coverImage?: { large?: string } | null;
  } | null;
}

interface FullMedia {
  relations?: { edges?: RelationEdge[] | null } | null;
}

/** Watchable-ish relation types are kept; these point at people/source material. */
const EXCLUDED_RELATIONS = new Set(["CHARACTER", "ADAPTATION", "SOURCE"]);

const RELATION_CODES: Record<string, string> = {
  PREQUEL: "PRE",
  SEQUEL: "SEQ",
  SIDE_STORY: "SIDE",
  SPIN_OFF: "SPIN",
  ALTERNATIVE: "ALT",
  ALTERNATIVE_VERSION: "ALT",
  SUMMARY: "SUM",
  PARENT_SERIES: "MAIN",
};

/** AniList CDN paths are type-specific: `/media/anime/…` vs `/media/manga/…`. */
function isAnimeCover(url?: string | null): boolean {
  return Boolean(url && url.includes("/media/anime/"));
}

/**
 * Order: prequels → current → sequels → everything else (side stories, spin
 * offs, alternatives, recaps). Returns `[]` when relations are unavailable.
 */
export function buildFranchiseEntries(
  full: FullMedia | null | undefined,
  currentId: number,
  currentTitle: string
): FranchiseEntry[] {
  const edges = full?.relations?.edges;
  if (!Array.isArray(edges)) return [];

  const prequels: FranchiseEntry[] = [];
  const sequels: FranchiseEntry[] = [];
  const others: FranchiseEntry[] = [];
  const seen = new Set<number>([currentId]);

  for (const edge of edges) {
    const type = edge?.relationType;
    const node = edge?.node;
    if (!type || !node?.id || seen.has(node.id)) continue;
    if (EXCLUDED_RELATIONS.has(type)) continue;
    if (!isAnimeCover(node.coverImage?.large)) continue;

    const title = node.title?.english || node.title?.romaji;
    if (!title) continue;
    seen.add(node.id);

    const entry: FranchiseEntry = {
      id: node.id,
      title,
      code: RELATION_CODES[type] ?? "ETC",
      current: false,
      mainLine: type === "PREQUEL" || type === "SEQUEL",
    };

    if (type === "PREQUEL") prequels.push(entry);
    else if (type === "SEQUEL") sequels.push(entry);
    else others.push(entry);
  }

  if (prequels.length + sequels.length + others.length === 0) return [];

  return [
    ...prequels,
    { id: currentId, title: currentTitle, code: "NOW", current: true, mainLine: false },
    ...sequels,
    ...others,
  ];
}

interface FranchiseStripProps {
  entries: FranchiseEntry[];
  provider?: string;
}

export default function FranchiseStrip({ entries, provider }: FranchiseStripProps) {
  // Only the current entry (or nothing) → nothing to switch to.
  if (entries.length < 2) return null;

  const providerQs = provider ? `?provider=${provider}` : "";
  const pillBase =
    "flex items-center gap-2 whitespace-nowrap rounded-none border px-3 py-2 sm:px-2.5 sm:py-1 min-h-[36px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider transition-colors";

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
            const className = entry.current
              ? `${pillBase} border-[var(--accent)] bg-[var(--accent)] text-black font-bold`
              : `${pillBase} border-[var(--accent)]/20 text-[var(--accent)]/60 hover:border-[var(--accent)]/50 hover:text-[var(--accent)]`;

            const content = (
              <>
                <span className="shrink-0 font-bold">{entry.code}</span>
                <span aria-hidden="true" className="shrink-0 opacity-50">
                  ·
                </span>
                <span className="min-w-0 max-w-[13rem] truncate" title={entry.title}>
                  {entry.title}
                </span>
              </>
            );

            if (entry.current) {
              return (
                <span key={entry.id} aria-current="page" className={className}>
                  {content}
                </span>
              );
            }

            const href = entry.mainLine
              ? `/anime/${entry.id}/watch/1${providerQs}`
              : `/anime/${entry.id}${providerQs}`;

            return (
              <Link key={entry.id} href={href} className={className}>
                {content}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
