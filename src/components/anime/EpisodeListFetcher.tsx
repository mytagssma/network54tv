"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import EpisodeList from "./EpisodeList";
import { AudioCount, EmptyState, LoadingNote, type AudioTallies } from "./Availability";
import type { Episode } from "@/types/anime";

/**
 * Mirrors `AudioSummary` from `@/lib/providers` (declared locally so this client
 * component never pulls the server-side provider module into the bundle).
 * `subOfTotal`/`dubOfTotal` are the shared partial-tally contract: present only
 * when SOME rows are known and others aren't (Lane A), absent when everything
 * was checked — `AudioCount` renders both shapes, and reads them defensively.
 */
interface AudioSummary extends AudioTallies {
  subCount: number | null;
  dubCount: number | null;
  canProbe: boolean;
  probed: boolean;
}

/** Mirrors `EpisodeListStatus` from `@/lib/providers` — same reason as above. */
type ListStatus = "ok" | "none" | "suspect";

/**
 * ── sessionStorage audio cache (shared with the Player) ─────────────────
 *
 * The sub/dub tally is expensive to relearn (a full `?audio=1` probe) and
 * cheap to remember, so the learned summary is mirrored under
 * `n54tv-audio:{anilistId}` for 5 minutes. Lane C's Player reads and writes
 * the SAME key, TTL and shape — that pairing is the contract:
 *
 *   { subCount, dubCount, subOfTotal?, dubOfTotal?, at }
 *
 * `at` is epoch ms; entries older than `AUDIO_CACHE_TTL_MS` are ignored (and
 * evicted on read). Writes happen whenever this component learns a count —
 * the streamed server props included — reads happen BEFORE any fetch, so a
 * fresh entry that knows at least one count skips the network entirely.
 */
const AUDIO_CACHE_KEY_PREFIX = "n54tv-audio:";
const AUDIO_CACHE_TTL_MS = 5 * 60 * 1000;

interface StoredAudioTallies {
  subCount?: number | null;
  dubCount?: number | null;
  subOfTotal?: number | null;
  dubOfTotal?: number | null;
  at?: number;
}

function audioCacheKey(animeId: number): string {
  return `${AUDIO_CACHE_KEY_PREFIX}${animeId}`;
}

/** Fresh stored tally, or null (missing / unreadable / expired). */
function readAudioCache(animeId: number): StoredAudioTallies | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(audioCacheKey(animeId));
    if (!raw) return null;
    const parsed: StoredAudioTallies | null = JSON.parse(raw);
    if (!parsed || typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return null;
    if (Date.now() - parsed.at > AUDIO_CACHE_TTL_MS) {
      window.sessionStorage.removeItem(audioCacheKey(animeId));
      return null;
    }
    return parsed;
  } catch {
    return null; // private mode / quota / corrupt JSON — the probe just runs.
  }
}

/** Mirror a learned tally. Only counts actually known are worth storing. */
function writeAudioCache(animeId: number, tallies: AudioTallies): void {
  if (typeof window === "undefined") return;
  const known =
    (typeof tallies.subCount === "number" && Number.isFinite(tallies.subCount)) ||
    (typeof tallies.dubCount === "number" && Number.isFinite(tallies.dubCount));
  if (!known) return;
  try {
    window.sessionStorage.setItem(
      audioCacheKey(animeId),
      JSON.stringify({
        subCount: tallies.subCount ?? null,
        dubCount: tallies.dubCount ?? null,
        subOfTotal: tallies.subOfTotal ?? null,
        dubOfTotal: tallies.dubOfTotal ?? null,
        at: Date.now(),
      })
    );
  } catch {
    // Storage unavailable — the cache is an optimization, never a dependency.
  }
}

/** True when the entry is fresh AND remembers at least one real count. */
function knowsACount(stored: StoredAudioTallies): boolean {
  return (
    (typeof stored.subCount === "number" && Number.isFinite(stored.subCount)) ||
    (typeof stored.dubCount === "number" && Number.isFinite(stored.dubCount))
  );
}

/**
 * Fold a stored tally into the current summary, per side and only where the
 * current summary doesn't already know the count (the streamed server props
 * win). Returns `prev` unchanged when there is nothing to gain — that identity
 * bail-out is what keeps the effect below from looping.
 */
function mergeStoredAudio(prev: AudioSummary | null, stored: StoredAudioTallies): AudioSummary | null {
  const useStoredSub = prev?.subCount == null && typeof stored.subCount === "number";
  const useStoredDub = prev?.dubCount == null && typeof stored.dubCount === "number";
  if (prev !== null && !useStoredSub && !useStoredDub) return prev;

  const next: AudioSummary = {
    subCount: useStoredSub ? (stored.subCount as number) : (prev?.subCount ?? null),
    dubCount: useStoredDub ? (stored.dubCount as number) : (prev?.dubCount ?? null),
    subOfTotal: useStoredSub ? (stored.subOfTotal ?? null) : (prev?.subOfTotal ?? null),
    dubOfTotal: useStoredDub ? (stored.dubOfTotal ?? null) : (prev?.dubOfTotal ?? null),
    canProbe: prev?.canProbe ?? false,
    probed: prev?.probed ?? false,
  };

  if (
    prev !== null &&
    next.subCount === prev.subCount &&
    next.dubCount === prev.dubCount &&
    next.subOfTotal === prev.subOfTotal &&
    next.dubOfTotal === prev.dubOfTotal &&
    next.canProbe === prev.canProbe &&
    next.probed === prev.probed
  ) {
    return prev;
  }
  return next;
}

interface EpisodeListFetcherProps {
  animeTitle: string;
  animeId: number;
  /**
   * The SERVER's resolved answer (getEpisodes + getAudioFlags without the
   * probe), streamed in behind the page's Suspense boundary. The list itself
   * is no longer fetched here — that roundtrip (plus the full cold provider
   * walk behind it) is exactly what used to hold "Fetching episodes…" on
   * screen after hydration. This component keeps the ONE thing that genuinely
   * needs a route handler: the `?audio=1` second pass, which costs a megaplay
   * probe (~1–3s) and must not delay the rows.
   */
  episodes: Episode[];
  audio: AudioSummary | null;
  listStatus: ListStatus | null;
}

export default function EpisodeListFetcher({
  animeTitle,
  animeId,
  episodes: initialEpisodes,
  audio: initialAudio,
  listStatus: initialListStatus,
}: EpisodeListFetcherProps) {
  const [episodes, setEpisodes] = useState<Episode[]>(initialEpisodes);
  const [audio, setAudio] = useState<AudioSummary | null>(initialAudio);
  const [listStatus, setListStatus] = useState<ListStatus | null>(initialListStatus);
  const [checkingAudio, setCheckingAudio] = useState(false);
  const audioRequested = useRef(false);

  const applyResponse = useCallback(
    (data: { episodes?: Episode[]; audio?: AudioSummary; listStatus?: ListStatus }) => {
      if (Array.isArray(data.episodes)) setEpisodes(data.episodes);
      if (data.audio) {
        setAudio(data.audio);
        // Learned something → mirror it for the Player and the next mount.
        writeAudioCache(animeId, data.audio);
      }
      if (data.listStatus) setListStatus(data.listStatus);
      return data.audio;
    },
    [animeId]
  );

  // Second pass: resolve unknown sub/dub flags with the provider-side probe.
  // Runs only when the server answer says flags are unknown AND probeable, and
  // only after the episode rows are already on screen — same predicate and
  // same fetch the old first-pass-then-probe flow used. A FRESH sessionStorage
  // entry (written by this fetcher's last visit or by the Player) is applied
  // first and skips the network outright.
  const fetchAudioFlags = useCallback(
    async (params: URLSearchParams) => {
      if (audioRequested.current) return;
      audioRequested.current = true;
      setCheckingAudio(true);
      try {
        const res = await fetch(`/api/episodes?${params}&audio=1`);
        if (res.ok) {
          applyResponse(await res.json());
        } else {
          audioRequested.current = false; // allow a retry on the next mount
        }
      } catch {
        audioRequested.current = false;
      } finally {
        setCheckingAudio(false);
      }
    },
    [applyResponse]
  );

  useEffect(() => {
    // Clear any stale stored provider from the removed header selector
    try { localStorage.removeItem("n54tv-provider"); } catch {}

    // Read-before-fetch: a fresh cached tally answers the probe's question
    // without any network. Deferred one microtask for the same reason the
    // probe below is — a synchronous setState here would cascade renders.
    const stored = readAudioCache(animeId);
    if (stored && knowsACount(stored)) {
      queueMicrotask(() => { setAudio((prev) => mergeStoredAudio(prev, stored)); });
      return;
    }

    const needsProbe =
      !!audio &&
      (audio.subCount === null || audio.dubCount === null) &&
      audio.canProbe &&
      !audio.probed;
    if (needsProbe) {
      // Deferred a tick: the probe's leading `setCheckingAudio(true)` is a
      // synchronous setState, and calling the probe straight from this
      // effect would be a cascading render (the old first-pass mount fetch
      // was flagged the same way). Behaviour is unchanged — the probe was
      // always async work.
      const params = new URLSearchParams({ title: animeTitle, id: String(animeId) });
      queueMicrotask(() => { void fetchAudioFlags(params); });
    }
    // Re-runs harmlessly when the probe's own response lands (`probed: true`
    // flips the predicate off; `audioRequested` guards double-fires).
  }, [audio, animeTitle, animeId, fetchAudioFlags]);

  // First visit: the STREAMED server props are a learned answer too — mirror
  // them so the Player (and the next mount) can skip the probe. A fresh
  // stored entry that knows MORE than the server answer is merged in first,
  // so this write can never trade knowledge away.
  useEffect(() => {
    if (!initialAudio) return;
    const stored = readAudioCache(animeId);
    writeAudioCache(animeId, stored ? (mergeStoredAudio(initialAudio, stored) ?? initialAudio) : initialAudio);
  }, [animeId, initialAudio]);

  // Sub/Dub counts — only real numbers; "—" when availability is unknown.
  // Partial knowledge renders `12/30 SUB` via AudioCount's ofTotal form.
  const subCount = audio?.subCount ?? null;
  const dubCount = audio?.dubCount ?? null;
  const subOfTotal = audio?.subOfTotal ?? null;
  const dubOfTotal = audio?.dubOfTotal ?? null;

  return (
    <div>
      <div className="flex items-center gap-4 mb-5">
        <h2 className="text-xl font-bold text-[var(--accent)] uppercase tracking-wider">
          // Episodes
        </h2>
        {episodes.length > 0 && (
          <div className="flex items-center gap-2">
            <AudioCount label="Sub" value={subCount} ofTotal={subOfTotal} />
            <AudioCount label="Dub" value={dubCount} ofTotal={dubOfTotal} />
          </div>
        )}
        {checkingAudio && <LoadingNote state="audio" />}
      </div>

      {episodes.length > 0 ? (
        <EpisodeList episodes={episodes} animeId={animeId} />
      ) : (
        // Resolved and empty: say WHICH kind of empty it was.
        <EmptyState
          code="NO_EPISODE_DATA"
          detail={listStatus === "suspect" ? "suspect" : undefined}
        />
      )}
    </div>
  );
}
