"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Hls from "hls.js";
import SubtitleOverlay from "./SubtitleOverlay";
import SubtitlePickerContent from "./SubtitlePickerContent";
import { proxyUrl } from "@/lib/utils";
import type { StreamSource, Subtitle } from "@/types/anime";

interface PlayerProps {
  animeTitle: string;
  episodeNumber: number;
  anilistId?: number;
  malId?: number;
  nextEpisodeNumber?: number;
  providerId?: string;
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

const FILTER_PRESETS = [
  { id: "off", label: "Off", css: "none" },
  { id: "vivid", label: "Anime Vivid", css: "brightness(1.05) contrast(1.1) saturate(1.3)" },
  { id: "soft", label: "Anime Soft", css: "brightness(1.02) contrast(0.95) saturate(1.1)" },
  { id: "cinema", label: "Cinema", css: "brightness(0.95) contrast(1.15) saturate(0.85) sepia(0.05)" },
  { id: "sharp", label: "Sharp", css: "brightness(1) contrast(1.1) saturate(1.3)" },
] as const;

type FilterId = (typeof FILTER_PRESETS)[number]["id"];

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

export default function Player({ animeTitle, episodeNumber, anilistId, malId, nextEpisodeNumber, providerId }: PlayerProps) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchIdRef = useRef(0);
  const failoverQueueRef = useRef<string[]>([]);
  const workingServersRef = useRef<{ server: string; sources: StreamSource[]; subtitles: Subtitle[]; headers: Record<string, string> }[]>([]);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressRef = useRef(false);
  const activeServerRef = useRef<string | null>(null);
  const currentQualityRef = useRef("auto");
  const lastTimeUpdateRef = useRef(0);
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
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const serverWrapRef = useRef<HTMLDivElement>(null);
  const providerWrapRef = useRef<HTMLDivElement>(null);
  const qualityWrapRef = useRef<HTMLDivElement>(null);
  const speedWrapRef = useRef<HTMLDivElement>(null);
  const subWrapRef = useRef<HTMLDivElement>(null);
  const filterWrapRef = useRef<HTMLDivElement>(null);

  // Stream state
  const [sources, setSources] = useState<StreamSource[]>([]);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [streamHeaders, setStreamHeaders] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [streamError, setStreamError] = useState(false);
  // Manual provider override — set when the user picks a provider after a failure
  const [providerOverride, setProviderOverride] = useState<string | null>(null);
  const activeProvider = providerOverride ?? providerId;

  // Playback state
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  // Center play/pause feedback glyph — keyboard toggles flash this icon
  // alone instead of the whole control bar
  const [actionGlyph, setActionGlyph] = useState<{ id: number; action: "play" | "pause" } | null>(null);
  const glyphTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Audio type (sub / dub)
  const [audioType, setAudioType] = useState<"sub" | "dub">("sub");
  const [dubAvailable, setDubAvailable] = useState(false);

  // Server / session state
  const [activeServer, setActiveServer] = useState<string | null>(null);
  const [availableServers, setAvailableServers] = useState<string[]>([]);
  const [showServerPicker, setShowServerPicker] = useState(false);

  // Provider dropdown (control bar) — drives the same manual override as the error overlay
  const [showProviderPicker, setShowProviderPicker] = useState(false);

  // Quality / speed state
  const [currentQuality, setCurrentQuality] = useState<string>("auto");
  const [showQualityPicker, setShowQualityPicker] = useState(false);
  const [hlsLevels, setHlsLevels] = useState<{ index: number; height: number; name: string }[]>([]);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showSpeedPicker, setShowSpeedPicker] = useState(false);

  // Subtitle state
  const [activeSubtitle, setActiveSubtitle] = useState<string | null>(null);
  const [showSubPicker, setShowSubPicker] = useState(false);

  // Video filter state
  const [videoFilter, setVideoFilter] = useState<FilterId>("off");
  const [showFilterPicker, setShowFilterPicker] = useState(false);

  // Settings menu (mobile)
  const [showSettings, setShowSettings] = useState(false);

  // Auto-play next episode
  const [autoPlayNext, setAutoPlayNext] = useState(false);

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
  // Prev/next episode targets for the control bar (prev never goes below EP 1)
  const prevEpisodeTarget = episodeNumber > 1 && anilistId ? episodeNumber - 1 : null;
  const nextEpisodeTarget = nextEpisodeNumber && anilistId ? nextEpisodeNumber : null;

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
                  try {
                    hls.recoverMediaError();
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
      setStreamError(false);
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
            handedOffToAttempt = true;
            loadHls(data.sources, data.headers || null, true);
            return;
          }
        }

        // If we exhausted all servers with no success
        if (fid === fetchIdRef.current) {
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
          };
        }
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
      setStreamError(false);

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
        // Populate failover queue with the other working servers
        workingServersRef.current = working.map((w) => ({
          server: w.server,
          sources: w.data.sources,
          subtitles: w.data.subtitles,
          headers: w.data.headers,
        }));
        failoverQueueRef.current = working
          .filter((w) => w.server !== target.server)
          .map((w) => w.server);
        setLoading(false);
        loadHls(target.data.sources, target.data.headers, true);
      } else {
        setLoading(false);
        setStreamError(true);
      }
    },
    [discoverServers, loadHls]
  );

  // ─── Auto-load sub & detect dub on mount ────────
  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setStreamError(false);
    setDubAvailable(false);
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

    // Check saved progress for audio type preference
    const saved = restoreProgress();
    const preferredType: "sub" | "dub" = saved?.audioType === "dub" ? "dub" : "sub";

    // Start dub probes in parallel immediately (don't wait for sub)
    const dubProbePromise = Promise.all(
      SERVERS.map(async (s) => {
        try {
          const d = await probeServer(s, "dub");
          return !!d;
        } catch { return false; }
      })
    );

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
            setAudioType(preferredType);
            // Don't dismiss the loading bar here — the attempt owns it and
            // clears it on MANIFEST_PARSED / loadedmetadata (or fails over).
            loadHls(data.sources, data.headers || null, true);

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

            // Check dub probe results (started at mount, should be done by now)
            const dubResults = await dubProbePromise;
            if (!cancelled && dubResults.some(Boolean)) {
              setDubAvailable(true);
            }
            return;
          }
        } catch { /* continue to next server */ }
      }

      // All sub servers failed — still check dub results
      const dubResults = await dubProbePromise;
      if (!cancelled && dubResults.some(Boolean)) {
        setDubAvailable(true);
      }
      if (!cancelled) {
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
      setShowSubPicker(false);
      setShowSettings(false);
    } catch (e) {
      setOsDownloadError(e instanceof Error ? e.message : "Download failed");
      failedOSIdsRef.current.add(fileId);
    }
  }, [activeSubtitle]);

  // ─── Controls auto-hide ────────────────────────────────
  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      if (playingRef.current) setShowControls(false);
    }, 3000);
  }, []);

  // ─── Center action glyph (YouTube-style play/pause feedback) ──
  const showActionGlyph = useCallback((action: "play" | "pause") => {
    setActionGlyph((prev) => ({ id: (prev?.id ?? 0) + 1, action }));
    if (glyphTimerRef.current) clearTimeout(glyphTimerRef.current);
    glyphTimerRef.current = setTimeout(() => setActionGlyph(null), 750);
  }, []);

  useEffect(() => {
    // Play/pause must not force the HUD visible — it used to flash the whole
    // control bar on every keyboard toggle. Only refresh the hide countdown
    // when the bar is already showing; otherwise leave it alone (the action
    // glyph carries the feedback instead).
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    if (showControlsRef.current) {
      controlsTimerRef.current = setTimeout(() => {
        if (playingRef.current) setShowControls(false);
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
      if (showSettings && settingsPanelRef.current && gearRef.current &&
          !settingsPanelRef.current.contains(t) && !gearRef.current.contains(t)) {
        setShowSettings(false);
      }
      if (showServerPicker && serverWrapRef.current && !serverWrapRef.current.contains(t)) setShowServerPicker(false);
      if (showProviderPicker && providerWrapRef.current && !providerWrapRef.current.contains(t)) setShowProviderPicker(false);
      if (showQualityPicker && qualityWrapRef.current && !qualityWrapRef.current.contains(t)) setShowQualityPicker(false);
      if (showSpeedPicker && speedWrapRef.current && !speedWrapRef.current.contains(t)) setShowSpeedPicker(false);
      if (showSubPicker && subWrapRef.current && !subWrapRef.current.contains(t)) setShowSubPicker(false);
      if (showFilterPicker && filterWrapRef.current && !filterWrapRef.current.contains(t)) setShowFilterPicker(false);
    };
    document.addEventListener("pointerdown", closeIfOutside);
    return () => document.removeEventListener("pointerdown", closeIfOutside);
  }, [showSettings, showServerPicker, showProviderPicker, showQualityPicker, showSpeedPicker, showSubPicker, showFilterPicker]);

  // ─── Handlers ──────────────────────────────────────────
  const handleTimeUpdate = useCallback(() => {
    const now = performance.now();
    if (now - lastTimeUpdateRef.current >= 250) {
      lastTimeUpdateRef.current = now;
      if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
    }
  }, []);
  const handleLoadedMetadata = () => {
    // Progressive/direct-src attempt now has media metadata — it is playable,
    // so this is where its loading bar is dismissed (HLS dismisses on
    // MANIFEST_PARSED). No-op unless an attempt is still pending.
    markAttemptReady();
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
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

  const togglePlay = (showGlyph: boolean = true) => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
      videoRef.current.playbackRate = playbackRateRef.current;
      setPlaying(true);
      if (showGlyph) showActionGlyph("play");
    } else {
      videoRef.current.pause();
      setPlaying(false);
      if (showGlyph) showActionGlyph("pause");
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
  };

  // ─── Skip ±10s (control-bar buttons) ─────────────────────
  const seekBy = (delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    const max = isFinite(video.duration) && video.duration > 0 ? video.duration : Number.MAX_SAFE_INTEGER;
    video.currentTime = Math.max(0, Math.min(max, video.currentTime + delta));
    setCurrentTime(video.currentTime);
    resetControlsTimer();
  };

  // ─── Episode navigation (control-bar prev/next) ──────────
  const goToEpisode = (n: number) => {
    if (!anilistId) return;
    saveProgress(); // SPA navigation never fires beforeunload — persist here
    router.push(`/anime/${anilistId}/watch/${n}`);
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    const doc = document as any;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc);
      // Unlock orientation when exiting fullscreen
      if (screen.orientation && typeof screen.orientation.unlock === "function") {
        screen.orientation.unlock();
      }
    } else {
      const el = containerRef.current as any;
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
    setShowQualityPicker(false);

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

  // ─── Pick a streaming provider (control-bar dropdown) ───────
  // Reuses the manual override the error overlay uses: flipping the
  // override changes `activeProvider`, which re-runs the load effect
  // and reloads the stream with that provider.
  const selectProvider = (id: string) => {
    setShowProviderPicker(false);
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
      destroyHls();
      loadByType(type);
    },
    [audioType, destroyHls, loadByType]
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

    // Periodic stall detection — if playback is frozen for >8s,
    // try to recover even without a network event.
    const stallCheck = setInterval(() => {
      const video = videoRef.current;
      const hls = hlsRef.current;
      if (!video || !hls || !hls.url || video.paused) return;
      if (video.readyState >= 3) return; // enough data, not stalled
      // Stalled and was playing — try to recover
      recoverStream();
    }, 8000);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    conn?.addEventListener("change", handleConnectionChange);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      conn?.removeEventListener("change", handleConnectionChange);
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
        try { hls.recoverMediaError(); } catch { /* ignore */ }
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
          // No HUD flash for keyboard toggles — the center glyph is the feedback
          togglePlay();
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
        case 'ArrowLeft':
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 10);
          setCurrentTime(video.currentTime);
          resetControlsTimer();
          break;
        case 'ArrowRight':
          e.preventDefault();
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
          setCurrentTime(video.currentTime);
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
          setShowSettings(false);
          setShowServerPicker(false);
          setShowProviderPicker(false);
          setShowQualityPicker(false);
          setShowSpeedPicker(false);
          setShowSubPicker(false);
          setShowFilterPicker(false);
          break;
        case ',':
          if (!e.shiftKey) break;
          e.preventDefault();
          { const i = SPEED_PRESETS.indexOf(playbackRateRef.current);
          const prev = i > 0 ? SPEED_PRESETS[i - 1] : SPEED_PRESETS[0];
          video.playbackRate = prev;
          setPlaybackRate(prev); }
          resetControlsTimer();
          break;
        case '.':
          if (!e.shiftKey) break;
          e.preventDefault();
          { const i = SPEED_PRESETS.indexOf(playbackRateRef.current);
          const next = i < SPEED_PRESETS.length - 1 ? SPEED_PRESETS[i + 1] : SPEED_PRESETS[SPEED_PRESETS.length - 1];
          video.playbackRate = next;
          setPlaybackRate(next); }
          resetControlsTimer();
          break;
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
          // Short tap — toggle play/pause (glyph feedback, no HUD flash)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="w-full">
    <div
      ref={containerRef}
      className="relative w-full aspect-[2/1] sm:aspect-video bg-black overflow-hidden group outline-none"
      tabIndex={0}
      onMouseMove={handleMouseMove}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && containerRef.current && !containerRef.current.contains(next) &&
            !(settingsPanelRef.current && settingsPanelRef.current.contains(next))) {
          setShowSettings(false);
          setShowServerPicker(false);
          setShowProviderPicker(false);
          setShowQualityPicker(false);
          setShowSpeedPicker(false);
          setShowSubPicker(false);
          setShowFilterPicker(false);
        }
      }}
    >
      {/* Action-glyph keyframes (inline so they ship with the player) */}
      <style>{`
        @keyframes n54-glyph-grow {
          from { transform: scale(0.7); }
          to { transform: scale(2.1); }
        }
        @keyframes n54-glyph-fade {
          0% { opacity: 1; }
          12% { opacity: 1; }
          100% { opacity: 0; }
        }
        .n54-action-glyph {
          animation:
            n54-glyph-grow 620ms cubic-bezier(0.16, 1, 0.3, 1) forwards,
            n54-glyph-fade 620ms linear forwards;
        }
        @media (prefers-reduced-motion: reduce) {
          .n54-action-glyph { animation: n54-glyph-fade 620ms linear forwards; }
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
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          if (autoPlayNext && nextEpisodeNumber) {
            router.push(`/anime/${anilistId}/watch/${nextEpisodeNumber}`);
          }
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

      {/* Error overlay */}
      {streamError && !loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
          <div className="text-center max-w-sm px-4">
            <p className="text-[#9a9aa0] text-sm mb-1">Stream unavailable</p>
            <p className="text-[#6b6b70] text-xs mb-4 leading-relaxed">
              {activeProvider
                ? `No working sources from ${activeProvider}. Pick a different provider below or retry.`
                : "All streaming providers returned no sources. Pick a provider below or try again later."}
            </p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => { destroyHls(); loadByType(audioType); }}
                className="text-xs px-5 py-2.5 border border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors rounded-none min-h-[44px]"
              >
                Retry
              </button>
              <button
                onClick={() => { destroyHls(); loadByType(audioType === "sub" ? "dub" : "sub"); }}
                className="text-xs px-5 py-2.5 border border-white/10 text-[#9a9aa0] hover:bg-white/5 transition-colors rounded-none min-h-[44px]"
              >
                {audioType === "sub" ? "Try Dub" : "Try Sub"}
              </button>
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

      {/* Center action glyph — shown on play/pause instead of flashing the HUD.
          Grows along a fast-start/decelerating curve while it fades out. */}
      {actionGlyph && (
        <div
          key={actionGlyph.id}
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
        >
          <div className="n54-action-glyph flex h-20 w-20 items-center justify-center rounded-full bg-black/45 text-white shadow-[0_4px_24px_rgba(0,0,0,0.45)] backdrop-blur-[2px]">
            {actionGlyph.action === "pause" ? (
              <svg className="h-9 w-9" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg className="h-9 w-9" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </div>
        </div>
      )}

      {/* Skip intro/outro buttons — only shown when AniSkip timestamps exist */}
      {!loading && sources.length > 0 && (inIntro || inOutro) && (
        <div className="absolute bottom-12 left-0 right-0 sm:bottom-16 sm:left-auto sm:right-auto flex justify-center sm:justify-center gap-2 sm:gap-3 z-30 px-3">
          {inIntro && introSegment && (
            <button
              onClick={() => { if (videoRef.current) videoRef.current.currentTime = introSegment.end; }}
              className="flex items-center gap-1.5 sm:gap-2 px-4 py-2 sm:px-3 sm:py-1.5 bg-[var(--accent)]/10 border border-[var(--accent)]/40 text-[var(--accent)] text-[11px] sm:text-xs font-mono uppercase tracking-wider hover:bg-[var(--accent)]/20 transition-colors rounded-none"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              </svg>
              Skip Intro
            </button>
          )}
          {inOutro && outroSegment && (
            <button
              onClick={() => { if (videoRef.current) videoRef.current.currentTime = outroSegment.end; }}
              className="flex items-center gap-1.5 sm:gap-2 px-4 py-2 sm:px-3 sm:py-1.5 bg-[var(--accent)]/10 border border-[var(--accent)]/40 text-[var(--accent)] text-[11px] sm:text-xs font-mono uppercase tracking-wider hover:bg-[var(--accent)]/20 transition-colors rounded-none"
            >
              Skip Outro
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>
      )}

        {/* Controls overlay (bottom) */}
      <div
        className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent pt-12 pb-3 px-3 transition-opacity duration-300 z-20 ${
          showControls ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Progress bar */}
        <div className="mb-2 group/bar h-4 flex items-center">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
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
        </div>

        {/* Controls row */}
        <div className="flex items-center justify-between">
          {/* Left group: prev/next episode, transport, volume, time */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Previous episode */}
            <button
              onClick={() => { if (prevEpisodeTarget) goToEpisode(prevEpisodeTarget); }}
              disabled={!prevEpisodeTarget}
              title={prevEpisodeTarget ? `Episode ${prevEpisodeTarget}` : "First episode"}
              aria-label="Previous episode"
              className={`hidden lg:flex items-center justify-center transition-colors w-11 h-11 sm:w-8 sm:h-8 ${
                prevEpisodeTarget
                  ? "text-[var(--accent)]/50 hover:text-[var(--accent)]"
                  : "text-[var(--accent)]/50 opacity-30 cursor-not-allowed"
              }`}
            >
              <svg className="w-6 h-6 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
              </svg>
            </button>

            {/* Skip back 10s */}
            <button
              onClick={() => seekBy(-10)}
              title="Back 10 seconds"
              aria-label="Skip back 10 seconds"
              className="flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors w-11 h-11 sm:w-8 sm:h-8"
            >
              <svg className="w-6 h-6 sm:w-5 sm:h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 4.8a7.2 7.2 0 1 0 7.2 7.2" />
                <path d="M12 1.8 12 7.8 8.4 4.8z" fill="currentColor" stroke="none" />
                <text x="12" y="12.2" textAnchor="middle" dominantBaseline="central" fontSize="7.6" fontWeight="700" fill="currentColor" stroke="none">10</text>
              </svg>
            </button>

            {/* Play/Pause */}
            <button onClick={() => togglePlay(false)} className="flex items-center justify-center text-[var(--accent)] hover:text-white transition-colors w-11 h-11 sm:w-8 sm:h-8">
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

            {/* Skip forward 10s */}
            <button
              onClick={() => seekBy(10)}
              title="Forward 10 seconds"
              aria-label="Skip forward 10 seconds"
              className="flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors w-11 h-11 sm:w-8 sm:h-8"
            >
              <svg className="w-6 h-6 sm:w-5 sm:h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 4.8a7.2 7.2 0 1 1-7.2 7.2" />
                <path d="M12 1.8 12 7.8 15.6 4.8z" fill="currentColor" stroke="none" />
                <text x="12" y="12.2" textAnchor="middle" dominantBaseline="central" fontSize="7.6" fontWeight="700" fill="currentColor" stroke="none">10</text>
              </svg>
            </button>

            {/* Next episode */}
            <button
              onClick={() => { if (nextEpisodeTarget) goToEpisode(nextEpisodeTarget); }}
              disabled={!nextEpisodeTarget}
              title={nextEpisodeTarget ? `Episode ${nextEpisodeTarget}` : "No next episode"}
              aria-label="Next episode"
              className={`hidden lg:flex items-center justify-center transition-colors w-11 h-11 sm:w-8 sm:h-8 ${
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
              <button onClick={toggleMute} className="flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors w-11 h-11 sm:w-8 sm:h-8">
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
              <div className="overflow-hidden w-0 group-hover/vol:w-20 sm:group-hover/vol:w-24 transition-all duration-200 h-8 flex items-center">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={handleVolume}
                  className="w-20 sm:w-24 h-1 appearance-none cursor-pointer
                             [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                             [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:rounded-none"
                  style={{
                    background: `linear-gradient(to right, rgba(var(--accent-rgb),0.5) ${(muted ? 0 : volume) * 100}%, rgba(255,255,255,0.1) ${(muted ? 0 : volume) * 100}%)`,
                  }}
                />
              </div>
            </div>

            {/* Time */}
            <span className="text-xs sm:text-sm text-[var(--accent)]/50 tabular-nums font-mono select-none leading-none">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          {/* Right group: gear (mobile), fullscreen */}
          <div className="flex items-center gap-1.5 justify-end shrink-0">
            {/* Desktop pickers: hidden on mobile */}
            <div className="hidden sm:contents">
            {/* Sub / Dub segmented toggle */}
            {dubAvailable && (
              <div className="flex items-center bg-black/40 border border-[var(--accent)]/20 overflow-hidden rounded-none">
                <button
                  onClick={() => switchAudioType("sub")}
                  className={`px-3 text-[11px] font-semibold tracking-wide transition-colors h-7 ${
                    audioType === "sub"
                      ? "bg-[var(--accent)] text-black"
                      : "text-[var(--accent)]/50 hover:text-[var(--accent)]"
                  }`}
                >
                  SUB
                </button>
                <div className="w-px h-4 bg-[var(--accent)]/20" />
                <button
                  onClick={() => switchAudioType("dub")}
                  className={`px-3 text-[11px] font-semibold tracking-wide transition-colors h-7 ${
                    audioType === "dub"
                      ? "bg-[var(--accent)] text-black"
                      : "text-[var(--accent)]/50 hover:text-[var(--accent)]"
                  }`}
                >
                  DUB
                </button>
              </div>
            )}

            {/* Provider picker */}
            <div ref={providerWrapRef} className="relative h-full flex items-center gap-1">
              <span className="text-[10px] text-[var(--accent)]/40 uppercase tracking-wider font-mono hidden sm:inline">Pv</span>
              <button
                onClick={() => { setShowProviderPicker(!showProviderPicker); setShowServerPicker(false); setShowQualityPicker(false); setShowSpeedPicker(false); setShowSubPicker(false); setShowSettings(false); setShowFilterPicker(false); }}
                className="text-[11px] px-2.5 text-[var(--accent)]/50 hover:text-[var(--accent)] bg-black/40 border border-[var(--accent)]/20 hover:border-[var(--accent)]/50 transition-colors rounded-none h-7 flex items-center gap-1"
                title="Streaming provider"
              >
                {PROVIDER_OPTIONS.find((p) => p.id === (providerOverride ?? providerId ?? ""))?.label ?? "Auto"}
                <svg className="w-3 h-3 opacity-50" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M7 10l5 5 5-5z" />
                </svg>
              </button>
              {showProviderPicker && (
                <div className="absolute right-0 bottom-full mb-1 w-40 bg-[#131318] border border-[var(--accent)]/20 shadow-xl z-50 backdrop-blur-sm py-0.5 rounded-none">
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--accent)]/30 font-semibold font-mono">Provider</div>
                  {PROVIDER_OPTIONS.map((p) => {
                    const current = providerOverride ?? providerId ?? "";
                    const isActive = current === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => selectProvider(p.id)}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors rounded-none ${
                          isActive
                            ? "bg-[var(--accent)]/20 text-[var(--accent)] border-l-2 border-[var(--accent)]"
                            : "text-[#9a9aa0] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Server/Session picker */}
            {availableServers.length > 0 && (
              <div ref={serverWrapRef} className="relative h-full flex items-center gap-1">
                <span className="text-[10px] text-[var(--accent)]/40 uppercase tracking-wider font-mono hidden sm:inline">Srv</span>
                <button
                  onClick={() => { setShowServerPicker(!showServerPicker); setShowProviderPicker(false); setShowQualityPicker(false); setShowSubPicker(false); setShowSettings(false); setShowFilterPicker(false); }}
                  className="text-[11px] px-2.5 text-[var(--accent)]/50 hover:text-[var(--accent)] bg-black/40 border border-[var(--accent)]/20 hover:border-[var(--accent)]/50 transition-colors rounded-none h-7 flex items-center gap-1"
                >
                  {activeServer || "Auto"}
                </button>
                {showServerPicker && (
                  <div className="absolute right-0 bottom-full mb-1 w-40 bg-[#131318] border border-[var(--accent)]/20 shadow-xl z-50 backdrop-blur-sm py-0.5 rounded-none">
                    <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--accent)]/30 font-semibold font-mono">Server</div>
                    {availableServers.map((s) => (
                      <button
                        key={s}
                        onClick={() => { setActiveServer(s); activeServerRef.current = s; setShowServerPicker(false); loadByType(audioType, s); }}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors rounded-none ${
                          activeServer === s
                            ? "bg-[var(--accent)]/20 text-[var(--accent)] border-l-2 border-[var(--accent)]"
                            : "text-[#9a9aa0] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Quality picker */}
            {availableQualities.length > 0 && (
              <div ref={qualityWrapRef} className="relative h-full flex items-center">
                <button
                  onClick={() => { setShowQualityPicker(!showQualityPicker); setShowProviderPicker(false); setShowSpeedPicker(false); setShowSubPicker(false); setShowSettings(false); setShowFilterPicker(false); }}
                  className="h-7 flex items-center gap-1 text-[11px] px-2 text-[var(--accent)]/50 hover:text-[var(--accent)] bg-black/40 border border-[var(--accent)]/20 hover:border-[var(--accent)]/50 transition-colors rounded-none"
                >
                  <svg className="w-3 h-3 opacity-60" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.611 3.611 0 0112 15.6z" />
                  </svg>
                  {currentQuality === "auto" ? "Auto" : currentQuality}
                  <svg className="w-3 h-3 opacity-50" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M7 10l5 5 5-5z" />
                  </svg>
                </button>
                {showQualityPicker && (
                  <div className="absolute right-0 bottom-full mb-1.5 w-32 bg-[#131318] border border-[var(--accent)]/20 shadow-xl overflow-hidden z-50 backdrop-blur-sm rounded-none">
                    <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] text-[var(--accent)]/30 uppercase tracking-wider font-semibold font-mono">
                      Quality
                    </div>
                    {availableQualities.map((q) => (
                      <button
                        key={q}
                        onClick={() => changeQuality(q)}
                        className={`w-full text-left px-2.5 py-1.5 text-xs transition-colors rounded-none ${
                          // Highlight if it's the current quality, or if auto is active and this is the first item
                          q === currentQuality
                            ? "bg-[var(--accent)]/20 text-[var(--accent)] border-l-2 border-[var(--accent)]"
                            : "text-[#9a9aa0] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
                        }`}
                      >
                        {q === "auto" ? "Auto" : q}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Speed selector */}
            <div ref={speedWrapRef} className="relative h-full flex items-center">
              <button
                onClick={() => { setShowSpeedPicker(!showSpeedPicker); setShowProviderPicker(false); setShowQualityPicker(false); setShowSubPicker(false); setShowSettings(false); setShowFilterPicker(false); }}
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
                <div className="absolute right-0 bottom-full mb-1.5 w-28 bg-[#131318] border border-[var(--accent)]/20 shadow-xl overflow-hidden z-50 backdrop-blur-sm rounded-none">
                  <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] text-[var(--accent)]/30 uppercase tracking-wider font-semibold font-mono">
                    Speed
                  </div>
                  {SPEED_PRESETS.map((r) => (
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

            {/* Subtitle toggle + picker */}
            <div ref={subWrapRef} className="relative h-full flex items-center">
              <button
                onClick={() => { setShowSubPicker(!showSubPicker); setShowProviderPicker(false); setShowQualityPicker(false); setShowSpeedPicker(false); setShowSettings(false); setShowFilterPicker(false); }}
                className={`h-7 flex items-center gap-1 text-[11px] px-2 border transition-colors rounded-none ${
                  activeSubtitle
                    ? "text-[var(--accent)] bg-[var(--accent)]/20 border-[var(--accent)]/50"
                    : "text-[var(--accent)]/50 bg-black/40 border-[var(--accent)]/20 hover:text-[var(--accent)] hover:border-[var(--accent)]/50"
                }`}
              >
                <svg className="w-3 h-3 opacity-80" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z" />
                </svg>
                CC
              </button>
              {showSubPicker && (
                <div className="absolute right-0 bottom-full mb-1.5 w-52 bg-[#131318] border border-[var(--accent)]/20 shadow-xl z-50 max-h-80 overflow-y-auto backdrop-blur-sm rounded-none">
                  <SubtitlePickerContent
                    activeSubtitle={activeSubtitle}
                    subtitles={subtitles}
                    onSelect={(url) => { setActiveSubtitle(url); setActiveOSSubtitleId(null); setShowSubPicker(false); }}
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
            </div>

            {/* Auto-play next episode toggle */}
            <button
              onClick={() => setAutoPlayNext(!autoPlayNext)}
              className={`h-7 flex items-center gap-1 text-[11px] px-2 border transition-colors rounded-none ${
                autoPlayNext
                  ? "text-[var(--accent)] bg-[var(--accent)]/20 border-[var(--accent)]/50"
                  : "text-[var(--accent)]/50 bg-black/40 border-[var(--accent)]/20 hover:text-[var(--accent)] hover:border-[var(--accent)]/50"
              }`}
            >
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
              AUTO
            </button>

            {/* Auto-skip toggle */}
            <button
              onClick={() => setAutoSkipEnabled(!autoSkipEnabled)}
              className={`h-7 flex items-center gap-1 text-[11px] px-2 border transition-colors rounded-none ${
                autoSkipEnabled
                  ? "text-[var(--accent)] bg-[var(--accent)]/20 border-[var(--accent)]/50"
                  : "text-[var(--accent)]/50 bg-black/40 border-[var(--accent)]/20 hover:text-[var(--accent)] hover:border-[var(--accent)]/50"
              }`}
            >
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
              </svg>
              SKIP
            </button>

            {/* Video filter picker */}
            <div ref={filterWrapRef} className="relative h-full flex items-center">
              <button
                onClick={() => { setShowFilterPicker(!showFilterPicker); setShowProviderPicker(false); setShowQualityPicker(false); setShowSpeedPicker(false); setShowSubPicker(false); setShowSettings(false); }}
                className={`h-7 flex items-center gap-1 text-[11px] px-2 border transition-colors rounded-none ${
                  videoFilter !== "off"
                    ? "text-[var(--accent)] bg-[var(--accent)]/20 border-[var(--accent)]/50"
                    : "text-[var(--accent)]/50 bg-black/40 border-[var(--accent)]/20 hover:text-[var(--accent)] hover:border-[var(--accent)]/50"
                }`}
              >
                <svg className="w-3 h-3 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                </svg>
                FX
              </button>
              {showFilterPicker && (
                <div className="absolute right-0 bottom-full mb-1.5 w-40 bg-[#131318] border border-[var(--accent)]/20 shadow-xl overflow-hidden z-50 backdrop-blur-sm rounded-none">
                  <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] text-[var(--accent)]/30 uppercase tracking-wider font-semibold font-mono">
                    Filter
                  </div>
                  {FILTER_PRESETS.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => { setVideoFilter(f.id); setShowFilterPicker(false); }}
                      className={`w-full text-left px-2.5 py-1.5 text-xs transition-colors rounded-none ${
                        videoFilter === f.id
                          ? "bg-[var(--accent)]/20 text-[var(--accent)] border-l-2 border-[var(--accent)]"
                          : "text-[#9a9aa0] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            </div>

            {/* Settings gear (mobile only) */}
            <button
              ref={gearRef}
              onClick={() => { setShowSettings(!showSettings); setShowServerPicker(false); setShowProviderPicker(false); setShowQualityPicker(false); setShowSpeedPicker(false); setShowSubPicker(false); setShowFilterPicker(false); }}
              className="w-11 h-11 sm:hidden flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors rounded-none"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.611 3.611 0 0112 15.6z" />
              </svg>
            </button>

            {/* Enter fullscreen (hidden when already fullscreen — top-right exit button handles that) */}
            {!isFullscreen && (
              <button onClick={toggleFullscreen} className="w-11 h-11 sm:w-8 sm:h-8 flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors">
                <svg className="w-5 h-5 sm:w-4 sm:h-4" fill="currentColor" viewBox="0 0 24 24">
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
    </div>

    {/* Mobile settings panel — outside overflow-hidden so it isn't clipped */}
    {showSettings && (
      <div ref={settingsPanelRef} className="sm:hidden bg-[#131318] border border-[var(--accent)]/20 border-b-0 mx-0 mb-0 max-h-[60vh] overflow-y-auto rounded-none">
        {/* Close button */}
        <div className="sticky top-0 z-10 flex justify-end px-2 pt-2 bg-[#131318]">
          <button
            onClick={() => setShowSettings(false)}
            className="w-7 h-7 flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors border border-[var(--accent)]/20"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-3 pt-1 space-y-3">
          {/* Audio section */}
          {dubAvailable && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--accent)]/30 font-mono mb-2">Audio</div>
              <div className="flex bg-black/40 border border-[var(--accent)]/20 overflow-hidden rounded-none">
                <button
                  onClick={() => switchAudioType("sub")}
                  className={`flex-1 px-4 py-2 text-xs font-semibold tracking-wide transition-colors rounded-none ${
                    audioType === "sub"
                      ? "bg-[var(--accent)] text-black"
                      : "text-[var(--accent)]/50 hover:text-[var(--accent)]"
                  }`}
                >
                  SUB
                </button>
                <div className="w-px bg-[var(--accent)]/20" />
                <button
                  onClick={() => switchAudioType("dub")}
                  className={`flex-1 px-4 py-2 text-xs font-semibold tracking-wide transition-colors rounded-none ${
                    audioType === "dub"
                      ? "bg-[var(--accent)] text-black"
                      : "text-[var(--accent)]/50 hover:text-[var(--accent)]"
                  }`}
                >
                  DUB
                </button>
              </div>
            </div>
          )}

          {/* Server section */}
          {availableServers.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--accent)]/30 font-mono mb-2">Server</div>
              <div className="flex flex-col gap-0.5">
                {availableServers.map((s) => (
                  <button
                    key={s}
                    onClick={() => { setActiveServer(s); activeServerRef.current = s; loadByType(audioType, s); }}
                    className={`w-full text-left px-3 py-2 text-xs transition-colors rounded-none ${
                      activeServer === s
                        ? "bg-[var(--accent)]/20 text-[var(--accent)] border-l-2 border-[var(--accent)]"
                        : "text-[#9a9aa0] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Provider section */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--accent)]/30 font-mono mb-2">Provider</div>
            <div className="flex flex-wrap gap-1">
              {PROVIDER_OPTIONS.map((p) => {
                const current = providerOverride ?? providerId ?? "";
                return (
                  <button
                    key={p.id}
                    onClick={() => selectProvider(p.id)}
                    className={`px-3 py-1.5 text-xs transition-colors rounded-none ${
                      current === p.id
                        ? "bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/50"
                        : "text-[#9a9aa0] hover:text-[var(--accent)] border border-[var(--accent)]/10"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Quality section */}
          {availableQualities.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--accent)]/30 font-mono mb-2">Quality</div>
              <div className="flex flex-wrap gap-1">
                {availableQualities.map((q) => (
                  <button
                    key={q}
                    onClick={() => { changeQuality(q); }}
                    className={`px-3 py-1.5 text-xs transition-colors rounded-none ${
                      q === currentQuality
                        ? "bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/50"
                        : "text-[#9a9aa0] hover:text-[var(--accent)] border border-[var(--accent)]/10"
                    }`}
                  >
                    {q === "auto" ? "Auto" : q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Speed section */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--accent)]/30 font-mono mb-2">Speed</div>
            <div className="flex flex-wrap gap-1">
              {SPEED_PRESETS.map((r) => (
                <button
                  key={r}
                   onClick={() => { changeSpeed(r); }}
                  className={`px-3 py-1.5 text-xs transition-colors rounded-none ${
                    playbackRate === r
                      ? "bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/50"
                      : "text-[#9a9aa0] hover:text-[var(--accent)] border border-[var(--accent)]/10"
                  }`}
                >
                  {r}x
                </button>
              ))}
            </div>
          </div>

          {/* Filter section */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--accent)]/30 font-mono mb-2">Filter</div>
            <div className="flex flex-wrap gap-1">
              {FILTER_PRESETS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setVideoFilter(f.id)}
                  className={`px-3 py-1.5 text-xs transition-colors rounded-none ${
                    videoFilter === f.id
                      ? "bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/50"
                      : "text-[#9a9aa0] hover:text-[var(--accent)] border border-[var(--accent)]/10"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Auto-Play section */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--accent)]/30 font-mono mb-2">Auto-Play</div>
            <button
              onClick={() => setAutoPlayNext(!autoPlayNext)}
              className={`w-full text-left px-3 py-2 text-xs transition-colors rounded-none ${
                autoPlayNext
                  ? "bg-[var(--accent)]/20 text-[var(--accent)] border-l-2 border-[var(--accent)]"
                  : "text-[#9a9aa0] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
              }`}
            >
              {autoPlayNext ? "ON — Next episode plays automatically" : "OFF"}
            </button>
          </div>

          {/* Auto-Skip section */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--accent)]/30 font-mono mb-2">Auto-Skip</div>
            <button
              onClick={() => setAutoSkipEnabled(!autoSkipEnabled)}
              className={`w-full text-left px-3 py-2 text-xs transition-colors rounded-none ${
                autoSkipEnabled
                  ? "bg-[var(--accent)]/20 text-[var(--accent)] border-l-2 border-[var(--accent)]"
                  : "text-[#9a9aa0] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
              }`}
            >
              {autoSkipEnabled ? "ON — Auto-skips intro/outro" : "OFF"}
            </button>
          </div>

          {/* Subtitles section */}
          <div>
            <SubtitlePickerContent
               activeSubtitle={activeSubtitle}
               subtitles={subtitles}
               onSelect={(url) => { setActiveSubtitle(url); setActiveOSSubtitleId(null); }}
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
               onResetOpenSubtitles={() => { setOsSearched(false); setOsResults([]); setOsError(null); failedOSIdsRef.current.clear(); }}
               activeOSSubtitleId={activeOSSubtitleId}
               osDownloadError={osDownloadError}
               onClearDownloadError={() => setOsDownloadError(null)}
             />
          </div>
        </div>
      </div>
    )}
    </div>
  );
}
