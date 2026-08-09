"use client";

import { useState, useMemo } from "react";

interface SubtitlePickerContentProps {
  activeSubtitle: string | null;
  subtitles: { url: string; lang: string }[];
  onSelect: (url: string | null) => void; // null = Off
  subtitleOffset: number;
  onOffsetChange: (offset: number) => void;
  osSearched: boolean;
  osLoading: boolean;
  osError: string | null;
  osResults: { file_id: number; language: string; release: string; hearing_impaired: boolean; ai_translated: boolean }[];
  osPage: number;
  osFilterQuery: string;
  onSearchOpenSubtitles: (page?: number) => void;
  onFilterChange: (query: string) => void;
  onSelectOpenSubtitle: (fileId: number) => void;
  onResetOpenSubtitles: () => void;
  activeOSSubtitleId?: number | null;
  osDownloadError?: string | null;
  onClearDownloadError?: () => void;
}

export default function SubtitlePickerContent({
  activeSubtitle,
  subtitles,
  onSelect,
  subtitleOffset,
  onOffsetChange,
  osSearched,
  osLoading,
  osError,
  osResults,
  osPage,
  osFilterQuery,
  onSearchOpenSubtitles,
  onFilterChange,
  onSelectOpenSubtitle,
  onResetOpenSubtitles,
  activeOSSubtitleId,
  osDownloadError,
  onClearDownloadError,
}: SubtitlePickerContentProps) {
  // Filter OS results by release name / language
  const filteredOS = useMemo(() => {
    if (!osFilterQuery.trim()) return osResults;
    const q = osFilterQuery.toLowerCase();
    return osResults.filter(
      (s) =>
        s.release.toLowerCase().includes(q) ||
        s.language.toLowerCase().includes(q)
    );
  }, [osResults, osFilterQuery]);

  return (
    <>
      <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] text-[var(--accent)]/30 uppercase tracking-wider font-semibold font-mono">
        Subtitles
      </div>
      <button
        onClick={() => { onSelect(null); onClearDownloadError?.(); }}
        className={`w-full text-left px-2.5 py-1.5 text-xs transition-colors rounded-none ${
          !activeSubtitle
            ? "bg-[var(--accent)]/20 text-[var(--accent)] border-l-2 border-[var(--accent)]"
            : "text-[#9a9aa0] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
        }`}
      >
        Off
      </button>
      {subtitles.map((sub) => (
        <button
          key={sub.url}
          onClick={() => { onSelect(sub.url); onClearDownloadError?.(); }}
          className={`w-full text-left px-2.5 py-1.5 text-xs transition-colors rounded-none ${
            activeSubtitle === sub.url
              ? "bg-[var(--accent)]/20 text-[var(--accent)] border-l-2 border-[var(--accent)]"
              : "text-[#9a9aa0] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
          }`}
        >
          {sub.lang}
        </button>
      ))}
      {subtitles.length > 0 && <div className="border-t border-[var(--accent)]/20 mx-2 my-0.5" />}

      {/* Subtitle offset adjuster */}
      {activeSubtitle && (
        <div className="px-2.5 py-1.5 flex items-center gap-2">
          <span className="text-[10px] text-[var(--accent)]/30 uppercase tracking-wider font-mono">Offset</span>
          <button
            onClick={() => onOffsetChange(Math.max(-5, subtitleOffset - 0.5))}
            className="w-6 h-5 flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors border border-[var(--accent)]/20 text-xs"
          >
            −
          </button>
          <span className="text-xs text-[var(--accent)] font-mono w-12 text-center tabular-nums">
            {subtitleOffset > 0 ? "+" : ""}{subtitleOffset.toFixed(1)}s
          </span>
          <button
            onClick={() => onOffsetChange(Math.min(5, subtitleOffset + 0.5))}
            className="w-6 h-5 flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors border border-[var(--accent)]/20 text-xs"
          >
            +
          </button>
          {subtitleOffset !== 0 && (
            <button
              onClick={() => onOffsetChange(0)}
              className="text-[10px] text-[var(--accent)]/40 hover:text-[var(--accent)] transition-colors font-mono"
            >
              Reset
            </button>
          )}
        </div>
      )}
      {activeSubtitle && <div className="border-t border-[var(--accent)]/20 mx-2 my-0.5" />}

      {/* Download error */}
      {osDownloadError && (
        <div className="px-2.5 py-1.5 text-[11px] text-red-400 bg-red-400/10 border-l-2 border-red-400">
          {osDownloadError}
        </div>
      )}

      {!osSearched && (
        <button
          onClick={(e) => { e.stopPropagation(); onSearchOpenSubtitles(1); }}
          disabled={osLoading}
          className="w-full text-left px-2.5 py-1.5 text-xs text-[var(--accent)]/50 hover:text-[var(--accent)] hover:bg-[var(--accent)]/5 transition-colors disabled:opacity-50 flex items-center gap-1.5"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          {osLoading ? "Searching..." : "Search OpenSubtitles"}
        </button>
      )}

      {/* OS loading */}
      {osLoading && (
        <div className="px-2.5 py-2 text-xs text-[var(--accent)]/50 italic">
          Searching...
        </div>
      )}

      {/* OS error */}
      {osError && osResults.length === 0 && (
        <div className="px-2.5 py-2 text-xs text-[var(--accent)]/50 italic">
          {osError}
        </div>
      )}

      {/* OS results */}
      {osResults.length > 0 && (
        <>
          <div className="px-2.5 pt-1 pb-0.5 text-[10px] text-[var(--accent)]/30 uppercase tracking-wider font-semibold font-mono flex items-center justify-between">
            <span>OpenSubtitles</span>
            <span className="text-[var(--accent)]/20 normal-case">{osResults.length} found</span>
          </div>

          {/* Filter input */}
          <div className="px-2.5 py-1">
            <input
              type="text"
              placeholder="Filter subtitles..."
              value={osFilterQuery}
              onChange={(e) => onFilterChange(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              className="w-full bg-black/30 border border-[var(--accent)]/20 text-[var(--accent)] text-[11px] px-2 py-1 placeholder:text-[var(--accent)]/20 focus:outline-none focus:border-[var(--accent)]/50 transition-colors rounded-none font-mono"
            />
          </div>

          {/* Filtered results */}
          {filteredOS.length === 0 && osFilterQuery && (
            <div className="px-2.5 py-1.5 text-[11px] text-[var(--accent)]/30 italic">
              No matches for &ldquo;{osFilterQuery}&rdquo;
            </div>
          )}

          <div className="max-h-48 overflow-y-auto">
            {filteredOS.map((sub, idx) => {
              const isActive = activeOSSubtitleId === sub.file_id;
              const realIdx = osResults.indexOf(sub);
              return (
                <button
                  key={`os-${sub.file_id}-${idx}`}
                  onClick={() => { onSelectOpenSubtitle(sub.file_id); }}
                  className={`w-full text-left px-2.5 py-1.5 text-xs transition-colors truncate rounded-none ${
                    isActive
                      ? "bg-[var(--accent)]/20 text-[var(--accent)] border-l-2 border-[var(--accent)]"
                      : "text-[var(--accent)]/80 hover:text-[var(--accent)] hover:bg-[var(--accent)]/10"
                  }`}
                  title={`${sub.language} — ${sub.release}`}
                >
                  {realIdx === 0 && !isActive && <span className="text-[var(--accent)] mr-1">&#9733;</span>}
                  {isActive && <span className="text-[var(--accent)] mr-1">&#10003;</span>}
                  {sub.language.toUpperCase()}
                  {sub.hearing_impaired ? " \u00B7 HI" : ""}
                  {sub.ai_translated ? " \u00B7 AI" : ""}
                  <span className="text-[var(--accent)]/30 ml-1 text-[10px]">
                    {sub.release.length > 25 ? sub.release.substring(0, 25) + "\u2026" : sub.release}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Load more */}
          {!osLoading && (
            <button
              onClick={(e) => { e.stopPropagation(); onSearchOpenSubtitles(osPage + 1); }}
              className="w-full text-left px-2.5 py-1.5 text-[11px] text-[var(--accent)]/50 hover:text-[var(--accent)] hover:bg-[var(--accent)]/5 transition-colors flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              Load more
            </button>
          )}
        </>
      )}

      {/* Re-search link */}
      {osSearched && (
        <div className="border-t border-[var(--accent)]/20 mx-2 my-0.5" />
      )}
      {osSearched && (
        <button
          onClick={(e) => { e.stopPropagation(); onResetOpenSubtitles(); onClearDownloadError?.(); }}
          className="w-full text-left px-2.5 py-1 text-[11px] text-[var(--accent)]/50 hover:text-[var(--accent)] hover:bg-[var(--accent)]/5 transition-colors"
        >
          Search again
        </button>
      )}
    </>
  );
}
