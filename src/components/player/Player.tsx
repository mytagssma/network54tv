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

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function formatTime(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00";
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
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

  // Refs for close-on-outside-click
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const serverWrapRef = useRef<HTMLDivElement>(null);
  const qualityWrapRef = useRef<HTMLDivElement>(null);
  const speedWrapRef = useRef<HTMLDivElement>(null);
  const subWrapRef = useRef<HTMLDivElement>(null);

  // Stream state
  const [sources, setSources] = useState<StreamSource[]>([]);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [streamHeaders, setStreamHeaders] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [streamError, setStreamError] = useState(false);

  // Playback state
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);

  // Audio type (sub / dub)
  const [audioType, setAudioType] = useState<"sub" | "dub">("sub");
  const [dubAvailable, setDubAvailable] = useState(false);

  // Server / session state
  const [activeServer, setActiveServer] = useState<string | null>(null);
  const [availableServers, setAvailableServers] = useState<string[]>([]);
  const [showServerPicker, setShowServerPicker] = useState(false);

  // Quality / speed state
  const [currentQuality, setCurrentQuality] = useState<string>("auto");
  const [showQualityPicker, setShowQualityPicker] = useState(false);
  const [hlsLevels, setHlsLevels] = useState<{ index: number; height: number; name: string }[]>([]);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showSpeedPicker, setShowSpeedPicker] = useState(false);

  // Subtitle state
  const [activeSubtitle, setActiveSubtitle] = useState<string | null>(null);
  const [showSubPicker, setShowSubPicker] = useState(false);

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
        ts: Date.now(),
      }));
    } catch {}
  }, [storageKey, activeSubtitle, subtitleOffset, subtitleSize, autoSkipEnabled, autoPlayNext, audioType]);

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

  // ─── Destroy HLS ────────────────────────────────────────
  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  }, []);

  // ─── Load HLS stream ────────────────────────────────────
  const loadHls = useCallback(
    (srcs: StreamSource[], headers: Record<string, string> | null, autoPlay: boolean) => {
      const video = videoRef.current;
      if (!video || srcs.length === 0) return;

      destroyHls();

      // Pick the source matching selected quality, or fallback
      let selected = srcs.find((s) => s.quality === currentQualityRef.current);
      if (!selected) {
        selected =
          srcs.find((s) => s.quality === "1080p") ||
          srcs.find((s) => s.quality === "720p") ||
          srcs.find((s) => s.quality === "480p") ||
          srcs[0];
      }
      if (!selected) return;

      if (selected.isM3U8 && Hls.isSupported()) {
        const loadUrl = headers ? proxyUrl(selected.url, headers) : selected.url;

        const hls = new Hls({
          // Startup
          startLevel: -1,
          testBandwidth: true,
          abrEwmaDefaultEstimate: 1_000_000,
          startFragPrefetch: true,

          // Buffer — "standard" preset from MoonTVPlus/DecoTV
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          maxBufferSize: 60 * 1000 * 1000,
          backBufferLength: 30,
          maxBufferHole: 0.5,

          // VOD: disable LL-HLS to avoid part scheduling jitter
          lowLatencyMode: false,

          // Network resilience
          fragLoadingMaxRetry: 6,
          manifestLoadingMaxRetry: 4,
          levelLoadingMaxRetry: 4,

          // Cap quality to player size (saves bandwidth on mobile)
          capLevelToPlayerSize: true,

          enableWorker: true,
        });
        hls.loadSource(loadUrl);
        hls.attachMedia(video);
        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
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
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                hls.recoverMediaError();
                break;
              default:
                setStreamError(true);
                break;
            }
          }
        });
      } else {
        // Direct play for non-m3u8
        video.src = selected.url;
        if (autoPlay) {
          video.play().catch(() => {});
        }
      }
    },
    [destroyHls]
  );

  // ─── Fetch stream with server fallback ──────────────────
  const fetchStream = useCallback(
    async (type: "sub" | "dub") => {
      const fid = ++fetchIdRef.current;
      setLoading(true);
      setStreamError(false);

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
          if (providerId) params.set("providerId", providerId);

          const res = await fetch(`/api/stream?${params}`);
          if (!res.ok) continue;

          const data = await res.json();
          if (fid !== fetchIdRef.current) return;

          if (data.sources?.length > 0) {
            setSources(data.sources);
            setSubtitles(data.subtitles || []);
            setStreamHeaders(data.headers || null);
            setStreamError(false);
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
        if (fid === fetchIdRef.current) setLoading(false);
      }
    },
    [animeTitle, episodeNumber, anilistId, loadHls]
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
          strict: "true",
        });
        if (anilistId) params.set("anilistId", String(anilistId));
        if (providerId) params.set("providerId", providerId);
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
    [animeTitle, episodeNumber, anilistId]
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
            strict: "true",
          });
          if (anilistId) params.set("anilistId", String(anilistId));
          if (providerId) params.set("providerId", providerId);
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
            loadHls(data.sources, data.headers || null, true);
            setLoading(false);

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
  }, [animeTitle, episodeNumber, providerId]);

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

  useEffect(() => {
    resetControlsTimer();
    return () => {
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    };
  }, [playing, resetControlsTimer]);

  // ─── Close menus on outside click ───────────────────────
  useEffect(() => {
    const closeIfOutside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (showSettings && settingsPanelRef.current && gearRef.current &&
          !settingsPanelRef.current.contains(t) && !gearRef.current.contains(t)) {
        setShowSettings(false);
      }
      if (showServerPicker && serverWrapRef.current && !serverWrapRef.current.contains(t)) setShowServerPicker(false);
      if (showQualityPicker && qualityWrapRef.current && !qualityWrapRef.current.contains(t)) setShowQualityPicker(false);
      if (showSpeedPicker && speedWrapRef.current && !speedWrapRef.current.contains(t)) setShowSpeedPicker(false);
      if (showSubPicker && subWrapRef.current && !subWrapRef.current.contains(t)) setShowSubPicker(false);
    };
    document.addEventListener("pointerdown", closeIfOutside);
    return () => document.removeEventListener("pointerdown", closeIfOutside);
  }, [showSettings, showServerPicker, showQualityPicker, showSpeedPicker, showSubPicker]);

  // ─── Handlers ──────────────────────────────────────────
  const handleTimeUpdate = useCallback(() => {
    const now = performance.now();
    if (now - lastTimeUpdateRef.current >= 250) {
      lastTimeUpdateRef.current = now;
      if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
    }
  }, []);
  const handleLoadedMetadata = () => {
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
      }
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
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
          togglePlay();
          resetControlsTimer();
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
          // Short tap — toggle play/pause
          togglePlay();
          resetControlsTimer();
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
          setShowQualityPicker(false);
          setShowSpeedPicker(false);
          setShowSubPicker(false);
        }
      }}
    >
      {/* Video element */}
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
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
        onClick={togglePlay}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />

{/* Loading overlay — simple terminal progress bar */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10 pointer-events-none">
          <div className="flex flex-col items-center gap-4 w-80">
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
        />
      )}

      {/* Error overlay */}
      {streamError && !loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
          <div className="text-center max-w-sm">
            <p className="text-[#9a9aa0] text-sm mb-2">Stream unavailable</p>
            <p className="text-[#6b6b70] text-xs mb-4">
              No working sources found. Try a different episode or check back later.
            </p>
            <button
              onClick={() => { destroyHls(); loadByType(audioType); }}
              className="text-xs px-4 py-2 border border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors rounded-none"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Skip intro/outro buttons — only shown when AniSkip timestamps exist */}
      {!loading && sources.length > 0 && (inIntro || inOutro) && (
        <div className="absolute bottom-16 left-0 right-0 flex justify-center gap-3 z-30 px-3">
          {inIntro && introSegment && (
            <button
              onClick={() => { if (videoRef.current) videoRef.current.currentTime = introSegment.end; }}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)]/10 border border-[var(--accent)]/40 text-[var(--accent)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--accent)]/20 transition-colors rounded-none"
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
              className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)]/10 border border-[var(--accent)]/40 text-[var(--accent)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--accent)]/20 transition-colors rounded-none"
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
            className="w-full h-1 appearance-none cursor-pointer relative z-10
                       group-hover/bar:h-1.5
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
          {/* Left group: play, volume, time */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Play/Pause */}
            <button onClick={togglePlay} className="flex items-center justify-center text-[var(--accent)] hover:text-white transition-colors w-11 h-11 sm:w-8 sm:h-8">
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
            <span className="text-xs sm:text-sm text-[var(--accent)]/50 tabular-nums font-mono select-none leading-none hidden sm:inline">
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

            {/* Server/Session picker */}
            {availableServers.length > 0 && (
              <div ref={serverWrapRef} className="relative h-full flex items-center gap-1">
                <span className="text-[10px] text-[var(--accent)]/40 uppercase tracking-wider font-mono hidden sm:inline">Srv</span>
                <button
                  onClick={() => { setShowServerPicker(!showServerPicker); setShowQualityPicker(false); setShowSubPicker(false); setShowSettings(false); }}
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
                  onClick={() => { setShowQualityPicker(!showQualityPicker); setShowSpeedPicker(false); setShowSubPicker(false); setShowSettings(false); }}
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
                onClick={() => { setShowSpeedPicker(!showSpeedPicker); setShowQualityPicker(false); setShowSubPicker(false); setShowSettings(false); }}
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
                onClick={() => { setShowSubPicker(!showSubPicker); setShowQualityPicker(false); setShowSpeedPicker(false); setShowSettings(false); }}
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
            </div>

            {/* Settings gear (mobile only) */}
            <button
              ref={gearRef}
              onClick={() => { setShowSettings(!showSettings); setShowServerPicker(false); setShowQualityPicker(false); setShowSpeedPicker(false); setShowSubPicker(false); }}
              className="w-11 h-11 sm:hidden flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors rounded-none"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.611 3.611 0 0112 15.6z" />
              </svg>
            </button>

            {/* Fullscreen */}
            <button onClick={toggleFullscreen} className="w-8 h-8 flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors">
              {isFullscreen ? (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                </svg>
              )}
            </button>
          </div>
        </div>

      </div>

      {/* Top info bar */}
      <div
        className={`absolute top-0 left-0 right-0 p-3 flex items-center gap-3 transition-opacity duration-300 z-20 bg-gradient-to-b from-black/70 to-transparent ${
          showControls ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <span className="text-xs text-[#9a9aa0] truncate max-w-[60%]">
          {animeTitle}
        </span>
        <span className="text-xs text-[var(--accent)]/50 flex-shrink-0 font-mono font-bold">
          EP {String(episodeNumber).padStart(2, "0")}
        </span>
      </div>

      {/* Exit fullscreen button (mobile only, when fullscreen) */}
      {isFullscreen && (
        <button
          onClick={toggleFullscreen}
          className="absolute top-3 right-3 z-30 w-11 h-11 sm:w-10 sm:h-10 flex items-center justify-center bg-black/60 border border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
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
