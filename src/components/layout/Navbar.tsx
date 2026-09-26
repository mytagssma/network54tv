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

          {/* Right side: accent selector */}
          <div className="flex items-center gap-2 sm:gap-3">
            <AccentColorSelector />
          </div>
        </div>
      </div>
    </nav>
  );
}
