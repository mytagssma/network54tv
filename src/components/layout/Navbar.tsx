"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import AccentColorSelector from "@/components/ui/AccentColorSelector";

const PROVIDERS = [
  { id: "", label: "Auto" },
  { id: "anikoto", label: "Anikoto" },
  { id: "anizone", label: "Anizone" },
  { id: "allmanga", label: "AllManga" },
  { id: "anineko", label: "Anineko" },
  { id: "megaplay", label: "MegaPlay" },
  { id: "animeunity", label: "AnimeUnity" },
];

function getStoredProvider(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("n54tv-provider") || "";
}

export default function Navbar() {
  const pathname = usePathname();
  const isWatchPage = pathname?.includes("/watch/");
  const isAnimePage = pathname?.includes("/anime/");
  const [hidden, setHidden] = useState(false);
  const lastScrollRef = useRef(0);
  const [provider, setProviderState] = useState("");
  const [providerOpen, setProviderOpen] = useState(false);
  const providerMenuRef = useRef<HTMLDivElement>(null);

  // Hydrate provider from localStorage
  useEffect(() => {
    setProviderState(getStoredProvider());
  }, []);

  const setProvider = (id: string) => {
    setProviderState(id);
    localStorage.setItem("n54tv-provider", id);
    setProviderOpen(false);

    // Notify EpisodeListFetcher to re-fetch with new provider
    window.dispatchEvent(new CustomEvent("n54tv-provider-changed", { detail: id }));
  };

  // Close provider dropdown on outside click
  useEffect(() => {
    if (!providerOpen) return;
    const handler = (e: PointerEvent) => {
      if (providerMenuRef.current && !providerMenuRef.current.contains(e.target as Node)) {
        setProviderOpen(false);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [providerOpen]);

  // Close provider dropdown on Escape
  useEffect(() => {
    if (!providerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProviderOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [providerOpen]);

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

  const providerLabel = PROVIDERS.find((p) => p.id === provider)?.label || "Auto";

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

          {/* Right side: source selector + accent selector + search */}
          <div className="flex items-center gap-3">
            {/* Source dropdown */}
            <div ref={providerMenuRef} className="relative">
              <button
                onClick={() => setProviderOpen(!providerOpen)}
                className="flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--accent)] text-[11px] font-mono uppercase tracking-wider transition-colors border border-[var(--accent)]/20 px-2 py-1.5 sm:py-1 hover:border-[var(--accent)]/40 rounded-none min-h-[36px]"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
                </svg>
                {providerLabel}
                <svg className={`w-3 h-3 transition-transform ${providerOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {providerOpen && (
                <div className="absolute right-0 top-full mt-1 bg-[var(--panel)] border border-[var(--accent)]/30 min-w-[140px] z-50 rounded-none shadow-lg">
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setProvider(p.id)}
                      className={`w-full text-left px-3 py-2.5 sm:py-1.5 text-[11px] font-mono uppercase tracking-wider transition-colors rounded-none ${
                        provider === p.id
                          ? "bg-[var(--accent)]/20 text-[var(--accent)] border-l-2 border-[var(--accent)]"
                          : "text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <AccentColorSelector />
            <Link
              href="/"
              className="flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--accent)] text-xs font-medium uppercase tracking-wider transition-colors py-2"
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
