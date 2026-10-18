"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The anatomy every grid card on /browse and the home page shares:
 *
 *   div.card (panel + 10% accent border + hover lift; the Tailwind `group`
 *   every group-hover: state below hangs off)
 *     ├─ 3:4 cover — either the 4-section diagonal pulse skeleton or the image
 *     │    └─ coverOverlay (optional absolute layer — e.g. the home feed's
 *     │       play strip; overlays, never flows, so baselines can't shift).
 *     │       When the layer carries its own navigation target it renders as
 *     │       a SIBLING of the detail link, never inside it, at `z-10` so it
 *     │       stays clickable above the stretched ::after.
 *     └─ info column (p-3)
 *          ├─ fixed 2-line title slot — the title <a> IS the card's detail
 *          │    link, used as a "stretched link": its absolute ::after covers
 *          │    the whole card, so every click/Enter outside coverOverlay
 *          │    opens `href` (cursor and all)
 *          ├─ genre chips (hidden while loading)
 *          ├─ **children** ← the card's own meta row (★/EP, format/Airs …)
 *          └─ meta skeleton (only while loading)
 *
 * Why the card is not one big <a>: HTML forbids <a> inside <a> (and
 * <button> inside <a>), so a coverOverlay with its own link target — the
 * home feed's play strip → /anime/{id}/watch/{n} — cannot live inside a
 * card-wide anchor; React/Next flag that nesting as a hydration error. The
 * stretched-link pattern restores the same behavior without nesting: the
 * strip anchor (z-10) and this title link's ::after (z-auto) are siblings in
 * paint order, so clicks on the strip hit the strip's /watch/{n} and clicks
 * anywhere else hit the detail link — structurally, no stopPropagation
 * required. Both stay real anchors, so modifier-clicks and "open in new tab"
 * work natively on each. The focus ring keeps its old look too: the global
 * a:focus-visible rule in globals.css is unlayered (it beats Tailwind
 * utilities), so the title link opts out with `outline-none!` and redraws
 * the identical 1px accent/70 outline on its ::after — i.e. around the whole
 * card, exactly where it used to land when the card itself was the link.
 *
 * `AnimeCard` and `UpcomingCard` are byte-identical from the title link down
 * to the meta row — only the image source, the link target and the contents
 * of the meta row differ, so all three are props here.
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
   * out while `loading` so it never rides the skeleton. The card div below is
   * the Tailwind `group`, so the layer can light up with the card's own
   * hover via `group-hover:`. Any link inside the layer is a SIBLING of the
   * detail link (never nested in it — see the anatomy note above) — give it
   * `z-10` so it stays clickable above the stretched ::after.
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
    // A plain div, not a link: the detail navigation hangs off the title's
    // stretched link below, so a linked coverOverlay can sit beside it.
    // No overflow-hidden here on purpose — it would clip the stretched
    // ::after's focus outline (a descendant's outline IS clipped by an
    // ancestor's overflow); the cover div below already clips the image.
    <div
      className="group relative flex flex-col bg-[var(--panel)] border border-[var(--accent)]/10
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
            cover, so the info column's baseline math is untouched. It paints
            at z-10, above the title link's stretched ::after (z-auto), so its
            own /watch link wins the click wherever it sits. */}
        {coverOverlay}
      </div>

      {/* Info — flex column so the meta row can pin to the card bottom; every
          card in a row then shares the same title / genres / meta baselines */}
      <div className="flex flex-1 flex-col p-3">
        {/* Fixed 2-line slot (line-clamp-2 + leading-tight = 17.5px/line) so
            1-line and 2-line titles push the rows below them the same way.
            The stretched detail link hangs off the title: `after:inset-0`
            paints its ::after over the whole card div (its positioned
            ancestor), making every part of the card — cover, genres, meta —
            open `href` without a wrapping <a> that would illegal-nest any
            linked coverOverlay. */}
        <h3 className="min-h-[2.5em] text-sm font-bold text-white line-clamp-2 leading-tight uppercase tracking-wider">
          <Link
            href={href}
            onClick={() => onClick?.()}
            className="after:absolute after:inset-0 after:content-['']
                       focus-visible:outline-none!
                       focus-visible:after:outline focus-visible:after:outline-1
                       focus-visible:after:outline-offset-2
                       focus-visible:after:outline-[color-mix(in_srgb,var(--accent)_70%,transparent)]"
          >
            {loading ? "\u00A0" : title}
          </Link>
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
    </div>
  );
}
