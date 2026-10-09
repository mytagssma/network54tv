"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import AccentColorSelector from "@/components/ui/AccentColorSelector";
import { dispatchClearSearch } from "@/hooks/useClearSearch";

export default function Navbar() {
  const pathname = usePathname();
  const isWatchPage = pathname?.includes("/watch/");
  const [hidden, setHidden] = useState(false);
  // Client-only: true while <html> itself is the fullscreen element (the player
  // anchors fullscreen to <html>, not to its own container). Server render and
  // the first client render both start `false`, so hydration matches and the
  // navbar is painted normally until the effect below reads the live state.
  const [fullscreenHidden, setFullscreenHidden] = useState(false);
  const lastScrollRef = useRef(0);

  // The player's fullscreen layer is `fixed z-[100]`, but it lives inside
  // <main>'s z-10 stacking context while this nav is a z-50 sibling above it —
  // so a visible nav always paints over fullscreen video. Drop out of the way
  // with the same -translate-y-full the scroll-hide already uses.
  useEffect(() => {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
    };
    // Both spellings, same as the player: prefixed-only builds read
    // `fullscreenElement` as undefined with no change event ever firing for it.
    const sync = () => {
      const el = doc.fullscreenElement || doc.webkitFullscreenElement || null;
      setFullscreenHidden(el === document.documentElement);
    };
    // Read immediately too: fullscreen may already be active before hydration
    // (or entered before this effect's listeners were attached).
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  useEffect(() => {
    if (!isWatchPage) {
      setHidden(false);
      return;
    }

    const onScroll = () => {
      const y = window.scrollY;
      const last = lastScrollRef.current;
      if (y > 60 && y > last + 5) {
        setHidden(true);
      } else if (y < last - 5) {
        setHidden(false);
      }
      lastScrollRef.current = y;
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isWatchPage]);

  // Scroll-hide OR html-level fullscreen. Fullscreen wins so a scroll event
  // firing mid-fullscreen can't flip the nav back over the video, and on exit
  // `fullscreenHidden` goes false so the scroll-derived state returns exactly
  // as it was.
  const isNavHidden = hidden || fullscreenHidden;

  return (
    <nav
      className={`sticky top-0 z-50 bg-[var(--panel)] border-b border-[var(--accent)]/30 rounded-none transition-transform duration-300 ${
        isNavHidden ? "-translate-y-full" : "translate-y-0"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4">
        {/* <sm: TWO stacked bands — row 1 = brand + the true-centered swatch
            band, row 2 = the always-visible search field (328px at a 360px
            viewport). The band therefore never lands on the input: it centers
            over row 1, where the only other thing is the logo (~85px clear).
            From sm up: the single h-14 row as always — the row-1 wrapper
            dissolves via display:contents and brand/field/band fall back into
            today's order through the sm:order-* utilities. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:h-14 sm:items-center sm:gap-4">
          {/* ROW 1 (<sm): brand at the left edge; the swatch band is pulled
              out of flow and TRUE-centered over THIS row — the wrapper is
              `relative` and spans the content box inside px-4, so its 50% is
              the viewport's 50% (same true-center as before, just anchored to
              row 1 instead of the whole header). ≥sm the wrapper generates no
              box, so brand and band become direct children of the single row. */}
          <div className="relative flex h-12 items-center sm:contents">
            {/* Brand mark */}
            <div className="flex shrink-0 items-center gap-2 sm:order-1 sm:gap-3">
              <Link
                href="/"
                aria-label="n54tv"
                className="flex items-center p-1 -m-1 text-[var(--accent)] hover:accent-shadow-sm transition-shadow"
              >
                <N54Mark />
              </Link>
            </div>

            {/* Accent selector. <sm: absolutely TRUE-centered over row 1 —
                the 114px band (6×14 + 5×6 gaps) clears the logo with ~85px to
                spare and the rest of row 1 is empty (the field lives on row
                2), so nothing can overlap. ≥sm: back into the single h-14
                row's flow, ordered last — the source position it has today.
                Width reserved either way so its mount-time appearance (it
                renders null until mounted) doesn't shove the field over. */}
            <div className="absolute left-1/2 top-1/2 flex min-w-[114px] -translate-x-1/2 -translate-y-1/2 shrink-0 items-center justify-end sm:static sm:order-3 sm:translate-x-0 sm:translate-y-0">
              <AccentColorSelector />
            </div>
          </div>

          {/* The site's one query field: always visible, on row 2 below sm
              and back in the single header row from sm up. Suspense is
              required: HeaderSearch reads useSearchParams, and prerendered
              pages must be able to bail out to the placeholder instead of
              failing the production build with "Missing Suspense boundary".
              The fallback mirrors the single wrapper div that HeaderSearch
              returns. */}
          <Suspense
            fallback={
              <div
                aria-hidden
                className="flex min-w-0 w-full items-center pb-2 sm:order-2 sm:w-auto sm:flex-1 sm:pb-0"
              >
                <div className="h-9 w-full max-w-xl border border-[var(--accent)]/45 bg-[var(--background)]" />
              </div>
            }
          >
            <HeaderSearch />
          </Suspense>
        </div>
      </div>
    </nav>
  );
}

/**
 * The site's single query field, ALWAYS VISIBLE in the header at every width
 * — row 2 of the mobile header (<sm; row 1 holds the brand and the
 * true-centered swatch band, which is why the two never overlap), and the
 * middle slot of the single h-14 row from sm up. There is no collapse, no
 * toggle and no dock: the trailing button's only job is submitting (an empty
 * field still routes to /browse through the unchanged submit rule).
 *
 * Sync model — the URL is the source of truth: `?q=` is echoed back into the
 * field on back/forward, internal links and browse's Clear (via the effect
 * below), while keystrokes stay local until Enter / the magnifier pushes
 * `/browse?q=…`. That makes the field and the URL agree without coupling the
 * header to any page's state: browse reads `q` straight from the URL, and its
 * Clear only has to push `/browse` for the field to empty itself.
 *
 * Reads `useSearchParams`, so it must sit inside a `<Suspense>` boundary:
 * prerendered pages fall back to the placeholder box instead of failing the
 * production build with "Missing Suspense with useSearchParams".
 */
function HeaderSearch() {
  const router = useRouter();
  const urlQ = useSearchParams().get("q") ?? "";
  const [draft, setDraft] = useState(urlQ);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = draft.trim();

  // URL → field. Deliberately one-directional: the effect only re-runs when
  // the URL's q changes, so typing is never clobbered mid-edit.
  useEffect(() => {
    setDraft(urlQ);
  }, [urlQ]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Empty field → the browse landing view, exactly what the old magnifier
    // link did.
    router.push(q ? `/browse?q=${encodeURIComponent(q)}` : "/browse");
  }

  // ✕ (only rendered while the field has text): empties the field right
  // away, then asks browse — if it's mounted — to run its full Clear
  // (reset filters/chips + push /browse, which keeps the field empty through
  // the URL). Off /browse there's no listener, so it stays a local clear.
  // Focus returns to the field since the button unmounts with the text.
  function handleClearField() {
    setDraft("");
    inputRef.current?.focus();
    dispatchClearSearch();
  }

  return (
    // ROW 2 on mobile: full width beneath the brand row (`pb-2` leaves a
    // little breathing room above the nav's bottom edge). From sm up: the
    // middle slot of the single h-14 row — ordered between brand and
    // swatches. The field itself never changes, only which row it sits on.
    <div className="flex min-w-0 w-full items-center pb-2 sm:order-2 sm:w-auto sm:flex-1 sm:pb-0">
      <form
        role="search"
        onSubmit={handleSubmit}
        className="flex min-w-0 w-full justify-center"
      >
        {/* One bordered control: field + optional ✕ + magnifier. `group` is
            what drives the ✕ reveal below (group-hover / group-focus-within);
            the frame itself — 1px 45%-accent edge (quiet, not the rejected
            2px), inset --background fill, hover lift, full-accent focus glow
            + tinted fill — comes from the hand-written .header-search rules
            in globals.css so it reads solid in every accent theme without
            thickness. Border/background utilities are deliberately absent:
            the unlayered rules own them. */}
        <div className="header-search group flex h-9 w-full max-w-xl min-w-0 items-center transition-all">
          <input
            ref={inputRef}
            type="search"
            name="q"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search anime..."
            aria-label="Search anime"
            enterKeyHint="search"
            className="h-full min-w-0 flex-1 appearance-none bg-transparent px-3 font-mono text-sm text-[var(--foreground)] placeholder:text-[var(--text-secondary)] focus:outline-none"
          />
          {/* Rendered only with text, VISIBLE only while the group is
              hovered or holds focus — otherwise it sits at opacity-0. Just
              the glyph: no border, no divider, no background (hover changes
              its color only). It stays tabbable the whole time: tabbing into
              the group fires group-focus-within (revealing it, pointer-events
              included) and Enter/Space on it still fires onClick — keyboard
              activation doesn't depend on pointer hit-testing, and
              focus-within restores pointer events anyway. Screen readers
              always see it (opacity never removes it from the tree). */}
          {draft.length > 0 && (
            <button
              type="button"
              onClick={handleClearField}
              aria-label="Clear search"
              className="flex h-full w-8 shrink-0 items-center justify-center text-[var(--accent)] opacity-0 transition-all group-hover:opacity-100 group-focus-within:opacity-100 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto hover:text-white"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
                aria-hidden="true"
                focusable="false"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          {/* Trailing button: ALWAYS the magnifier — submitting a search is
              its only purpose (empty still routes to /browse through the
              unchanged submit rule). Bare-glyph treatment, divider and
              background unchanged from the quiet-frame round. */}
          <button
            type="submit"
            aria-label="Search"
            className="flex h-full w-9 shrink-0 items-center justify-center border-l border-[var(--accent)]/50 text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
              aria-hidden="true"
              focusable="false"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Inline copy of public/favicon.svg — same N54 badge, but painted with the
 * theme vars so it tracks the user-selected accent color.
 */
function N54Mark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className="shrink-0"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" fill="var(--background)" />
      <g fill="var(--accent)">
        {/* N */}
        <rect x="2" y="6" width="3" height="20" />
        <polygon points="2,6 5,6 10,26 7,26" />
        <rect x="7" y="6" width="3" height="20" />
        {/* 5 */}
        <rect x="12" y="6" width="8" height="3" />
        <rect x="12" y="6" width="3" height="11" />
        <rect x="12" y="14" width="8" height="3" />
        <rect x="17" y="14" width="3" height="12" />
        <rect x="12" y="23" width="8" height="3" />
        {/* 4 */}
        <rect x="22" y="6" width="3" height="11" />
        <rect x="22" y="14" width="8" height="3" />
        <rect x="27" y="6" width="3" height="20" />
      </g>
    </svg>
  );
}
