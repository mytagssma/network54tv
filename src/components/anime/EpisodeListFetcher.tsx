"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import EpisodeList from "./EpisodeList";
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

interface EpisodeListFetcherProps {
  animeTitle: string;
  animeId: number;
  initialEpisodes: Episode[];
}

const UNKNOWN_COUNT = "\u2014"; // "—" when sub/dub availability isn't known

export default function EpisodeListFetcher({ animeTitle, animeId, initialEpisodes }: EpisodeListFetcherProps) {
  const [episodes, setEpisodes] = useState<Episode[]>(initialEpisodes);
  const [audio, setAudio] = useState<AudioSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingAudio, setCheckingAudio] = useState(false);
  const audioRequested = useRef(false);

  const applyResponse = useCallback((data: { episodes?: Episode[]; audio?: AudioSummary }) => {
    if (Array.isArray(data.episodes)) setEpisodes(data.episodes);
    if (data.audio) setAudio(data.audio);
    return data.audio;
  }, []);

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
            <span className="bg-transparent border border-[var(--accent)]/20 text-[var(--accent)]/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider rounded-none">
              Sub {subCount ?? UNKNOWN_COUNT}
            </span>
            <span className="bg-transparent border border-[var(--accent)]/20 text-[var(--accent)]/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider rounded-none">
              Dub {dubCount ?? UNKNOWN_COUNT}
            </span>
          </div>
        )}
        {loading && (
          <span className="text-[10px] text-[var(--accent)]/40 font-mono animate-pulse">Loading...</span>
        )}
        {!loading && checkingAudio && (
          <span className="text-[10px] text-[var(--accent)]/40 font-mono animate-pulse">Checking audio...</span>
        )}
      </div>

      {episodes.length > 0 ? (
        <EpisodeList episodes={episodes} animeId={animeId} />
      ) : (
        <p className="text-[#6b6b70] italic">
          {loading ? "Fetching episodes..." : "No episodes available."}
        </p>
      )}
    </div>
  );
}
