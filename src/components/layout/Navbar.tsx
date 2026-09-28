"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import AccentColorSelector from "@/components/ui/AccentColorSelector";

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
        <div className="flex items-center justify-between h-14">
          {/* Brand mark */}
          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              href="/"
              aria-label="n54tv"
              className="flex items-center p-1 -m-1 text-[var(--accent)] hover:accent-shadow-sm transition-shadow"
            >
              <N54Mark />
            </Link>
          </div>

          {/* Right side: accent selector + search */}
          <div className="flex items-center gap-2 sm:gap-3">
            <AccentColorSelector />

            <Link
              href="/browse"
              aria-label="Search"
              className="flex items-center justify-center h-9 w-9 rounded-none border border-[var(--accent)]/30 text-[var(--accent)] font-mono uppercase transition-colors hover:bg-[var(--accent)]/10 hover:border-[var(--accent)]/60 hover:accent-shadow-sm"
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
            </Link>
          </div>
        </div>
      </div>
    </nav>
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
