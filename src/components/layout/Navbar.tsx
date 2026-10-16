"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import AccentColorSelector from "@/components/ui/AccentColorSelector";
import { ChevronDownIcon, GlobeIcon, XIcon } from "@/components/ui/icons";
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
  const navRef = useRef<HTMLElement>(null);

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

  // Route-change reset, done as render-phase adjust-state (the React-docs
  // pattern for syncing state to a prop change): leaving a watch page shows
  // the nav again. Previously this was `setHidden(false)` at the top of the
  // effect below — a sync setState-in-effect the linter (correctly) flags;
  // the effect now only attaches the listener.
  const [prevIsWatchPage, setPrevIsWatchPage] = useState(isWatchPage);
  if (prevIsWatchPage !== isWatchPage) {
    setPrevIsWatchPage(isWatchPage);
    if (!isWatchPage) setHidden(false);
  }

  useEffect(() => {
    if (!isWatchPage) return; // the reset above already ran during render

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

  // ── Sticky-player offset contract ────────────────────────────────────────
  // The watch page pins its player directly under this nav. Instead of a
  // hard-coded `top` (which would overlap the nav whenever the revealed
  // mobile search row grows it, or leave a dead 48px strip whenever this
  // nav auto-hides on watch pages), the nav publishes its CURRENTLY VISIBLE
  // height as --n54-nav-h on <html>: 0 while hidden (scroll-hide /
  // fullscreen), offsetHeight otherwise. A ResizeObserver catches every
  // height change — the search-reveal animation, breakpoint swaps — and
  // writes the variable straight to the document element (no React
  // re-renders). WatchDock consumes it as
  // `top-[var(--n54-nav-h,48px)]` (48px = the default mobile row, h-12).
  // Re-runs on isNavHidden so the read inside the observer is never stale;
  // cleanup removes the variable again.
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const write = () => {
      // transform does not change offsetHeight, so a translated-away nav
      // still reports its full height — the hidden branch is what zeroes it.
      const h = isNavHidden ? 0 : el.offsetHeight;
      document.documentElement.style.setProperty("--n54-nav-h", `${h}px`);
    };
    write();
    const ro = new ResizeObserver(write);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--n54-nav-h");
    };
  }, [isNavHidden]);

  return (
    <nav
      ref={navRef}
      className={`sticky top-0 z-50 bg-[var(--panel)] border-b border-[var(--accent)]/30 rounded-none transition-transform duration-300 ${
        isNavHidden ? "-translate-y-full" : "translate-y-0"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4">
        {/* ALIGNMENT SCHEME — <sm: one shared gutter — the page container's
            own `px-4` (the nav's inner wrapper is the same `max-w-7xl
            mx-auto px-4` the content column uses) — and equalized 40px edge
            boxes: the brand Link and the globe Link are both `h-10 w-10`
            AND both carry the field's quiet frame at EVERY breakpoint (the
            border/bg tokens are base classes, not sm:-gated), so row 1's
            left/right edges are symmetric and framed alike — and the
            absolutely-centered swatch band reads dead-center between them.
            The search bar spans the same content box — its left/right edges
            flush with both edge boxes. VERTICAL: row 1 is `h-12` in both
            states; the collapsed row 2 is h-0 with NO leftover flex gap (the
            spacing lives inside row 2's own `pt-2`/`pb-2`, so the reveal adds
            exactly one search-row height — 52px — and nothing double-counts).
            The nav is one 49px band hidden, 101px revealed; the
            --n54-nav-h effect publishes either live.
            <sm: TWO stacked bands — row 1 = brand + the true-centered swatch
            band + the browse link; row 2 = the search field, REVEALED only
            by the single pull-to-search gesture (or by a URL that already
            carries ?q) and auto-hidden again on pull-up, collapsed to h-0
            until then. The band never lands on the input: it centers over
            row 1's content box, which is symmetric inside px-4 (82px clear
            of both edge boxes at 390px).
            ≥sm: the single h-14 row, CENTERED instead of flow-ordered. Two
            flow groups stay at the edges via `justify-between` — the brand
            box (left) and the swatch-band + globe cluster (right) — while
            the field leaves the flow entirely and is absolutely centered
            against THIS wrapper (`sm:relative`; the wrapper's 50% is the
            viewport's 50% because `max-w-7xl mx-auto px-4` is symmetric):
            true geometric center, independent of the side groups' unequal
            widths. Width: `calc(100% - 24rem)` capped by max-w-xl (576px).
            Math for the narrowest sm viewport (640 → 608px content): the
            right cluster holds 166px (114 band + 16 gap + 36 globe), the
            left brand box 36px — a centered 224px box clears the cluster
            by a constant 26px and the brand by 156px; past 992px viewport
            the cap engages and both clearances only grow. The three boxes
            share ONE frame spec — 1px accent/45% edge over the inset
            --background fill, the .header-search outline language — at
            every breakpoint: 40×40 edge boxes below sm (row 1's symmetric
            edges, the band's centering reference), h-9 / 36px from sm up.
            Row 1 therefore always reads [boxed logo] … [boxed globe]; from
            sm the field joins them dead-center. Note: the field keeps its
            DOM place AFTER
            the swatches/globe (unchanged from the two-band order), so
            keyboard focus still walks logo → swatches → globe → field at
            every width — only the field's paint position is centered. */}
        <div className="sm:relative flex flex-col sm:flex-row sm:h-14 sm:items-center sm:gap-4 sm:justify-between">
          {/* ROW 1 (<sm): brand left, browse link right (justify-between);
              the swatch band is pulled out of flow and TRUE-centered over
              THIS row — the wrapper is `relative` and spans the content box
              inside px-4, so its 50% is the viewport's 50%. ≥sm the wrapper
              generates no box (display: contents), so the brand group and
              the swatch+globe cluster become the row's two flow items —
              justify-between pins them to the edges while the field below
              is absolutely dead-centered. */}
          <div className="relative flex h-12 items-center justify-between sm:contents">
            {/* Brand mark. <sm: a FRAMED 40×40 box EQUAL to the globe's
                (frame tokens at the base breakpoint — no sm: gate), mark
                centered — the two boxes are row 1's symmetric edges (and the
                swatch band's centering reference) and now read [boxed logo]
                … [boxed globe] like the field's outline language. No
                negative margin: the box sits flush on the px-4 gutter like
                everything else. ≥sm: the same frame scaled to a 36×36 badge
                — h-9 outer height, matching the field and the globe's box,
                1px accent/45% edge over the inset --background fill (the
                .header-search frame tokens as utilities). The old hug +
                p-1/-m-1 bleed goes away WITH the fixed box: border boxes
                don't reflow on hover (glow/wash only paint), so there is
                nothing left to bleed-compensate, and the target only grows. */}
            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              <Link
                href="/"
                aria-label="n54tv"
                className="flex h-10 w-10 items-center justify-center rounded-none border border-[var(--accent)]/45 bg-[var(--background)] text-[var(--accent)] transition-all hover:bg-[var(--accent)]/10 hover:accent-shadow-sm sm:h-9 sm:w-9"
              >
                <N54Mark />
              </Link>
            </div>

            {/* RIGHT CLUSTER: swatch band + browse globe. `contents`
                below sm — generates no box, so the band's absolute
                centering still resolves against row 1 (relative) and the
                globe stays row 1's justify-between right edge, exactly as
                before; ≥sm it is a real flex box whose gap-4 equals the
                band↔globe spacing the row's single gap used to give them,
                and justify-between pins the whole cluster to the row's
                right edge — the field's absolute box clears it (see the
                scheme above). */}
            <div className="contents sm:flex sm:items-center sm:gap-4">
              {/* Accent selector. <sm: absolutely TRUE-centered over row 1's
                  content box — the 114px band (6×14 + 5×6 gaps) clears both
                  40px edge boxes by an equal 82px at 390px, so it reads
                  dead-center; the selected-swatch ring sits inside the band
                  and nothing in either header state overlaps it. ≥sm: back
                  into flow inside the right cluster. Width reserved either
                  way so its mount-time appearance (it renders null until
                  mounted) doesn't shove anything over. */}
              <div className="absolute left-1/2 top-1/2 flex min-w-[114px] -translate-x-1/2 -translate-y-1/2 shrink-0 items-center justify-end sm:static sm:translate-x-0 sm:translate-y-0">
                <AccentColorSelector />
              </div>

              {/* Browse link — the empty-field submit's visible home now that
                  the in-field globe/lens button is gone (Enter still submits;
                  an empty field still routes to /browse). <sm: the row's
                  right 40×40 edge box, FRAMED at base exactly like the brand
                  (justify-between; the absolute swatch band ignores both and
                  stays true-centered). ≥sm: the cluster's last item — the
                  same frame on the h-9 box (its quiet hover wash now lands
                  on the inset fill instead of the panel). Box rendered from
                  SSR, so — unlike the late-mounting swatch band — there is
                  nothing to pre-reserve: no shift on either width. Accent
                  glyph, sibling of the header's existing iconography. */}
              <Link
                href="/browse"
                aria-label="Browse"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-none border border-[var(--accent)]/45 bg-[var(--background)] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10 hover:text-white motion-reduce:transition-none sm:h-9 sm:w-9"
              >
                <GlobeIcon className="h-4 w-4" focusable="false" />
              </Link>
            </div>
          </div>

          {/* The site's one query field: from sm up it leaves the flow and
              is absolutely DEAD-CENTERED in the single h-14 row (true
              viewport center — see the scheme above), always visible.
              Below sm it starts COLLAPSED (h-0, SSR default) and opens via
              a single pull-to-search gesture — or stays open whenever the
              URL carries ?q (a populated field is never hidden). Suspense is
              required: HeaderSearch reads useSearchParams, and prerendered
              pages must be able to bail out to the placeholder instead of
              failing the production build with "Missing Suspense boundary".
              The fallback mirrors HeaderSearch's root div in its default
              (collapsed) state — same class string, absolute box included —
              so prerender → hydration is the same shape — no CLS. */}
          <Suspense
            fallback={
              <div
                aria-hidden
                className="flex min-w-0 w-full items-center h-0 pt-0 pb-0 opacity-0 overflow-hidden pointer-events-none transition-[height,opacity] duration-200 ease-out motion-reduce:transition-none sm:absolute sm:left-1/2 sm:top-1/2 sm:w-[calc(100%_-_24rem)] sm:max-w-xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:pt-0 sm:pb-0 sm:h-auto sm:overflow-visible sm:opacity-100 sm:pointer-events-auto"
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
 * The site's single query field. From sm up: absolutely dead-centered in
 * the single h-14 row (out of the flex flow — see the scheme in the nav's
 * JSX), always visible — sizing/frames/behavior unchanged apart from
 * the trailing submit button being gone. Below sm: COLLAPSED by default
 * (SSR renders hidden, so hydration matches) and revealed by a SINGLE
 * PULL-TO-SEARCH gesture — one downward pull at the very top of the page
 * (scrollY ≤ 4, ≥40px of travel). The qualifying pull opens the row
 * (≈200ms height/opacity, instant under prefers-reduced-motion) and
 * focuses the input inside the same touch gesture so the keyboard opens —
 * no arming step, no hint line, no second pull to wait for. The reveal
 * listeners themselves are passive and only ever arm at scrollY ≈ 0 with
 * downward direction — normal scrolling is never hijacked. On top of them,
 * ONE non-passive touchmove guard cancels the browser's native
 * pull-to-refresh (the reported bug: Chrome's spinner / Safari's
 * rubber-band refresh won the pull at page top before the reveal could
 * act). It fires only while the gesture is armed — that touch started
 * <sm at scrollY ≤ 4, row not visible — AND the finger is moving
 * downward, vertical-dominant, from its own origin; at scrollY ≤ 4 a
 * downward pull has no scroll to do, so the only default action cancelled
 * is the refresh gesture itself. Horizontal-dominant movement is never
 * cancelled (the Player's video swipe keeps its stream), and the guard
 * tears down with the same `visible` gate: once revealed, native PTR
 * works normally again until auto-hide returns the row to hidden. The
 * root-level `overscroll-behavior-y: none` on <html> (globals.css) is
 * the belt-and-braces layer — see that rule's comment for the site-wide
 * trade-off. A URL that carries ?q keeps the field visible
 * unconditionally — a populated field is never hidden. The revealed flag
 * is component state: the navbar lives in the root layout, so it survives
 * client navigations for the page session and resets with the document
 * (SSR always hidden).
 *
 * Auto-hide (<sm): a revealed row collapses again on a clear PULL-UP — the
 * page scrolling ≥120px below where the reveal happened (an upward finger
 * swipe at the top is exactly that: it scrolls the page down). The collapse
 * blurs the input so the keyboard dismisses with it, and `revealed` resets,
 * so the next pull reveals again. Guards: ?q-forced visibility never
 * auto-hides (the URL owns that state — we don't collapse and don't blur);
 * a keystroke within the last 1500ms defers the collapse (focus is the
 * keyboard-open proxy, recency is the typing proxy — type, then scroll, and
 * the keyboard stays up), and the guard releases the moment the field
 * blurs — keyboard dismissed, Enter-submit, Escape, or the collapse itself;
 * sm+ never collapses (the row is permanent there, so collapsing would only
 * blur mid-scroll). Passive scroll listener,
 * no preventDefault; the collapse reuses the row's height/opacity
 * transition (instant under prefers-reduced-motion).
 *
 * Keyboard dismiss (mobile): closing the software keyboard (Android back
 * gesture or drag-dismiss) does NOT blur the input on its own — the page
 * stays zoomed/keyboard-ready and the field stays focused, so every
 * focus-based guard keeps waiting on a keyboard that is already gone (URL
 * sync paused; auto-hide holding). A visualViewport resize listener tracks
 * the viewport height against a keyboard-free baseline: "meaningfully
 * open" once the height sits ≥120px below it, closed when it collapses
 * back within 60px of the baseline — hysteresis, so URL-bar wiggle and
 * other small chrome resizes touch neither edge. Closing blurs the field
 * through the same release path as submit/Escape (releaseAndBlur below),
 * and only when it actually holds focus; refs only — no state, so the
 * no-JS Suspense copy has nothing to mirror — the effect runs client-side
 * only, guards browsers without visualViewport, and removes its listener
 * on unmount.
 *
 * Pull indicator (HOME only, <sm): a small chevron pill just below the
 * header (absolute against the nav — it never counts toward the measured
 * --n54-nav-h) teaches the gesture once. Lifecycle: SSR renders it at
 * opacity 0 (hydration matches); ~600ms after mount it fades/slides in
 * with a subtle pulse (`animate-pulse`, static under reduced-motion) and
 * fades out ~3.5s later — the timer phase lives in state flipped from
 * setTimeout callbacks, never in an effect body. An in-progress pull at
 * the top re-lights it with progress-linked opacity/translate (8px dead
 * zone, 0.1 quantization); the 40px commit consumes it. Tapping it reveals
 * and focuses exactly like the pull. It never returns for the session once
 * the search is revealed (`searchUsed`), never renders off "/", and is
 * `sm:hidden`.
 *
 * Submitting: ENTER ONLY — there is no trailing globe/lens button anymore.
 * An empty field still routes to /browse through the unchanged submit rule
 * (the form has a single text input, so implicit submission works), and
 * the header's standalone globe Link is the visible route there. The ✕
 * clear stays.
 *
 * Ownership model — the field owns its own text; the URL owns everything
 * else. Keystrokes stay local (never pushed by the field itself) until Enter
 * pushes `/browse?q=…`. The URL flows back into the field only when the
 * field is not focused (effect below), so back/forward, internal links and
 * browse's Clear (which pushes `/browse`) still sync it — while typing, the
 * user is the sole writer and no navigation can eat a keystroke. That keeps
 * the field and the URL agreeing without coupling the header to any page's
 * state: browse reads `q` straight from the URL, and its Clear only has to
 * push `/browse` for the field to empty itself.
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
  // Interaction-only reveal (see the doc above). SSR starts false.
  const [revealed, setRevealed] = useState(false);
  // Keystroke clock — the auto-hide typing guard reads it (see below).
  const lastTypedAt = useRef(0);
  // ── Pull-to-search indicator (home, <sm) — see the doc above ──
  // Timer phase: "pre" (SSR + first frame, opacity 0), "in" (shown, pulse),
  // "out" (fading), "gone" (unmounted). Flipped only from setTimeout
  // CALLBACKS — never synchronously in an effect body — so the effect below
  // stays clear of the setState-in-effect rule while SSR still matches
  // ("pre" renders the element invisible).
  const [indicatorPhase, setIndicatorPhase] = useState<"pre" | "in" | "out" | "gone">("pre");
  // Session latch: once the search has been revealed (pull or tap), the
  // affordance is done teaching and never returns.
  const [searchUsed, setSearchUsed] = useState(false);
  // In-progress pull distance, 0..1 — quantized in the touch handler.
  const [pullP, setPullP] = useState(0);
  const isHome = usePathname() === "/";
  const q = draft.trim();

  // Visible = gesture-revealed OR the URL already carries a query (the user
  // is mid-search — never hide a populated field, even before any gesture).
  const visible = revealed || urlQ.length > 0;

  // SINGLE PULL-TO-SEARCH (<sm; the row is always visible from sm up, so the
  // gesture has nothing to do there). The reveal listeners stay PURE —
  // passive, no preventDefault — so scrolling is untouched; a separate
  // NON-PASSIVE guard below cancels ONLY the native pull-to-refresh
  // gesture (the bug: the browser's spinner consumed the pull at page top
  // before the reveal could act). Everything in this effect — guard
  // included — tears down once `visible` flips (populated URL or an
  // already-open row), so the revealed state restores native PTR until
  // auto-hide returns the row to hidden.
  useEffect(() => {
    if (visible) return;
    let startY = 0;
    let startX = 0;
    let pulling = false;
    // Downward travel from the touch's own origin that counts as "the
    // pull" for the PTR guard — far below the 40px reveal threshold, so
    // suppression starts the moment the pull departs, before any engine
    // can commit to its refresh gesture.
    const PTR_GUARD_EPSILON_PX = 2;

    const onTouchStart = (e: TouchEvent) => {
      // Arm only at the very top — a downward drag mid-page is just reading.
      if (window.matchMedia("(max-width: 639px)").matches && window.scrollY <= 4) {
        startY = e.touches[0].clientY;
        startX = e.touches[0].clientX;
        pulling = true;
      } else {
        pulling = false;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      if (dy < 40) {
        // Feed the pull indicator (home <sm): an 8px dead zone keeps tiny
        // jitters dark, then progress-linked opacity/slide, quantized to
        // 0.1 steps so one gesture renders the indicator ≤10 times.
        if (dy > 8) setPullP(Math.min(9, Math.round(dy / 4)) / 10);
        return;
      }
      pulling = false; // this gesture is consumed — one pull, one reveal
      setPullP(0); // the commit consumes the indicator (same steps the
      // indicator's tap handler runs: latch, reveal, focus)
      setSearchUsed(true);
      setRevealed(true);
      // Focus NOW, still inside the user's gesture, which is what lets
      // mobile Safari open the keyboard.
      inputRef.current?.focus({ preventScroll: true });
    };

    const onTouchEnd = () => {
      pulling = false; // abort an in-progress pull; the next one restarts
      setPullP(0); // an uncommitted pull releases the indicator
    };

    // ── Native pull-to-refresh guard — THE one intentional preventDefault
    // in this file (everything else here stays passive). Registered
    // { passive: false } — a passive listener couldn't cancel anything.
    // ALL of these must hold before the call:
    //   1. `pulling` — this touch STARTED armed: its touchstart happened
    //      <sm (max-width: 639px) at scrollY ≤ 4; the effect's own
    //      `visible` gate already excludes revealed / ?q states. So sm+,
    //      mid-page, and revealed gestures never reach this line;
    //   2. dy > PTR_GUARD_EPSILON_PX from the touch's OWN origin — the
    //      finger is genuinely pulling down (upward/still never);
    //   3. dy ≥ |dx| — downward-DOMINANT. The Player's video swipe arms
    //      only when |dx| ≥ 2.5×|dy| (and ≥44px), which always fails
    //      this test — horizontal movement is never preventDefaulted, so
    //      the Player's touch-action: pan-y stream is untouched.
    // At scrollY ≤ 4 a downward pull has no scroll left to perform; the
    // only default action this cancels is the browser's refresh gesture.
    const onGuardMove = (e: TouchEvent) => {
      if (!pulling) return;
      const t = e.touches[0];
      const dy = t.clientY - startY;
      if (dy <= PTR_GUARD_EPSILON_PX) return;
      if (Math.abs(t.clientX - startX) > dy) return; // horizontal-dominant — hands off
      e.preventDefault();
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchmove", onGuardMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchmove", onGuardMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [visible]);

  // AUTO-HIDE (<sm): the reveal's inverse — a clear PULL-UP collapses the
  // row. Mechanically: the page scrolling ≥120px below where the reveal
  // happened (an upward finger swipe at the top produces exactly that — it
  // scrolls the page down). The 120px threshold keeps ordinary micro-jitters
  // and small reading scrolls from collapsing it mid-browse. Guards: ?q-
  // forced visibility never auto-hides (the URL owns that state — we neither
  // collapse nor blur); a keystroke within TYPING_GUARD_MS defers the
  // collapse (focus is the keyboard-open proxy, recency is the typing
  // proxy — type, then scroll, and nothing collapses under the keyboard);
  // every blur path zeroes lastTypedAt, so a keyboard dismissed by the
  // viewport listener below frees the next clear scroll at once;
  // sm+ never collapses (the row is permanent there, so it would only blur
  // mid-scroll). Passive listener, no preventDefault; blur FIRST so the
  // keyboard dismisses together with the collapse; `revealed` resets, so
  // the next pull reveals again. The Navbar's ResizeObserver notices the
  // nav shrinking and republishes --n54-nav-h, so the watch page's sticky
  // player slides back up under the shorter nav on its own.
  useEffect(() => {
    if (urlQ.length > 0) return; // URL-forced visibility: never auto-hide
    if (!revealed) return; // nothing to collapse
    const HIDE_AFTER_PX = 120;
    const TYPING_GUARD_MS = 1500;
    const baseline = window.scrollY; // the reveal fires at the very top (≤4)
    const onScroll = () => {
      if (window.matchMedia("(min-width: 640px)").matches) return;
      if (Date.now() - lastTypedAt.current < TYPING_GUARD_MS) return;
      if (window.scrollY - baseline < HIDE_AFTER_PX) return;
      lastTypedAt.current = 0; // guard releases with the blur below
      inputRef.current?.blur();
      setRevealed(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [revealed, urlQ]);

  // KEYBOARD-DISMISS BLUR (mobile) — see the doc above. Dismissing the
  // software keyboard leaves the input focused; this listener is what
  // unfocuses it. Baseline = a keyboard-free viewport height (captured at
  // mount, tracked while the field is idle so browser-chrome movement
  // doesn't masquerade as a keyboard, re-anchored after every close).
  // Hysteresis guards the two edges: open needs ≥120px of drop (a real
  // keyboard, not URL-bar wiggle), close needs the height back within
  // 60px of baseline (a real collapse, not a mid-typing suggestion-bar
  // resize). The close branch is ref-only — zero the typing guard, blur
  // ONLY if this field actually holds focus (idempotent across the
  // animation's repeated resizes) — so no setState lives in this effect,
  // there is nothing to mirror in SSR, and nothing depends on render
  // scope beyond stable refs. Without visualViewport (older browsers) the
  // effect is a no-op; the listener is removed on unmount.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const KEYBOARD_OPEN_PX = 120;
    const KEYBOARD_CLOSED_PX = 60;
    let baseline = vv.height;
    let open = false;
    const onResize = () => {
      const delta = baseline - vv.height;
      if (!open) {
        if (delta >= KEYBOARD_OPEN_PX) {
          open = true;
        } else if (document.activeElement !== inputRef.current) {
          baseline = vv.height; // idle: any height is keyboard-free chrome
        }
        return;
      }
      if (delta >= KEYBOARD_CLOSED_PX) return; // still open / mid-animation
      open = false;
      lastTypedAt.current = 0; // the guard releases WITH the keyboard
      const input = inputRef.current;
      if (input && document.activeElement === input) input.blur();
      baseline = vv.height; // re-anchor: chrome may have moved while open
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  // Indicator lifecycle (home only): fade/slide in ~600ms after mount, hold
  // with a subtle pulse ~3.5s, fade out, unmount. Every setState lives in
  // a timeout CALLBACK — the effect body only schedules — and the cleanup
  // cancels the whole window (route change, reveal mid-window, latch).
  useEffect(() => {
    if (!isHome || visible || searchUsed) return;
    const t1 = window.setTimeout(() => setIndicatorPhase("in"), 600);
    const t2 = window.setTimeout(() => setIndicatorPhase("out"), 600 + 3500);
    const t3 = window.setTimeout(() => setIndicatorPhase("gone"), 600 + 3500 + 400);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [isHome, visible, searchUsed]);

  // URL → field, but ONLY while the field is not being edited.
  //
  // `draft` must have exactly ONE writer while typing: the field's own
  // onChange below. An older version of this effect ran `setDraft(urlQ)` on
  // every URL change, which made the URL a SECOND writer — a submitted
  // navigation landing mid-edit overwrote the newer draft. The URL is
  // therefore adopted only when the field holds no focus — which is exactly
  // "not typing". Focus now actually drops when the keyboard closes (the
  // viewport listener blurs), so a dismissed keyboard resumes this sync
  // instead of freezing it until the scroll-collapse. Back/forward,
  // internal links and browse's Clear (it pushes
  // /browse) all arrive unfocused and still sync the field as before; while
  // the user IS typing, nothing but the user can move `draft`.
  // Accepted trade-off: pressing the browser Back button while focused in the
  // field leaves the field showing what was typed (the URL itself is still
  // correct) — the safe direction, and the next navigation resyncs it.
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    setDraft(urlQ);
  }, [urlQ]);

  // ONE blur path for every keyboard dismisser (viewport-close listener,
  // Enter-submit, Escape): zero the typing guard FIRST — once the keyboard
  // is gone there is nothing left to protect, so auto-hide's next clear
  // scroll is free — then blur only if the field actually holds focus (the
  // check keeps the viewport listener's mid-animation resizes idempotent;
  // blur on an unfocused element would be a no-op anyway).
  function releaseAndBlur() {
    lastTypedAt.current = 0;
    const input = inputRef.current;
    if (input && document.activeElement === input) input.blur();
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Empty field → the browse landing view, exactly what the header's
    // standalone globe link does (Enter is now the only submit path).
    router.push(q ? `/browse?q=${encodeURIComponent(q)}` : "/browse");
    // Submit takes the keyboard with it — the same release path a keyboard
    // close takes, so Enter never leaves a focused field behind holding
    // the page zoomed/keyboard-ready.
    releaseAndBlur();
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
    <>
      {/* Pull-to-search indicator — see the doc above. Absolutely
          positioned against the nav (`top-full`), so it NEVER counts toward
          the measured nav height (--n54-nav-h); `sm:hidden` keeps it
          <sm-only. z-10 = above page content (the nav's z-50 still owns
          the top; it never coexists with the revealed row — that state
          unmounts it). Tap = reveal + focus, the same three steps the
          pull's 40px commit runs. During "pre"/"out" it's an invisible,
          inert shell (hydration matches, zero CLS); pull progress overrides
          the phase's opacity/transform inline. */}
      {isHome && !visible && !searchUsed && indicatorPhase !== "gone" && (
        <button
          type="button"
          onClick={() => {
            setPullP(0);
            setSearchUsed(true);
            setRevealed(true);
            inputRef.current?.focus({ preventScroll: true });
          }}
          aria-label="Open search"
          style={
            pullP > 0
              ? { opacity: 0.25 + 0.65 * pullP, transform: `translate(-50%, ${-5 + 5 * pullP}px)` }
              : { transform: indicatorPhase === "in" ? "translate(-50%, 0)" : "translate(-50%, -5px)" }
          }
          className={`absolute left-1/2 top-full z-10 mt-1 flex items-center justify-center rounded-none border border-[var(--accent)]/30 bg-[var(--panel)] px-2.5 py-1 text-[var(--accent)] transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none sm:hidden ${
            indicatorPhase === "in"
              ? "animate-pulse motion-reduce:animate-none"
              : "opacity-0 pointer-events-none"
          }`}
        >
          <ChevronDownIcon className="h-3.5 w-3.5" focusable="false" />
        </button>
      )}
      {/* ROW 2 on mobile, revealed (see the doc above): full width beneath
          row 1; `h-[52px]` counts everything exactly once — pt-2 separates
          it from row 1 (this replaced the old flex gap, which left an 8px
          dead strip below row 1 while collapsed), pb-2 from the nav edge,
          the h-9 field between: the reveal adds exactly this one row's
          height. The sm:* restorers return the always-visible behavior
          (h-auto, no padding, visible, interactive) while the sm:absolute
          utilities pull the whole row to the row's dead-center (see the
          scheme above). The field
          itself never changes, only whether the row around it is open. */}
      <div
        className={`flex min-w-0 w-full items-center transition-[height,opacity] duration-200 ease-out motion-reduce:transition-none sm:absolute sm:left-1/2 sm:top-1/2 sm:w-[calc(100%_-_24rem)] sm:max-w-xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:pt-0 sm:pb-0 sm:h-auto sm:overflow-visible sm:opacity-100 sm:pointer-events-auto ${
          visible
            ? "h-[52px] pt-2 pb-2 opacity-100"
            : "h-0 pt-0 pb-0 opacity-0 overflow-hidden pointer-events-none"
        }`}
      >
        <form
          role="search"
          onSubmit={handleSubmit}
          className="flex min-w-0 w-full justify-center"
        >
          {/* One bordered control: field + optional ✕. `group` is what
              drives the ✕ reveal below (group-hover / group-focus-within);
              the frame itself — 1px 45%-accent edge (quiet, not the rejected
              2px), inset --background fill, hover lift, full-accent focus
              glow + tinted fill — comes from the hand-written .header-search
              rules in globals.css so it reads solid in every accent theme
              without thickness. Border/background utilities are deliberately
              absent: the unlayered rules own them. */}
          <div className="header-search group flex h-9 w-full max-w-xl min-w-0 items-center transition-all">
            <input
              ref={inputRef}
              type="search"
              name="q"
              value={draft}
              onChange={(e) => {
                lastTypedAt.current = Date.now(); // arms the auto-hide typing guard
                setDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                // Escape = cheap keyboard dismiss (the same release path a
                // viewport close takes). preventDefault blocks type=search's
                // native Escape-clear, so the query survives — this only
                // drops focus and the keyboard.
                if (e.key !== "Escape") return;
                e.preventDefault();
                releaseAndBlur();
              }}
              placeholder="Search anime..."
              aria-label="Search anime"
              enterKeyHint="search"
              className="h-full min-w-0 flex-1 appearance-none bg-transparent px-3 font-mono text-sm text-[var(--foreground)] placeholder:text-[var(--text-secondary)] focus:outline-none"
            />
            {/* Rendered only with text, VISIBLE only while the group is
                hovered or holds focus — otherwise it sits at opacity-0. Just
                the glyph: no border, no divider, no background (hover changes
                its color only). It stays tabbable the whole time: tabbing
                into the group fires group-focus-within (revealing it,
                pointer-events included) and Enter/Space on it still fires
                onClick — keyboard activation doesn't depend on pointer
                hit-testing, and focus-within restores pointer events anyway.
                Screen readers always see it (opacity never removes it from
                the tree). */}
            {draft.length > 0 && (
              <button
                type="button"
                onClick={handleClearField}
                aria-label="Clear search"
                className="flex h-full w-8 shrink-0 items-center justify-center text-[var(--accent)] opacity-0 transition-all group-hover:opacity-100 group-focus-within:opacity-100 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto hover:text-white"
              >
                <XIcon className="h-4 w-4" focusable="false" />
              </button>
            )}
            {/* NO trailing submit button — Enter submits (implicit, single
                input), and the header's standalone globe Link owns the
                visible "browse" route. The ✕ above is the only button left. */}
          </div>
        </form>
    </div>
    </>
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
