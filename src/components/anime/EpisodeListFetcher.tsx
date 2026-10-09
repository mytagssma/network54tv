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
  initialEpisodes: Episode[];
}

export default function EpisodeListFetcher({ animeTitle, animeId, initialEpisodes }: EpisodeListFetcherProps) {
  const [episodes, setEpisodes] = useState<Episode[]>(initialEpisodes);
  const [audio, setAudio] = useState<AudioSummary | null>(null);
  // Why the list can be empty. `null` until an answer arrives, so an empty SSR
  // payload never claims a reason it hasn't been given.
  const [listStatus, setListStatus] = useState<ListStatus | null>(null);
  // Start in the loading state whenever there's nothing to show yet: an empty
  // SSR payload must read "Fetching...", never "no data" — the empty card is
  // only honest *after* a fetch has actually resolved to zero episodes.
  const [loading, setLoading] = useState(initialEpisodes.length === 0);
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
  // Runs only when the fast response says flags are unknown AND probeable, and
  // only after the episode rows are already on screen.
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

  const fetchEpisodes = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ title: animeTitle, id: String(animeId) });
      const res = await fetch(`/api/episodes?${params}`);
      if (res.ok) {
        const summary = applyResponse(await res.json());
        const needsProbe =
          !!summary &&
          (summary.subCount === null || summary.dubCount === null) &&
          summary.canProbe &&
          !summary.probed;
        if (needsProbe) void fetchAudioFlags(params);
      }
    } catch {
      // keep current episodes on error
    } finally {
      setLoading(false);
    }
  }, [animeTitle, animeId, applyResponse, fetchAudioFlags]);

  // Fetch episodes on mount (auto provider — selector was removed)
  useEffect(() => {
    // Clear any stale stored provider from the removed header selector
    try { localStorage.removeItem("n54tv-provider"); } catch {}
    fetchEpisodes();
  }, [fetchEpisodes]);

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
        {loading && <LoadingNote state="list" />}
        {!loading && checkingAudio && <LoadingNote state="audio" />}
      </div>

      {episodes.length > 0 ? (
        <EpisodeList episodes={episodes} animeId={animeId} />
      ) : loading ? (
        // Real fetch in flight — the pulse above is driven by this same flag,
        // so it stops the moment the request settles.
        <LoadingNote state="rows" />
      ) : (
        // Resolved and still empty: say WHICH kind of empty it was.
        <EmptyState
          code="NO_EPISODE_DATA"
          detail={listStatus === "suspect" ? "suspect" : undefined}
        />
      )}
    </div>
  );
}
