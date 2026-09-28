/**
 * Shared franchise resolver — ONE AniList relation-graph expansion behind every
 * "Same Franchise" / "Franchise" surface: the detail page row, the watch page
 * strip, and (eligibility + label helpers only) the client-side search
 * grouping in `anilist.ts`.
 *
 * ── Why transitive ────────────────────────────────────────────────────────
 * AniList's `relations` edges only describe DIRECT neighbours of one entry:
 * media 113936 (Dr. STONE: STONE WARS) knows its prequel, its Ryuusui special
 * and the "Koe Dake ga" music video — but seasons 3/4 are relations of
 * *other* entries. So the resolver walks the relation graph outward:
 *
 *   hop 0   the seed (DETAIL_QUERY media) or a batch fetch of the root;
 *   hop 1+  batch `media(id_in: [...])` over the pending frontier (<=50 ids),
 *           until the frontier dries up, 6 hops, or 60 franchise members.
 *
 * ── Edge tiers (the junk rule) ────────────────────────────────────────────
 *   expanding    PREQUEL/SEQUEL/ADAPTATION/SOURCE/SIDE_STORY/SPIN_OFF/
 *                SUMMARY/ALTERNATIVE(_VERSION)/CONTAINS/PARENT_SERIES are
 *                followed transitively.
 *   member-only  every other code (OTHER, unknowns) still *joins* the set —
 *                that is exactly what the old direct-neighbour rows showed —
 *                but is a dead end: expansion never runs through it. This is
 *                what keeps cross-franchise OTHER chains (One Piece ->
 *                "Annecy Festival" -> Dragon Ball -> ...) out of the graph.
 *   ignored      CHARACTER / PREVIEW — never counted, anywhere.
 *
 * ── Format eligibility ────────────────────────────────────────────────────
 * Members must be anime in TV / TV_SHORT / MOVIE / SPECIAL / OVA / ONA.
 * MUSIC (PVs, music videos, CD entries) is excluded — never a member, never
 * expanded through (a music video's relations drag in unrelated shows).
 * Manga/novel nodes are never listed (they dead-link to `/anime/{id}`) but a
 * source node reached through an ADAPTATION edge is traversed once: every
 * anime adapting the same source is a franchise member, which collapses long
 * chains (Dr. STONE season 4) into a single hop.
 *
 * ── Caching ───────────────────────────────────────────────────────────────
 * Every hop is its own `fetch(..., { next: { revalidate: 300 } })` against
 * graphql.anilist.co (same path/style as `anilist.ts`), so each batch lands in
 * the Next data cache independently and the walk is deterministic: the same
 * seed id always replays the same queries. Failures are swallowed — a partial
 * graph (or the seed alone) still renders, the page never fails over it.
 */

const ANILIST_API = "https://graphql.anilist.co";

/** One batch: up to 50 pending ids, relations included for the next hop. */
const FRANCHISE_QUERY = `
query ($ids: [Int]) {
  Page(page: 1, perPage: 50) {
    media(id_in: $ids) {
      id
      type
      format
      title { romaji english }
      coverImage { large }
      relations {
        edges {
          relationType
          node { id type format }
        }
      }
    }
  }
}
`;

/** Bounded walk: at most this many batch round-trips per franchise. */
const FRANCHISE_MAX_HOPS = 6;
/** Hard ceiling on franchise members (One Piece lands under it, Conan would too). */
const FRANCHISE_CAP = 60;
/** `media(id_in:)` batch size — matches the query's perPage. */
const FRANCHISE_BATCH = 50;

/* ── Eligibility (shared by the row, the strip and the search grouping) ─── */

/** Formats allowed in a franchise listing. MUSIC is deliberately absent. */
export const FRANCHISE_FORMATS = new Set([
  "TV",
  "TV_SHORT",
  "MOVIE",
  "SPECIAL",
  "OVA",
  "ONA",
]);

/** Source-material node types — never listed, traversed as a hub only. */
const SOURCE_NODE_TYPES = new Set(["MANGA", "NOVEL", "ONE_SHOT", "PMQ"]);

/** Relation edges that are never franchise links — anywhere. */
export const IGNORED_RELATION_TYPES = new Set(["CHARACTER", "PREVIEW"]);

/** Edges followed during transitive expansion (see tier notes above). */
export const EXPANDING_RELATION_TYPES = new Set([
  "PREQUEL",
  "SEQUEL",
  "ADAPTATION",
  "SOURCE",
  "SIDE_STORY",
  "SPIN_OFF",
  "SUMMARY",
  "ALTERNATIVE",
  "ALTERNATIVE_VERSION",
  "CONTAINS",
  "PARENT_SERIES",
]);

/** Summaries read as recaps whatever their broadcast format says. */
export const RECAP_RELATION_TYPES = new Set(["SUMMARY"]);

function normalizeRelation(relationType?: string | null): string {
  return String(relationType || "").trim().toUpperCase();
}

/** How much a discovery edge says about the member it reached (for `via`). */
function viaRank(relation?: string): number {
  const value = normalizeRelation(relation);
  if (value === "PREQUEL" || value === "SEQUEL") return 3;
  if (
    value === "SUMMARY" ||
    value === "SPIN_OFF" ||
    value === "SIDE_STORY" ||
    value === "ALTERNATIVE" ||
    value === "ALTERNATIVE_VERSION" ||
    value === "PARENT_SERIES" ||
    value === "CONTAINS"
  ) {
    return 2;
  }
  return value ? 1 : 0;
}

/** `TV`/`OVA`/... in a franchise listing — MUSIC and friends never qualify. */
export function isFranchiseFormat(format?: string | null): boolean {
  return FRANCHISE_FORMATS.has(String(format || "").trim().toUpperCase());
}

/** Is this edge counted at all (membership or expansion)? */
export function isFranchiseRelation(relationType?: string | null): boolean {
  return !IGNORED_RELATION_TYPES.has(normalizeRelation(relationType));
}

/** Is this edge followed transitively (vs. member-only / ignored)? */
export function expandsRelation(relationType?: string | null): boolean {
  return EXPANDING_RELATION_TYPES.has(normalizeRelation(relationType));
}

/* ── Ordering + season primitives (shared) ──────────────────────────────── */

/** Mainline TV first, then movie/ONA/OVA/specials — release order after. */
export const FRANCHISE_FORMAT_RANK: Record<string, number> = {
  TV: 0,
  TV_SHORT: 1,
  MOVIE: 2,
  ONA: 3,
  OVA: 4,
  SPECIAL: 5,
  MUSIC: 6,
};

/** Compact one-token badges used by the detail row. */
export const FRANCHISE_FORMAT_BADGES: Record<string, string> = {
  TV: "TV",
  TV_SHORT: "TV SHORT",
  MOVIE: "MOVIE",
  OVA: "OVA",
  ONA: "ONA",
  SPECIAL: "SPECIAL",
};

/** Only a TV run earns a season number. */
export function isTvLikeFormat(format?: string | null): boolean {
  const raw = String(format || "").trim().toUpperCase();
  return raw === "" || raw === "TV" || raw === "TV_SHORT";
}

/** Release order — AniList ids track it closely enough to order a run. */
export function byRelease(a: { id: number }, b: { id: number }): number {
  return a.id - b.id;
}

/** "MOVIE" -> "Movie", "OVA"/"ONA"/"TV" kept as-is — group/label wording. */
export function franchiseFormatLabel(format?: string | null): string {
  const raw = String(format || "").toUpperCase();
  if (!raw) return "Other";
  if (raw === "OVA" || raw === "ONA" || raw === "TV") return raw;
  if (raw === "MOVIE") return "Movie";
  if (raw === "TV_SHORT") return "TV Short";
  if (raw === "SPECIAL") return "Special";
  if (raw === "MUSIC") return "Music";
  return raw.charAt(0) + raw.slice(1).toLowerCase();
}

const SEASON_PATTERNS = [
  /\bseason\s*(\d{1,2})\b/i,
  /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i,
];

/** `... Season 3` / `... 3rd Season` -> 3; `null` when the title has no hint. */
export function franchiseSeasonHint(title?: string | null): number | null {
  if (!title) return null;
  for (const pattern of SEASON_PATTERNS) {
    const match = pattern.exec(title);
    if (match) {
      const value = parseInt(match[1], 10);
      if (value >= 1 && value <= 99) return value;
    }
  }
  return null;
}

/**
 * Split-cour continuations ("... Part 2", "... Cour 3") are the same season as
 * their predecessor in the chain, not a new one — Dr. STONE New World Part 2
 * is season 3, not season 4. Only consulted when the title carries no
 * explicit "Season N" hint (a hint always wins).
 */
const CONTINUATION_PATTERNS = [
  /\bpart\s*(\d{1,2})\b/i,
  /\bcour\s*(\d{1,2})\b/i,
  /\b(\d{1,2})(?:st|nd|rd|th)?\s+cour\b/i,
];

function isContinuationTitle(title?: string | null): boolean {
  if (!title) return false;
  for (const pattern of CONTINUATION_PATTERNS) {
    const match = pattern.exec(title);
    if (match && parseInt(match[1], 10) >= 2) return true;
  }
  return false;
}

/* ── Resolver ───────────────────────────────────────────────────────────── */

/** Where a franchise member sits relative to the title being viewed. */
export type FranchiseBucket = "prequel" | "current" | "sequel" | "rest";

export interface FranchiseItem {
  id: number;
  /** English title when AniList has one, romaji otherwise. */
  title: string;
  /** Large cover URL ("" when the API returned none — callers may drop it). */
  cover: string;
  /** Uppercased AniList format (`TV`, `OVA`, `MOVIE` ...). */
  format: string;
  /** Relation edge that first pulled this member in ("" for the current entry). */
  relation: string;
  /** Numbered season along the PREQUEL->SEQUEL chain (`1`, `2`, ...). */
  season?: number;
  bucket: FranchiseBucket;
}

/** Raw DETAIL_QUERY media — doubles as the seed so hop 0 costs no query. */
export interface FranchiseSeedMedia {
  id?: number;
  format?: string | null;
  title?: { romaji?: string | null; english?: string | null } | null;
  coverImage?: { large?: string | null } | null;
  relations?: { edges?: FranchiseRelationEdge[] | null } | null;
}

export interface FranchiseRelationEdge {
  relationType?: string | null;
  node?: {
    id?: number;
    type?: string | null;
    format?: string | null;
    title?: { romaji?: string | null; english?: string | null } | null;
    coverImage?: { large?: string | null } | null;
  } | null;
}

interface FranchiseLink {
  from: number;
  to: number;
  type: string;
}

async function fetchFranchiseBatch(ids: number[]): Promise<Map<number, any>> {
  const media = new Map<number, any>();
  try {
    const res = await fetch(ANILIST_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://anilist.co",
        Referer: "https://anilist.co/",
      },
      body: JSON.stringify({ query: FRANCHISE_QUERY, variables: { ids } }),
      next: { revalidate: 300 },
    });
    if (!res.ok) return media;
    const json = await res.json();
    for (const node of json?.data?.Page?.media || []) {
      if (typeof node?.id === "number") media.set(node.id, node);
    }
  } catch {
    // Best effort: a failed batch just ends the walk with what we already have.
  }
  return media;
}

function titleOf(node?: FranchiseSeedMedia | null): string {
  return node?.title?.english || node?.title?.romaji || "";
}

/**
 * Resolve the franchise around `currentId` into a canonical, ordered list:
 * prequels (earliest first) -> current -> sequels (in air order) -> everything
 * else (side stories, movies, spin-offs ... grouped by format, then release).
 * Season numbers are assigned along the PREQUEL->SEQUEL chain that runs
 * through the current entry.
 *
 * `seed` is the raw `getAnimeFull(currentId)` media when the caller already
 * has it — its edges seed the walk for free, and they are exactly the
 * direct-neighbour set the UI showed before this resolver existed (which is
 * also the degradation path when every batch fetch fails).
 */
export async function getFranchiseItems(
  currentId: number,
  seed?: FranchiseSeedMedia | null
): Promise<FranchiseItem[]> {
  if (!Number.isFinite(currentId)) return [];

  const items = new Map<number, FranchiseItem>();
  const visited = new Set<number>();
  /** Pending frontier: id -> whether its own edges will be expanded. */
  const pending = new Map<number, boolean>();
  /** Discovery provenance for display (edge that first reached the member). */
  const via = new Map<number, string>();
  /** PREQUEL/SEQUEL edges seen between members — drives bucketing. */
  const links: FranchiseLink[] = [];

  const enqueue = (id: number, expand: boolean, relation: string) => {
    if (id === currentId || visited.has(id)) return;
    const known = pending.get(id);
    if (known === undefined) {
      pending.set(id, expand);
      via.set(id, relation);
      return;
    }
    if (expand && !known) pending.set(id, true); // reached again through an expanding edge
    // First discovery wins, unless a *better* edge shows up later: the source
    // hub hands everything out as "OTHER", the real PREQUEL/SEQUEL/SUMMARY
    // edge (which drives the recap badge and the "sequel" wording) may only be
    // seen one node further along.
    if (viaRank(relation) > viaRank(via.get(id))) via.set(id, relation);
  };

  /** Every edge leaving an anime member (or the seed root). */
  const recordTargets = (from: number, edges?: FranchiseRelationEdge[] | null) => {
    if (!Array.isArray(edges)) return;
    for (const edge of edges) {
      const relation = normalizeRelation(edge?.relationType);
      if (IGNORED_RELATION_TYPES.has(relation)) continue;
      const node = edge?.node;
      if (typeof node?.id !== "number" || node.id === from) continue;

      const nodeType = String(node?.type || "").trim().toUpperCase();
      const format = String(node?.format || "").trim().toUpperCase();
      if (SOURCE_NODE_TYPES.has(nodeType) || SOURCE_NODE_TYPES.has(format)) {
        // Source material: not listable, but every anime adapting it is a
        // franchise member — traverse it as a hub (one hop, all seasons).
        if (relation === "ADAPTATION" || relation === "SOURCE") {
          enqueue(node.id, true, relation);
        }
        continue;
      }
      if (!isFranchiseFormat(format)) continue; // MUSIC / unknown — never listed
      links.push({ from, to: node.id, type: relation });
      enqueue(node.id, expandsRelation(relation), relation);
    }
  };

  /** Edges leaving a source node: hand back its anime adaptations only. */
  const recordSourceTargets = (edges?: FranchiseRelationEdge[] | null) => {
    if (!Array.isArray(edges)) return;
    for (const edge of edges) {
      const relation = normalizeRelation(edge?.relationType);
      if (relation !== "ADAPTATION" && relation !== "SOURCE") continue;
      const node = edge?.node;
      if (typeof node?.id !== "number") continue;
      if (!isFranchiseFormat(node?.format)) continue;
      // Not a link between members — the discovery relation reads "related".
      enqueue(node.id, true, "OTHER");
    }
  };

  const toItem = (node: any): FranchiseItem => ({
    id: node.id,
    title: titleOf(node),
    cover: node?.coverImage?.large || "",
    format: String(node?.format || "").trim().toUpperCase(),
    relation: via.get(node.id) || "",
    bucket: "rest",
  });

  if (seed) {
    // Free hop: the caller's DETAIL_QUERY already carries the root's edges.
    visited.add(currentId);
    items.set(currentId, {
      id: currentId,
      title: titleOf(seed),
      cover: seed?.coverImage?.large || "",
      format: String(seed?.format || "").trim().toUpperCase(),
      relation: "",
      bucket: "current",
    });
    recordTargets(currentId, seed?.relations?.edges);
  } else {
    pending.set(currentId, true);
  }

  let hops = 0;
  while (pending.size > 0 && hops < FRANCHISE_MAX_HOPS && items.size < FRANCHISE_CAP) {
    const batch: { id: number; expand: boolean }[] = [];
    for (const [id, expand] of pending) {
      if (batch.length >= FRANCHISE_BATCH) break;
      batch.push({ id, expand });
    }
    // Retire the batch *before* the await: an id still sitting in `pending`
    // while its own node is being processed would be re-enqueued by a sibling
    // (e.g. the manga hub pointing back at a neighbour of the seed), which
    // overwrote its discovery relation and cost a second fetch of the node.
    for (const entry of batch) {
      pending.delete(entry.id);
      visited.add(entry.id);
    }

    const nodes = await fetchFranchiseBatch(batch.map((entry) => entry.id));
    hops++;

    for (const { id, expand } of batch) {
      const node = nodes.get(id);
      if (!node) continue;
      const nodeType = String(node?.type || "").trim().toUpperCase();
      const format = String(node?.format || "").trim().toUpperCase();
      const isCurrentNode = id === currentId;
      // `type` is authoritative when the API ships it; when it is missing the
      // format decides (same fallback the detail row always used).
      const looksAnime = nodeType === "ANIME" || (!nodeType && isFranchiseFormat(format));

      if (isCurrentNode || looksAnime) {
        // Eligible formats only — MUSIC / PVs are never listed (and, because
        // this `continue`s past `recordTargets`, never expanded through).
        if (!isCurrentNode && !isFranchiseFormat(format)) continue;
        if (items.size < FRANCHISE_CAP || isCurrentNode) items.set(id, toItem(node));
        if (!expand) continue; // member-only nodes are dead ends
        recordTargets(id, node?.relations?.edges);
      } else if (expand) {
        recordSourceTargets(node?.relations?.edges);
      }
    }
  }

  return finalizeFranchise(items, links, currentId);
}

/* ── Bucketing, ordering, season numbers ────────────────────────────────── */

function addEdge(map: Map<number, Set<number>>, from: number, to: number) {
  let set = map.get(from);
  if (!set) map.set(from, (set = new Set()));
  set.add(to);
}

/** BFS distances from `currentId` over one direction of the season chain. */
function chainDistances(
  edges: Map<number, Set<number>>,
  currentId: number
): Map<number, number> {
  const distance = new Map<number, number>([[currentId, 0]]);
  const queue = [currentId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const next = distance.get(cur)! + 1;
    for (const neighbour of edges.get(cur) || []) {
      if (distance.has(neighbour)) continue;
      distance.set(neighbour, next);
      queue.push(neighbour);
    }
  }
  return distance;
}

/**
 * Season numbers along the linear chain [prequels, current, sequels].
 * An explicit "Season N" hint in a TV-run title is authoritative for its slot
 * and propagates to its neighbours; a split-cour continuation inherits the
 * previous slot's number instead of starting a new season. Without any hint
 * the earliest TV slot anchors as Season 1 — but a lone TV slot claims
 * nothing (it cannot verify a season number it has no neighbours to count).
 */
function assignChainSeasons(chain: FranchiseItem[]): void {
  const slots: number[] = [];
  chain.forEach((item, index) => {
    if (isTvLikeFormat(item.format)) slots.push(index);
  });
  if (slots.length === 0) return;

  const hints = slots.map((index) => franchiseSeasonHint(chain[index].title));
  const anyHint = hints.some((hint) => hint !== null);
  if (!anyHint && slots.length < 2) return;

  const continuation = slots.map(
    (index, slot) => hints[slot] === null && isContinuationTitle(chain[index].title)
  );
  const numbers: (number | null)[] = hints.slice();
  if (!anyHint) numbers[0] = 1;

  // Forward fill: each blank slot continues or follows the previous number.
  for (let i = 1; i < slots.length; i++) {
    if (numbers[i] !== null || numbers[i - 1] === null) continue;
    numbers[i] = continuation[i] ? numbers[i - 1]! : numbers[i - 1]! + 1;
  }
  // Backward fill: a hint deep in the chain anchors everything before it.
  for (let i = slots.length - 2; i >= 0; i--) {
    if (numbers[i] !== null || numbers[i + 1] === null) continue;
    numbers[i] = continuation[i + 1] ? numbers[i + 1]! : numbers[i + 1]! - 1;
  }

  slots.forEach((chainIndex, slot) => {
    const value = numbers[slot];
    if (value !== null && value >= 1) chain[chainIndex].season = value;
  });
}

function finalizeFranchise(
  items: Map<number, FranchiseItem>,
  links: FranchiseLink[],
  currentId: number
): FranchiseItem[] {
  // Chain adjacency between members: child -> older, parent -> newer.
  const prequelOf = new Map<number, Set<number>>();
  const sequelOf = new Map<number, Set<number>>();
  for (const link of links) {
    if (link.from === link.to) continue;
    if (!items.has(link.from) || !items.has(link.to)) continue;
    if (link.type === "PREQUEL") {
      // link.to precedes link.from
      addEdge(prequelOf, link.from, link.to);
      addEdge(sequelOf, link.to, link.from);
    } else if (link.type === "SEQUEL") {
      addEdge(prequelOf, link.to, link.from);
      addEdge(sequelOf, link.from, link.to);
    }
  }

  const prequelDistance = chainDistances(prequelOf, currentId);
  const sequelDistance = chainDistances(sequelOf, currentId);

  const prequels: FranchiseItem[] = [];
  const sequels: FranchiseItem[] = [];
  const rest: FranchiseItem[] = [];
  for (const item of items.values()) {
    if (item.id === currentId) continue;
    if (prequelDistance.has(item.id)) prequels.push(item);
    else if (sequelDistance.has(item.id)) sequels.push(item);
    else rest.push(item);
  }

  // Prequels farthest-first (earliest in story), sequels nearest-first
  // (air order), ties broken by release. Extras: format rank, then release.
  prequels.sort(
    (a, b) =>
      (prequelDistance.get(b.id) ?? 0) - (prequelDistance.get(a.id) ?? 0) ||
      byRelease(a, b)
  );
  sequels.sort(
    (a, b) =>
      (sequelDistance.get(a.id) ?? 0) - (sequelDistance.get(b.id) ?? 0) ||
      byRelease(a, b)
  );
  rest.sort(
    (a, b) => (FRANCHISE_FORMAT_RANK[a.format] ?? 7) - (FRANCHISE_FORMAT_RANK[b.format] ?? 7) ||
      byRelease(a, b)
  );

  prequels.forEach((item) => (item.bucket = "prequel"));
  sequels.forEach((item) => (item.bucket = "sequel"));
  const current = items.get(currentId);
  if (current) current.bucket = "current";

  const chain = current ? [...prequels, current, ...sequels] : [...prequels, ...sequels];
  assignChainSeasons(chain);

  return current
    ? [...prequels, current, ...sequels, ...rest]
    : [...prequels, ...sequels, ...rest];
}
