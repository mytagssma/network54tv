"use client";

import { useEffect, useRef, useState, useCallback, useMemo, Fragment } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Hls from "hls.js";
import SubtitleOverlay from "./SubtitleOverlay";
import SubtitlePickerContent from "./SubtitlePickerContent";
import { proxyUrl } from "@/lib/utils";
import { EmptyState } from "@/components/anime/Availability";
import type { StreamSource, Subtitle } from "@/types/anime";
import { franchiseSortGroups, type FranchiseEntry } from "@/components/watch/franchiseEntries";
import { useFranchiseSort } from "@/hooks/useFranchiseSort";

interface PlayerProps {
  animeTitle: string;
  episodeNumber: number;
  anilistId?: number;
  malId?: number;
  nextEpisodeNumber?: number;
  providerId?: string;
  /** `?provider=` from the watch page — carried through episode navigation */
  providerQuery?: string;
  /** Compact episode list for the drawer (passed down; never re-fetched here) */
  episodes?: { number: number; title?: string }[];
  /**
   * Franchise / season entries (same set the watch page's `// Franchise`
   * grid lists) — the dropdown docked at the top of the episode drawer.
   */
  franchise?: FranchiseEntry[];
  /**
   * The CURRENT episode's dub flag, straight from the episode list the watch
   * page already resolved (`Episode.hasDub`):
   *   `true`  this episode carries a dub        → DUB is offered
   *   `false` this episode has no dub           → DUB renders muted + inert
   *   `null`  the provider didn't say (megaplay ships `null` for everything)
   *           → resolved through `/api/episodes?audio=1` below, and only if
   *           that can't tell either does the old stream probe have a say.
   * Data decides; the probe never overrides a known answer.
   */
  episodeHasDub?: boolean | null;
}

const SERVERS = ["vidstream-2", "vidcloud-1", "vidstream-1"];

// Provider options shown in the error overlay when a stream fails
const PROVIDER_OPTIONS = [
  { id: "", label: "Auto" },
  { id: "kickassanime", label: "Kickass" },
  { id: "anikoto", label: "Anikoto" },
  { id: "anizone", label: "AniZone" },
  { id: "allmanga", label: "AllManga" },
  { id: "anineko", label: "AniNeko" },
  { id: "animeunity", label: "AnimeUnity" },
];

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

/* ─── Series / episode switch handoff ───────────────────────────────────
 * A route-param change (`…/watch/5` → `…/watch/6`, or a different `[id]`)
 * changes the App Router segment's *state key* (`createRouterCacheKey`
 * bakes the param value in), and with `cacheComponents` off the bfcache
 * keeps only 1 entry — so React unmounts the entire previous segment,
 * player included, and mounts a fresh one. Anything that has to survive
 * that trip is stashed here in sessionStorage and read back by the NEXT
 * Player instance: the switch overlay's payload, and the "we were in
 * fullscreen" intent used to restore it.
 */
const SWITCH_KEY = "n54tv-switch";
/** Never let an instant load flash the overlay — hold it at least this long. */
const SWITCH_MIN_MS = 700;
/** Older than this is a leftover from a dead tab, not a live switch. */
const SWITCH_STALE_MS = 20_000;

interface SwitchHandoff {
  /** Epoch ms of the click that started the switch (drives the min hold). */
  t: number;
  /** The player was fullscreen then — the new instance must restore it. */
  fs: boolean;
  /** What the overlay announces. */
  kind: "episode" | "series";
  /** Series title to show (the *target* series on a series switch). */
  series: string;
  /** Target episode number. */
  episode: number;
  /** Episode title when hopping within the same series. */
  epTitle?: string;
}

function readSwitchHandoff(): SwitchHandoff | null {
  try {
    const raw = sessionStorage.getItem(SWITCH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SwitchHandoff;
    if (!parsed || typeof parsed.t !== "number") return null;
    if (Date.now() - parsed.t > SWITCH_STALE_MS) {
      sessionStorage.removeItem(SWITCH_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeSwitchHandoff(h: SwitchHandoff): void {
  try {
    sessionStorage.setItem(SWITCH_KEY, JSON.stringify(h));
  } catch {
    /* private mode / quota — the overlay then only lives on this instance */
  }
}

function clearSwitchHandoff(): void {
  try {
    sessionStorage.removeItem(SWITCH_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Last-resort fullscreen recovery: browsers only grant `requestFullscreen()`
 * inside user activation, so when the instant post-navigation attempt above
 * has been rejected, the honest way back in is the viewer's *next* real
 * gesture. One shot (first click or key), disarmed after 15s so a stray
 * later tap can never yank someone into fullscreen.
 */
function armFullscreenRetry(): void {
  const tryIt = () => {
    disarm();
    const el = document.documentElement as any;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try {
      const p = req.call(el);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* still refused — leave the viewer where they are */
    }
  };
  const disarm = () => {
    window.removeEventListener("pointerdown", tryIt);
    window.removeEventListener("keydown", tryIt);
    clearTimeout(timer);
  };
  const timer = setTimeout(disarm, 15_000);
  window.addEventListener("pointerdown", tryIt, { once: true });
  window.addEventListener("keydown", tryIt, { once: true });
}

const FILTER_PRESETS = [
  { id: "off", label: "Off", css: "none" },
  { id: "vivid", label: "Anime Vivid", css: "brightness(1.05) contrast(1.1) saturate(1.3)" },
  { id: "soft", label: "Anime Soft", css: "brightness(1.02) contrast(0.95) saturate(1.1)" },
  { id: "cinema", label: "Cinema", css: "brightness(0.95) contrast(1.15) saturate(0.85) sepia(0.05)" },
  { id: "sharp", label: "Sharp", css: "brightness(1) contrast(1.1) saturate(1.3)" },
] as const;

type FilterId = (typeof FILTER_PRESETS)[number]["id"];

// Sub-pages inside the ⋯ overflow menu
type MoreSection = "provider" | "server" | "quality" | "speed" | "filter" | "subs";

// One row of the ⋯ menu's root list: label + current value + chevron.
// Kept at module scope so rows keep their identity across re-renders.
function MoreRow({
  label,
  value,
  onClick,
  className = "",
  active = false,
}: {
  label: string;
  value?: React.ReactNode;
  onClick: () => void;
  className?: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors rounded-none ${
        active
          ? "bg-[var(--accent)]/10 text-[var(--accent)]"
          : "text-[#9a9aa0] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
      } ${className}`}
    >
      <span className="truncate">{label}</span>
      {/* The value may be a long provider/server name — it truncates at the
          band edge (min-w-0 lets the flex child shrink) instead of forcing a
          horizontal overflow inside the menu panel. Only the chevron stays rigid. */}
      <span className="flex min-w-0 items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-[var(--accent)]/50">
        <span className="truncate">{value}</span>
        <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </span>
    </button>
  );
}

function getFilterCSS(id: FilterId): string {
  return FILTER_PRESETS.find((f) => f.id === id)?.css ?? "none";
}

function formatTime(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00";
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Pathname (lowercased, query/hash ignored) for extension checks
function getUrlPathname(url: string): string {
  try {
    return new URL(url, window.location.href).pathname.toLowerCase();
  } catch {
    return url.split(/[?#]/)[0].toLowerCase();
  }
}

// DASH manifests — unplayable here (hls.js only, no dash.js)
function isDashUrl(url: string): boolean {
  return getUrlPathname(url).endsWith(".mpd");
}

// Progressive files the browser can play directly via video.src
function isProgressiveUrl(url: string): boolean {
  return /\.(mp4|m4v|webm|mov)$/.test(getUrlPathname(url));
}

// A source we can actually attempt: HLS (when hls.js is supported) or progressive —
// never DASH (.mpd), which would otherwise assign an unplayable URL and stall at 0:00
function isPlayableSource(s: StreamSource): boolean {
  if (isDashUrl(s.url)) return false;
  return (s.isM3U8 && Hls.isSupported()) || isProgressiveUrl(s.url);
}

export default function Player({ animeTitle, episodeNumber, anilistId, malId, nextEpisodeNumber, providerId, providerQuery, episodes, franchise, episodeHasDub }: PlayerProps) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchIdRef = useRef(0);
  const failoverQueueRef = useRef<string[]>([]);
  const workingServersRef = useRef<{ server: string; sources: StreamSource[]; subtitles: Subtitle[]; headers: Record<string, string>; providerId?: string }[]>([]);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressRef = useRef(false);
  const activeServerRef = useRef<string | null>(null);
  const currentQualityRef = useRef("auto");
  const lastTimeUpdateRef = useRef(0);
  // performance.now() stamp of the most recent `seeking`/`seeked` event.
  // stallCheck uses it to forgive the post-seek readyState dip (fragment
  // fetch keeps the element at readyState 1–2 for 1–4s — not a real stall).
  const lastSeekAtRef = useRef(0);
  const triedUrlsRef = useRef<Set<string>>(new Set()); // playable URLs already attempted this load
  // ─── Load-attempt lifecycle ───────────────────────────────
  // Each source choice is one bounded "attempt" (see loadHls below).
  // watchdogRef: 15s timer that fails an attempt when neither MANIFEST_PARSED
  //              nor a fatal error ever fires (silent black screen).
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "idle" → no attempt running, "pending" → waiting for media, "ready" → playing
  const attemptStateRef = useRef<"idle" | "pending" | "ready">("idle");
  // Fails the attempt that is currently running (null while idle).
  const failAttemptRef = useRef<(() => void) | null>(null);

  // Refs for close-on-outside-click
  const moreWrapRef = useRef<HTMLDivElement>(null); // the ⋯ menu (right-anchored popup, all widths)
  const moreBtnRef = useRef<HTMLButtonElement>(null); // the ⋯ trigger
  // The dismiss layer under the ⋯ menu (transparent catcher on wide
  // viewports, scrim on phones). Excluded from the pointerdown "outside"
  // test on purpose: it closes on its own click instead, so the menu is
  // still mounted when the click lands and the gesture can't fall through
  // to the video (which would toggle playback alongside the dismissal).
  const moreDismissRef = useRef<HTMLDivElement>(null);
  const speedWrapRef = useRef<HTMLDivElement>(null);

  // Stream state
  const [sources, setSources] = useState<StreamSource[]>([]);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [streamHeaders, setStreamHeaders] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [streamError, setStreamError] = useState(false);
  /**
   * `/api/stream`'s own `data.error`, captured whenever a lookup answers with
   * no sources — the server knows better than any local fallback whether this
   * was "providers have nothing" versus a transport failure. Stays `null` for
   * playback-side failures (dead manifest, exhausted source pool), which keep
   * the generic copy. Rendered by `EmptyState` instead of it, only when set.
   */
  const [streamErrorDetail, setStreamErrorDetail] = useState<string | null>(null);
  /**
   * Scratch slot for the same string while a load window is in progress.
   * Probes that run *after* a successful load also report `data.error` for the
   * servers that missed, and materialising those would leave the card quoting a
   * reason from a success. So probes only write the ref; the three API-driven
   * failure sites below turn it into `streamErrorDetail`, and every load window
   * starts by clearing both.
   */
  const lastApiErrorRef = useRef<string | null>(null);
  // Manual provider override — set when the user picks a provider after a failure
  const [providerOverride, setProviderOverride] = useState<string | null>(null);
  const activeProvider = providerOverride ?? providerId;
  // Slow-load hint: armed at ~11s while the lookup is still running. Nothing
  // resets it here — every site that *opens* a loading window clears the flag
  // first, so a stale hint can never paint at the start of the next one.
  const [slowLoad, setSlowLoad] = useState(false);

  // ─── Slow-load hint ─────────────────────────────────────
  // One timer per loading window; the window closing tears it down.
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setSlowLoad(true), 11_000);
    return () => clearTimeout(t);
  }, [loading]);

  // Playback state
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  // Seeded from the document, not from `false`: a fresh page load can never be
  // fullscreen (both server and client render false → hydration matches), but
  // a *remount* mid-navigation must come back in cinematic shape on its very
  // first paint — otherwise a fullscreened <html> would flash the whole page
  // before this state caught up. The listener below keeps it live afterwards.
  // Both spellings, like every other fullscreen read in this file: on the
  // prefixed-only builds the guards below still cover, `fullscreenElement`
  // alone reads undefined and a surviving fullscreen would seed `false` —
  // with no change event left to fire, the player would paint windowed
  // inside a fullscreen page and never recover.
  const [isFullscreen, setIsFullscreen] = useState(() => {
    if (typeof document === "undefined") return false;
    const doc = document as any;
    return !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  });
  const isFullscreenRef = useRef(isFullscreen);
  isFullscreenRef.current = isFullscreen;
  const [showControls, setShowControls] = useState(true);
  // Seekbar buffer read-out — % ranges sampled from video.buffered (drawn as
  // a lighter segment under the input's translucent tail) plus a "starved"
  // flag driven purely by the media events (waiting/stalled vs playing/
  // canplay), so the pulse only shows while the browser is actually fetching
  // — never during normal playback.
  const [bufferedRanges, setBufferedRanges] = useState<{ start: number; end: number }[]>([]);
  const [isBuffering, setIsBuffering] = useState(false);
  const bufferedKeyRef = useRef("");

  // Audio type (sub / dub)
  const [audioType, setAudioType] = useState<"sub" | "dub">("sub");
  // ─── Dub availability — data first, probe last ──────────────────────
  // The episode's own `hasDub`, derived — never written during render or
  // from an effect body: the server prop when it's known, otherwise the
  // value the effect below fetched from the SAME `/api/episodes` endpoint
  // the episode list uses, so the answer comes from the provider's flags /
  // the shared megaplay probe instead of from a guess. The fetched value is
  // keyed by episode, so a slow answer for the previous episode can never
  // describe the current one (a key mismatch simply reads as "unknown").
  const [fetchedDub, setFetchedDub] = useState<{ key: string; value: boolean } | null>(null);
  // Legacy fallback only: did ANY server answer a `type=dub` stream request?
  // Consulted exclusively while the flag is still unknown (titles the shared
  // probe can't cover — e.g. >60 episodes with no per-episode flags).
  const [dubProbeOk, setDubProbeOk] = useState(false);
  const dubFlag: boolean | null =
    episodeHasDub ??
    (fetchedDub && fetchedDub.key === `${anilistId}:${episodeNumber}` ? fetchedDub.value : null);
  const dubKnown = dubFlag !== null;
  /** DUB may be switched to — a known "no dub" beats any probe result. */
  const dubEnabled = dubKnown ? dubFlag === true : dubProbeOk;
  /** The SUB/DUB control renders whenever we have ANY answer (yes *or* no). */
  const showAudioToggle = dubKnown || dubProbeOk;

  // Resolve a missing server flag once per episode, non-blocking: the toggle
  // simply appears the moment the API answers. `audio=1` asks the route to
  // run its (cached, ≤8s-budgeted) megaplay probe; a `null` back means the
  // flags are unknowable for this title and the legacy probe below decides.
  useEffect(() => {
    if (episodeHasDub !== null && episodeHasDub !== undefined) return;
    if (!anilistId) return;
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({
          title: animeTitle,
          id: String(anilistId),
          audio: "1",
        });
        const res = await fetch(`/api/episodes?${params}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const listed: { number?: number; hasDub?: boolean | null }[] | undefined = data?.episodes;
        const ep = Array.isArray(listed) ? listed.find((e) => e.number === episodeNumber) : null;
        if (!cancelled && typeof ep?.hasDub === "boolean") {
          setFetchedDub({ key: `${anilistId}:${episodeNumber}`, value: ep.hasDub });
        }
      } catch {
        /* network hiccup — stay unknown, the stream probe still answers */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [episodeHasDub, anilistId, animeTitle, episodeNumber]);

  // Server / session state
  const [activeServer, setActiveServer] = useState<string | null>(null);
  const [availableServers, setAvailableServers] = useState<string[]>([]);

  // Quality / speed state
  const [currentQuality, setCurrentQuality] = useState<string>("auto");
  const [hlsLevels, setHlsLevels] = useState<{ index: number; height: number; name: string }[]>([]);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showSpeedPicker, setShowSpeedPicker] = useState(false);

  // Subtitle state
  const [activeSubtitle, setActiveSubtitle] = useState<string | null>(null);

  // Video filter state
  const [videoFilter, setVideoFilter] = useState<FilterId>("off");

  // "More" (⋯) overflow menu — holds every control the row hides at this
  // width, plus the always-low-priority toggles (auto-play, auto-skip, FX).
  // One open flag + one section flag: `null` = root list, otherwise the
  // sub-page (provider / quality / …) inside the same popup.
  const [showMore, setShowMore] = useState(false);
  const [moreSection, setMoreSection] = useState<MoreSection | null>(null);
  // SHAPE modifier for the ⋯ menu, not a different shape: the popup is
  // right-anchored at every width (see `moreMenuAnchor` below), and below
  // 640px — the same breakpoint the controls use to switch to touch-sized
  // buttons — it only keeps a 36px floor on the root list's own rows
  // (`[&>button]:min-h-9`; the drill panel is unfloored = desktop-density
  // 28px options) and the width/height cap shared with the desktop popup.
  // Read post-mount so the first render still matches the SSR output (the
  // menu starts closed, so there is nothing to flash).
  const [isCompact, setIsCompact] = useState(false);
  // Mirror for the controls auto-hide timer (a []-deps effect reads this)
  const moreOpenRef = useRef(showMore);
  moreOpenRef.current = showMore;
  // Single way to dismiss the ⋯ menu (outside click, Escape, picking an
  // option) — always drops back to the root list for the next open.
  const closeMore = useCallback(() => {
    setShowMore(false);
    setMoreSection(null);
  }, []);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639.98px)");
    const sync = () => setIsCompact(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Episode drawer — Netflix-style panel sliding in from the right, over the
  // video. Two flags: `drawerOpen` marks it open (or in its exit transition),
  // `drawerIn` drives the translate. The panel itself stays mounted whenever
  // there is anything to show — closed it sits `translate-x-full` behind
  // `pointer-events-none` + `inert` (unclickable, out of the tab order and
  // out of the a11y tree) — which lets the franchise dropdown docked at its
  // top ship in the initial HTML instead of materialising only after the
  // first fullscreen tap.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerIn, setDrawerIn] = useState(false);
  const drawerCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The slide-in is two chained animation frames; this holds whichever frame
  // is still pending so `closeDrawer` can cancel it. Without that, a close
  // landing inside the two-frame window (Escape right after the handle,
  // fullscreen dropping out from under the open) would be *undone* by the
  // late `setDrawerIn(true)` — stranding a fully on-screen drawer that is
  // simultaneously `inert` + pointer-events-none: visible, and dead.
  const drawerSlideRafRef = useRef<number | null>(null);
  const drawerCurrentRef = useRef<HTMLButtonElement>(null); // row to scroll into view
  const drawerListRef = useRef<HTMLDivElement>(null); // list scrolled to that row

  // Franchise / season dropdown — docked at the top of the drawer, above the
  // episode list. One open flag; the trigger's wrapper is the "inside" test
  // for the shared outside-click closer, and `franchiseOpenRef` mirrors the
  // flag for the []-deps keyboard handler (its Escape must drop the dropdown
  // first, only then the drawer).
  const [franchiseOpen, setFranchiseOpen] = useState(false);
  const franchiseOpenRef = useRef(franchiseOpen);
  franchiseOpenRef.current = franchiseOpen;
  const franchiseWrapRef = useRef<HTMLDivElement>(null);
  // Set on pointerdown on the drawer's scrim: was the franchise dropdown open
  // at that moment? The scrim then drops the dropdown only (its own click),
  // so one tap per layer — exactly how Escape unwinds it.
  const franchiseOnScrimRef = useRef(false);
  // The drawer exists whenever EITHER list does — episodes alone, a franchise
  // with nothing to page, or both.
  const hasEpisodeList = (episodes?.length ?? 0) > 0;
  const hasFranchise = (franchise?.length ?? 0) > 1;
  const hasDrawer = hasEpisodeList || hasFranchise;
  const currentFranchise = franchise?.find((entry) => entry.current);
  // Series dropdown order — the SAME persisted mode the watch page's
  // `// Franchise` grid uses (`useFranchiseSort`'s store notifies both), so
  // flipping Default/Time/Type up there re-orders this list live too.
  const [franchiseSort] = useFranchiseSort();
  const franchiseGroups = useMemo(
    () => (franchise ? franchiseSortGroups(franchise, franchiseSort) : []),
    [franchise, franchiseSort]
  );

  // ─── Series/episode switch overlay ───────────────────────────────
  // Armed by `beginSwitch` on the clicking instance, and re-armed from the
  // sessionStorage handoff on the *next* instance (the route change remounts
  // this whole subtree). Dismissal tracks the real load: `loading` flips false
  // when the attempt reports ready (MANIFEST_PARSED / loadedmetadata) or when
  // the error overlay takes over — never on a fixed delay.
  const [switchTo, setSwitchTo] = useState<SwitchHandoff | null>(null);
  const [switchFade, setSwitchFade] = useState(false);

  // Mount: adopt the handoff the outgoing instance stashed (if this mount was
  // caused by a switch) and make sure fullscreen came through with us.
  useEffect(() => {
    const h = readSwitchHandoff();
    if (!h) return;
    clearSwitchHandoff();
    setSwitchFade(false);
    setSwitchTo(h);

    // Fullscreen intent. With <html> as the fullscreen element (see
    // `toggleFullscreen`) nothing in the route change *can* drop it — but if
    // this browser refused to fullscreen <html> in the first place (or the
    // platform dropped it anyway), ask again right now: this effect still
    // runs inside the click's transient-activation window, which is exactly
    // what Chrome/Safari check. A rejection arms one gesture-based retry.
    // The `standard || webkit` probe again: reading only `fullscreenElement`
    // on a prefixed-only build reports "dropped" when it never was, and we
    // would ask for a fullscreen we already have (denied → stray retry arm).
    const fsDoc = document as any;
    if (h.fs && (fsDoc.fullscreenElement || fsDoc.webkitFullscreenElement) == null) {
      const el = document.documentElement as any;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) {
        try {
          const p = req.call(el);
          if (p && typeof p.catch === "function") p.catch(() => armFullscreenRetry());
        } catch {
          armFullscreenRetry();
        }
      } else {
        armFullscreenRetry();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dismissal: stay up while `loading` is true (real fetch + manifest), then
  // hold at least SWITCH_MIN_MS from the click so an instant load fades
  // instead of flashing, then fade out over 320ms. Never a fixed delay.
  useEffect(() => {
    if (!switchTo) {
      setSwitchFade(false);
      return;
    }
    if (loading) return; // still loading — re-run when `loading` flips
    const holdLeft = Math.max(0, switchTo.t + SWITCH_MIN_MS - Date.now());
    const fadeTimer = setTimeout(() => setSwitchFade(true), holdLeft);
    const dropTimer = setTimeout(() => setSwitchTo(null), holdLeft + 320);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(dropTimer);
    };
  }, [switchTo, loading]);

  /**
   * Start a switch from inside the player: arm the overlay on THIS instance
   * (so it covers the RSC fetch too) and stash the handoff for the next one.
   * Fullscreen is not touched here — it lives on <html> and survives.
   */
  const beginSwitch = useCallback(
    (next: { kind: "episode" | "series"; series?: string; episode: number; epTitle?: string }) => {
      const handoff: SwitchHandoff = {
        t: Date.now(),
        fs: isFullscreenRef.current,
        kind: next.kind,
        series: next.series ?? animeTitle,
        episode: next.episode,
        epTitle: next.epTitle,
      };
      writeSwitchHandoff(handoff);
      setSwitchFade(false);
      setSwitchTo(handoff);
    },
    [animeTitle]
  );

  // Auto-play next episode
  const [autoPlayNext, setAutoPlayNext] = useState(false);
  // Next-episode countdown (Netflix-style overlay) — set to 10 when the
  // episode ends with auto-play armed, ticks to 0, then navigates.
  const [countdown, setCountdown] = useState<number | null>(null);

  // Skip intro / outro — from AniSkip per-episode timestamps
  const [introSegment, setIntroSegment] = useState<{ start: number; end: number } | null>(null);
  const [outroSegment, setOutroSegment] = useState<{ start: number; end: number } | null>(null);
  const [autoSkipEnabled, setAutoSkipEnabled] = useState(false);

  // Subtitle timing offset (seconds)
  const [subtitleOffset, setSubtitleOffset] = useState(0);
  // Subtitle size: "small" | "medium" | "large"
  const [subtitleSize, setSubtitleSize] = useState<"small" | "medium" | "large">("medium");

  // OpenSubtitles state
  const [osResults, setOsResults] = useState<
    { file_id: number; language: string; release: string; hearing_impaired: boolean; ai_translated: boolean }[]
  >([]);
  const [osLoading, setOsLoading] = useState(false);
  const [osError, setOsError] = useState<string | null>(null);
  const [osSearched, setOsSearched] = useState(false);
  const [osPage, setOsPage] = useState(1);
  const [osFilterQuery, setOsFilterQuery] = useState("");
  const [activeOSSubtitleId, setActiveOSSubtitleId] = useState<number | null>(null);
  const [osDownloadError, setOsDownloadError] = useState<string | null>(null);
  const failedOSIdsRef = useRef(new Set<number>()); // track failed downloads

  // Refs for keyboard handler and callbacks (stable across renders)
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const showControlsRef = useRef(showControls);
  showControlsRef.current = showControls;
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;
  const spaceDownRef = useRef(0);
  const spaceWasPlayingRef = useRef(false);
  const hasProviderSkipRef = useRef(false); // tracks if provider supplied skip times

  // ─── Playback progress persistence ────────────────────
  const storageKey = useMemo(
    () => `n54tv-progress-${anilistId || animeTitle}-${episodeNumber}`,
    [anilistId, animeTitle, episodeNumber]
  );

  const saveProgress = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.duration < 1) return;
    // Don't save if within 5s of end — treat as finished
    if (video.duration - video.currentTime < 5) {
      try { localStorage.removeItem(storageKey); } catch {}
      return;
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        time: video.currentTime,
        volume: video.volume,
        speed: video.playbackRate,
        muted: video.muted,
        subtitle: activeSubtitle,
        subtitleOffset,
        subtitleSize,
        autoSkip: autoSkipEnabled,
        autoPlayNext,
        audioType,
        videoFilter,
        ts: Date.now(),
      }));
    } catch {}
  }, [storageKey, activeSubtitle, subtitleOffset, subtitleSize, autoSkipEnabled, autoPlayNext, audioType, videoFilter]);

  const restoreProgress = useCallback(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const data = JSON.parse(raw);
      // Expire after 30 days
      if (data.ts && Date.now() - data.ts > 30 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem(storageKey);
        return null;
      }
      return data;
    } catch { return null; }
  }, [storageKey]);

  // Derived
  const availableQualities = useMemo(
    () => hlsLevels.length > 0
      ? ["auto", ...hlsLevels.map((l) => l.name)]
      : Array.from(new Set(sources.map((s) => s.quality).filter(Boolean))),
    [hlsLevels, sources]
  );
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const inIntro = !!introSegment && currentTime >= introSegment.start && currentTime < introSegment.end && duration > 0;
  const inOutro = !!outroSegment && currentTime >= outroSegment.start && currentTime < outroSegment.end && duration > 0;
  // Speed picker options: presets plus the current rate when it came from a
  // ±0.25 keyboard step, so the active rate is always highlighted
  const speedOptions = useMemo(() => {
    const opts = new Set(SPEED_PRESETS);
    opts.add(playbackRate);
    return [...opts].sort((a, b) => a - b);
  }, [playbackRate]);
  // Prev/next episode targets for the control bar (prev never goes below EP 1)
  const prevEpisodeTarget = episodeNumber > 1 && anilistId ? episodeNumber - 1 : null;
  const nextEpisodeTarget = nextEpisodeNumber && anilistId ? nextEpisodeNumber : null;
  // Title of that next episode, for the countdown card
  const nextEpisodeTitle = nextEpisodeTarget
    ? episodes?.find((ep) => ep.number === nextEpisodeTarget)?.title
    : undefined;

  // ─── Attempt watchdog ────────────────────────────────────
  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  // ─── Destroy HLS ────────────────────────────────────────
  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    // A torn-down instance can never report progress again — retire its
    // attempt so its watchdog/handlers can't fire against a newer load.
    clearWatchdog();
    attemptStateRef.current = "idle";
    failAttemptRef.current = null;
  }, [clearWatchdog]);

  // The running attempt produced a usable stream: dismiss the loading bar
  // here (HLS: MANIFEST_PARSED, progressive: loadedmetadata).
  const markAttemptReady = useCallback(() => {
    if (attemptStateRef.current !== "pending") return;
    clearWatchdog();
    attemptStateRef.current = "ready";
    setStreamError(false);
    setLoading(false);
  }, [clearWatchdog]);

  // ─── Load HLS stream ────────────────────────────────────
  const loadHls = useCallback(
    (srcs: StreamSource[], headers: Record<string, string> | null, autoPlay: boolean) => {
      const video = videoRef.current;
      if (!video) {
        // Nothing to attach media to — surface the error instead of hanging.
        setLoading(false);
        setStreamError(true);
        return;
      }

      destroyHls(); // also retires any previous attempt (watchdog + handlers)
      triedUrlsRef.current = new Set();

      // Restrict to sources the browser can actually play (.mpd/DASH is excluded)
      const playable = srcs.filter(isPlayableSource);
      if (playable.length === 0) {
        setLoading(false);
        setStreamError(true);
        return;
      }

      // Pick the source matching selected quality, or fallback
      const pick = (pool: StreamSource[]): StreamSource | undefined =>
        pool.find((s) => s.quality === currentQualityRef.current) ||
        pool.find((s) => s.quality === "1080p") ||
        pool.find((s) => s.quality === "720p") ||
        pool.find((s) => s.quality === "480p") ||
        pool.find((s) => s.isM3U8 && Hls.isSupported()) ||
        pool[0];

      // ── Attempt lifecycle ──────────────────────────────────────────
      // Each selected source is one bounded "attempt":
      //   • fatal NETWORK_ERROR → startLoad() at most 2×, then fail attempt
      //   • fatal MEDIA_ERROR   → recoverMediaError() at most 2×, then fail attempt
      //   • any other fatal     → fail attempt immediately
      //   • watchdog (15s)      → fail attempt if the stream never becomes ready
      // Failing = destroyHls → next untried source; when the pool is exhausted
      // → setStreamError(true) (the failover effect then rotates servers, or
      // the error overlay renders). No recovery path is unbounded any more.
      const tryLoad = (pool: StreamSource[]) => {
        const selected = pick(pool);
        if (!selected) {
          // Pool exhausted — the error overlay requires !loading, so error wins.
          setLoading(false);
          setStreamError(true);
          return;
        }
        triedUrlsRef.current.add(selected.url);

        // ── Arm a fresh attempt ──
        const netRecoveries = { used: 0 };
        const mediaRecoveries = { used: 0 };
        setLoading(true); // honest: the bar stays up until media is ready
        setSlowLoad(false);
        attemptStateRef.current = "pending";

        const fail = () => {
          if (failAttemptRef.current !== fail) return; // superseded attempt
          failAttemptRef.current = null;
          destroyHls(); // tears down hls and clears this attempt's watchdog
          const next = pool.filter((s) => !triedUrlsRef.current.has(s.url));
          if (next.length > 0) {
            tryLoad(next);
          } else {
            // Drop a broken direct-play src so it can't keep erroring.
            const v = videoRef.current;
            if (v?.getAttribute("src")) {
              try {
                v.removeAttribute("src");
                v.load();
              } catch {}
            }
            setLoading(false);
            setStreamError(true);
          }
        };
        failAttemptRef.current = fail;

        // Watchdog: no MANIFEST_PARSED / loadedmetadata / fatal error within
        // 15s means this attempt is silently stuck on a black frame — fail it.
        clearWatchdog();
        watchdogRef.current = setTimeout(() => {
          watchdogRef.current = null;
          fail();
        }, 15000);

        if (selected.isM3U8 && Hls.isSupported()) {
          // Always through /api/proxy: the CDN requires a Referer and sends no
          // CORS headers, so a direct cross-origin load fails silently.
          const loadUrl = proxyUrl(selected.url, headers);

          const hls = new Hls({
            // Startup — start low, ramp up fast
            startLevel: -1,
            testBandwidth: true,
            abrEwmaDefaultEstimate: 2_000_000,
            startFragPrefetch: true,
            maxLoadingDelay: 200,

            // Buffer — generous to avoid desktop stalling
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferSize: 60 * 1000 * 1000,
            backBufferLength: 30,
            maxBufferHole: 0.5,

            // VOD: disable LL-HLS
            lowLatencyMode: false,

            // Network — aggressive retries reduce stall duration
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 200,
            manifestLoadingMaxRetry: 4,
            manifestLoadingRetryDelay: 100,
            levelLoadingMaxRetry: 4,
            levelLoadingRetryDelay: 100,
            fragLoadingTimeOut: 15000,
            manifestLoadingTimeOut: 8000,
            levelLoadingTimeOut: 10000,

            // Cap quality to player size (saves bandwidth on mobile)
            capLevelToPlayerSize: true,

            enableWorker: true,
          });
          hls.loadSource(loadUrl);
          hls.attachMedia(video);
          hlsRef.current = hls;

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (failAttemptRef.current !== fail) return; // superseded attempt
            markAttemptReady(); // loading dismissed + watchdog cleared
            setStreamError(false);
            // Restore saved progress
            const saved = restoreProgress();
            if (saved && saved.time > 0) {
              video.currentTime = saved.time;
            }
            if (autoPlay) {
              video.play().catch(() => {});
            }
            // Expose HLS internal quality levels
            if (hls.levels?.length) {
              const levels = hls.levels.map((l, i) => ({
                index: i,
                height: l.height || 0,
                name: l.height ? `${l.height}p` : `Level ${i}`,
              }));
              setHlsLevels(levels);
              setCurrentQuality("auto");
              currentQualityRef.current = "auto";
            }
          });

          // Track auto-selected level for display
          hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
            if (hls.currentLevel === -1 && hls.levels?.[data.level]) {
              const h = hls.levels[data.level].height;
              if (h) {
                setCurrentQuality(`${h}p`);
                currentQualityRef.current = `${h}p`;
              }
            }
          });

          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                if (netRecoveries.used < 2) {
                  netRecoveries.used += 1;
                  try {
                    hls.startLoad();
                  } catch {
                    fail();
                  }
                } else {
                  fail();
                }
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                if (mediaRecoveries.used < 2) {
                  mediaRecoveries.used += 1;
                  // Same detach caveat as recoverStream: recoverMediaError()
                  // resets currentTime to 0 and drops the SourceBuffers —
                  // restore position + play state or the element freezes at
                  // 0:00 while the buffer restarts at `pos`.
                  const pos = video.currentTime;
                  const wasPlaying = video.paused === false;
                  try {
                    hls.recoverMediaError();
                    if (Math.abs(video.currentTime - pos) > 1) video.currentTime = pos;
                    if (wasPlaying) video.play().catch(() => {});
                  } catch {
                    fail();
                  }
                } else {
                  fail();
                }
                break;
              default:
                // Any other fatal error fails the attempt right away; `fail`
                // moves on to the next untried playable source (tried-set
                // prevents re-selecting the same failing URL).
                fail();
            }
          });
        } else {
          // Direct play for progressive files — also through /api/proxy,
          // otherwise the CDN 403s (no Referer) and the browser blocks the
          // cross-origin response (no CORS headers).
          video.src = proxyUrl(selected.url, headers);
          if (autoPlay) {
            video.play().catch(() => {});
          }
        }
      };

      tryLoad(playable);
    },
    [destroyHls, clearWatchdog, markAttemptReady]
  );

  // ─── Fetch stream with server fallback ──────────────────
  const fetchStream = useCallback(
    async (type: "sub" | "dub") => {
      const fid = ++fetchIdRef.current;
      setLoading(true);
      setSlowLoad(false);
      setStreamError(false);
      setStreamErrorDetail(null);
      lastApiErrorRef.current = null;
      // Set once a load attempt owns the loading state (it dismisses the bar
      // on MANIFEST_PARSED / loadedmetadata).
      let handedOffToAttempt = false;

      try {
        for (const server of SERVERS) {
          if (fid !== fetchIdRef.current) return;

          const params = new URLSearchParams({
            title: animeTitle,
            episode: String(episodeNumber),
            type,
            server,
          });
          if (anilistId) params.set("anilistId", String(anilistId));
          if (activeProvider) params.set("providerId", activeProvider);

          const res = await fetch(`/api/stream?${params}`);
          if (!res.ok) continue;

          const data = await res.json();
          if (fid !== fetchIdRef.current) return;

          if (data.sources?.length > 0) {
            setSources(data.sources);
            setSubtitles(data.subtitles || []);
            setStreamHeaders(data.headers || null);
            setStreamError(false);
            setStreamErrorDetail(null);
            lastApiErrorRef.current = null;
            handedOffToAttempt = true;
            loadHls(data.sources, data.headers || null, true);
            return;
          }
          // No sources here: remember the server's reason for the card below.
          if (typeof data?.error === "string" && data.error) lastApiErrorRef.current = data.error;
        }

        // If we exhausted all servers with no success
        if (fid === fetchIdRef.current) {
          setStreamErrorDetail(lastApiErrorRef.current);
          setStreamError(true);
        }
      } catch {
        if (fid === fetchIdRef.current) setStreamError(true);
      } finally {
        // Safety net so the loading overlay can never be stranded over an
        // error: error paths clear it here, successful loads clear it when
        // their attempt becomes ready.
        if (fid === fetchIdRef.current && !handedOffToAttempt) setLoading(false);
      }
    },
    [animeTitle, episodeNumber, anilistId, activeProvider, loadHls]
  );

  // ─── Probe a specific server for a given type ──────────
  const probeServer = useCallback(
    async (server: string, type: "sub" | "dub"): Promise<{
      sources: StreamSource[];
      subtitles: Subtitle[];
      headers: Record<string, string>;
      providerId?: string;
    } | null> => {
      try {
        const params = new URLSearchParams({
          title: animeTitle,
          episode: String(episodeNumber),
          type,
          server,
        });
        if (anilistId) params.set("anilistId", String(anilistId));
        if (activeProvider) params.set("providerId", activeProvider);
        const res = await fetch(`/api/stream?${params}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.sources?.length > 0) {
          return {
            sources: data.sources,
            subtitles: data.subtitles || [],
            headers: data.headers || {},
            providerId: data.providerId,
          };
        }
        // Probe failed — record the server's reason for the error card.
        if (typeof data?.error === "string" && data.error) lastApiErrorRef.current = data.error;
      } catch { /* skip */ }
      return null;
    },
    [animeTitle, episodeNumber, anilistId, activeProvider]
  );

  // ─── Auto-detect all working servers ──────────────────
  const discoverServers = useCallback(
    async (type: "sub" | "dub"): Promise<{ server: string; data: NonNullable<Awaited<ReturnType<typeof probeServer>>> }[]> => {
      const results = await Promise.all(
        SERVERS.map(async (s) => {
          const data = await probeServer(s, type);
          return data ? { server: s, data } : null;
        })
      );
      return results.filter(Boolean) as any;
    },
    [probeServer]
  );

  // ─── Load stream by type ────────────────────────────────
  const loadByType = useCallback(
    async (type: "sub" | "dub", serverOverride?: string) => {
      setAudioType(type);
      setLoading(true);
      setSlowLoad(false);
      setStreamError(false);
      setStreamErrorDetail(null);
      lastApiErrorRef.current = null;

      // Get all working servers for this type
      const working = await discoverServers(type);
      if (working.length > 0) {
        setAvailableServers(working.map((w) => w.server));
        // Use provided server, or prefer current active, or first working
        const target = serverOverride
          ? working.find((w) => w.server === serverOverride) ?? working[0]
          : activeServerRef.current
            ? working.find((w) => w.server === activeServerRef.current) ?? working[0]
            : working[0];
        setActiveServer(target.server);
        activeServerRef.current = target.server;
        setSources(target.data.sources);
        setSubtitles(target.data.subtitles);
        setStreamHeaders(target.data.headers);
        // One of the probes answered — any reason they reported is obsolete.
        setStreamErrorDetail(null);
        lastApiErrorRef.current = null;
        // Populate failover queue with the other working servers
        workingServersRef.current = working.map((w) => ({
          server: w.server,
          sources: w.data.sources,
          subtitles: w.data.subtitles,
          headers: w.data.headers,
          providerId: w.data.providerId,
        }));
        failoverQueueRef.current = working
          .filter((w) => w.server !== target.server)
          .map((w) => w.server);
        setLoading(false);
        loadHls(target.data.sources, target.data.headers, true);
      } else {
        setLoading(false);
        setStreamErrorDetail(lastApiErrorRef.current);
        setStreamError(true);
      }
    },
    [discoverServers, loadHls]
  );

  // ─── Auto-load sub & detect dub on mount ────────
  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setSlowLoad(false);
    setStreamError(false);
    setStreamErrorDetail(null);
    lastApiErrorRef.current = null;
    setDubProbeOk(false);
    hasProviderSkipRef.current = false;
    hasSetInitialSubRef.current = false;

    // Reset OpenSubtitles state for new episode
    setOsSearched(false);
    setOsResults([]);
    setOsError(null);
    setOsDownloadError(null);
    setActiveOSSubtitleId(null);
    failedOSIdsRef.current.clear();
    hasAutoLoadedDubSubRef.current = false;
    setSubtitleOffset(0);
    setSubtitleSize("medium");
    setOsPage(1);
    setOsFilterQuery("");

    // Check saved progress for audio type preference. A saved "dub" is only
    // honoured when the episode doesn't already rule a dub out — data beats
    // habit, so a dub-less episode never boots into a dub request.
    //
    // Both tests below read `dubFlag`, the ONE derived dub truth declared next
    // to the prop (server prop, else the keyed `/api/episodes` answer). They
    // used to re-read the raw `episodeHasDub` prop directly, which is the same
    // value only until the fetched answer lands — two rules for one question
    // was the last remaining re-derivation of dub truth inside the player.
    const saved = restoreProgress();
    const preferredType: "sub" | "dub" =
      saved?.audioType === "dub" && dubFlag !== false ? "dub" : "sub";

    // Legacy dub probe — only while the episode list left the flags unknown
    // (megaplay ships `null`, and >60-episode titles can't be probed there).
    // When the flag IS known this is a no-op: no requests, no guess, and
    // `dubEnabled` reads straight from the data instead.
    //
    // It deliberately starts only ONCE the preferred stream has settled
    // (see both call sites below) instead of racing it from mount: it is three
    // more `/api/stream` calls, i.e. three more provider walks fired at the
    // exact moment episode load is most congested. Same probes, same gate,
    // same `dubProbeOk` answer — only the ordering changed, and it no longer
    // holds the error overlay hostage to a probe the user didn't ask for.
    const startDubProbe = () => {
      if (cancelled || dubFlag !== null) return;
      void Promise.all(
        SERVERS.map(async (s) => {
          try {
            const d = await probeServer(s, "dub");
            return !!d;
          } catch {
            return false;
          }
        })
      ).then((dubResults) => {
        if (!cancelled && dubResults.some(Boolean)) setDubProbeOk(true);
      });
    };

    (async () => {
      // Fetch preferred stream type — try servers sequentially until one works
      for (const server of SERVERS) {
        if (cancelled) return;
        try {
          const params = new URLSearchParams({
            title: animeTitle,
            episode: String(episodeNumber),
            type: preferredType,
            server,
          });
          if (anilistId) params.set("anilistId", String(anilistId));
          if (activeProvider) params.set("providerId", activeProvider);
          const res = await fetch(`/api/stream?${params}`);
          if (!res.ok) continue;
          const data = await res.json();
          if (cancelled) return;

          if (data.sources?.length > 0) {
            setSources(data.sources);
            setSubtitles(data.subtitles || []);
            setStreamHeaders(data.headers || null);
            setActiveServer(server);
            activeServerRef.current = server;
            setAvailableServers([server]);
            setStreamError(false);
            setStreamErrorDetail(null);
            lastApiErrorRef.current = null;
            setAudioType(preferredType);
            // Don't dismiss the loading bar here — the attempt owns it and
            // clears it on MANIFEST_PARSED / loadedmetadata (or fails over).
            loadHls(data.sources, data.headers || null, true);

            // Dub probe now that the stream itself is in hand.
            startDubProbe();

            // Use provider skip times if available (more accurate than AniSkip)
            if (data.intro || data.outro) {
              hasProviderSkipRef.current = true;
              if (data.intro && !introSegment) setIntroSegment(data.intro);
              if (data.outro && !outroSegment) setOutroSegment(data.outro);
            }

            // Discover remaining sub servers in background
            const otherServers = SERVERS.filter((s) => s !== server);
            const subExtras = await Promise.all(
              otherServers.map(async (s) => {
                const d = await probeServer(s, "sub");
                return d ? s : null;
              })
            );
            const allSub = [server, ...subExtras.filter(Boolean)] as string[];
            if (!cancelled) setAvailableServers(allSub);

            return;
          }
          // No sources on this server — keep the reason for the error card.
          if (typeof data?.error === "string" && data.error) lastApiErrorRef.current = data.error;
        } catch { /* continue to next server */ }
      }

      // All sub servers failed. The error must not wait on the dub probe —
      // start it in the background so the toggle still gets its answer.
      startDubProbe();
      if (!cancelled) {
        setStreamErrorDetail(lastApiErrorRef.current);
        setStreamError(true);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      destroyHls();
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animeTitle, episodeNumber, activeProvider]);

  // ─── Warm the next episode's stream (#5) ─────────────────────
  // Switching episodes costs the *new* episode a full provider walk, and in
  // fullscreen that walk sits under the switch card with nothing else on
  // screen — so the same wait reads as "fullscreen is slower" while windowed
  // hides it behind a page that has already repainted. Arming the request as
  // soon as `nextEpisodeTarget` exists moves that walk off the click: by the
  // time the countdown fires or the user hits next, `/api/stream` for the next
  // episode is already in the route cache (5 min for a hit, 90 s for a miss,
  // so even an unplayable episode switches instantly).
  //
  // Gated on `!loading` so it never races this episode's own provider walk —
  // both would miss the shared (provider, title) session cache and duplicate
  // the search — and on a short delay so it also clears the "remaining servers"
  // discovery that runs right after a successful load. Omitting neither would
  // cost an extra walk for no benefit. `server` is pinned to the player's first
  // choice so an anikoto answer lands under the key the player will ask for.
  useEffect(() => {
    if (!nextEpisodeTarget || loading) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        title: animeTitle,
        episode: String(nextEpisodeTarget),
        type: audioType,
        server: SERVERS[0],
      });
      if (anilistId) params.set("anilistId", String(anilistId));
      if (activeProvider) params.set("providerId", activeProvider);
      void fetch(`/api/stream?${params}`, { signal: controller.signal }).catch(() => {
        /* aborted / offline — the switch simply pays the walk itself */
      });
    }, 1500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [nextEpisodeTarget, loading, audioType, animeTitle, anilistId, activeProvider]);

  // ─── Fetch AniSkip timestamps independently (non-blocking) ──
  useEffect(() => {
    if (!malId || !episodeNumber) return;
    let cancelled = false;

    (async () => {
      try {
        const params = new URLSearchParams({ malId: String(malId), episode: String(episodeNumber) });
        const res = await fetch(`/api/skip-times?${params}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) {
          // Only use AniSkip as fallback — provider skip times are preferred
          if (!hasProviderSkipRef.current) {
            if (data.intro) setIntroSegment(data.intro);
            if (data.outro) setOutroSegment(data.outro);
          }
        }
      } catch {
        // No skip data available — that's fine
      }
    })();

    return () => { cancelled = true; };
  }, [malId, episodeNumber]);

  // ─── Save progress periodically while playing ──────────
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(saveProgress, 15000); // every 15s
    return () => clearInterval(id);
  }, [playing, saveProgress]);

  // ─── Save on pause / unload ────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPause = () => saveProgress();
    video.addEventListener("pause", onPause);
    window.addEventListener("beforeunload", saveProgress);
    return () => {
      video.removeEventListener("pause", onPause);
      window.removeEventListener("beforeunload", saveProgress);
    };
  }, [saveProgress]);

  // ─── Auto-set initial subtitle track (once per stream load) ──
  const hasSetInitialSubRef = useRef(false);
  useEffect(() => {
    if (hasSetInitialSubRef.current) return;
    if (subtitles.length > 0) {
      hasSetInitialSubRef.current = true;
      const en = subtitles.find((s) => s.lang.toLowerCase().includes("en"));
      setActiveSubtitle(en ? en.url : subtitles[0].url);
    }
  }, [subtitles]);

  // ─── Auto-load AI English subs for dub episodes ─────────
  const hasAutoLoadedDubSubRef = useRef(false);
  useEffect(() => {
    if (audioType !== "dub" || hasAutoLoadedDubSubRef.current) return;
    if (!animeTitle || !episodeNumber) return;
    // Only auto-load if stream is loaded
    if (loading || sources.length === 0) return;

    hasAutoLoadedDubSubRef.current = true;

    (async () => {
      try {
        const params = new URLSearchParams({
          query: animeTitle,
          season_number: "1",
          episode_number: String(episodeNumber),
          languages: "en",
        });
        const res = await fetch(`/api/opensubtitles?${params}`);
        if (!res.ok) return;
        const data = await res.json();
        const results = data.results ?? [];
        if (results.length === 0) return;

        // Pick the best result — prefer AI-translated for dub (they're timed for dubbed audio)
        const ai = results.find((r: any) => r.ai_translated);
        const best = ai || results[0];

        // Download the subtitle
        const dlRes = await fetch(`/api/opensubtitles?file_id=${best.file_id}&sub_format=vtt`);
        if (!dlRes.ok) return;
        const blob = await dlRes.blob();
        if (blob.size < 50) return;

        const url = URL.createObjectURL(blob);
        // Add to subtitles list right at the top (after Off)
        const aiLabel = `English (AI)`;
        setSubtitles((prev) => {
          // Don't duplicate if already present
          if (prev.some((s) => s.url === url)) return prev;
          return [{ url, lang: aiLabel }, ...prev];
        });
        setActiveSubtitle(url);
        setActiveOSSubtitleId(best.file_id);
        // Mark as searched so user can see results in picker
        setOsSearched(true);
        setOsResults(results);
      } catch {
        // Silent fail — user can manually search
      }
    })();
  }, [audioType, animeTitle, episodeNumber, loading, sources.length]);

  // ─── OpenSubtitles search ──────────────────────────────
  const searchOpenSubtitles = useCallback(async (page = 1) => {
    if (osLoading) return;

    setOsLoading(true);
    setOsError(null);
    if (page === 1) setOsSearched(true);

    try {
      const params = new URLSearchParams({
        query: animeTitle,
        season_number: "1",
        episode_number: String(episodeNumber),
        languages: "en",
        page: String(page),
      });

      const res = await fetch(`/api/opensubtitles?${params}`);
      if (!res.ok) {
        setOsError("Search failed");
        return;
      }
      const data = await res.json();
      const newResults = data.results ?? [];

      if (page === 1) {
        setOsResults(newResults);
      } else {
        setOsResults((prev) => [...prev, ...newResults]);
      }
      setOsPage(page);

      if (newResults.length === 0 && page === 1) {
        setOsError("No subtitles found");
      }
    } catch {
      setOsError("Search failed");
    } finally {
      setOsLoading(false);
    }
  }, [animeTitle, episodeNumber, osLoading]);

  // ─── Select an OpenSubtitles subtitle ──────────────────
  const selectOSSubtitle = useCallback(async (fileId: number) => {
    try {
      setOsDownloadError(null);
      const res = await fetch(`/api/opensubtitles?file_id=${fileId}&sub_format=vtt`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setOsDownloadError(data?.error || `Download failed (${res.status})`);
        failedOSIdsRef.current.add(fileId);
        return;
      }

      const blob = await res.blob();
      if (blob.size < 50) {
        setOsDownloadError("Subtitle file is empty");
        failedOSIdsRef.current.add(fileId);
        return;
      }
      const url = URL.createObjectURL(blob);

      // Revoke previous OS blob URL if any
      if (activeSubtitle?.startsWith("blob:")) {
        URL.revokeObjectURL(activeSubtitle);
      }

      setActiveSubtitle(url);
      // Track which OS subtitle is active
      setActiveOSSubtitleId(fileId);
      closeMore();
    } catch (e) {
      setOsDownloadError(e instanceof Error ? e.message : "Download failed");
      failedOSIdsRef.current.add(fileId);
    }
  }, [activeSubtitle, closeMore]);

  // ─── Controls auto-hide ────────────────────────────────
  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      // The ⋯ menu parks right above the control bar — never yank the bar
      // out from under an open menu.
      if (playingRef.current && !moreOpenRef.current) setShowControls(false);
    }, 3000);
  }, []);

  useEffect(() => {
    // Play/pause must not force the HUD visible — it used to flash the whole
    // control bar on every keyboard toggle. Only refresh the hide countdown
    // when the bar is already showing; otherwise leave it alone: the toggle
    // itself carries no overlay, so a hidden bar simply stays hidden.
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    if (showControlsRef.current) {
      controlsTimerRef.current = setTimeout(() => {
        if (playingRef.current && !moreOpenRef.current) setShowControls(false);
      }, 3000);
    }
    return () => {
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    };
  }, [playing]);

  // ─── Close menus on outside click ───────────────────────
  useEffect(() => {
    const closeIfOutside = (e: PointerEvent) => {
      const t = e.target as Node;
      // Clicks inside the ⋯ panel must not dismiss it, and its trigger is
      // exempt too — the trigger toggles the menu itself (exposing it here
      // would close-then-reopen it on the same click).
      if (showMore && moreWrapRef.current && moreBtnRef.current &&
          !moreWrapRef.current.contains(t) && !moreBtnRef.current.contains(t) &&
          !moreDismissRef.current?.contains(t)) {
        closeMore();
      }
      if (showSpeedPicker && speedWrapRef.current && !speedWrapRef.current.contains(t)) setShowSpeedPicker(false);
      // Drawer's franchise dropdown: the trigger's wrapper counts as inside
      // (the trigger toggles it itself — exposing it would close-then-reopen
      // on the same tap). The drawer's own backdrop click closes the drawer,
      // which drops the dropdown with it.
      if (franchiseOpen && franchiseWrapRef.current && !franchiseWrapRef.current.contains(t)) {
        setFranchiseOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeIfOutside);
    return () => document.removeEventListener("pointerdown", closeIfOutside);
  }, [showMore, showSpeedPicker, franchiseOpen, closeMore]);

  // ─── Handlers ──────────────────────────────────────────
  const handleTimeUpdate = useCallback(() => {
    const now = performance.now();
    if (now - lastTimeUpdateRef.current >= 250) {
      lastTimeUpdateRef.current = now;
      if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
    }
  }, []);

  // Sample video.buffered → seekbar % ranges. Quantised to 0.5% and keyed so
  // the frequent `progress` events never re-render when nothing moved; an
  // empty buffer (episode switch, detach) clears the segment list.
  const handleBufferProgress = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.buffered.length === 0) {
      if (bufferedKeyRef.current !== "") {
        bufferedKeyRef.current = "";
        setBufferedRanges([]);
      }
      return;
    }
    if (!isFinite(v.duration) || v.duration <= 0) return;
    const ranges: { start: number; end: number }[] = [];
    for (let i = 0; i < v.buffered.length; i++) {
      ranges.push({
        start: (v.buffered.start(i) / v.duration) * 100,
        end: (v.buffered.end(i) / v.duration) * 100,
      });
    }
    const key = ranges.map((r) => `${Math.round(r.start * 2)}-${Math.round(r.end * 2)}`).join(",");
    if (key === bufferedKeyRef.current) return;
    bufferedKeyRef.current = key;
    setBufferedRanges(ranges);
  }, []);
  // ─── Content aspect — the windowed box follows the stream's own ratio ──
  // The frame starts at 16:9 (what it shows before any metadata exists) and
  // then adopts the element's real videoWidth:videoHeight. The dims guard
  // makes this stick: it only ever acts on an ACTUAL dimension change, so an
  // HLS level switch to another level with the same storage size — or a
  // different size at the same ratio — cannot oscillate the layout (the
  // functional update below also no-ops when the ratio is unchanged).
  const [contentAspect, setContentAspect] = useState(16 / 9);
  const contentDimsRef = useRef<{ w: number; h: number } | null>(null);
  const syncContentAspect = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) return; // metadata not there yet — keep the default
    const ratio = w / h;
    if (ratio < 0.5 || ratio > 3.5) return; // ignore nonsense metadata
    const prev = contentDimsRef.current;
    if (prev && prev.w === w && prev.h === h) return; // dimensions didn't change
    contentDimsRef.current = { w, h };
    setContentAspect((cur) => (Math.abs(cur - ratio) < 0.001 ? cur : ratio));
  }, []);

  // Dimensions can also change AFTER load (an HLS level switch to a level
  // stored at a different size) — the media element's `resize` event is the
  // exact signal that videoWidth/videoHeight changed, so re-read there.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.addEventListener("resize", syncContentAspect);
    return () => v.removeEventListener("resize", syncContentAspect);
  }, [syncContentAspect]);

  const handleLoadedMetadata = () => {
    // Progressive/direct-src attempt now has media metadata — it is playable,
    // so this is where its loading bar is dismissed (HLS dismisses on
    // MANIFEST_PARSED). No-op unless an attempt is still pending.
    markAttemptReady();
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
      // Metadata carries the real frame size — adopt it for the box aspect.
      syncContentAspect();
      // Restore saved preferences
      const saved = restoreProgress();
      if (saved) {
        videoRef.current.volume = saved.volume ?? 1;
        setVolume(saved.volume ?? 1);
        videoRef.current.muted = saved.muted ?? false;
        setMuted(saved.muted ?? false);
        videoRef.current.playbackRate = saved.speed ?? 1;
        setPlaybackRate(saved.speed ?? 1);
        playbackRateRef.current = saved.speed ?? 1;
        if (saved.autoSkip !== undefined) setAutoSkipEnabled(saved.autoSkip);
        if (saved.autoPlayNext !== undefined) setAutoPlayNext(saved.autoPlayNext);
        if (typeof saved.subtitleOffset === "number") {
          setSubtitleOffset(saved.subtitleOffset);
        }
        if (saved.subtitleSize === "small" || saved.subtitleSize === "medium" || saved.subtitleSize === "large") {
          setSubtitleSize(saved.subtitleSize);
        }
        if (saved.videoFilter && FILTER_PRESETS.some((f) => f.id === saved.videoFilter)) {
          setVideoFilter(saved.videoFilter);
        }
      }
    }
  };

  // Media-element failures (progressive 403/decode, MSE attach errors) are
  // never reported by hls.js and used to vanish silently — fail the current
  // attempt so we rotate to the next source instead of freezing on black.
  const handleVideoError = () => {
    if (attemptStateRef.current === "idle") return; // no attempt running
    if (!videoRef.current?.error) return; // stale/reset event
    failAttemptRef.current?.();
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    // Pressing play after the episode ended restarts it — the countdown is off
    setCountdown(null);
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
      videoRef.current.playbackRate = playbackRateRef.current;
      setPlaying(true);
    } else {
      videoRef.current.pause();
      setPlaying(false);
    }
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.volume = v;
      videoRef.current.muted = v === 0;
      setVolume(v);
      setMuted(v === 0);
    }
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    videoRef.current.muted = !videoRef.current.muted;
    setMuted(videoRef.current.muted);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = t;
      setCurrentTime(t);
    }
    // Still interacting with this episode — cancel a running "up next" card
    setCountdown(null);
  };

  // ─── Skip ±10s (control-bar buttons; j/l are its keyboard twins) ──
  const seekBy = (delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    const max = isFinite(video.duration) && video.duration > 0 ? video.duration : Number.MAX_SAFE_INTEGER;
    video.currentTime = Math.max(0, Math.min(max, video.currentTime + delta));
    setCurrentTime(video.currentTime);
    // Skipping around means the viewer is still engaged with THIS episode —
    // drop the "up next" card instead of yanking them forward.
    setCountdown(null);
    resetControlsTimer();
  };

  // ─── Episode navigation (control-bar prev/next, drawer, countdown) ──
  const goToEpisode = useCallback(
    (n: number) => {
      if (!anilistId) return;
      // One exit door for every route change (drawer, next/prev, countdown):
      // retire the card first so it can never fire a second navigation from
      // the episode we're navigating to.
      setCountdown(null);
      saveProgress(); // SPA navigation never fires beforeunload — persist here
      // Keep the provider the user picked — dropping it would silently switch
      // back to the default provider on the next episode
      const qs = providerQuery ? `?provider=${encodeURIComponent(providerQuery)}` : "";
      // Arm the feedback overlay before the push: it paints on this instance
      // (covering the RSC fetch), then the handoff re-arms it on the next one.
      beginSwitch({
        kind: "episode",
        episode: n,
        epTitle: episodes?.find((ep) => ep.number === n)?.title,
      });
      router.push(`/anime/${anilistId}/watch/${n}${qs}`);
    },
    [anilistId, providerQuery, router, saveProgress, beginSwitch, episodes]
  );

  // ─── Episode drawer open/close (250ms slide either way) ─────
  // Drop a slide-in that hasn't painted yet (see `drawerSlideRafRef`).
  const cancelDrawerSlide = useCallback(() => {
    if (drawerSlideRafRef.current !== null) {
      cancelAnimationFrame(drawerSlideRafRef.current);
      drawerSlideRafRef.current = null;
    }
  }, []);

  const openDrawer = useCallback(() => {
    if (drawerCloseTimerRef.current) {
      clearTimeout(drawerCloseTimerRef.current);
      drawerCloseTimerRef.current = null;
    }
    cancelDrawerSlide();
    franchiseOnScrimRef.current = false;
    // Opening a surface drops the others — the same set the ⋯ trigger clears
    // when it opens: a control-bar picker left open underneath would reappear
    // the moment the drawer closes, and the drawer is the modal now. No-ops
    // (false → false) in the normal flow, so the usual path stays put.
    setShowSpeedPicker(false);
    setDrawerOpen(true);
    // The panel is already in the DOM (closed, off-screen); slide it in on
    // the next frame so the browser has a style to transition from. Each
    // frame's id is parked in `drawerSlideRafRef` — including the inner one —
    // so a close arriving before the slide starts can still cancel it.
    drawerSlideRafRef.current = requestAnimationFrame(() => {
      drawerSlideRafRef.current = requestAnimationFrame(() => {
        drawerSlideRafRef.current = null;
        setDrawerIn(true);
      });
    });
  }, [cancelDrawerSlide]);

  const closeDrawer = useCallback(() => {
    // The dropdown lives inside the drawer — never strand it open.
    setFranchiseOpen(false);
    // …and never strand a queued slide-in either: it would flip `drawerIn`
    // back to true after this close and pin the panel on screen.
    cancelDrawerSlide();
    setDrawerIn(false);
    if (drawerCloseTimerRef.current) clearTimeout(drawerCloseTimerRef.current);
    drawerCloseTimerRef.current = setTimeout(() => {
      drawerCloseTimerRef.current = null;
      setDrawerOpen(false);
    }, 260);
  }, [cancelDrawerSlide]);

  // Don't leave a pending unmount timer (or frame) behind
  useEffect(() => () => {
    if (drawerCloseTimerRef.current) clearTimeout(drawerCloseTimerRef.current);
    if (drawerSlideRafRef.current !== null) cancelAnimationFrame(drawerSlideRafRef.current);
  }, []);

  // Bring the current episode's row into view when the drawer opens.
  // Manual scrollTop rather than scrollIntoView: scrollIntoView would also
  // centre the row in the *document*, yanking the page under the player.
  useEffect(() => {
    if (!drawerOpen) return;
    const id = requestAnimationFrame(() => {
      const box = drawerListRef.current;
      const row = drawerCurrentRef.current;
      if (!box || !row) return;
      box.scrollTop = Math.max(
        0,
        row.offsetTop - box.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2
      );
    });
    return () => cancelAnimationFrame(id);
  }, [drawerOpen]);

  // The drawer is a fullscreen-only surface — leaving fullscreen (or any
  // route that keeps this component mounted) must not strand it open over
  // the windowed player, where there is no trigger to close it from.
  useEffect(() => {
    if (!isFullscreen && drawerOpen) closeDrawer();
  }, [isFullscreen, drawerOpen, closeDrawer]);

  // The drawer and the ⋯ menu are the player's only z-50 top surfaces, and
  // the ⋯ panel is LAST in the DOM — stacked, it would punch straight through
  // the drawer's scrim and sit on the episode list. The mouse can't get there
  // (each surface's own layer covers the other's trigger), but both triggers
  // stay keyboard-focusable while covered, so both orders are reachable.
  // One rule closes the gap: whenever they overlap, the drawer — the modal —
  // wins and the menu drops.
  useEffect(() => {
    if (drawerOpen && showMore) closeMore();
  }, [drawerOpen, showMore, closeMore]);

  // ─── Next-episode countdown ────────────────────────────────
  // One tick per second; at 0 we navigate. Every re-render (time updates land
  // ~4×/s) must NOT restart the tick, so this only re-runs when `countdown`
  // itself — or a stable dep — changes.
  useEffect(() => {
    if (countdown === null) return;
    // Never auto-advance without auto-play armed or a next episode to go to
    if (!autoPlayNext || !nextEpisodeTarget) {
      setCountdown(null);
      return;
    }
    if (countdown <= 0) {
      // Short hold on 0 so the last number actually reads before we leave
      const t = setTimeout(() => {
        setCountdown(null);
        goToEpisode(nextEpisodeTarget);
      }, 700);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, autoPlayNext, nextEpisodeTarget, goToEpisode]);

  // Leaving this episode any other way (drawer row, prev/next button) must not
  // strand a card that would navigate a second time off the new page.
  useEffect(() => {
    setCountdown(null);
  }, [episodeNumber]);

  // Fullscreen is anchored to <html>, NOT to this container. A route change
  // (`…/watch/5` → `…/watch/6`, or another `[id]`) changes the App Router
  // segment's state key, so React unmounts the whole player subtree and
  // mounts a fresh one — any fullscreen element inside it is disconnected
  // and the browser drops fullscreen (Chrome/Safari: same-document
  // navigation keeps *user activation*, but it cannot keep a dead element).
  // <html> is never unmounted, so the mode itself survives; the container
  // then pins itself to the viewport with `fixed inset-0` while fullscreen
  // (see the root className) and presents exactly like the old
  // element-fullscreen did.
  const exitFullscreen = useCallback(() => {
    const doc = document as any;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc);
    }
    // Unlock orientation when exiting fullscreen
    if (screen.orientation && typeof screen.orientation.unlock === "function") {
      screen.orientation.unlock();
    }
  }, []);

  const toggleFullscreen = () => {
    const doc = document as any;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      exitFullscreen();
    } else {
      const el = document.documentElement as any;
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
      // Lock to landscape when entering fullscreen
      if (screen.orientation && typeof screen.orientation.lock === "function") {
        screen.orientation.lock("landscape").catch(() => {
          // Ignore if not supported or user denied
        });
      }
    }
  };

  // Sync isFullscreen state from actual fullscreen events (not optimistic)
  useEffect(() => {
    const doc = document as any;
    const handleFullscreenChange = () => {
      const inFs = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
      setIsFullscreen(inFs);
      if (!inFs && screen.orientation && typeof screen.orientation.unlock === "function") {
        screen.orientation.unlock();
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
    };
  }, []);

  const changeQuality = (q: string) => {
    // No change needed if already at this quality
    if (q === currentQuality) return;

    setCurrentQuality(q);
    currentQualityRef.current = q;

    if (q === "auto" && hlsRef.current) {
      hlsRef.current.currentLevel = -1;
      return;
    }

    // If an HLS level was selected, use nextLevel for smooth switching (no rebuffer)
    if (hlsLevels.length > 0 && hlsRef.current) {
      const level = hlsLevels.find((l) => l.name === q);
      if (level) {
        hlsRef.current.nextLevel = level.index;
        return;
      }
    }

    // Fallback: reload source with matching quality
    if (sources.length > 0) {
      loadHls(sources, streamHeaders, playing);
    }
  };

  const changeSpeed = (rate: number) => {
    setPlaybackRate(rate);
    setShowSpeedPicker(false);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
  };

  // Keyboard speed steps (shift+, / shift+.): ±0.25, clamped to 0.25–4.
  // Updates the rate state too, so the speed picker stays in sync.
  const stepPlaybackRate = (delta: number) => {
    const next = Math.min(4, Math.max(0.25, Math.round((playbackRateRef.current + delta) * 100) / 100));
    if (next === playbackRateRef.current) return;
    playbackRateRef.current = next;
    setPlaybackRate(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  };

  // ─── Pick a streaming provider (control-bar dropdown) ───────
  // Reuses the manual override the error overlay uses: flipping the
  // override changes `activeProvider`, which re-runs the load effect
  // and reloads the stream with that provider.
  const selectProvider = (id: string) => {
    const current = providerOverride ?? providerId ?? "";
    if (id === current) {
      // Already the active provider — on a failed stream, retry it
      if (streamError) {
        destroyHls();
        loadByType(audioType);
      }
      return;
    }
    setProviderOverride(id);
  };

  // ─── Switch sub ↔ dub ─────────────────────────────────
  const switchAudioType = useCallback(
    (type: "sub" | "dub") => {
      if (type === audioType) return;
      // Defence in depth for the muted DUB button: keyboard/AT activation can
      // reach a control a pointer never could, and the data says no dub.
      if (type === "dub" && !dubEnabled) return;
      destroyHls();
      loadByType(type);
    },
    [audioType, dubEnabled, destroyHls, loadByType]
  );

  const handleMouseMove = () => {
    resetControlsTimer();
  };

  // ─── Hold-to-2x (touch / pointer) ────────────────────
  const handlePointerDown = useCallback(() => {
    longPressRef.current = false;
    holdTimerRef.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.playbackRate = 2;
        longPressRef.current = true;
        resetControlsTimer();
      }
    }, 300);
  }, [resetControlsTimer]);

  const handlePointerUp = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (longPressRef.current && videoRef.current) {
      videoRef.current.playbackRate = playbackRateRef.current;
      longPressRef.current = false;
    }
  }, []);

  // ─── Auto-failover: try next server when stream errors ─────
  useEffect(() => {
    if (streamError && failoverQueueRef.current.length > 0 && !loading) {
      const nextServer = failoverQueueRef.current.shift()!;
      const cached = workingServersRef.current.find((w) => w.server === nextServer);
      if (cached) {
        setActiveServer(cached.server);
        activeServerRef.current = cached.server;
        setSources(cached.sources);
        setSubtitles(cached.subtitles);
        setStreamHeaders(cached.headers);
        destroyHls();
        setStreamError(false);
        loadHls(cached.sources, cached.headers, true);
      }
    }
  }, [streamError, loading, destroyHls, loadHls]);

  // ─── Auto-skip intro/outro ─────────────────────────────
  useEffect(() => {
    if (!autoSkipEnabled || !videoRef.current) return;
    if (inIntro && introSegment && videoRef.current) {
      videoRef.current.currentTime = introSegment.end;
    } else if (inOutro && outroSegment && videoRef.current) {
      videoRef.current.currentTime = outroSegment.end;
    }
  }, [autoSkipEnabled, inIntro, inOutro, introSegment, outroSegment]);

  // ─── Network recovery: reconnect HLS on network change ─────
  // Handles: online/offline events, VPN/WiFi↔mobile data switches
  // (navigator.connection), and periodic stall detection.
  useEffect(() => {
    // Stamp every seek (both start and finish). A seek loads the target
    // fragment with readyState pinned at 1–2 for 1–4s, which is otherwise
    // indistinguishable from a genuine stall — stallCheck must not recover
    // mid-seek (see the stallCheck guard below).
    const seekedAt = () => { lastSeekAtRef.current = performance.now(); };
    const videoEl = videoRef.current;
    videoEl?.addEventListener("seeking", seekedAt);
    videoEl?.addEventListener("seeked", seekedAt);

    const recoverStream = () => {
      const hls = hlsRef.current;
      const video = videoRef.current;
      if (!hls || !video || !hls.url) return;

      const pos = video.currentTime;
      const wasPlaying = video.paused === false;
      const srcs = sources;
      const hdrs = streamHeaders;

      // Try lightweight recover first, fall back to full reload
      try {
        hls.recoverMediaError();
        // recoverMediaError() detaches → reattaches the media element, and
        // the detach (removeAttribute('src') + load()) resets currentTime to
        // 0 and tears down every SourceBuffer — hls.js never seeks back.
        // Restore position + play state here or the element sits at 0 while
        // the buffer starts at `pos`: readyState stays <3 forever and every
        // later stall tick re-fires recovery (frozen at 0:00).
        if (Math.abs(video.currentTime - pos) > 1) video.currentTime = pos;
        if (wasPlaying) video.play().catch(() => {});
      } catch {
        if (srcs.length > 0) {
          loadHls(srcs, hdrs, false);
          const onManifestParsed = () => {
            if (videoRef.current) {
              videoRef.current.currentTime = pos;
              if (wasPlaying) videoRef.current.play().catch(() => {});
            }
            hls?.off(Hls.Events.MANIFEST_PARSED, onManifestParsed);
          };
          hls.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);
        }
      }
    };

    const handleOnline = () => recoverStream();

    const handleOffline = () => {
      // Don't pause — just let HLS buffer drain gracefully.
      // When the network comes back (online/connection change),
      // recoverStream will kick in.
    };

    // navigator.connection fires on WiFi↔mobile/VPN switches that
    // don't trigger the online/offline events.
    const conn = typeof navigator !== "undefined" ? (navigator as any).connection : null;
    const handleConnectionChange = () => {
      // Small delay so the OS has time to establish the new route
      setTimeout(recoverStream, 500);
    };

    // Periodic stall detection — if playback is frozen for >8s (two ticks),
    // try to recover even without a network event.
    // Two guards keep this from nuking a healthy seek:
    //  • skip while seeking / <3s after a seek (fragment fetch holds
    //    readyState at 1–2 the whole time), and
    //  • demand 2 consecutive stalled ticks, so one slow buffer refill can't
    //    trigger recoverMediaError() (which detaches the media and resets
    //    currentTime — recoverStream now repairs that, but avoid it anyway).
    let stalledTicks = 0;
    const stallCheck = setInterval(() => {
      const video = videoRef.current;
      const hls = hlsRef.current;
      if (!video || !hls || !hls.url || video.paused) { stalledTicks = 0; return; }
      if (video.readyState >= 3) { stalledTicks = 0; return; } // enough data, not stalled
      // Mid-seek or just-seeked → not a stall, don't count it either way.
      if (video.seeking || performance.now() - lastSeekAtRef.current < 3000) return;
      // Stalled and was playing — 2nd consecutive tick → try to recover
      stalledTicks += 1;
      if (stalledTicks < 2) return;
      stalledTicks = 0;
      recoverStream();
    }, 8000);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    conn?.addEventListener("change", handleConnectionChange);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      conn?.removeEventListener("change", handleConnectionChange);
      videoEl?.removeEventListener("seeking", seekedAt);
      videoEl?.removeEventListener("seeked", seekedAt);
      clearInterval(stallCheck);
    };
  }, [sources, streamHeaders, loadHls]);

  // ─── Recover stream when tab becomes visible again (mobile background) ──
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const video = videoRef.current;
      const hls = hlsRef.current;
      if (!video || !hls) return;

      // If video is stalled, try to recover
      if (video.readyState < 3 && hls.url) {
        // Capture state before recovery: same detach caveat as recoverStream —
        // recoverMediaError() does detachMedia()→attachMedia(), and the detach
        // (removeAttribute('src') + load()) resets currentTime to 0 and drops
        // the SourceBuffers, so the resume below is mandatory or the tab
        // comes back frozen at 0:00.
        const pos = video.currentTime;
        const wasPlaying = video.paused === false;
        try {
          hls.recoverMediaError();
          if (Math.abs(video.currentTime - pos) > 1) video.currentTime = pos;
          if (wasPlaying) video.play().catch(() => {});
        } catch { /* ignore */ }
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // ─── Keyboard shortcuts ──────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when user is typing in an input/select/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;

      const video = videoRef.current;
      if (!video) return;

      // shift + ,/. — step playback speed by 0.25 (clamped 0.25–4).
      // Matched on the physical key (e.code) so it works on any layout,
      // where e.key may report '<', ';', etc.
      if (e.shiftKey && (e.code === "Comma" || e.code === "Period")) {
        e.preventDefault();
        stepPlaybackRate(e.code === "Comma" ? -0.25 : 0.25);
        resetControlsTimer();
        return;
      }

      switch (e.key) {
        case ' ':
          e.preventDefault();
          // Ignore key repeat
          if (e.repeat) return;
          // Start hold-to-2x timer (same logic as pointer-based hold)
          spaceDownRef.current = performance.now();
          spaceWasPlayingRef.current = !video.paused;
          holdTimerRef.current = setTimeout(() => {
            if (video && !video.paused) {
              video.playbackRate = 2;
              longPressRef.current = true;
              resetControlsTimer();
            }
          }, 300);
          break;
        case 'k':
          e.preventDefault();
          // No HUD flash for keyboard toggles — the toggle is silent; the
          // controls surface only if the viewer already has them open
          togglePlay();
          break;
        // j / l — YouTube-style ±10s seek, the keyboard twins of the skip
        // buttons (whose tooltips name them). Holding the key repeats, so a
        // press-and-hold scrubs, exactly like the arrow keys.
        case 'j':
          e.preventDefault();
          seekBy(-10);
          break;
        case 'l':
          e.preventDefault();
          seekBy(10);
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
          e.preventDefault();
          video.muted = !video.muted;
          setMuted(video.muted);
          resetControlsTimer();
          break;
        // c — subtitles on/off. Only when a track exists (no-op otherwise);
        // repeat-guarded so a held key can't flicker the track. Both visible
        // states read activeSubtitle — the ⋯ row's On/Off value and the
        // picker's highlight — so they follow with no extra wiring. Turning
        // it back on prefers English, same as the per-stream auto-select.
        // The handler's deps re-subscribe on subtitle changes, so these
        // values are never stale inside the []-style closure.
        case 'c':
          e.preventDefault();
          if (!e.repeat && subtitles.length > 0) {
            setActiveSubtitle(
              activeSubtitle
                ? null
                : (subtitles.find((s) => s.lang.toLowerCase().includes("en")) ?? subtitles[0]).url
            );
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 10);
          setCurrentTime(video.currentTime);
          // Manual seek = still watching — dismiss the up-next card
          setCountdown(null);
          resetControlsTimer();
          break;
        case 'ArrowRight':
          e.preventDefault();
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
          setCurrentTime(video.currentTime);
          setCountdown(null);
          resetControlsTimer();
          break;
        case 'ArrowUp':
          e.preventDefault();
          { const nv = Math.min(1, video.volume + 0.1);
          video.volume = nv;
          video.muted = false;
          setVolume(nv);
          setMuted(false); }
          resetControlsTimer();
          break;
        case 'ArrowDown':
          e.preventDefault();
          { const nv = Math.max(0, video.volume - 0.1);
          video.volume = nv;
          video.muted = nv === 0;
          setVolume(nv);
          setMuted(nv === 0); }
          resetControlsTimer();
          break;
        case 'Escape':
          // Open dropdowns unwind one layer per press: the franchise list
          // first, then the rest (⋯ menu, pickers, the drawer itself).
          if (franchiseOpenRef.current) {
            setFranchiseOpen(false);
            break;
          }
          setCountdown(null);
          closeMore();
          setShowSpeedPicker(false);
          closeDrawer();
          break;
        // speed steps are handled above via e.code (shift + ,/.)
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === ' ') {
        // Clear hold timer
        if (holdTimerRef.current) {
          clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
        }
        // Restore 2x if hold fired
        if (longPressRef.current && videoRef.current) {
          videoRef.current.playbackRate = playbackRateRef.current;
          longPressRef.current = false;
        } else if (!e.repeat) {
          // Short tap — toggle play/pause (silent toggle, no HUD flash)
          togglePlay();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
    };
    // Subtitle state is a dep so the `c` handler reads the current track
    // (everything else in here is refs/stable setters).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitles, activeSubtitle]);

  // ─── ⋯ "More" menu — one panel, one popup language ───────────────
  // The panel never picks its own spot: `moreMenuAnchor` below does, and
  // every offset in it resolves against the `relative overflow-hidden`
  // container, so the menu can never render past the player's frame.
  // ROOT LIST and DRILL-DOWN both use the SAME shape at every width: a
  // content-sized popup anchored bottom-right on the 76px line, above the
  // ⋯ trigger — the desktop silhouette, not a full-width band.
  // • Width `w-56` (root) / `w-52` (drill) at ≥640px; below 640px the
  //   shared cap `min(15rem, 100% - 1.5rem)` keeps that same ~15rem column
  //   while guaranteeing ≥1.5rem of player on EACH side — the `right-3`
  //   offset matches desktop exactly, and the `1.5rem` term only wins on
  //   players narrower than ~15rem + 1.5rem, so the panel never reaches an
  //   edge (let alone past it). It is content-height by default (absolute,
  //   `bottom-` set, no `top`/`height`) — dead vertical space can't happen.
  // • `max-h` subtracts the 76px control line + ~20px headroom, so a short
  //   windowed player scrolls the list instead of pushing it off the top.
  //   Floor split below 640: the ROOT panel floors only its direct-child
  //   rows (`[&>button]:min-h-9` = MoreRow + toggles at 36px; the nested
  //   ✕ and SUB/DUB halves pick their own smaller sizes), while the DRILL
  //   panel carries NO floor — submenu options render at their natural
  //   28px like desktop. ≥640px is floor-free everywhere (natural ~28px).
  const moreMenuAnchor =
    moreSection !== null
      ? isCompact
        ? "absolute right-3 bottom-[76px] w-[min(15rem,calc(100%_-_1.5rem))] max-h-[calc(100%_-_96px)]"
        : "absolute right-3 bottom-[76px] w-52 max-h-[calc(100%_-_84px)]"
      : isCompact
      ? "absolute right-3 bottom-[76px] w-[min(15rem,calc(100%_-_1.5rem))] max-h-[calc(100%_-_96px)] [&>button]:min-h-9"
      : "absolute right-2 bottom-[76px] w-56 max-h-[calc(100%_-_84px)] sm:right-3";
  const moreMenu = (
    <div
      ref={moreWrapRef}
      role="menu"
      aria-label="More controls"
      className={`rounded-none border border-[var(--accent)]/20 bg-[#131318] pt-1 pb-2 shadow-xl backdrop-blur-sm z-50 overflow-y-auto overscroll-contain ${moreMenuAnchor}`}
    >
      {moreSection === null ? (
        <>
          <div className="flex items-center justify-between gap-2 px-3 text-[10px] uppercase tracking-wider text-[var(--accent)]/30 font-semibold font-mono">
            <span className="py-1">More</span>
            {/* Touch-only dismiss target: on phones the ✕ is a clearer
                close affordance than the transparent catcher (desktop uses
                catcher/⋯); the popup no longer covers the ⋯ trigger, so this
                is a convenience, not a necessity. */}
            <button
              type="button"
              onClick={closeMore}
              aria-label="Close more controls"
              className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center text-[var(--accent)]/60 transition-colors hover:text-[var(--accent)] sm:hidden"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Sub / Dub — rendered whenever the episode list answers (even
              with "no dub"): the DUB half then reads muted and refuses the
              click, instead of silently vanishing. Styled as a segmented
              control, not a highlighter fill — active half = 15% accent tint
              + accent text + a full 1px accent border (the .header-search
              focus language), inactive = muted mono text on the panel glass.
              The halves overlap their adjacent borders (-ml-px) into one
              seam; the active half carries z-10 so it owns that seam. */}
          {showAudioToggle && (
            <>
              {/* Compact at <640 (28px halves inside a 4px wrapper = 34px
                  block); ≥640 keeps the round-4 sizing (py-1.5, 8px wrapper). */}
              <div className="px-2 pt-1 pb-1 max-sm:pt-0.5 max-sm:pb-0.5 lg:hidden">
                <div className="flex rounded-none">
                  <button
                    type="button"
                    onClick={() => switchAudioType("sub")}
                    aria-pressed={audioType === "sub"}
                    className={`flex-1 rounded-none border px-3 py-1.5 max-sm:py-1 min-h-7 font-mono text-[11px] font-medium uppercase tracking-[0.14em] transition-colors ${
                      audioType === "sub" || !dubEnabled
                        ? "z-10 border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] text-[var(--accent)]"
                        : "border-[var(--accent)]/20 bg-black/40 text-[var(--accent)]/50 hover:border-[var(--accent)]/50 hover:text-[var(--accent)]"
                    }`}
                  >
                    SUB
                  </button>
                  <button
                    type="button"
                    onClick={() => switchAudioType("dub")}
                    disabled={!dubEnabled}
                    aria-pressed={audioType === "dub" && dubEnabled}
                    title={dubEnabled ? undefined : "No dub for this episode"}
                    className={`-ml-px flex-1 rounded-none border px-3 py-1.5 max-sm:py-1 min-h-7 font-mono text-[11px] font-medium uppercase tracking-[0.14em] transition-colors ${
                      audioType === "dub" && dubEnabled
                        ? "z-10 border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] text-[var(--accent)]"
                        : dubEnabled
                        ? "border-[var(--accent)]/20 bg-black/40 text-[var(--accent)]/50 hover:border-[var(--accent)]/50 hover:text-[var(--accent)]"
                        : "cursor-not-allowed border-[var(--accent)]/10 bg-black/40 text-[var(--accent)]/25"
                    }`}
                  >
                    DUB
                  </button>
                </div>
              </div>
              {/* Section rhythm: a tight hairline break under the toggle
                  group before the settings rows (4px + 1px + 4px — desktop
                  density, not the old 16px sheet gap; both sides only exist
                  below lg, where the row itself carries SUB/DUB). */}
              <div
                aria-hidden="true"
                className="mx-3 my-1 h-px bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] lg:hidden"
              />
            </>
          )}

          {/* Settings rows — provider / server / quality / subtitles no
              longer sit inline anywhere, so they show at EVERY width. Only
              Speed (and the SUB/DUB copy above) still hide at lg, where the
              row itself carries them — a control is never offered twice. */}
          <MoreRow
            label="Provider"
            value={PROVIDER_OPTIONS.find((p) => p.id === (providerOverride ?? providerId ?? ""))?.label ?? "Auto"}
            onClick={() => setMoreSection("provider")}
          />
          {availableServers.length > 0 && (
            <MoreRow
              label="Server"
              value={activeServer || "Auto"}
              onClick={() => setMoreSection("server")}
            />
          )}
          {availableQualities.length > 0 && (
            <MoreRow
              label="Quality"
              value={currentQuality === "auto" ? "Auto" : currentQuality}
              onClick={() => setMoreSection("quality")}
            />
          )}
          <MoreRow
            className="lg:hidden"
            label="Speed"
            value={`${playbackRate}x`}
            onClick={() => setMoreSection("speed")}
          />
          <MoreRow
            label="Subtitles"
            value={activeSubtitle ? "On" : "Off"}
            onClick={() => setMoreSection("subs")}
          />

          {/* Always here — lowest priority, never on the row */}
          <MoreRow
            label="Filter"
            value={FILTER_PRESETS.find((f) => f.id === videoFilter)?.label ?? "Off"}
            onClick={() => setMoreSection("filter")}
          />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={autoPlayNext}
            onClick={() => setAutoPlayNext(!autoPlayNext)}
            className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors rounded-none ${
              autoPlayNext
                ? "text-[var(--accent)]"
                : "text-[#9a9aa0] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
            }`}
          >
            <span className="flex items-center gap-2">
              <svg className="h-3.5 w-3.5 shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
              Auto-Play Next
            </span>
            <span className={`font-mono text-[10px] uppercase tracking-wider ${autoPlayNext ? "text-[var(--accent)]" : "text-[var(--accent)]/30"}`}>
              {autoPlayNext ? "On" : "Off"}
            </span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={autoSkipEnabled}
            onClick={() => setAutoSkipEnabled(!autoSkipEnabled)}
            className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors rounded-none ${
              autoSkipEnabled
                ? "text-[var(--accent)]"
                : "text-[#9a9aa0] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
            }`}
          >
            <span className="flex items-center gap-2">
              <svg className="h-3.5 w-3.5 shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
              </svg>
              Auto-Skip Intro
            </span>
            <span className={`font-mono text-[10px] uppercase tracking-wider ${autoSkipEnabled ? "text-[var(--accent)]" : "text-[var(--accent)]/30"}`}>
              {autoSkipEnabled ? "On" : "Off"}
            </span>
          </button>
        </>
      ) : (
        <>
          {/* Section header — back one level, name the level. A chevron-only
              target (not a ✕, not a word) so the bar stays narrow enough for
              the sub-panel's compact popover at every width. Compact cuts:
              py-0.5 + a 24px chevron (was py-1 + 28px) = 28px + hairline;
              ≥640 keeps the round-4 sizing via the sm: fallbacks. */}
          <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--accent)]/15 bg-[#131318] px-1.5 py-1 max-sm:py-0.5">
            <button
              type="button"
              onClick={() => setMoreSection(null)}
              aria-label="Back to more controls"
              className="flex h-7 w-7 max-sm:h-6 max-sm:w-6 shrink-0 items-center justify-center text-[var(--accent)]/50 transition-colors hover:text-[var(--accent)]"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 5l-7 7 7 7" />
              </svg>
            </button>
            <span className="truncate font-mono text-[10px] uppercase tracking-wider text-[var(--accent)]/40">
              {moreSection === "provider"
                ? "Provider"
                : moreSection === "server"
                ? "Server"
                : moreSection === "quality"
                ? "Quality"
                : moreSection === "speed"
                ? "Speed"
                : moreSection === "filter"
                ? "Filter"
                : "Subtitles"}
            </span>
          </div>

          {moreSection === "provider" &&
            PROVIDER_OPTIONS.map((p) => {
              const current = providerOverride ?? providerId ?? "";
              const isActive = current === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { selectProvider(p.id); closeMore(); }}
                  className={`w-full rounded-none px-3 py-1.5 text-left text-xs transition-colors ${
                    isActive
                      ? "border-l-2 border-[var(--accent)] bg-[var(--accent)]/20 text-[var(--accent)]"
                      : "text-[#9a9aa0] hover:bg-[var(--accent)]/5 hover:text-[var(--accent)]"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}

          {moreSection === "server" &&
            availableServers.map((srv) => (
              <button
                key={srv}
                type="button"
                onClick={() => {
                  setActiveServer(srv);
                  activeServerRef.current = srv;
                  closeMore();
                  loadByType(audioType, srv);
                }}
                className={`w-full rounded-none px-3 py-1.5 text-left text-xs transition-colors ${
                  activeServer === srv
                    ? "border-l-2 border-[var(--accent)] bg-[var(--accent)]/20 text-[var(--accent)]"
                    : "text-[#9a9aa0] hover:bg-[var(--accent)]/5 hover:text-[var(--accent)]"
                }`}
              >
                {srv}
              </button>
            ))}

          {moreSection === "quality" &&
            availableQualities.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => { changeQuality(q); closeMore(); }}
                className={`w-full rounded-none px-3 py-1.5 text-left text-xs transition-colors ${
                  q === currentQuality
                    ? "border-l-2 border-[var(--accent)] bg-[var(--accent)]/20 text-[var(--accent)]"
                    : "text-[#9a9aa0] hover:bg-[var(--accent)]/5 hover:text-[var(--accent)]"
                }`}
              >
                {q === "auto" ? "Auto" : q}
              </button>
            ))}

          {moreSection === "speed" &&
            speedOptions.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => { changeSpeed(r); closeMore(); }}
                className={`w-full rounded-none px-3 py-1.5 text-left text-xs transition-colors ${
                  playbackRate === r
                    ? "border-l-2 border-[var(--accent)] bg-[var(--accent)]/20 text-[var(--accent)]"
                    : "text-[#9a9aa0] hover:bg-[var(--accent)]/5 hover:text-[var(--accent)]"
                }`}
              >
                {r}x
              </button>
            ))}

          {moreSection === "filter" &&
            FILTER_PRESETS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => { setVideoFilter(f.id); closeMore(); }}
                className={`w-full rounded-none px-3 py-1.5 text-left text-xs transition-colors ${
                  videoFilter === f.id
                    ? "border-l-2 border-[var(--accent)] bg-[var(--accent)]/20 text-[var(--accent)]"
                    : "text-[#9a9aa0] hover:bg-[var(--accent)]/5 hover:text-[var(--accent)]"
                }`}
              >
                {f.label}
              </button>
            ))}

          {moreSection === "subs" && (
            <div className="px-1 py-0.5">
              <SubtitlePickerContent
                activeSubtitle={activeSubtitle}
                subtitles={subtitles}
                onSelect={(url) => { setActiveSubtitle(url); setActiveOSSubtitleId(null); closeMore(); }}
                subtitleOffset={subtitleOffset}
                onOffsetChange={setSubtitleOffset}
                subtitleSize={subtitleSize}
                onSizeChange={setSubtitleSize}
                osSearched={osSearched}
                osLoading={osLoading}
                osError={osError}
                osResults={osResults.filter((r) => !failedOSIdsRef.current.has(r.file_id))}
                osPage={osPage}
                osFilterQuery={osFilterQuery}
                onSearchOpenSubtitles={(page) => { searchOpenSubtitles(page); }}
                onFilterChange={setOsFilterQuery}
                onSelectOpenSubtitle={(fileId) => selectOSSubtitle(fileId)}
                onResetOpenSubtitles={() => { setOsSearched(false); setOsResults([]); setOsError(null); setOsPage(1); setOsFilterQuery(""); failedOSIdsRef.current.clear(); }}
                activeOSSubtitleId={activeOSSubtitleId}
                osDownloadError={osDownloadError}
                onClearDownloadError={() => setOsDownloadError(null)}
              />
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    <div className="w-full">
    <div
      ref={containerRef}
      // Windowed: in-flow, and the BOX follows the content's own aspect ratio
      // (16:9 until metadata, then videoWidth:videoHeight via
      // syncContentAspect) — edge-to-edge at full column width, with the
      // video contained inside it. Fullscreen: <html> is the fullscreen
      // element, so the player pins itself to the viewport — above every page
      // layer (the navbar is z-50) — and fills the screen exactly like the old
      // element-fullscreen did, with nothing else visible underneath; no
      // aspect or height constraint there, the viewport wins and the video
      // letterboxes itself.
      className={`w-full bg-black overflow-hidden group outline-none ${
        isFullscreen
          ? "fixed inset-0 z-[100]"
          : `relative${
              // Height cap only for content TALLER than 16:9 (its job is
              // keeping 4:3 from taking over a short viewport). When the cap
              // clamps, the box ends up wider than the ratio and the
              // contained video simply pillarboxes — still never stretched.
              // 16:9/wide content is never capped, so it keeps exactly the
              // look it has today.
              contentAspect < 16 / 9 ? " max-h-[calc(100vh_-_8rem)]" : ""
            }`
      }`}
      style={isFullscreen ? undefined : { aspectRatio: contentAspect }}
      tabIndex={0}
      onMouseMove={handleMouseMove}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && containerRef.current && !containerRef.current.contains(next)) {
          setShowSpeedPicker(false);
        }
      }}
    >
      {/* Switch-overlay + skip-chip keyframes (inline so they ship with the player) */}
      <style>{`
        /* Accent band sweeping down the switch overlay — the "scan" read */
        @keyframes n54-switch-sweep {
          0% { transform: translateY(-60%); opacity: 0; }
          15% { opacity: 1; }
          85% { opacity: 1; }
          100% { transform: translateY(320%); opacity: 0; }
        }
        .n54-switch-sweep {
          animation: n54-switch-sweep 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        @keyframes n54-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
        .n54-blink { animation: n54-blink 900ms steps(1, end) infinite; }
        /* Skip chip entrance — fades up the moment a segment window opens */
        @keyframes n54-skip-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .n54-skip-in { animation: n54-skip-in 240ms cubic-bezier(0.16, 1, 0.3, 1); }
        @media (prefers-reduced-motion: reduce) {
          .n54-switch-sweep { animation: none; opacity: 0.6; }
          .n54-blink { animation: none; }
          .n54-skip-in { animation: none; }
        }
      `}</style>

      {/* Video element */}
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        style={{ filter: videoFilter === "off" ? undefined : getFilterCSS(videoFilter) }}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onError={handleVideoError}
        onPlay={() => {
          setPlaying(true);
          // Playback restarted for any reason → the viewer is watching again,
          // so a pending up-next card has no business auto-advancing.
          setCountdown(null);
        }}
        onPause={() => {
          setPlaying(false);
          setIsBuffering(false);
        }}
        // Buffer read-out (queue #4): `progress` feeds the seekbar's buffered
        // segments; waiting/stalled vs playing/canplay flip the "starved"
        // flag that drives the playhead pulse — normal playback never sets it.
        onProgress={handleBufferProgress}
        onWaiting={() => setIsBuffering(true)}
        onStalled={() => setIsBuffering(true)}
        onPlaying={() => setIsBuffering(false)}
        onCanPlay={() => setIsBuffering(false)}
        onEnded={() => {
          setPlaying(false);
          // Arm the countdown instead of jumping: with auto-play on and a next
          // episode to go to, the overlay takes over from here (it navigates
          // through goToEpisode — no video.play(), so the browser's autoplay
          // policy is never fought). Without auto-play, nothing happens.
          if (autoPlayNext && nextEpisodeTarget) setCountdown(10);
        }}
        playsInline
        crossOrigin="anonymous"
        onClick={() => togglePlay()}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />

{/* Loading overlay — simple terminal progress bar */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10 pointer-events-none">
          <div className="flex flex-col items-center gap-4 w-80 max-w-[85%]">
            <div className="w-full h-2 bg-[#0a0a0f] border border-[var(--accent)]/30 relative overflow-hidden">
              <div className="absolute inset-y-0 left-0 h-full bg-[var(--accent)] animate-loading-bar" />
            </div>
            <div className="font-mono text-[10px] text-[var(--accent)]/50 tracking-[0.2em]">
              [ {animeTitle?.substring(0, 20) || "STREAM"} ]
            </div>
            {/* Slow-load honesty: the provider chain can legitimately take
                ~20s, so say so instead of spinning in silence. The timer that
                arms this lives with `loading` and is torn down when it settles. */}
            {slowLoad && (
              <div
                role="status"
                aria-live="polite"
                className="font-mono text-[10px] tracking-[0.15em] text-[var(--accent)]/70"
              >
                Still checking providers…
              </div>
            )}
          </div>
        </div>
      )}

      {/* Switch feedback — armed by the drawer's series dropdown and episode
          rows (the prev/next + up-next controls share `goToEpisode`, so they
          get it too). Sits above the HUD (z-20/40), the up-next card (z-45)
          and the drawer (z-50); pointer-transparent so it can never trap the
          viewer — it tracks the real load and fades out (dismissal effect
          above), with a 700ms floor so an instant load never flashes. */}
      {switchTo && (
        <div
          role="status"
          aria-live="polite"
          aria-label={`Switching to ${switchTo.series}, episode ${switchTo.episode}`}
          className={`absolute inset-0 z-[60] flex flex-col justify-center overflow-hidden bg-black/90 px-6 transition-opacity duration-300 pointer-events-none sm:px-12 ${
            switchFade ? "opacity-0" : "opacity-100"
          }`}
        >
          {/* CRT scanlines */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg, rgba(0,0,0,0.5) 0px, rgba(0,0,0,0.5) 1px, transparent 1px, transparent 3px)",
            }}
          />
          {/* Accent band sweeping down — the "scan" read */}
          <div
            aria-hidden="true"
            className="n54-switch-sweep pointer-events-none absolute inset-x-0 top-0 h-1/4 bg-gradient-to-b from-transparent via-[var(--accent)]/25 to-transparent"
          />

          <div className="relative min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.35em] text-[var(--accent)]/70">
              {switchTo.kind === "series" ? "// switching series" : "// loading episode"}
              <span className="n54-blink">_</span>
            </div>

            <div className="mt-2 truncate text-2xl font-bold uppercase tracking-wider text-[var(--accent)] sm:text-4xl">
              {switchTo.series}
            </div>

            <div className="mt-2 flex min-w-0 items-center gap-2">
              <span className="shrink-0 border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-[var(--accent)]">
                {`EP ${String(switchTo.episode).padStart(2, "0")}`}
              </span>
              {switchTo.epTitle && (
                <span className="min-w-0 truncate font-mono text-xs text-[#9a9aa0]">
                  {switchTo.epTitle}
                </span>
              )}
            </div>

            <div className="relative mt-5 h-2 w-full max-w-xs overflow-hidden border border-[var(--accent)]/30 bg-[#0a0a0f] sm:max-w-sm">
              <div className="absolute inset-y-0 left-0 h-full bg-[var(--accent)] animate-loading-bar" />
            </div>

            <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--accent)]/40">
              {"> awaiting source\u2026"}
            </div>
          </div>
        </div>
      )}

      {/* Subtitle overlay */}
      {activeSubtitle && !loading && (
        <SubtitleOverlay
          subtitleUrl={activeSubtitle}
          videoRef={videoRef}
          headers={streamHeaders || undefined}
          offset={subtitleOffset}
          size={subtitleSize}
          controlsVisible={showControls}
        />
      )}

      {/* Error overlay — a real "no stream" state, not a generic error string.
          Retry re-runs the whole lookup (server → provider chain); the escape
          hatch goes back to the episode list rather than leaving the viewer
          stuck on a player that has nothing to play. */}
      {streamError && !loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
          <div className="text-center max-w-sm px-4">
            {/* Heading + reason are the shared card's. `note` is whatever
                `/api/stream` told us; when it had nothing to add we fall back
                to the generic line. */}
            <EmptyState code="NO_STREAM_FOUND" note={streamErrorDetail} className="" />
            <div className="flex flex-wrap gap-2 justify-center">
              <button
                onClick={() => { destroyHls(); loadByType(audioType); }}
                className="text-xs px-5 py-2.5 border border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors rounded-none min-h-[44px]"
              >
                Retry
              </button>
              {/* The dub escape hatch is gated by the same data as the SUB/DUB
                  control — offering "Try Dub" for an episode the list says has
                  no dub would be the guess we just removed. A dub track that IS
                  playing still offers "Try Sub". */}
              {(audioType !== "sub" || dubEnabled) && (
                <button
                  onClick={() => { destroyHls(); loadByType(audioType === "sub" ? "dub" : "sub"); }}
                  className="text-xs px-5 py-2.5 border border-white/10 text-[#9a9aa0] hover:bg-white/5 transition-colors rounded-none min-h-[44px]"
                >
                  {audioType === "sub" ? "Try Dub" : "Try Sub"}
                </button>
              )}
              {anilistId && (
                <Link
                  href={`/anime/${anilistId}${providerQuery ? `?provider=${encodeURIComponent(providerQuery)}` : ""}`}
                  className="text-xs px-5 py-2.5 border border-white/10 text-[#9a9aa0] hover:text-[var(--accent)] hover:border-[var(--accent)]/40 transition-colors rounded-none min-h-[44px] inline-flex items-center"
                >
                  All Episodes
                </Link>
              )}
            </div>
            {/* Provider picker — only shown when the stream fails */}
            <div className="mt-4 pt-3 border-t border-white/10">
              <p className="text-[#6b6b70] text-[10px] uppercase tracking-widest mb-2 font-mono">
                // Switch Provider
              </p>
              <div className="flex flex-wrap gap-1.5 justify-center">
                {PROVIDER_OPTIONS.map((p) => {
                  const current = providerOverride ?? providerId ?? "";
                  const isActive = current === p.id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => {
                        if (p.id === current) {
                          // Same provider — force a retry
                          destroyHls();
                          loadByType(audioType);
                        } else {
                          // Different provider — override triggers the load effect
                          setProviderOverride(p.id);
                        }
                      }}
                      className={`text-[10px] px-2.5 py-1.5 border font-mono uppercase tracking-wider transition-colors rounded-none min-h-[36px] ${
                        isActive
                          ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/15"
                          : "border-white/10 text-[#9a9aa0] hover:text-[var(--accent)] hover:border-[var(--accent)]/40"
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Skip intro/outro — the PRIMARY action while a segment window is
          open: solid accent chip (mono uppercase, rounded-none, house
          glow), parked bottom-20 / right-3 — the measured 80px clearance
          over the control cluster (80px tall mobile / 68px desktop) — so it
          mirrors the right-hand controls and never covers the transport.
          The drain strip under the label shows the window emptying; the chip
          auto-dismisses the instant the window closes (armed auto-skip still
          jumps at that same end), and the 240ms entrance gives the moment
          the window opens a beat of its own. z-30 keeps it over the HUD
          while stepping to z-[19] when the speed picker is open, so the
          picker — which lives inside the HUD's z-20 stacking context —
          always paints over it; the ⋯ panel and drawer are top-level z-50
          and need no such help. */}
      {!loading && sources.length > 0 && (inIntro || inOutro) && (
        <div className={`absolute bottom-20 right-3 flex justify-end gap-2 sm:gap-3 ${showSpeedPicker ? "z-[19]" : "z-30"}`}>
          {inIntro && introSegment && (
            <button
              onClick={() => { if (videoRef.current) videoRef.current.currentTime = introSegment.end; }}
              className="n54-skip-in group relative overflow-hidden rounded-none border border-[var(--accent)] bg-[var(--accent)] px-4 py-2.5 text-black accent-shadow-sm transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              <span className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.18em]">
                Skip Intro
                <svg className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 5l7 7-7 7M13 5l7 7-7 7" />
                </svg>
              </span>
              {/* Drain strip: width = share of the segment window left */}
              <span
                className="absolute inset-x-0 bottom-0 h-[3px] bg-black/30"
                style={{ width: `${Math.max(0, Math.min(100, ((introSegment.end - currentTime) / Math.max(1, introSegment.end - introSegment.start)) * 100))}%` }}
              />
            </button>
          )}
          {inOutro && outroSegment && (
            <button
              onClick={() => { if (videoRef.current) videoRef.current.currentTime = outroSegment.end; }}
              className="n54-skip-in group relative overflow-hidden rounded-none border border-[var(--accent)] bg-[var(--accent)] px-4 py-2.5 text-black accent-shadow-sm transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              <span className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.18em]">
                Skip Outro
                <svg className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 5l7 7-7 7M13 5l7 7-7 7" />
                </svg>
              </span>
              <span
                className="absolute inset-x-0 bottom-0 h-[3px] bg-black/30"
                style={{ width: `${Math.max(0, Math.min(100, ((outroSegment.end - currentTime) / Math.max(1, outroSegment.end - outroSegment.start)) * 100))}%` }}
              />
            </button>
          )}
        </div>
      )}

        {/* Controls overlay (bottom) */}
      <div
        className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent pt-12 pb-3 px-2 sm:px-3 transition-opacity duration-300 z-20 ${
          showControls ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Progress bar — buffered ranges paint a lighter segment UNDER the
            input (its tail is translucent white, so they read through); the
            pulse + label ride the playhead (edge-clamped) only while the
            media is starved — waiting/stalled — never in normal playback. */}
        <div className="group/bar relative mb-2 h-4 flex items-center">
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2" aria-hidden="true">
            {bufferedRanges.map((r, i) => (
              <div
                key={i}
                className="absolute top-0 h-full bg-white/25"
                style={{ left: `${r.start}%`, width: `${Math.max(0, r.end - r.start)}%` }}
              />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
            aria-label="Seek"
            className="progress-range w-full h-1 appearance-none cursor-pointer relative z-10
                       [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                       [&::-webkit-slider-thumb]:-mt-[4px] [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:rounded-none
                       [&::-webkit-slider-thumb]:shadow-md
                       [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-150
                       [&::-webkit-slider-thumb]:hover:scale-125
                       [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-none
                       [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-none
                       [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3
                       [&::-moz-range-thumb]:-mt-[4px] [&::-moz-range-thumb]:bg-[var(--accent)] [&::-moz-range-thumb]:rounded-none
                       [&::-moz-range-thumb]:border-none"
            style={{
              background: `linear-gradient(to right, rgba(var(--accent-rgb),0.9) ${progress}%, rgba(var(--accent-rgb),0.2) ${progress}%, rgba(255,255,255,0.1) ${progress}%)`,
            }}
          />
          {isBuffering && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 z-20 -translate-y-1/2"
              style={{ left: `clamp(12px, ${progress}%, calc(100% - 12px))` }}
            >
              <span className="absolute bottom-[14px] left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] uppercase leading-none tracking-[0.2em] text-[var(--accent)]">
                Buffering
              </span>
              <span className="block h-2.5 w-2.5 -translate-x-1/2 animate-pulse bg-[var(--accent)]" />
            </div>
          )}
        </div>

        {/* Controls row — grouped by priority, never scrolled. Left group:
            the always-on essentials (transport, volume, time); right group:
            the next tier (from lg) plus the ⋯ menu that parks everything
            else. No horizontal strip, no edge chevrons — the row always fits.

            `z-20` is load-bearing: the seekbar input is `relative z-10`, so
            without an explicit z-index here the picker menus (z-50) open
            *under* the seekbar. The row lifts itself — menus included — above it. */}
        <div className="relative z-20 flex w-full items-center justify-between gap-2 sm:gap-6 select-none">
          {/* Left group: prev/next episode, transport, volume, time — the
              essentials, always first so they are on screen at offset 0 */}
          <div className="flex items-center gap-1 sm:gap-3 shrink-0">
            {/* Previous episode — first thing to go when the row gets tight */}
            <button
              onClick={() => { if (prevEpisodeTarget) goToEpisode(prevEpisodeTarget); }}
              disabled={!prevEpisodeTarget}
              title={prevEpisodeTarget ? `Episode ${prevEpisodeTarget}` : "First episode"}
              aria-label="Previous episode"
              className={`hidden sm:flex items-center justify-center transition-colors w-10 h-10 sm:w-8 sm:h-8 ${
                prevEpisodeTarget
                  ? "text-[var(--accent)]/50 hover:text-[var(--accent)]"
                  : "text-[var(--accent)]/50 opacity-30 cursor-not-allowed"
              }`}
            >
              <svg className="w-6 h-6 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
              </svg>
            </button>

            {/* Skip back 10s — double-chevron rewind (`<<`); J is its
                keyboard twin, and the tooltip says so */}
            <button
              onClick={() => seekBy(-10)}
              title="Back 10 seconds (J)"
              aria-label="Skip back 10 seconds"
              className="flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors w-10 h-10 sm:w-8 sm:h-8"
            >
              <svg className="w-6 h-6 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 18l-8.5-6L20 6v12zM11 6v12L2.5 12 11 6z" />
              </svg>
            </button>

            {/* Play/Pause */}
            <button
              onClick={() => togglePlay()}
              aria-label={playing ? "Pause" : "Play"}
              className="flex items-center justify-center text-[var(--accent)] hover:text-white transition-colors w-10 h-10 sm:w-8 sm:h-8"
            >
              {playing ? (
                <svg className="w-6 h-6 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg className="w-6 h-6 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Skip forward 10s — double-chevron fast-forward (`>>`); L is
                its keyboard twin */}
            <button
              onClick={() => seekBy(10)}
              title="Forward 10 seconds (L)"
              aria-label="Skip forward 10 seconds"
              className="flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors w-10 h-10 sm:w-8 sm:h-8"
            >
              <svg className="w-6 h-6 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
              </svg>
            </button>

            {/* Next episode */}
            <button
              onClick={() => { if (nextEpisodeTarget) goToEpisode(nextEpisodeTarget); }}
              disabled={!nextEpisodeTarget}
              title={nextEpisodeTarget ? `Episode ${nextEpisodeTarget}` : "No next episode"}
              aria-label="Next episode"
              className={`hidden sm:flex items-center justify-center transition-colors w-10 h-10 sm:w-8 sm:h-8 ${
                nextEpisodeTarget
                  ? "text-[var(--accent)]/50 hover:text-[var(--accent)]"
                  : "text-[var(--accent)]/50 opacity-30 cursor-not-allowed"
              }`}
            >
              <svg className="w-6 h-6 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
              </svg>
            </button>

            {/* Volume */}
            <div className="flex items-center gap-1 group/vol">
              <button
                onClick={toggleMute}
                aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
                className="flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors w-10 h-10 sm:w-8 sm:h-8"
              >
                {muted || volume === 0 ? (
                  <svg className="w-6 h-6 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                )}
              </button>
              <div className="overflow-hidden w-0 sm:group-hover/vol:w-24 transition-all duration-200 h-8 flex items-center">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={handleVolume}
                  aria-label="Volume"
                  className="w-20 sm:w-24 h-1 appearance-none cursor-pointer
                             [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                             [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:rounded-none"
                  style={{
                    background: `linear-gradient(to right, rgba(var(--accent-rgb),0.5) ${(muted ? 0 : volume) * 100}%, rgba(255,255,255,0.1) ${(muted ? 0 : volume) * 100}%)`,
                  }}
                />
              </div>
            </div>

            {/* Time — full readout from sm up; below sm only the elapsed
                clock fits, and the seekbar carries the rest */}
            <span className="text-[10px] sm:text-sm text-[var(--accent)]/50 tabular-nums font-mono select-none leading-none shrink-0">
              {formatTime(currentTime)}
              <span className="hidden sm:inline"> / {formatTime(duration)}</span>
            </span>
          </div>

          {/* Right group: second-tier pickers (lg+), ⋯ menu, fullscreen.
              (The episode drawer is NOT here — it is an edge handle, see below) */}
          <div className="flex items-center gap-1.5 justify-end shrink-0">
            {/* Second tier — lg+ only inline; below lg the same controls
                live in the ⋯ menu, so nothing is ever offered twice */}
            <div className="hidden lg:contents">
            {/* Sub / Dub segmented toggle — data-gated: shown as soon as the
                episode's flag is known, with DUB dimmed + inert when it isn't
                there. Never a guess: a known "no dub" wins over any probe. */}
            {showAudioToggle && (
              <div className="flex items-center bg-black/40 border border-[var(--accent)]/20 overflow-hidden rounded-none">
                <button
                  onClick={() => switchAudioType("sub")}
                  aria-pressed={audioType === "sub"}
                  className={`px-3 text-[11px] font-semibold tracking-wide transition-colors h-7 ${
                    audioType === "sub" || !dubEnabled
                      ? "bg-[var(--accent)] text-black"
                      : "text-[var(--accent)]/50 hover:text-[var(--accent)]"
                  }`}
                >
                  SUB
                </button>
                <div className="w-px h-4 bg-[var(--accent)]/20" />
                <button
                  onClick={() => switchAudioType("dub")}
                  disabled={!dubEnabled}
                  aria-pressed={audioType === "dub" && dubEnabled}
                  title={dubEnabled ? undefined : "No dub for this episode"}
                  className={`px-3 text-[11px] font-semibold tracking-wide transition-colors h-7 ${
                    audioType === "dub" && dubEnabled
                      ? "bg-[var(--accent)] text-black"
                      : dubEnabled
                      ? "text-[var(--accent)]/50 hover:text-[var(--accent)]"
                      : "cursor-not-allowed text-[var(--accent)]/25"
                  }`}
                >
                  DUB
                </button>
              </div>
            )}

            {/* Speed selector */}
            <div ref={speedWrapRef} className="relative h-full flex items-center">
              <button
                onClick={() => { setShowSpeedPicker(!showSpeedPicker); closeMore(); }}
                className="h-7 flex items-center gap-1 text-[11px] px-2 text-[var(--accent)]/50 hover:text-[var(--accent)] bg-black/40 border border-[var(--accent)]/20 hover:border-[var(--accent)]/50 transition-colors rounded-none"
              >
                <svg className="w-3 h-3 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                {playbackRate}x
                <svg className="w-3 h-3 opacity-50" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M7 10l5 5 5-5z" />
                </svg>
              </button>
              {showSpeedPicker && (
                <div className="absolute right-0 bottom-full mb-1.5 w-28 bg-[#131318] border border-[var(--accent)]/20 shadow-xl max-h-[min(14rem,45vh)] overflow-y-auto overflow-x-hidden z-50 backdrop-blur-sm rounded-none">
                  <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] text-[var(--accent)]/30 uppercase tracking-wider font-semibold font-mono">
                    Speed
                  </div>
                  {speedOptions.map((r) => (
                    <button
                      key={r}
                      onClick={() => changeSpeed(r)}
                      className={`w-full text-left px-2.5 py-1.5 text-xs transition-colors rounded-none ${
                        playbackRate === r
                          ? "bg-[var(--accent)]/20 text-[var(--accent)] border-l-2 border-[var(--accent)]"
                          : "text-[#9a9aa0] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
                      }`}
                    >
                      {r}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            </div>

            {/* More (⋯) — always present, never scrolls away. It carries the
                settings that used to be inline pickers (provider, server,
                quality, subtitles) plus the toggles at their peak (auto-play,
                auto-skip, FX filter). */}
            <button
              ref={moreBtnRef}
              onClick={() => {
                if (showMore) {
                  closeMore();
                } else {
                  setShowMore(true);
                  setMoreSection(null);
                  setShowControls(true);
                }
                setShowSpeedPicker(false);
              }}
              aria-label="More controls"
              aria-haspopup="menu"
              aria-expanded={showMore}
              title="More"
              className={`w-9 h-10 shrink-0 sm:w-8 sm:h-8 flex items-center justify-center border transition-colors rounded-none ${
                showMore
                  ? "text-[var(--accent)] bg-[var(--accent)]/20 border-[var(--accent)]/50"
                  : "text-[var(--accent)]/50 bg-black/40 border-[var(--accent)]/20 hover:text-[var(--accent)] hover:border-[var(--accent)]/50"
              }`}
            >
              <svg className="w-5 h-5 sm:w-4 sm:h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 10a2 2 0 100 4 2 2 0 000-4zm6 0a2 2 0 100 4 2 2 0 000-4zm6 0a2 2 0 100 4 2 2 0 000-4z" />
              </svg>
            </button>

            {/* Enter fullscreen (hidden when already fullscreen — top-right exit button handles that) */}
            {!isFullscreen && (
              <button
                onClick={toggleFullscreen}
                aria-label="Enter fullscreen"
                title="Fullscreen"
                className="w-9 h-10 shrink-0 sm:w-8 sm:h-8 flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors"
              >
                <svg className="w-5 h-5 sm:w-4 sm:h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                </svg>
              </button>
            )}

          </div>

        </div>

      </div>

      {/* Exit fullscreen button (mobile only, when fullscreen) */}
      {isFullscreen && (
        <button
          onClick={toggleFullscreen}
          className={`absolute top-4 right-4 z-40 min-w-[48px] min-h-[48px] w-11 h-11 sm:w-10 sm:h-10 flex items-center justify-center bg-black/60 border border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors transition-opacity duration-300 ${
            showControls ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
          </svg>
        </button>
      )}

      {/* Episode drawer handle — docked at the MIDDLE of the right edge, the
          only trigger there is (fullscreen-only; windowed mode has no drawer).
          Fades with the control HUD so it never sits on a clean frame. */}
      {isFullscreen && !drawerOpen && hasDrawer && (
        <button
          onClick={openDrawer}
          aria-label="Episodes"
          aria-expanded={false}
          title="Episodes"
          className={`group/handle absolute right-0 top-1/2 z-40 flex h-16 w-7 -translate-y-1/2 items-center justify-center rounded-none border border-r-0 border-[var(--accent)]/40 bg-black/60 text-[var(--accent)] transition-all duration-300 hover:border-[var(--accent)] hover:bg-[var(--accent)]/15 hover:accent-shadow-sm ${
            showControls ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <svg
            className="h-4 w-4 transition-transform duration-200 group-hover/handle:-translate-x-0.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 5l-7 7 7 7" />
          </svg>
        </button>
      )}

      {/* Next-episode countdown — Netflix-style "up next" card. Only ever
          armed by onEnded when auto-play next is on AND a next episode
          exists, so nothing appears otherwise. The scrim keeps the last frame
          visible underneath; z-[45] sits above the HUD (z-20/40) but under the
          episode drawer (z-50). */}
      {countdown !== null && nextEpisodeTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Up next"
          // Clicking off-card dismisses — never navigates — so the last frame
          // stays put and the viewer can keep the episode they're in.
          onClick={() => setCountdown(null)}
          className="absolute inset-0 z-[45] flex items-center justify-center bg-black/60 p-3"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[320px] rounded-none border border-[var(--accent)]/40 bg-[#131318]/95 backdrop-blur-sm"
            // Both shadows inlined: `.accent-shadow-*` lives outside @layer in
            // globals.css, so as a class it would override Tailwind's
            // `shadow-[…]` utility (same specificity, unlayered wins) and the
            // drop shadow would silently vanish. One declaration, both effects.
            style={{
              boxShadow:
                "0 8px 40px rgba(0,0,0,0.7), 0 0 16px rgba(var(--accent-rgb), 0.4)",
            }}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--accent)]/20 px-3 py-2">
              <div className="font-mono text-[10px] uppercase leading-none tracking-[0.25em] text-[var(--accent)]/60">
                Up Next
              </div>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-none border border-[var(--accent)] bg-black/50 font-mono text-lg leading-none tabular-nums text-[var(--accent)] accent-shadow-sm">
                {Math.max(0, countdown)}
              </div>
            </div>

            <div className="px-3 pt-3 pb-2.5">
              <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--accent)]/40">
                Episode {nextEpisodeTarget}
              </div>
              <div className="mt-1 truncate text-sm text-[#e6e6ea]">
                {nextEpisodeTitle || `Episode ${nextEpisodeTarget}`}
              </div>
            </div>

            {/* Drain rule — steps down once a second, 1s linear between steps */}
            <div className="h-px w-full bg-[var(--accent)]/15">
              <div
                className="h-full bg-[var(--accent)] transition-[width] duration-1000 ease-linear"
                style={{ width: `${(Math.max(0, countdown) / 10) * 100}%` }}
              />
            </div>

            <div className="flex gap-2 px-3 py-3">
              <button
                onClick={() => setCountdown(null)}
                className="flex-1 rounded-none border border-[var(--accent)]/30 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]/70 transition-colors hover:border-[var(--accent)]/60 hover:bg-[var(--accent)]/10 hover:text-[var(--accent)]"
              >
                Cancel
              </button>
              <button
                onClick={() => { setCountdown(null); goToEpisode(nextEpisodeTarget); }}
                className="flex-1 rounded-none bg-[var(--accent)] px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-wider text-black transition-all hover:brightness-110 accent-shadow-sm"
              >
                Play Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Episode drawer — slides in from the right, over the video.
          Rendered inside the container so it is clipped to the player and
          still works in fullscreen. It stays mounted (closed = off-screen,
          `inert`, pointer-events-none) so its markup — the franchise dropdown
          first — ships in the initial HTML instead of only materialising on
          the first fullscreen tap. */}
      {hasDrawer && (
        <div
          aria-hidden={!drawerOpen}
          // `inert` keeps the closed drawer out of the tab order and out of
          // the accessibility tree; React 19 renders it as `inert=""`.
          inert={!drawerOpen}
          className={`absolute inset-0 z-50 ${drawerOpen ? "" : "pointer-events-none"}`}
        >
          {/* Backdrop — one layer per tap: with the franchise dropdown open,
              the first tap on the scrim drops the dropdown (this element's
              pointerdown also closed it via the shared outside-click closer),
              the next one closes the drawer. */}
          <div
            onPointerDown={() => {
              franchiseOnScrimRef.current = franchiseOpen;
            }}
            onClick={() => {
              if (franchiseOnScrimRef.current) {
                franchiseOnScrimRef.current = false;
                return;
              }
              closeDrawer();
            }}
            aria-hidden="true"
            className={`absolute inset-0 bg-black/70 transition-opacity duration-[250ms] ease-out ${
              drawerIn ? "opacity-100" : "opacity-0"
            }`}
          />
          {/* Panel — `overflow-hidden` is the hard edge: nothing inside it
              (the franchise dropdown included) can paint past the drawer. */}
          <div
            role="dialog"
            aria-modal={drawerOpen}
            aria-label="Episodes"
            // The edge shadow only exists while the drawer is on screen — a
            // closed (translated-out) panel would otherwise smear its 12px
            // spread across the right edge of the video at all times.
            className={`absolute right-0 top-0 flex h-full w-[320px] max-w-[85%] flex-col overflow-hidden border-l border-[var(--accent)]/30 bg-[#131318] transition-transform duration-[250ms] ease-out ${
              drawerIn
                ? "translate-x-0 shadow-[-12px_0_32px_rgba(0,0,0,0.6)]"
                : "translate-x-full"
            }`}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--accent)]/20 px-4 py-3">
              <div className="min-w-0">
                <div className="font-mono text-[11px] uppercase leading-none tracking-[0.2em] text-[var(--accent)]">
                  Episodes
                </div>
                <div className="mt-1.5 truncate font-mono text-[10px] uppercase tracking-wider text-[var(--accent)]/40">
                  {animeTitle}
                </div>
              </div>
              <button
                onClick={closeDrawer}
                aria-label="Close episodes"
                className="flex h-8 w-8 shrink-0 items-center justify-center border border-[var(--accent)]/30 text-[var(--accent)]/60 transition-colors hover:border-[var(--accent)]/60 hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] rounded-none"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Franchise / season switcher — ONE control docked at the top of
                the drawer, above the episode list. The wrapper is the
                positioning context for the panel, so every offset resolves
                against it: `top-full` drops the list straight under the
                trigger (inside the drawer's padding), `max-h` + `overflow-y-auto`
                cap and scroll it, and the drawer's own `overflow-hidden`
                clips it as a second, hard boundary — it can never leave the
                drawer or the player box. */}
            {hasFranchise && (
              <div
                ref={franchiseWrapRef}
                className="relative shrink-0 border-b border-[var(--accent)]/20 px-3 py-2.5"
              >
                <button
                  type="button"
                  onClick={() => setFranchiseOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={franchiseOpen}
                  aria-label="Switch series"
                  title={currentFranchise?.detail ?? animeTitle}
                  className={`flex min-h-[44px] w-full items-center gap-2.5 border px-3 text-left transition-colors rounded-none ${
                    franchiseOpen
                      ? "border-[var(--accent)] bg-[var(--accent)]/10"
                      : "border-[var(--accent)]/30 bg-black/40 hover:border-[var(--accent)]/60 hover:bg-[var(--accent)]/10"
                  }`}
                >
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-[var(--accent)]/50">
                    Series
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--accent)]">
                    {currentFranchise?.title ?? animeTitle}
                  </span>
                  <svg
                    aria-hidden="true"
                    className={`h-4 w-4 shrink-0 text-[var(--accent)]/60 transition-transform duration-200 ${
                      franchiseOpen ? "rotate-180" : ""
                    }`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {franchiseOpen && (
                  <div
                    role="menu"
                    aria-label="Franchise"
                    className="absolute inset-x-0 top-full z-30 mt-1 max-h-[min(50vh,18rem)] overflow-y-auto overscroll-contain border border-[var(--accent)]/30 bg-[#131318] shadow-xl"
                  >
                    {/* Same persisted order as the watch page's `// Franchise`
                        grid (presentational here: every row stays a plain
                        menu item). */}
                    {franchiseGroups.map((group) => (
                      <Fragment key={group.label ?? "all"}>
                        {group.label !== null && (
                          <div
                            role="presentation"
                            className="flex items-center gap-2 border-b border-[var(--accent)]/10 bg-black/30 px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-[var(--accent)]/55"
                          >
                            <span className="shrink-0">{group.label}</span>
                            <span aria-hidden="true" className="h-px flex-1 bg-[var(--accent)]/15" />
                            <span className="shrink-0 tabular-nums text-[#6b6b70]">
                              {group.entries.length}
                            </span>
                          </div>
                        )}
                        {group.entries.map((entry) => {
                          const isCurrent = entry.current;
                          const qs = providerQuery
                            ? `?provider=${encodeURIComponent(providerQuery)}`
                            : "";
                          // Same href rules as the watch page's `// Franchise`
                          // grid: mainline seasons deep-link to episode 1, the
                          // rest fall through to their detail page.
                          const href = entry.mainLine
                            ? `/anime/${entry.id}/watch/1${qs}`
                            : `/anime/${entry.id}${qs}`;

                          return (
                            <button
                              key={entry.id}
                              type="button"
                              role="menuitem"
                              aria-current={isCurrent ? "page" : undefined}
                              title={entry.detail}
                              onClick={() => {
                                setFranchiseOpen(false);
                                if (isCurrent) return; // already here — just close
                                closeDrawer();
                                if (entry.mainLine) {
                                  // Watch-page switch: arm the overlay + handoff,
                                  // then push. Fullscreen lives on <html>, so it
                                  // carries across the remount untouched.
                                  beginSwitch({ kind: "series", series: entry.title, episode: 1 });
                                  router.push(href);
                                } else {
                                  // Detail page — there is no player to hand over
                                  // to, so drop out of fullscreen deliberately
                                  // rather than strand a fullscreened text page.
                                  exitFullscreen();
                                  router.push(href);
                                }
                              }}
                              className={`flex min-h-[44px] w-full items-center gap-2.5 border-l-2 px-3 py-2.5 text-left transition-colors rounded-none ${
                                isCurrent
                                  ? "border-[var(--accent)] bg-[var(--accent)]/15"
                                  : entry.tier === "main"
                                    ? "border-l-[var(--accent)]/45 bg-[var(--accent)]/5 hover:bg-[var(--accent)]/10"
                                    : "border-l-transparent hover:bg-[var(--accent)]/5"
                              }`}
                            >
                              {entry.season !== undefined && (
                                <span
                                  className={`shrink-0 border px-1.5 py-1 font-mono text-[11px] font-bold leading-none tabular-nums ${
                                    isCurrent
                                      ? "border-[var(--accent)]/50 bg-[var(--accent)]/15 text-[var(--accent)]"
                                      : "border-[var(--accent)]/30 text-[var(--accent)]/70"
                                  }`}
                                >
                                  {`S${entry.season}`}
                                </span>
                              )}
                              <span
                                className={`shrink-0 border px-1.5 py-1 font-mono text-[9px] uppercase leading-none tracking-wider ${
                                  isCurrent
                                    ? "border-[var(--accent)]/40 text-[var(--accent)]/85"
                                    : "border-[var(--accent)]/20 text-[var(--accent)]/55"
                                }`}
                              >
                                {entry.badge}
                              </span>
                              <span
                                className={`min-w-0 flex-1 truncate text-xs ${
                                  isCurrent
                                    ? "text-[var(--accent)]"
                                    : entry.tier === "main"
                                      ? "text-[#e6e6ea]"
                                      : "text-[#9a9aa0]"
                                }`}
                              >
                                {entry.title}
                              </span>
                              {isCurrent && (
                                <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-[var(--accent)]/70">
                                  Now
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </Fragment>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div ref={drawerListRef} className="flex-1 overflow-y-auto overscroll-contain py-1">
              {episodes?.map((ep) => {
                const isCurrent = ep.number === episodeNumber;
                return (
                  <button
                    key={ep.number}
                    ref={isCurrent ? drawerCurrentRef : undefined}
                    onClick={() => {
                      closeDrawer();
                      if (!isCurrent) goToEpisode(ep.number);
                    }}
                    className={`flex w-full items-center gap-3 border-l-2 px-4 py-3 text-left transition-colors rounded-none ${
                      isCurrent
                        ? "border-[var(--accent)] bg-[var(--accent)]/15"
                        : "border-transparent hover:bg-[var(--accent)]/5"
                    }`}
                  >
                    <span
                      className={`w-8 shrink-0 font-mono text-xs tabular-nums ${
                        isCurrent ? "text-[var(--accent)]" : "text-[var(--accent)]/50"
                      }`}
                    >
                      {String(ep.number).padStart(2, "0")}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate text-xs ${
                        isCurrent ? "text-[var(--accent)]" : "text-[#9a9aa0]"
                      }`}
                    >
                      {ep.title || `Episode ${ep.number}`}
                    </span>
                    {isCurrent && (
                      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-[var(--accent)]/70">
                        Now
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ⋯ "More" menu — ALWAYS inside the player box. The container is
          `relative overflow-hidden`, and both the dismiss layer and the panel
          below are its direct children, so every offset resolves against the
          player frame — nothing can render past its edge (see `moreMenuAnchor`
          for the geometry of each shape):
          • BOTH breakpoints: a popup bottom-right on the 76px line — root list
            or drill-down — over a TRANSPARENT catcher that swallows clicks
            meant for the video, so dismissing the menu never also toggles
            playback. The catcher stops at 76px, leaving the whole control
            cluster live underneath (⋯ included, so it toggles shut). There is
            deliberately no dark scrim: the popup is a small floating card, not
            a takeover, and desktop has never dimmed the video behind it.
          z-40 on the dismiss layer sits above the HUD and stacked overlays
          (z-20/30), below the panel (z-50) — and below the up-next card
          (z-45), which stays actionable if it fires mid-menu. */}
      {showMore && (
        <>
          <div
            ref={moreDismissRef}
            onClick={closeMore}
            aria-hidden="true"
            className="absolute inset-x-0 top-0 bottom-[76px] z-40"
          />
          {moreMenu}
        </>
      )}
    </div>

    </div>
  );
}
