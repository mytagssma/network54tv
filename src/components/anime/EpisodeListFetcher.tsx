"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import EpisodeList from "./EpisodeList";
import { AudioCount, EmptyState, LoadingNote } from "./Availability";
import type { Episode } from "@/types/anime";

/**
 * Mirrors `AudioSummary` from `@/lib/providers` (declared locally so this client
 * component never pulls the server-side provider module into the bundle).
 */
interface AudioSummary {
  subCount: number | null;
  dubCount: number | null;
  canProbe: boolean;
  probed: boolean;
}

/** Mirrors `EpisodeListStatus` from `@/lib/providers` — same reason as above. */
type ListStatus = "ok" | "none" | "suspect";

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
      if (data.audio) setAudio(data.audio);
      if (data.listStatus) setListStatus(data.listStatus);
      return data.audio;
    },
    []
  );

  // Second pass: resolve unknown sub/dub flags with the provider-side probe.
  // Runs only when the server answer says flags are unknown AND probeable, and
  // only after the episode rows are already on screen — same predicate and
  // same fetch the old first-pass-then-probe flow used.
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

  // Sub/Dub counts — only real numbers; "—" when availability is unknown.
  const subCount = audio?.subCount ?? null;
  const dubCount = audio?.dubCount ?? null;

  return (
    <div>
      <div className="flex items-center gap-4 mb-5">
        <h2 className="text-xl font-bold text-[var(--accent)] uppercase tracking-wider">
          // Episodes
        </h2>
        {episodes.length > 0 && (
          <div className="flex items-center gap-2">
            <AudioCount label="Sub" value={subCount} />
            <AudioCount label="Dub" value={dubCount} />
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
