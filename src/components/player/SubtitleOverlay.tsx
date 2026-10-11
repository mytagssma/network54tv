"use client";

import { useEffect, useRef, useState, useMemo, Fragment } from "react";
import { proxyUrl } from "@/lib/utils";

interface SubtitleOverlayProps {
  subtitleUrl: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  headers?: Record<string, string>;
  offset?: number; // subtitle timing offset in seconds (positive = delayed, negative = earlier)
  size?: "small" | "medium" | "large";
  controlsVisible?: boolean;
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

// ─── Binary search: find first cue whose end >= time ─────────────
function findActiveCues(cues: Cue[], time: number): string[] {
  let lo = 0,
    hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].end < time) lo = mid + 1;
    else hi = mid;
  }

  const result: string[] = [];
  for (let i = lo; i < cues.length && cues[i].start <= time; i++) {
    if (cues[i].end >= time) {
      result.push(cues[i].text);
    }
  }
  return result;
}

// ─── VTT cache (module-level, persists across mounts) ─────────────
const vttCache = new Map<string, Cue[]>();
const VTT_CACHE_MAX = 50;

function cacheVTT(url: string, cues: Cue[]) {
  vttCache.set(url, cues);
  if (vttCache.size > VTT_CACHE_MAX) {
    const first = vttCache.keys().next().value;
    if (first) vttCache.delete(first);
  }
}

// ─── Tag formatting (stable, outside component) ───────────────────
const TAG_MAP: Record<string, string> = {
  b: "font-bold",
  i: "italic",
  u: "underline",
  s: "line-through",
  "c.bold": "font-bold",
  "c.italic": "italic",
  "c.underline": "underline",
  "c.strike": "line-through",
};

const CLASS_STYLE_MAP: Record<string, string> = {
  bg_black: "bg-black/80",
  bg_white: "bg-white/80",
  bg_yellow: "bg-yellow-500/80",
  bg_cyan: "bg-cyan-500/80",
};

function renderFormattedText(text: string): React.ReactNode {
  let key = 0;

  function processSegment(segment: string): React.ReactNode {
    if (!segment) return null;

    segment = segment.replace(/<br\s*\/?>/gi, "\n");

    const result: React.ReactNode[] = [];
    let pos = 0;
    const tagRe = /<(\/)?([\w.]+)(?:\s[^>]*)?>/g;
    let match: RegExpExecArray | null;

    while ((match = tagRe.exec(segment)) !== null) {
      if (match.index > pos) {
        result.push(segment.slice(pos, match.index));
      }

      const isClosing = !!match[1];
      const tagName = match[2].toLowerCase();
      pos = match.index + match[0].length;

      if (isClosing) continue;

      const mappedClass = TAG_MAP[tagName] || CLASS_STYLE_MAP[tagName];
      const effectiveTag = tagName.split(".")[0];

      if (mappedClass) {
        const closeTag = `</${effectiveTag}>`;
        const closeIdx = segment.indexOf(closeTag, pos);
        if (closeIdx !== -1) {
          const inner = processSegment(segment.slice(pos, closeIdx));
          result.push(
            <span key={key++} className={mappedClass}>
              {inner}
            </span>
          );
          pos = closeIdx + closeTag.length;
          tagRe.lastIndex = pos;
        }
      } else {
        const closeTag = `</${effectiveTag}>`;
        const closeIdx = segment.indexOf(closeTag, pos);
        if (closeIdx !== -1) {
          const inner = processSegment(segment.slice(pos, closeIdx));
          if (typeof inner === "string") {
            result.push(inner);
          } else {
            result.push(<Fragment key={key++}>{inner}</Fragment>);
          }
          pos = closeIdx + closeTag.length;
          tagRe.lastIndex = pos;
        }
      }
    }

    if (pos < segment.length) {
      result.push(segment.slice(pos));
    }

    return result.length > 0 ? result : null;
  }

  return processSegment(text) || text;
}

// ─── VTT parser ───────────────────────────────────────────────────
function parseVTTTime(time: string): number {
  const parts = time.split(":");
  if (parts.length === 3) {
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return 0;
}

/* ─── ASS/SSA inline overrides ──────────────────────────────────────────
 * `{…}` blocks carry both layout (`\pos`, `\an8`, `\fad`) and TEXT STYLE
 * (`\i1`, `\b0`, …). The old code deleted every block, which threw the
 * styles away with the layout: an ASS `\i1` is a STATEFUL toggle that stays
 * on until `\i0` or the end of the line, so the cue rendered roman while a
 * neighbouring cue that used a WebVTT `<i>` rendered italic — the mid-sentence
 * flip. Keep dropping the layout overrides, but rewrite the four basic
 * styles the renderer already understands into balanced HTML tags.
 */
function applyAssOverrides(text: string): string {
  let out = "";
  let last = 0;
  const open: string[] = [];
  const blockRe = /\{([^}]*)\}/g;
  let block: RegExpExecArray | null;

  while ((block = blockRe.exec(text)) !== null) {
    out += text.slice(last, block.index);
    last = block.index + block[0].length;

    const body = block[1];

    // `\N` (hard break) and `\n` (soft wrap) are LINE BREAKS, not styles.
    // Deleting the block — which the old strip did — silently merged the two
    // halves: `of {\N} in legends` rendered as one line, `of in legends`,
    // the break flattened into the surrounding spaces. Emit a real newline;
    // the per-line trim in normalizeSpacing then drops the spaces around it
    // and the render stacks the two lines. Handled before the `\r` reset
    // below so a combined `{\r\N}` keeps its break too.
    const breaks = body.match(/\\[Nn]/g);
    if (breaks) out += "\n".repeat(breaks.length);

    // `\r` / `\rStyleName` resets every style back to default.
    if (/\\r(\w+)?/.test(body)) {
      for (let i = open.length - 1; i >= 0; i--) out += `</${open[i]}>`;
      open.length = 0;
      continue;
    }

    const toggleRe = /\\([iubs])([01])/g;
    let toggle: RegExpExecArray | null;
    while ((toggle = toggleRe.exec(body)) !== null) {
      const tag = toggle[1];
      const on = toggle[2] === "1";
      const at = open.lastIndexOf(tag);
      if (on) {
        if (at === -1) { out += `<${tag}>`; open.push(tag); }
      } else if (at !== -1) {
        // Close this tag plus everything opened inside it, then reopen the rest.
        const closing = open.splice(at);
        for (let i = closing.length - 1; i >= 0; i--) out += `</${closing[i]}>`;
        for (let i = closing.length - 2; i >= 0; i--) out += `<${closing[i]}>`;
      }
    }
  }

  out += text.slice(last);
  for (let i = open.length - 1; i >= 0; i--) out += `</${open[i]}>`;
  return out;
}

/** Inline tags the renderer actually styles — the only ones worth re-opening. */
const STYLE_TAG_RE = /^(?:b|i|u|s)$/;

/** Which style tags are still open at `index` in `text`. */
function tagsOpenAt(text: string, index: number): string[] {
  const open: string[] = [];
  const re = /<(\/)?([a-z]+)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && m.index < index) {
    const name = m[2].toLowerCase();
    if (!STYLE_TAG_RE.test(name)) continue;
    if (m[1]) {
      const at = open.lastIndexOf(name);
      if (at !== -1) open.splice(at, 1);
    } else if (!open.includes(name)) {
      open.push(name);
    }
  }
  return open;
}

/**
 * Split a cue into the lines the overlay renders — one box per line — and
 * balance the style tags across each break.
 *
 * Two jobs a plain split cannot do:
 *
 * - Drop whitespace-only and tag-only lines. The sentence split slices its
 *   pieces at the boundary MATCH, which includes the trailing whitespace —
 *   so a cue like `Now, now, Frieren. \nTonight, we drink for free.` produced
 *   the piece `Now, now, Frieren.\n`, and that trailing newline rendered a
 *   second, EMPTY box: a padding-sized block that reads on screen as a smear
 *   of excess whitespace next to the real line (measured: 6/21/5 per episode
 *   on Frieren/One Piece/Black Clover). A line that is only `</i>` is the
 *   same box with a tag in it.
 *
 * - Re-open/close the style tags the break cut through. `<i>Gold Roger,\n
 *   the King of the Pirates,</i>` opens on one line and closes on the next;
 *   processed per line, each half fell outside a balanced pair and rendered
 *   unstyled — the mid-sentence flip again, this time at every hard wrap.
 *   Same contract as the piece split in parseVTT: re-open what was open at
 *   the line's start, close what is still open at its end.
 */
function splitStyledLines(text: string): string[] {
  const re = /<br\s*\/?>|\n/gi;
  const lines: string[] = [];
  let pos = 0;
  let m: RegExpExecArray | null;

  const push = (start: number, end: number) => {
    const piece = text.slice(start, end);
    if (!piece.replace(/<[^>]*>/g, "").trim()) return;
    const openBefore = tagsOpenAt(text, start);
    const openAfter = tagsOpenAt(text, end);
    let line = "";
    for (const tag of openBefore) if (!piece.includes(`<${tag}>`)) line += `<${tag}>`;
    line += piece.trim();
    for (let i = openAfter.length - 1; i >= 0; i--) {
      if (!piece.includes(`</${openAfter[i]}>`)) line += `</${openAfter[i]}>`;
    }
    lines.push(line);
  };

  while ((m = re.exec(text)) !== null) {
    push(pos, m.index);
    pos = m.index + m[0].length;
  }
  push(pos, text.length);
  return lines;
}

/**
 * Collapse every run of horizontal whitespace to one space, trim the edges,
 * and squeeze blank lines out.
 *
 * This exists purely for the tag-remnant gap: deleting an ASS override block
 * removes the block but NOT the spaces around it, so `spoken of {\i1} in
 * legends` becomes `spoken of  in legends`, and `{\N}` wedged between two
 * spaces does the same until it is converted to a real newline (see
 * applyAssOverrides). The source files are innocent — all three real VTTs
 * this app ships hold zero consecutive spaces across ~1000 cues — so every
 * doubled space on screen is introduced by the tag strip, and this folds it
 * back.
 *
 * Per-CUE only. Running it over the whole file would eat the blank lines that
 * separate blocks, and `split(/\n\n+/)` would then glue every cue in the file
 * into one (measured: 291 cues collapsed to 22).
 *
 * `\n` is STRUCTURAL — the render path turns each one into its own line — so
 * line breaks are preserved and every line is trimmed instead of merged.
 */
function normalizeSpacing(text: string): string {
  // `<br>` is a line break like `\n` — convert first, so the per-line pass
  // below reaches the spaces on both sides of it (`of <br> in` kept them and
  // rendered as a box with a stray edge space).
  let collapsed = text.replace(/<br\s*\/?>/gi, "\n");

  // A whitespace run can STRADDLE a tag: `{\i1}` is kept as `<i>`, so
  // `of {\i1} in` leaves `of <i> in` — two spaces with a (zero-width) tag
  // between them, which the plain run-collapse below cannot see as one run.
  // Keep the tags, leave exactly one space before the group, drop the ones
  // on either side. Repeats so `a <i> <b> c` settles too. Any HORIZONTAL
  // whitespace counts, not just the ASCII space: `of\u00A0<i>\u00A0in` has a
  // non-breaking space on each side, and collapsing those one at a time (as
  // the per-line pass must) turns the pair into two ASCII spaces with the
  // tag between — a doubled space no later pass can see. `\n` stays
  // excluded: it is the line structure the render stacks.
  let previous: string;
  do {
    previous = collapsed;
    collapsed = collapsed.replace(/[^\S\n]+(<[^>]+>)+[^\S\n]+/g, " $1");
  } while (collapsed !== previous);

  return (
    collapsed
      .split("\n")
      .map((line) =>
        line
          .replace(/[^\S\n]+/g, " ")
          .trim()
          // A space hugging a tag at the line edge (`world </i>`, `<i> hello`)
          // hides from the trim above — trim cannot see past the tag — and
          // renders as padding-sized whitespace inside the line box.
          .replace(/^((?:<[^>]+>)+) +/, "$1")
          .replace(/ +((?:<[^>]+>)+)$/, "$1")
      )
      .join("\n")
      // Squeeze blank lines, then drop the blank lines a piece-slice can
      // leave at the edges (`Sentence.\n` from the sentence split): kept,
      // they render as an empty subtitle box — excess whitespace on screen.
      .replace(/\n{2,}/g, "\n")
      .replace(/^\n+|\n+$/g, "")
  );
}

function parseVTT(vttContent: string): Cue[] {
  const cues: Cue[] = [];
  let text = vttContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // ASS/SSA style overrides: keep {\i1}/{\b0}… as tags, drop {\pos}/{\an8}/{\fad(…)}…
  text = applyAssOverrides(text);

  // Bare ASS line breaks (\N, \n) without a {…} wrapper → real newlines.
  // Brace-wrapped ones ({\N}) were already converted by applyAssOverrides;
  // this catches the unwrapped leftovers.
  text = text.replace(/\\[Nn]/g, "\n");

  const headerMatch = text.match(/^WEBVTT.*?\n\n/);
  if (headerMatch) {
    text = text.slice(headerMatch[0].length);
  } else if (text.startsWith("WEBVTT")) {
    const firstNewline = text.indexOf("\n");
    text = text.slice(firstNewline + 1);
  }

  const blocks = text.split(/\n\n+/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("NOTE") || trimmed.startsWith("COMMENT")) continue;

    const lines = trimmed.split("\n");
    const timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx === -1) continue;

    const timingMatch = lines[timingIdx].match(
      /(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/
    );
    if (!timingMatch) continue;

    const start = parseVTTTime(timingMatch[1]);
    const end = parseVTTTime(timingMatch[2]);
    // Per-cue whitespace normalization — collapses the tag-remnant runs the
    // override strip left behind (see normalizeSpacing). Must run here, on
    // the joined cue text, and NOT on the whole file: the blank lines between
    // blocks are what `split(/\n\n+/)` uses to tell cues apart.
    const cueText = normalizeSpacing(
      lines.slice(timingIdx + 1).filter((l) => !l.startsWith("NOTE")).join("\n").trim()
    );

    if (!cueText) continue;

    // Split long cues that contain multiple speakers' dialogue.
    // Detect sentence boundaries (. ! ?) followed by a capital letter or space+capital,
    // which typically marks a new speaker's line in merged subtitles.
    //
    // The split must NOT strip the inline tags: a cue wrapped in <i>…</i> that
    // happens to contain a sentence boundary lost its tags (roman) while a
    // sibling cue without a boundary kept them (italic) — the mid-sentence
    // flip. Instead, re-open whatever style tags were already open at each
    // piece's offset so every piece stays styled the way its parent cue was.
    const duration = end - start;
    const boundaries: number[] = [0];
    const boundaryRe = /(?<=[.!?])\s+(?=[A-Z""\u201c])/g;
    let boundary: RegExpExecArray | null;
    while ((boundary = boundaryRe.exec(cueText)) !== null) {
      boundaries.push(boundary.index + boundary[0].length);
    }
    boundaries.push(cueText.length);

    const pieces: { text: string; plain: string; from: number; to: number }[] = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const from = boundaries[i];
      const to = boundaries[i + 1];
      // Re-normalize per piece: the global pass above already cleaned the
      // whole file, but this is the boundary the instruction cares about —
      // every piece that reaches a cue gets the run-collapse + edge trim.
      const raw = normalizeSpacing(cueText.slice(from, to));
      if (!raw) continue;
      const plain = raw.replace(/<[^>]*>/g, "");
      if (!plain.trim()) continue;
      pieces.push({ text: raw, plain, from, to });
    }

    if (pieces.length > 1) {
      // Distribute time proportionally across sentences
      const totalChars = pieces.reduce((sum, p) => sum + p.plain.length, 0);
      let t = start;
      for (const piece of pieces) {
        const share = totalChars > 0 ? piece.plain.length / totalChars : 1 / pieces.length;
        const cueEnd = t + duration * share;
        // The piece is a raw substring, so it may start inside a tag that was
        // opened before it and end inside one that closes after it. Balance it
        // against the tags open at each edge, but only for the tags the piece
        // doesn't already carry — otherwise the closing `</i>` that is already
        // in the slice gets a second one bolted on.
        const openBefore = tagsOpenAt(cueText, piece.from);
        const openAfter = tagsOpenAt(cueText, piece.to);
        let styled = "";
        for (const tag of openBefore) if (!piece.text.includes(`<${tag}>`)) styled += `<${tag}>`;
        styled += piece.text;
        for (let i = openAfter.length - 1; i >= 0; i--) {
          if (!piece.text.includes(`</${openAfter[i]}>`)) styled += `</${openAfter[i]}>`;
        }
        cues.push({ start: t, end: Math.min(cueEnd, end), text: styled });
        t = cueEnd;
      }
    } else {
      // Unsplit cue — same treatment as the pieces above (idempotent; the
      // file-wide pass already cleaned this text).
      cues.push({ start, end, text: normalizeSpacing(cueText) });
    }
  }

  // Sort by start time for binary search correctness
  cues.sort((a, b) => a.start - b.start);

  return cues;
}

// ─── Component ────────────────────────────────────────────────────

export default function SubtitleOverlay({
  subtitleUrl,
  videoRef,
  headers,
  offset = 0,
  size = "medium",
  controlsVisible = true,
}: SubtitleOverlayProps) {
  const [cues, setCues] = useState<Cue[]>([]);
  const [activeText, setActiveText] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const offsetRef = useRef(offset);

  // Keep offsetRef in sync with prop
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  // Fetch and parse VTT (with module-level cache)
  useEffect(() => {
    if (!subtitleUrl) return;

    // Check VTT cache first
    const cached = vttCache.get(subtitleUrl);
    if (cached) {
      setCues(cached);
      setError(false);
      return;
    }

    setError(false);
    setCues([]);
    let cancelled = false;

    const fetchSubs = async () => {
      try {
        const url = subtitleUrl.startsWith("blob:") ? subtitleUrl : proxyUrl(subtitleUrl, headers);
        const res = await fetch(url, {
          headers: { Accept: "text/vtt, text/plain, */*" },
        });

        if (!res.ok || cancelled) {
          if (!cancelled) setError(true);
          return;
        }

        const text = await res.text();
        if (cancelled) return;

        const parsed = parseVTT(text);
        cacheVTT(subtitleUrl, parsed);
        setCues(parsed);
      } catch {
        if (!cancelled) setError(true);
      }
    };

    fetchSubs();
    return () => {
      cancelled = true;
    };
  }, [subtitleUrl, headers]);

  // rAF loop: read video.currentTime directly, update active text only when changed
  useEffect(() => {
    if (cues.length === 0) {
      setActiveText([]);
      return;
    }

    let rafId: number;
    let lastTime = -1;
    let lastText = "";

    const tick = () => {
      const video = videoRef.current;
      if (!video) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      const t = video.currentTime + offsetRef.current;
      // Only recompute when time actually changed (handles pause + seek)
      if (t !== lastTime) {
        lastTime = t;
        const active = findActiveCues(cues, t);
        const joined = active.length > 0 ? active.join("\n") : "";

        if (joined !== lastText) {
          lastText = joined;
          setActiveText(active);
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [cues, videoRef]);

  if (error || activeText.length === 0) return null;

  const sizeClasses = size === "small"
    ? "text-[10px] sm:text-xs sm:text-sm"
    : size === "large"
    ? "text-sm sm:text-lg sm:text-xl"
    : "text-xs sm:text-sm sm:text-base md:text-lg";

  return (
    <div
      className={`absolute left-0 right-0 pointer-events-none z-20 flex flex-col items-center gap-1 px-2 sm:px-4 transition-all duration-300 ease-in-out ${
        controlsVisible
          ? "bottom-10 sm:bottom-16"
          : "bottom-2 sm:bottom-4"
      }`}
    >
      {activeText.map((text, i) => {
        // One box per line — see splitStyledLines for the tag balancing and
        // the empty-line drop.
        const lines = splitStyledLines(text);
        if (lines.length === 0) return null;

        return (
          // Flex COLUMN, not a plain text-align:center block: as inline-level
          // boxes in a block container the line spans flowed HORIZONTALLY, so
          // every source line break rendered as the two boxes' padding sitting
          // side by side — a ~2-space-wide gap between words where the newline
          // was ("land spoken of  in legends"), the excess-whitespace smear.
          // Column + items-center stacks the boxes and keeps each one
          // shrink-wrapped and centred, which the per-line mb-0.5 was
          // already spacing for.
          <div key={i} className="text-center max-w-full flex flex-col items-center">
            {lines.map((line, j) => (
              <span
                key={j}
                className={`inline-block max-w-full bg-black/80 text-white font-medium leading-relaxed px-2 sm:px-3 py-0.5 mb-0.5 ${sizeClasses}`}
                style={{
                  textShadow:
                    "0 0 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,229,255,0.3)",
                  WebkitFontSmoothing: "antialiased",
                }}
              >
                {renderFormattedText(line)}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}