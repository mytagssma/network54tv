import type { ReactNode } from "react";

/**
 * ─── One visual language for "is it there?" ─────────────────────────────
 *
 * Before this module every availability surface spoke its own dialect:
 * EpisodeList rendered an `N/A` text token, EpisodeSelector dimmed the same
 * rows with no reason at all, EpisodeListFetcher carried three different
 * loading strings plus a `—`/`UNKNOWN` count, and two separate `// NO EPISODE
 * DATA` cards and one `// NO STREAM FOUND` card each owned a private copy of
 * the same idea. Queue #9 was exactly that fragmentation.
 *
 * This file is the ONLY place those strings and chip styles are written. The
 * visual language is unchanged on purpose — mono, uppercase, accent, and
 * `rounded-none` — because this is consolidation, not a redesign. The two
 * headings tests and users depend on (`// NO EPISODE DATA`, `// NO STREAM
 * FOUND`) are verbatim.
 *
 * Deliberately has no `"use client"` directive: it is presentational, so the
 * server components (the watch page) and the client components (Player,
 * EpisodeList*, EpisodeSelector) can all render the same instance.
 */

/** Which badge a row/episode carries. */
export type AvailabilityKind = "sub" | "dub" | "na" | "unknown";

/** Why an episode list is empty. */
export type EmptyStateCode = "NO_EPISODE_DATA" | "NO_STREAM_FOUND";

/**
 * Extra reason under an empty heading.
 * `suspect` — a provider DID answer, but the list it returned was discarded by
 * the plausibility gate (`listStatus` from `/api/episodes`), which is a
 * different story from "nobody answered".
 */
export type EmptyStateDetail = "suspect";

/** Which in-flight message to show. */
export type LoadingState = "list" | "audio" | "rows";

/** Every user-visible string lives in this object. Nowhere else. */
const COPY: Record<
  EmptyStateCode,
  { heading: string; body: string; suspect?: string; bodyClass: string }
> = {
  NO_EPISODE_DATA: {
    heading: "// NO EPISODE DATA",
    body: "No working provider has an episode list for this title yet.",
    // The gate saw a list and threw it away — say so instead of pretending
    // nothing came back, which is what used to happen.
    suspect: "A provider did answer, but the list it returned looked wrong for this title, so it was discarded.",
    bodyClass: "mt-2 text-sm leading-relaxed text-[var(--text-decorative)]",
  },
  NO_STREAM_FOUND: {
    heading: "// NO STREAM FOUND",
    body: "Every source failed or has no file for this episode — provider outage, or this title isn't carried.",
    // `mb-4` separates the copy from the Retry / Try Dub button row below it.
    bodyClass: "mt-3 text-[var(--text-secondary)] text-sm mb-4 leading-relaxed",
  },
};

/** The three states the episode list can be waiting in. One place. */
const LOADING: Record<LoadingState, string> = {
  list: "Loading...",
  audio: "Checking audio...",
  rows: "Fetching episodes...",
};

/** Single spelling of "we don't know this count" for the Sub/Dub tallies. */
const UNKNOWN_COUNT = "\u2014"; // em dash

const HEADING_CLASS = "font-mono text-xs uppercase tracking-[0.25em] text-[var(--accent)]";

const CARD_CLASS = "border-l-2 border-[var(--accent)]/40 bg-[var(--panel)] px-4 py-5 sm:px-6";

/**
 * Per-kind chip styles, copied verbatim from the surfaces they replace so the
 * pixels don't move:
 *  - `sub`/`dub` → EpisodeList's SUB/DUB boxes
 *  - `na`        → EpisodeList's bare `N/A` token (and now EpisodeSelector's
 *                  previously silent dimmed row, which gets this reason label)
 *  - `unknown`   → the bordered accent box EpisodeListFetcher used for counts
 */
const CHIP_CLASS: Record<AvailabilityKind, string> = {
  sub: "border border-[var(--accent)]/20 text-[var(--accent)]/60 px-1 py-0.5 label-micro rounded-none",
  dub: "border border-[var(--accent)]/20 text-[var(--accent)]/60 px-1 py-0.5 label-micro rounded-none",
  na: "font-mono text-[10px] text-[var(--text-decorative)] uppercase tracking-wider",
  unknown: "bg-transparent border border-[var(--accent)]/20 text-[var(--accent)]/70 px-2 py-0.5 label-micro rounded-none",
};

const CHIP_LABEL: Record<AvailabilityKind, string> = {
  sub: "SUB",
  dub: "DUB",
  na: "N/A",
  unknown: "UNKNOWN",
};

/** The sub/dub/audio badge — the one box every surface now borrows. */
export function AvailabilityChip({ kind, className }: { kind: AvailabilityKind; className?: string }) {
  return (
    <span className={[CHIP_CLASS[kind], className].filter(Boolean).join(" ")}>
      {CHIP_LABEL[kind]}
    </span>
  );
}

/**
 * The empty-state card: heading + one reason line.
 *
 * `className` replaces the default bordered card (the Player keeps its own
 * centred overlay wrapper and passes `""`). `note` overrides the reason line
 * with a server-supplied string — used for `/api/stream`'s `data.error`, so
 * the card can say what actually failed instead of the generic fallback.
 */
export function EmptyState({
  code,
  detail,
  note,
  className,
  children,
}: {
  code: EmptyStateCode;
  detail?: EmptyStateDetail;
  /** Server-provided reason; shown instead of the generic line when present. */
  note?: string | null;
  className?: string;
  /** Extra content rendered after the reason (action rows, pickers…). */
  children?: ReactNode;
}) {
  const copy = COPY[code];
  const body =
    note?.trim() ||
    (code === "NO_EPISODE_DATA" && detail === "suspect" && copy.suspect
      ? copy.suspect
      : copy.body);

  return (
    <div className={className ?? CARD_CLASS}>
      <p className={HEADING_CLASS}>{copy.heading}</p>
      <p className={copy.bodyClass}>{body}</p>
      {children}
    </div>
  );
}

/**
 * In-flight message. `list` and `audio` are the two small pulse notes in the
 * section header; `rows` is the block placeholder shown while the list body is
 * still empty. All three texts live in `LOADING` above.
 */
export function LoadingNote({ state }: { state: LoadingState }) {
  if (state === "rows") {
    return <p className="text-[var(--text-decorative)] italic">{LOADING.rows}</p>;
  }
  return (
    <span className="text-[10px] text-[var(--accent)]/40 font-mono animate-pulse">
      {LOADING[state]}
    </span>
  );
}

/**
 * `Sub 28` / `Dub 12` tally — now the SHARED sub/dub contract (Lane A's
 * `getAudioFlags` summary), rendered three ways:
 *
 *   null/unknown count  → `—`        (never guesses)
 *   count + ofTotal     → `12/30 SUB` (partial knowledge: 12 of the 30 rows
 *                                      are known to carry the track)
 *   count alone         → `30 SUB`    (every row was checked)
 *
 * `ofTotal` is read defensively: a numeric count with an undefined ofTotal
 * renders the plain form, so this works both before and after Lane A lands.
 * The watch-page header uses `audioTallyText` for the exact same wording.
 */
export interface AudioTallies {
  subCount?: number | null;
  dubCount?: number | null;
  subOfTotal?: number | null;
  dubOfTotal?: number | null;
}

/** The numeric half of a tally: `12/30`, `30`, or null when unknown. */
export function audioTallyText(
  count: number | null | undefined,
  ofTotal?: number | null
): string | null {
  if (typeof count !== "number" || !Number.isFinite(count)) return null;
  if (typeof ofTotal === "number" && Number.isFinite(ofTotal)) return `${count}/${ofTotal}`;
  return String(count);
}

export function AudioCount({
  label,
  value,
  ofTotal,
}: {
  label: "Sub" | "Dub";
  value: number | null;
  ofTotal?: number | null;
}) {
  const count = audioTallyText(value, ofTotal);
  return (
    <span className="bg-transparent border border-[var(--accent)]/20 text-[var(--accent)]/70 px-2 py-0.5 label-micro rounded-none">
      {count === null ? UNKNOWN_COUNT : `${count} ${label.toUpperCase()}`}
    </span>
  );
}
