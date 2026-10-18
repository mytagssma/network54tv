"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The anatomy every grid card on /browse and the home page shares:
 *
 *   Link (panel + 10% accent border + hover lift)
 *     ├─ 3:4 cover — either the 4-section diagonal pulse skeleton or the image
 *     │    └─ coverOverlay (optional absolute layer — e.g. the home feed's
 *     │       play strip; overlays, never flows, so baselines can't shift)
 *     └─ info column (p-3)
 *          ├─ fixed 2-line title slot
 *          ├─ genre chips (hidden while loading)
 *          ├─ **children** ← the card's own meta row (★/EP, format/Airs …)
 *          └─ meta skeleton (only while loading)
 *
 * `AnimeCard` and `UpcomingCard` are byte-identical from the `<Link>` down to
 * the meta row — only the image source, the link target and the contents of
 * the meta row differ, so all three are props here.
 */
interface CardShellProps {
  href: string;
  onClick?: () => void;
  /** Renders the diagonal pulse cover + meta skeleton instead of content. */
  loading?: boolean;
  image: string;
  alt: string;
  title: string;
  genres?: string[];
  /**
   * Absolute layer over the cover (the home feed's play strip). Optional —
   * browse/search cards pass nothing and render exactly as before. Because
   * it overlays the cover instead of flowing in the info column, the title /
   * genres / meta baselines and grid alignment cannot move; callers leave it
   * out while `loading` so it never rides the skeleton. The shell's Link is
   * the Tailwind `group` below, so the layer can light up with the card's
   * own hover via `group-hover:`.
   */
  coverOverlay?: ReactNode;
  /** The meta row. Rendered between the genre chips and the loading skeleton. */
  children?: ReactNode;
}

export default function CardShell({
  href,
  onClick,
  loading,
  image,
  alt,
  title,
  genres,
  coverOverlay,
  children,
}: CardShellProps) {
  return (
    <Link
      href={href}
      onClick={() => onClick?.()}
      className="group flex flex-col bg-[var(--panel)] border border-[var(--accent)]/10 overflow-hidden
                 transition-all duration-200 hover:border-[var(--accent)]/50 hover:-translate-y-0.5
                 rounded-none accent-card-hover"
    >
      {/* Cover image */}
      <div className="aspect-[3/4] shrink-0 relative overflow-hidden bg-[var(--background)] rounded-none">
        {loading ? (
          <>
            {/* Diagonal 4-part pulse loading overlay */}
            <div className="absolute inset-0 z-10 pointer-events-none">
              {/* Top triangle */}
              <div
                className="diagonal-pulse-section absolute inset-0"
                style={{ clipPath: "polygon(0 0, 100% 0, 50% 50%)" }}
              />
              {/* Right triangle */}
              <div
                className="diagonal-pulse-section absolute inset-0"
                style={{ clipPath: "polygon(100% 0, 100% 100%, 50% 50%)" }}
              />
              {/* Bottom triangle */}
              <div
                className="diagonal-pulse-section absolute inset-0"
                style={{ clipPath: "polygon(0 100%, 100% 100%, 50% 50%)" }}
              />
              {/* Left triangle */}
              <div
                className="diagonal-pulse-section absolute inset-0"
                style={{ clipPath: "polygon(0 0, 0 100%, 50% 50%)" }}
              />
            </div>
            {/* Dimmed placeholder behind the pulse */}
            <div className="absolute inset-0 bg-[var(--panel)]" />
          </>
        ) : (
          // Same loader in every card: AniList CDN covers are used as-is
          // (next/image would need remotePatterns config + a loader change).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={alt}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        )}

        {/* Optional absolute layer (the home play strip) — overlays the
            cover, so the info column's baseline math is untouched */}
        {coverOverlay}
      </div>

      {/* Info — flex column so the meta row can pin to the card bottom; every
          card in a row then shares the same title / genres / meta baselines */}
      <div className="flex flex-1 flex-col p-3">
        {/* Fixed 2-line slot (line-clamp-2 + leading-tight = 17.5px/line) so
            1-line and 2-line titles push the rows below them the same way */}
        <h3 className="min-h-[2.5em] text-sm font-bold text-white line-clamp-2 leading-tight uppercase tracking-wider">
          {loading ? "\u00A0" : title}
        </h3>

        {!loading && genres && genres.length > 0 && (
          <div className="mt-1.5 mb-1.5 flex flex-wrap gap-1">
            {genres.slice(0, 3).map((genre) => (
              <span
                key={genre}
                className="text-[10px] px-1.5 py-0.5 bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20 rounded-none"
              >
                {genre}
              </span>
            ))}
          </div>
        )}

        {children}

        {loading && (
          <div className="mt-auto flex flex-col gap-1 pt-1">
            <div className="flex gap-1">
              <div className="h-2.5 w-12 bg-[var(--accent)]/10 rounded-none animate-pulse" />
              <div className="h-2.5 w-8 bg-[var(--accent)]/10 rounded-none animate-pulse" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="h-2.5 w-7 bg-[var(--accent)]/10 rounded-none animate-pulse" />
              <div className="h-2.5 w-9 bg-[var(--accent)]/10 rounded-none animate-pulse" />
            </div>
          </div>
        )}
      </div>
    </Link>
  );
}
