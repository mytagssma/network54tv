import Link from "next/link";
import { FRANCHISE_FORMAT_BADGES, type FranchiseItem } from "@/lib/franchise";

/**
 * Franchise row on the anime detail page — every franchise *anime* entry
 * resolved by `getFranchiseItems()` (`src/lib/franchise.ts`), as one compact
 * horizontally-scrolling row of small covers (Netflix "More Like This"
 * density), clearly smaller than the main card grid.
 *
 * ── Coverage ──────────────────────────────────────────────────────────────
 * The resolver already walked the relation graph transitively (relations of
 * relations, capped) and already dropped everything that is not watchable:
 * manga/novel (they would dead-link to `/anime/{id}`), MUSIC entries (PVs,
 * music videos) and PREVIEW/CHARACTER edges. Entries with no usable title or
 * cover are dropped here, as is the title being viewed.
 *
 * ── Badge ladder (mono, uppercase, one per card) ─────────────────────────
 *   S3   numbered season along the PREQUEL→SEQUEL chain (shared with the
 *        watch page strip, so both surfaces read the same season numbers)
 *   PRE  prequel of the current entry      SEQ  sequel of it
 *   OVA / ONA / MOVIE / TV / SPECIAL …     the entry's format
 *   SIDE / RECAP / ALT / RELATED …         the relation code
 *
 * Order (canonical, produced by the resolver): prequels → current → sequels
 * → rest; the row drops the current entry, so prequels → sequels → rest. The
 * section renders nothing when no entry qualifies, so a standalone title
 * shows no heading either.
 */

export interface FranchiseRowProps {
  /** Canonical franchise list from `getFranchiseItems(animeId, fullMedia)`. */
  items: FranchiseItem[];
  /** The title being viewed — excluded from the row. */
  currentId: number;
}

/** Compact relation codes for entries that are neither numbered nor pre/seq. */
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

/**
 * Badge ladder: chain season → prequel/sequel bucket → format → relation
 * code. Only TV-like entries can claim a season number, and only through the
 * shared chain walk (a movie titled "... Season 2" would be a coincidence).
 */
function badgeFor(item: FranchiseItem): string {
  if (item.season !== undefined) return `S${item.season}`;
  if (item.bucket === "prequel") return "PRE";
  if (item.bucket === "sequel") return "SEQ";
  if (item.format) return FRANCHISE_FORMAT_BADGES[item.format] || item.format;
  if (item.relation) return RELATION_BADGES[item.relation] || item.relation.replace(/_/g, " ");
  return "RELATED";
}

/* ── Row ────────────────────────────────────────────────────────────────── */

export default function FranchiseRow({ items, currentId }: FranchiseRowProps) {
  const entries = items.filter(
    (item) => item.id !== currentId && item.title && item.cover
  );
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
                    {badgeFor(entry)}
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
