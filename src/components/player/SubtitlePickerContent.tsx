"use client";

interface SubtitlePickerContentProps {
  activeSubtitle: string | null;
  subtitles: { url: string; lang: string }[];
  onSelect: (url: string | null) => void; // null = Off
  osSearched: boolean;
  osLoading: boolean;
  osError: string | null;
  osResults: { file_id: number; language: string; release: string; hearing_impaired: boolean; ai_translated: boolean }[];
  onSearchOpenSubtitles: () => void;
  onSelectOpenSubtitle: (fileId: number) => void;
  onResetOpenSubtitles: () => void; // resets osSearched/osResults/osError for "Search again"
}

export default function SubtitlePickerContent({
  activeSubtitle,
  subtitles,
  onSelect,
  osSearched,
  osLoading,
  osError,
  osResults,
  onSearchOpenSubtitles,
  onSelectOpenSubtitle,
  onResetOpenSubtitles,
}: SubtitlePickerContentProps) {
  return (
    <>
      <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] text-[var(--accent)]/30 uppercase tracking-wider font-semibold font-mono">
        Subtitles
      </div>
      <button
        onClick={() => { onSelect(null); }}
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
          onClick={() => { onSelect(sub.url); }}
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
      {!osSearched && (
        <button
          onClick={(e) => { e.stopPropagation(); onSearchOpenSubtitles(); }}
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
          <div className="px-2.5 pt-1 pb-0.5 text-[10px] text-[var(--accent)]/30 uppercase tracking-wider font-semibold font-mono">
            OpenSubtitles
          </div>
          {osResults.slice(0, 15).map((sub, idx) => (
            <button
              key={`os-${sub.file_id}-${idx}`}
              onClick={() => { onSelectOpenSubtitle(sub.file_id); }}
              className="w-full text-left px-2.5 py-1.5 text-xs text-[var(--accent)]/70 hover:text-[var(--accent)] hover:bg-[var(--accent)]/5 transition-colors truncate"
              title={`${sub.language} — ${sub.release}`}
            >
              {sub.language.toUpperCase()}
              {sub.hearing_impaired ? " \u00B7 HI" : ""}
              {sub.ai_translated ? " \u00B7 AI" : ""}
              <span className="text-[var(--accent)]/30 ml-1">
                {sub.release.substring(0, 20)}
              </span>
            </button>
          ))}
        </>
      )}

      {/* Re-search link */}
      {osSearched && (
        <div className="border-t border-[var(--accent)]/20 mx-2 my-0.5" />
      )}
      {osSearched && (
        <button
          onClick={(e) => { e.stopPropagation(); onResetOpenSubtitles(); }}
          className="w-full text-left px-2.5 py-1 text-[11px] text-[var(--accent)]/50 hover:text-[var(--accent)] hover:bg-[var(--accent)]/5 transition-colors"
        >
          Search again
        </button>
      )}
    </>
  );
}
