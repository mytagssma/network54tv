"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { decode } from "html-entities";

interface ExpandableDescriptionProps {
  description: string;
  maxLines?: number;
}

/* ── Text prep ────────────────────────────────────────────────────────────
   AniList descriptions arrive as a sliver of HTML (`<br>`, `<i>`, `<b>`,
   character entities). Convert to plain text before it ever reaches the DOM:
   raw tags must never render, entities must not show up as `&#x27;`. */

/** Length at which the upstream mapper hard-cuts the synopsis. */
const SOURCE_CUT_LENGTH = 300;
/** Ends with sentence punctuation (plus optional closing quotes/brackets). */
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

function toPlainText(raw: string): string {
  if (!raw) return "";
  const withBreaks = raw
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(?:p|div|li|h[1-6])\s*>/gi, "\n");
  const withoutTags = withBreaks.replace(/<[^>]*>/g, "");
  return (
    decode(withoutTags)
      .replace(/\r\n?/g, "\n")
      // collapse runs of spaces/tabs (but keep paragraph breaks)
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** True when the text was cut mid-word by the upstream 300-char cap. */
function looksCutOff(text: string): boolean {
  return text.length >= SOURCE_CUT_LENGTH && !SENTENCE_END.test(text);
}

/* ── Measurement ──────────────────────────────────────────────────────────
   The old approach measured a detached probe appended to `document.body`
   with `width: 100%` — i.e. the *viewport* width, not the synopsis column —
   so it counted ~130 chars/line while the real layout wraps at ~75 and
   `isLong` never flipped. Everything below measures a mirror cloned from the
   real element's computed styles at the real element's content width. */

/** Computed `line-height` as CSS pixels (`normal` → null). */
function lineHeightInPx(cs: CSSStyleDeclaration): number | null {
  const raw = cs.lineHeight.trim();
  if (!raw || raw === "normal") return null;
  const value = parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (raw.endsWith("px")) return value;
  const fontSize = parseFloat(cs.fontSize) || 16;
  if (raw.endsWith("em")) return value * fontSize;
  if (raw.endsWith("rem")) {
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return value * root;
  }
  // unitless multiplier (`line-height: 1.625`)
  return /[a-z%]/i.test(raw) ? null : value * fontSize;
}

/** How many lines `text` takes at the element's real width and typography. */
function measureLineCount(el: HTMLElement, text: string): number | null {
  const width = el.clientWidth;
  if (!width) return null; // not laid out yet (hidden ancestor)

  const cs = getComputedStyle(el);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  Object.assign(mirror.style, {
    position: "absolute",
    left: "0",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    boxSizing: "border-box",
    margin: "0",
    width: `${width}px`,
    padding: cs.padding,
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontStyle: cs.fontStyle,
    fontWeight: cs.fontWeight,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    wordSpacing: cs.wordSpacing,
    textTransform: cs.textTransform,
    textIndent: cs.textIndent,
    whiteSpace: cs.whiteSpace,
    overflowWrap: cs.overflowWrap,
    wordBreak: cs.wordBreak,
  });
  mirror.textContent = text;
  document.body.appendChild(mirror);

  let lines: number;
  const lineHeight = lineHeightInPx(cs);
  if (lineHeight) {
    lines = Math.max(1, Math.round(mirror.getBoundingClientRect().height / lineHeight));
  } else {
    const range = document.createRange();
    range.selectNodeContents(mirror);
    lines = Math.max(1, range.getClientRects().length);
  }
  mirror.remove();
  return lines;
}

export default function ExpandableDescription({ description, maxLines = 3 }: ExpandableDescriptionProps) {
  const text = toPlainText(description);
  const cutOff = looksCutOff(text);
  /** Display copy: an upstream mid-word cut always gets an explicit ellipsis. */
  const displayText = cutOff ? `${text}…` : text;

  const [open, setOpen] = useState(false);
  /**
   * `null` until the first measurement — SSR and no-JS start *clamped*, so the
   * preview can never render unbounded (and affordance-less) before we know.
   */
  const [isLong, setIsLong] = useState<boolean | null>(null);
  const titleId = useId();
  const previewRef = useRef<HTMLParagraphElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Measure the element that is actually on screen, and re-measure whenever
  // its width changes (grid/viewport) or the webfont finishes loading.
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;

    const measure = () => {
      const lines = measureLineCount(el, displayText);
      if (lines === null) return;
      setIsLong(lines > maxLines);
    };

    measure();

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    document.fonts?.ready.then(measure).catch(() => {});

    return () => observer?.disconnect();
  }, [displayText, maxLines]);

  // Modal: lock body scroll, Escape to close, focus management
  useEffect(() => {
    if (!open) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    closeRef.current?.focus();

    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKeyDown);
      // Return focus to the trigger that opened the dialog
      triggerRef.current?.focus();
    };
  }, [open]);

  if (!displayText) return null;

  // Clamped until measurement proves the copy fits (or stays clamped).
  const clamp = isLong !== false;
  const showControl = clamp || cutOff || open;

  const clampStyle: CSSProperties | undefined = clamp
    ? {
        display: "-webkit-box",
        WebkitBoxOrient: "vertical",
        WebkitLineClamp: maxLines,
        overflow: "hidden",
      }
    : undefined;

  return (
    <>
      <div className="text-[#9a9aa0] leading-relaxed">
        <p ref={previewRef} className="whitespace-pre-line" style={clampStyle}>
          {displayText}
        </p>
        {showControl && (
          <button
            ref={triggerRef}
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            className="mt-2 inline-block py-1 text-xs font-mono text-[var(--accent)]/70 hover:text-[var(--accent)] uppercase tracking-wider transition-colors"
          >
            <span aria-hidden="true">[+] </span>Read More
          </button>
        )}
      </div>

      {open &&
        createPortal(
          // Backdrop = this element; click only closes when the press starts on it
          <div
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false);
            }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-fadeIn"
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-none border border-[var(--accent)]/40 bg-[var(--panel)] shadow-[0_0_48px_rgba(0,0,0,0.7)] animate-fadeIn"
            >
              {/* Header */}
              <div className="flex shrink-0 items-center justify-between border-b border-[var(--accent)]/20 px-5 py-3">
                <h3
                  id={titleId}
                  className="font-mono text-sm uppercase tracking-wider text-[var(--accent)]"
                >
                  // Synopsis
                </h3>
                <button
                  ref={closeRef}
                  onClick={() => setOpen(false)}
                  aria-label="Close synopsis"
                  className="ml-4 flex h-7 w-7 items-center justify-center rounded-none border border-[var(--accent)]/30 text-xs text-[var(--accent)]/70 transition-colors hover:border-[var(--accent)]/70 hover:text-[var(--accent)]"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </div>

              {/* Full description — its own scroll area */}
              <div className="max-h-[70vh] overflow-y-auto overscroll-contain px-5 py-4 text-[15px] leading-relaxed whitespace-pre-line text-[#9a9aa0]">
                {displayText}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
