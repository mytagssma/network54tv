"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ComponentProps } from "react";
import type { Episode } from "@/types/anime";
import Player from "@/components/player/Player";
import EpisodeBrowser from "./EpisodeBrowser";
import { EpisodePanelHeader, DEFAULT_PAGE_SIZE } from "./EpisodeSelector";
import { DockIcon } from "@/components/ui/icons";
import { buttonClass } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

/**
 * Watch-page player + episode-panel composition with a dock toggle.
 *
 * The player sits at the top in both modes; the episode panel either flows
 * BELOW the page's middle band (default — exactly the pre-dock layout) or
 * docks as a playlist RAIL beside the player (lg+ only).
 *
 * Layout matrix:
 *   - undocked (default): the player keeps its `-mx-4` bleed; the panel
 *     renders below the children band (FranchiseStrip) at its historical
 *     `mt-8` position, with its own header row (title · count · pager ·
 *     toggle) inside.
 *   - docked, lg+: a flex row — player column (`flex-1 min-w-0`; the bleed
 *     is dropped at lg+ so both columns share the page column's optical
 *     line, and returns below lg for narrow parity) + the rail
 *     (`w-80 xl:w-96`). The panel's whole HEADER row moves UP into the
 *     page-title band (right of the h1, above the player's top edge), and
 *     the rail holds only the list panel, pinned to the player's measured
 *     height (ResizeObserver on the player column — the player is
 *     aspect-video, so height follows width) with `overscroll-contain`
 *     internal scrolling. The below-position panel gets `lg:hidden`, so
 *     exactly one instance is visible; both stay mounted, and the hidden
 *     one is inert (a display:none rect makes the reveal effect's
 *     on-screen gate fail).
 *   - below lg: ALWAYS the stacked layout regardless of the preference —
 *     every dock class is `lg:`-gated, and the toggle button itself is
 *     `hidden lg:grid` (docking doesn't exist there, so the control
 *     shouldn't either).
 *   - Sticky player, TWO PHASES (below lg, PORTRAIT only):
 *     Phase 1 — the player row sticks under the navbar as the page scrolls
 *     (`top-[var(--n54-nav-h,48px)]` — Navbar publishes its live visible
 *     height there; 0 while the nav auto-hides, growing with the revealed
 *     search row). z-10 = above page content, below the nav's z-50; the
 *     ancestor chain carries no overflow/transform, so the player's own
 *     popovers/drawer still escape the frame.
 *     Phase 2 — the moment the row becomes STUCK, the sections band
 *     (FranchiseStrip + episodes panel, wrapped in one div below) becomes a
 *     BOUNDED SCROLLER: `overflow-y-auto overscroll-contain` at
 *     `calc(100dvh - var(--n54-nav-h, 48px) - <playerH>px)` (a vh value is
 *     written first as the fallback; engines without dvh ignore the second
 *     write). Nothing ever passes under the player: the page bottoms out at
 *     exactly the pin point and further swipes scroll the sections area
 *     internally. Handback: scroll the bounded area back to its top edge —
 *     or drag down from it — and it unpins; the sections return to flow at
 *     the identical pixel position and the page (and player) descend
 *     naturally. Pin detection: a passive window-scroll check of the row's
 *     stuck-ness against `navH + playerH` (read live from the CSS var — no
 *     sentinel needed, and the flip lands the bounded box's top exactly on
 *     the player's bottom edge, so the phase change is pixel-continuous);
 *     release uses an 8px hysteresis + a 200ms settle guard so it cannot
 *     flap.
 *     Landscape is OUTSIDE the whole mechanism (phones play video there
 *     edge-to-edge — a pinned sliver is the wrong shape): the row carries
 *     `landscape:static landscape:z-auto landscape:transition-none`
 *     alongside `lg:static`, so below lg in landscape the player is a
 *     plain in-flow box the page scrolls over like any embed — no pin, no
 *     bounded area, no locked sections. The pin effect gates JS the same
 *     way: an explicit `(orientation: portrait)` media-query check inside
 *     the evaluate gate, re-run on resize AND on the query's own change
 *     event, so a rotation mid-pin unpins IMMEDIATELY in either direction
 *     (the effect re-run detaches the inner listeners; the height effect
 *     clears the bounded box's inline height) — a rotate never needs a
 *     reload. The bounded area is additionally skipped when even a
 *     portrait viewport can't host it (< 240px left below the player —
 *     split-screen / short windows keep the plain sticky instead of a
 *     sliver of a scroller) and torn down at lg+. All listeners passive,
 *     no preventDefault; a frozen page emits no scroll events, so the flip
 *     can't fight the nav's scroll-hide, and the row's `transition-[top]`
 *     easing is untouched. `lg:static` on the row keeps the lg+ dock
 *     byte-for-byte as before.
 *
 * The pager is ONE shared state (see the render-phase follow-sync below):
 * the band header and both panel positions page together.
 *
 * Persistence: a global (not per-anime) preference under
 * `n54tv-watch-dock`. SSR always renders undocked; the saved value is
 * applied in a mount effect only — the hydration-safe read pattern the
 * Player's prefs code uses (nothing reads storage during render).
 */

const DOCK_KEY = "n54tv-watch-dock";

// ── Two-phase sticky constants (below lg, portrait only) ──────────────
// Don't enter the bounded phase unless this many pixels remain below the
// pinned player — even in PORTRAIT, a viewport too short for a usable
// scroller (split-screen, small windows) keeps the plain sticky instead of
// a sliver of a scroller. Landscape never gets here: orientation is gated
// earlier, in the effect below and by the row's landscape:static.
const MIN_PINNED_SECTIONS = 240;
// Release hysteresis: pin at row.bottom ≤ line + 1, release only past
// + 8 — a 1px sub-pixel jitter at the boundary must not flap the phase.
const RELEASE_SLACK_PX = 8;
// Settle guard: ignore unpin triggers for this long after pinning (guards
// against synthetic scroll events firing as the layout reflows).
const SETTLE_MS = 200;
// Finger-down travel (px) on the bounded area's top edge that counts as
// an explicit "take me back" drag.
const TOUCH_UNPIN_PX = 30;

// The Navbar's published visible height, read live: "" (no var set yet)
// falls back to the sticky row's own CSS fallback, 48px. Module scope —
// it captures nothing reactive, so effects can call it freely.
const readNavH = () => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--n54-nav-h");
  if (raw === "") return 48;
  const v = parseFloat(raw);
  return Number.isNaN(v) ? 48 : v;
};

type PlayerProps = ComponentProps<typeof Player>;

interface WatchDockProps extends Omit<PlayerProps, "episodes" | "anilistId"> {
  /** Required here (unlike Player's optional prop): the episode links need it. */
  anilistId: number;
  /** The page's h1 — rendered above the player; the docked header joins it. */
  title: ReactNode;
  /** The full raw run — feeds the episodes panel (sorted inside the browser). */
  episodes: Episode[];
  /** The drawer list page.tsx already maps — Player's own `episodes` prop. */
  drawerEpisodes: PlayerProps["episodes"];
  /** The page band between the player and the panel (FranchiseStrip). */
  children?: ReactNode;
}

/** Square pager-styled toggle; the pressed paint mirrors the "on" language
 *  of the player's other toggles (accent border + accent wash). Hidden
 *  below lg — docking is a lg+ layout, so the control is too. */
function DockToggle({
  docked,
  onToggle,
}: {
  docked: boolean;
  onToggle: () => void;
}) {
  const label = docked ? "Undock episodes" : "Dock episodes";
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-pressed={docked}
      className={cn(
        buttonClass("pager"),
        "hidden lg:grid",
        docked && "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/15"
      )}
    >
      <DockIcon className="h-4 w-4" />
    </button>
  );
}

export default function WatchDock({
  animeTitle,
  episodeNumber,
  anilistId,
  malId,
  nextEpisodeNumber,
  providerId,
  providerQuery,
  franchise,
  episodeHasDub,
  title,
  episodes,
  drawerEpisodes,
  children,
}: WatchDockProps) {
  const [docked, setDocked] = useState(false);

  // Hydration-safe restore: SSR must render the DEFAULT (undocked) layout,
  // so the saved preference is applied only after mount. Nothing reads
  // storage during render — a private-mode failure just stays undocked.
  // (setState here is the React-documented storage-hydration pattern; the
  // value isn't derivable during render, so the rule's cascade concern
  // doesn't apply — same read-in-effect shape as Player's prefs code.)
  useEffect(() => {
    try {
      if (localStorage.getItem(DOCK_KEY) === "1") {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDocked(true);
      }
    } catch {
      // private mode / disabled storage — keep the default
    }
  }, []);

  const toggleDock = () => {
    const next = !docked;
    setDocked(next);
    try {
      localStorage.setItem(DOCK_KEY, next ? "1" : "0");
    } catch {
      // a storage write must never break the page — just don't persist
    }
  };

  const toggle = <DockToggle docked={docked} onToggle={toggleDock} />;

  // Sorted once: the band header's range readout slices this run, and the
  // browsers receive it (their own sort is then a no-op).
  const sorted = useMemo(
    () => [...episodes].sort((a, b) => a.number - b.number),
    [episodes]
  );

  // ONE shared pager for the band header and both panel positions.
  const [page, setPage] = useState(() => {
    const idx = episodes.findIndex((ep) => ep.number === episodeNumber);
    return idx >= 0 ? Math.floor(idx / DEFAULT_PAGE_SIZE) : 0;
  });
  const pageCount = Math.ceil(episodes.length / DEFAULT_PAGE_SIZE);
  const currentPage = pageCount === 0 ? 0 : Math.min(Math.max(page, 0), pageCount - 1);

  // Follow the watched episode across client-side navigations (moved here
  // from EpisodeSelector when the pager became shared). Adjusted during
  // render (React's "adjust state when props change" pattern) rather than
  // in an effect: the page flips in the same render pass, so the reveal
  // effect inside the panel already runs against the correct page.
  const [syncKey, setSyncKey] = useState({ episodeNumber, episodes });
  if (syncKey.episodeNumber !== episodeNumber || syncKey.episodes !== episodes) {
    setSyncKey({ episodeNumber, episodes });
    const idx = episodes.findIndex((ep) => ep.number === episodeNumber);
    if (idx >= 0) setPage(Math.floor(idx / DEFAULT_PAGE_SIZE));
  }

  // The docked rail matches the player's rendered height EXACTLY (top and
  // bottom flush): the player is aspect-video, so its height follows its
  // width — measured with a ResizeObserver on the player column (same
  // fit-measure pattern as Player's row-fit effect). The measurement is
  // always on (one element, cheap), so the height is already known the
  // moment the dock flips — no tall-then-snap frame.
  const playerRef = useRef<HTMLDivElement>(null);
  const [playerH, setPlayerH] = useState(0);
  useEffect(() => {
    const el = playerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      // Equality-guarded: sub-pixel resize noise must not re-render.
      setPlayerH((prev) => (Math.abs(prev - h) >= 1 ? h : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Two-phase sticky (below lg, portrait only) ──────────────────────
  // Phase 1 = plain sticky page scroll (no JS — and CSS-side portrait
  // only: the row's landscape:static drops it in landscape). Phase 2 =
  // `pinned`: the sections band scrolls inside a viewport-bounded area
  // under the stuck player. See the doc comment's two-phase bullet for the
  // full model.
  const rowRef = useRef<HTMLDivElement>(null);
  const sectionsRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  const pinnedAtRef = useRef(0);

  useEffect(() => {
    if (playerH <= 0) return; // no measurement yet — nothing to pin against
    const isWide = () => window.matchMedia("(min-width: 1024px)").matches;
    // Sticky is PORTRAIT-only below lg (landscape plays as a plain in-flow
    // player — the row's landscape:static owns the CSS side). This SAME
    // media object feeds both the evaluate gate and its change event, so a
    // rotation unpins immediately — in EITHER direction — even before any
    // scroll or resize event has a chance to fire.
    const portraitMq = window.matchMedia("(orientation: portrait)");

    // Window scroll: phase detection (row stuck?) + release hysteresis +
    // resize re-evaluation (rotation, lg crossing). Passive, no
    // preventDefault — the page keeps its native scroll in phase 1.
    const evaluate = () => {
      if (isWide()) {
        setPinned(false); // lg+ hands everything to the dock layout
        return;
      }
      if (!portraitMq.matches) {
        // Landscape below lg: never pin — and UNPIN right now if we were
        // (rotation mid-pin lands in a correct state without a reload:
        // the effect re-run below detaches the inner scroll/touch
        // listeners, and the height effect clears the bounded box's
        // inline height, dropping the sections back into plain flow).
        setPinned(false);
        return;
      }
      const row = rowRef.current;
      if (!row) return;
      const line = readNavH() + playerH;
      const bottom = row.getBoundingClientRect().bottom;
      // Portrait-only secondary guard: if even a portrait viewport can't
      // host the bounded area (split-screen, short windows), keep the
      // plain sticky instead of a sliver of a scroller.
      const canHost = window.innerHeight - line >= MIN_PINNED_SECTIONS;
      if (pinned) {
        // Release when the row came unstuck (page scrolled back above the
        // pin point) or the viewport narrowed past hosting (split-screen)
        // — with slack so boundary jitter can't flap.
        if (bottom > line + RELEASE_SLACK_PX || !canHost) setPinned(false);
      } else if (bottom <= line + 1 && canHost) {
        pinnedAtRef.current = Date.now();
        setPinned(true);
      }
    };

    // Bounded-area scroll: handback — scrolling the area back to its top
    // edge unpins (the sections rejoin flow at the identical pixel and the
    // page takes over on the next swipe). scrollTop can be fractional on
    // hi-dpi, hence < 1.
    const onInnerScroll = () => {
      const el = sectionsRef.current;
      if (!el || !pinned) return;
      if (Date.now() - pinnedAtRef.current < SETTLE_MS) return;
      if (el.scrollTop < 1) setPinned(false);
    };

    // Bounded-area touch: a finger-DOWN drag from the top edge unpins —
    // covers the zero-overflow case (short list) where the area never
    // emits scroll events, and makes the back-out gesture feel immediate.
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      const el = sectionsRef.current;
      if (!el || !pinned) return;
      if (el.scrollTop > 0) return;
      if (e.touches[0].clientY - touchY < TOUCH_UNPIN_PX) return;
      if (Date.now() - pinnedAtRef.current < SETTLE_MS) return;
      setPinned(false);
    };
    const onTouchEnd = () => {
      touchY = 0;
    };

    const sections = pinned ? sectionsRef.current : null;
    window.addEventListener("scroll", evaluate, { passive: true });
    window.addEventListener("resize", evaluate, { passive: true });
    portraitMq.addEventListener("change", evaluate);
    sections?.addEventListener("scroll", onInnerScroll, { passive: true });
    sections?.addEventListener("touchstart", onTouchStart, { passive: true });
    sections?.addEventListener("touchmove", onTouchMove, { passive: true });
    sections?.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("scroll", evaluate);
      window.removeEventListener("resize", evaluate);
      portraitMq.removeEventListener("change", evaluate);
      sections?.removeEventListener("scroll", onInnerScroll);
      sections?.removeEventListener("touchstart", onTouchStart);
      sections?.removeEventListener("touchmove", onTouchMove);
      sections?.removeEventListener("touchend", onTouchEnd);
    };
  }, [pinned, playerH]);

  // Bounded-area height, written via CSSOM so the fallback ordering is
  // exact: vh first — engines without dvh support reject the second write
  // and keep it — then dvh. Both are calc()s off the SAME --n54-nav-h
  // contract the sticky row uses, with the measured playerH, so the area
  // tracks nav hide/show and the revealed search row live. Cleared back to
  // natural height whenever unpinned (phase 1 / landscape / lg+) — which
  // includes the rotation-unpin path: `pinned` flips false and this
  // effect drops the inline height on the same commit.
  useEffect(() => {
    const el = sectionsRef.current;
    if (!el) return;
    if (!pinned || playerH <= 0) {
      el.style.height = "";
      return;
    }
    el.style.height = `calc(100vh - var(--n54-nav-h, 48px) - ${playerH}px)`;
    el.style.height = `calc(100dvh - var(--n54-nav-h, 48px) - ${playerH}px)`;
  }, [pinned, playerH]);

  return (
    // Root = the sticky context: it spans band → player → FranchiseStrip →
    // episodes, giving the sticky row its travel room (the player releases
    // exactly when this section scrolls past).
    <div>
      {/* Title band — the h1 by default; docked (lg+) the panel header row
          joins it on the right, above the player's top edge. The h1's own
          `mb-4` still sets the gap below the band. */}
      <div className={docked ? "lg:flex lg:items-start lg:justify-between lg:gap-4" : ""}>
        {title}
        {docked && (
          <div className="hidden shrink-0 lg:block">
            <EpisodePanelHeader
              heading="// Episodes"
              episodes={sorted}
              pageSize={DEFAULT_PAGE_SIZE}
              pageCount={pageCount}
              currentPage={currentPage}
              onPageChange={setPage}
              headerExtra={toggle}
            />
          </div>
        )}
      </div>

      {/* Player row — a flex row only while docked (lg+); a bare wrapper
          around the player in the undocked stack. Below lg in PORTRAIT
          it's the sticky player: pins under the navbar (offset from
          --n54-nav-h, which Navbar keeps honest for hide/show/search-
          reveal), z-10 over the scrolling sections beneath. Landscape below
          lg is OUTSIDE the mechanism — `landscape:static landscape:z-auto
          landscape:transition-none` turns it into a plain in-flow player
          the page scrolls over like any embed (the two-phase effect gates
          JS by the same orientation check), and `lg:static` keeps the
          docked row at lg+ byte-for-byte as before. `transition-[top]`
          matches the nav's own 300ms hide/show easing (motion-reduced:
          instant; landscape:transition-none — a static box has nothing to
          ease). */}
      <div
        ref={rowRef}
        className={cn(
          "sticky top-[var(--n54-nav-h,48px)] z-10 transition-[top] duration-300 ease-out motion-reduce:transition-none landscape:static landscape:z-auto landscape:transition-none lg:static lg:z-auto",
          docked && "flex flex-col lg:flex-row lg:items-start lg:gap-4"
        )}
      >
        {/* `-mx-4` bleed below lg in BOTH modes (narrow parity); at lg+ the
            docked column drops it so player and rail sit on one page-column
            line — a bleeding player against an inset rail reads lopsided. */}
        <div ref={playerRef} className={docked ? "-mx-4 flex-1 min-w-0 lg:mx-0" : "-mx-4"}>
          <Player
            animeTitle={animeTitle}
            episodeNumber={episodeNumber}
            anilistId={anilistId}
            malId={malId}
            nextEpisodeNumber={nextEpisodeNumber}
            providerId={providerId}
            providerQuery={providerQuery}
            episodes={drawerEpisodes}
            franchise={franchise}
            episodeHasDub={episodeHasDub}
          />
        </div>
        {docked && episodes.length > 0 && (
          // Height pinned to the player's measured height, so the panel's
          // top and bottom edges sit flush with the player's. `0`/unset =
          // pre-measure fallback: natural height for the first frame.
          <aside
            className="hidden w-80 shrink-0 lg:block xl:w-96"
            style={playerH > 0 ? { height: playerH } : undefined}
          >
            <EpisodeBrowser
              episodes={sorted}
              animeId={anilistId}
              provider={providerQuery}
              currentEpisode={episodeNumber}
              docked
              hideHeader
              page={currentPage}
              onPageChange={setPage}
            />
          </aside>
        )}
      </div>

      {/* Sections band — FranchiseStrip + the below panel. Unpinned: a
          plain block whose margins collapse through exactly as the old
          loose siblings did, so phase 1 and ALL of lg+ are visually
          identical to before. Pinned (phase 2, below lg only): the band
          becomes the viewport-bounded scroller under the stuck player —
          `overscroll-contain` kills chaining, and the height itself is
          written via CSSOM (calc off --n54-nav-h + the measured playerH,
          dvh over vh) in the effect above. */}
      <div
        ref={sectionsRef}
        className={pinned ? "overflow-y-auto overscroll-contain" : ""}
      >
        {children}

        {/* Below-position panel — the default flow. Hidden at lg+ ONLY while
            docked (the rail covers it there); below lg it's always the
            layout. Its header (with the toggle) renders inside, as before. */}
        {episodes.length > 0 && (
          <div className={docked ? "mt-8 lg:hidden" : "mt-8"}>
            <EpisodeBrowser
              episodes={sorted}
              animeId={anilistId}
              provider={providerQuery}
              currentEpisode={episodeNumber}
              page={currentPage}
              onPageChange={setPage}
              headerExtra={toggle}
            />
          </div>
        )}
      </div>
    </div>
  );
}
