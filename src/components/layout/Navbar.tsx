"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import AccentColorSelector from "@/components/ui/AccentColorSelector";

export default function Navbar() {
  const pathname = usePathname();
  const isWatchPage = pathname?.includes("/watch/");
  const [hidden, setHidden] = useState(false);
  const lastScrollRef = useRef(0);

  useEffect(() => {
    if (!isWatchPage) {
      setHidden(false);
      return;
    }

    const onScroll = () => {
      const y = window.scrollY;
      const last = lastScrollRef.current;
      // Hide when scrolling down past navbar height, show when scrolling up
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

  return (
    <nav
      className={`sticky top-0 z-50 bg-[var(--panel)] border-b border-[var(--accent)]/30 rounded-none transition-transform duration-300 ${
        hidden ? "-translate-y-full" : "translate-y-0"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between h-14">
          {/* Site name */}
          <Link
            href="/"
            className="text-[var(--accent)] font-bold text-lg tracking-wider uppercase hover:accent-shadow-sm transition-shadow"
            style={{ letterSpacing: "0.15em" }}
          >
            n54tv
          </Link>

          {/* Right side: accent selector + search */}
          <div className="flex items-center gap-4">
            <AccentColorSelector />
            <Link
              href="/"
              className="flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--accent)] text-xs font-medium uppercase tracking-wider transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              Search
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}
