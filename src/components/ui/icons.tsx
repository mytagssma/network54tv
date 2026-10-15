import type { SVGProps } from "react";

/**
 * The icon library — every glyph whose path used to be copy-pasted between
 * `Player.tsx`, the `/design` specimens and the page chrome lives here once.
 *
 * House rules, so replacing an inline `<svg>` is always a no-op:
 *   - `viewBox="0 0 24 24"` + `currentColor` everywhere: an icon inherits the
 *     colour of the text around it and never paints a hard-coded hue.
 *   - NO size of its own. The call site keeps passing its own `className`
 *     (`w-6 h-6 sm:w-5 sm:h-5`, `h-3.5 w-3.5 shrink-0`, …), so hit boxes,
 *     responsive swaps and hover transitions are untouched.
 *   - `aria-hidden` defaults on (these are all decorative, and every host
 *     control already carries its own `aria-label` / text); props spread last,
 *     so a call site can override anything without forking the component.
 */
export type IconProps = SVGProps<SVGSVGElement>;

/** Filled glyph shell — `fill` is the only paint. */
function Fill({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

/** Outlined glyph shell — `stroke` paint, 2px by default (2.4px for the skip chip). */
function Stroke({ children, strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/* ── Player transport ─────────────────────────────────────────────────── */

export function PlayIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M8 5v14l11-7z" />
    </Fill>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
    </Fill>
  );
}

export function PrevTrackIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
    </Fill>
  );
}

export function NextTrackIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
    </Fill>
  );
}

/** Skip back 10s — the `<<` double-chevron (J's on-screen twin). */
export function Rewind10Icon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M20 18l-8.5-6L20 6v12zM11 6v12L2.5 12 11 6z" />
    </Fill>
  );
}

/** Skip forward 10s — the `>>` double-chevron (L's on-screen twin). */
export function Forward10Icon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
    </Fill>
  );
}

export function VolumeIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
    </Fill>
  );
}

export function VolumeMutedIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
    </Fill>
  );
}

export function FullscreenIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
    </Fill>
  );
}

/* ── ⋯ menu + pickers ─────────────────────────────────────────────────── */

/** The `⋯` overflow trigger. */
export function MoreIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M6 10a2 2 0 100 4 2 2 0 000-4zm6 0a2 2 0 100 4 2 2 0 000-4zm6 0a2 2 0 100 4 2 2 0 000-4z" />
    </Fill>
  );
}

/** The playback-rate lightning. The player's Speed control moved to the
 *  clock-like `SpeedIcon` — this glyph now only backs the /design specimen. */
export function BoltIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </Stroke>
  );
}

/** The tiny solid caret that says "this opens a list". */
export function CaretDownIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M7 10l5 5 5-5z" />
    </Fill>
  );
}

/* ── Control-row icon toolbar + ⋯ menu rows ──────────────────────────────
 * One glyph per option, imported by BOTH its icon-only row trigger and its
 * ⋯ menu row (PlayIcon / Forward10Icon / GlobeIcon are the pre-existing
 * three reused here: auto play, auto skip, provider). Everything below is
 * NEW so the row and the menu can't drift apart. Each glyph depicts its
 * actual domain — a clock for rate, a contrast circle for picture, a
 * waveform for sound — not a generic settings metaphor. */

/** Quality / resolution — ascending level bars (replaces the old hamburger). */
export function QualityIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M3 15h3v4H3zM8 11h3v8H8zM13 7h3v12h-3zM18 3h3v16h-3z" />
    </Fill>
  );
}

/** Playback speed — a plain clock face (rate = time per revolution). The
 *  stopwatch crown was tried and dropped: at the row's 16px it is noise. */
export function SpeedIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3.5 2" />
    </Stroke>
  );
}

/** Server — the two-tray rack, dots and all. */
export function ServerIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <rect x="3" y="4" width="18" height="7" />
      <rect x="3" y="13" width="18" height="7" />
      <circle cx="7" cy="7.5" r="1" />
      <circle cx="7" cy="16.5" r="1" />
    </Stroke>
  );
}

/** Subtitles — a caption box with two lines of text under it. */
export function SubtitleIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <rect x="3" y="5" width="18" height="14" />
      <path strokeLinecap="round" d="M6.5 11h5M6.5 15h11" />
    </Stroke>
  );
}

/** Video filter — the half-filled contrast circle: the universal display /
 *  picture-settings glyph. (Was a funnel — a data-filter metaphor from the
 *  wrong domain.) The filled half is drawn INSIDE the stroked ring: the
 *  Stroke shell paints the circle, one child paints the left half solid. */
export function VideoFilterIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <circle cx="12" cy="12" r="9" />
      <path fill="currentColor" stroke="none" d="M12 3a9 9 0 000 18z" />
    </Stroke>
  );
}

/** Audio filter — a waveform: bars of varying heights around a midline, the
 *  "processing what you hear" glyph. (Was mixer faders — a track-mixing
 *  metaphor.) Bars are 2px wide and IRREGULAR — deliberately not the
 *  monotonic baseline-ascent of QualityIcon, so the two bar-glyphs on the
 *  same row can't be confused: this one peaks and troughs around centre. */
export function AudioFilterIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M3 9h2v6H3zM7 6h2v12H7zM11 3h2v18h-2zM15 7h2v10h-2zM19 5h2v14h-2z" />
    </Fill>
  );
}

/* ── Chevrons / glyphs ────────────────────────────────────────────────── */

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 5l-7 7 7 7" />
    </Stroke>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </Stroke>
  );
}

/** The `»»` chip on Skip Intro / Skip Outro — 2.4px stroke, by design. */
export function SkipChevronIcon(props: IconProps) {
  return (
    <Stroke strokeWidth={2.4} {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 5l7 7-7 7M13 5l7 7-7 7" />
    </Stroke>
  );
}

/** Filled back-chevron used by the watch-page episode nav. */
export function ChevronLeftSolidIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
    </Fill>
  );
}

/** Filled hamburger used by the watch-page "All Episodes" action. */
export function MenuIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M3 5h18v2H3zM3 11h18v2H3zM3 17h18v2H3z" />
    </Fill>
  );
}

/** Dock — the watch page's layout toggle: the big panel is the player, the
 *  narrow lined rail beside it is the episode list. */
export function DockIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <rect x="3" y="4" width="18" height="16" />
      <path strokeLinecap="round" d="M14.5 4v16" />
      <path strokeLinecap="round" d="M16.5 8.5h2.5M16.5 12h2.5M16.5 15.5h2.5" />
    </Stroke>
  );
}

/** Filled forward-chevron (watch-page "next episode" + its /design replica). */
export function ChevronRightSolidIcon(props: IconProps) {
  return (
    <Fill {...props}>
      <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
    </Fill>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </Stroke>
  );
}

export function XIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </Stroke>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
      />
    </Stroke>
  );
}

/** Meridian globe — the search field's "browse everything" resting state. */
export function GlobeIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <circle cx="12" cy="12" r="9" />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 12h18"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"
      />
    </Stroke>
  );
}
