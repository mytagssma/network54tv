"use client";

import { GENRES } from "@/lib/anilist";

export type TagState = "include" | "exclude";
export type TagMode = "OR" | "AND";

interface TagFilterGridProps {
  tags: Record<string, TagState>;
  onToggle: (genre: string) => void;
  mode: TagMode;
  onModeToggle: () => void;
}

/**
 * Genre tag picker: a click cycles include → exclude → off, and the mode chip
 * switches between matching any or all of the included tags.
 */
export default function TagFilterGrid({ tags, onToggle, mode, onModeToggle }: TagFilterGridProps) {
  const hasInclude = Object.values(tags).some((state) => state === "include");

  return (
    <div className="flex w-full flex-col gap-3 border-t border-[var(--accent)]/10 pt-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs uppercase tracking-wider text-[var(--accent)]/70">
          Tags
        </span>
        <button
          type="button"
          onClick={onModeToggle}
          className={`min-h-[44px] rounded-none border px-4 font-mono text-xs uppercase tracking-wider transition-colors ${
            hasInclude
              ? "border-[var(--accent)]/30 text-[var(--accent)]"
              : "border-[var(--accent)]/10 text-[var(--accent)]/30"
          }`}
        >
          {mode === "OR" ? "Match Any" : "Match All"}
        </button>
      </div>
      {/* Compact chips: every label fits 3+ per row at 360px (text-[10px],
          px-1, gap-1 grid), 32px tall so they stay tappable. The state glyph
          is its own flex item so the 2px gap really applies — adjacent JSX
          text nodes merge into one item and would touch the label. */}
      <div className="flex flex-wrap gap-1">
        {GENRES.map((genre) => {
          const state = tags[genre];
          return (
            <button
              key={genre}
              type="button"
              aria-pressed={state === "include"}
              // The glyph is visual-only; spell the tri-state out for SRs.
              aria-label={`${genre}${state === "include" ? ", included" : state === "exclude" ? ", excluded" : ""}`}
              onClick={() => onToggle(genre)}
              className={`flex min-h-[32px] items-center gap-0.5 rounded-none border px-1 font-mono text-[10px] leading-none transition-colors ${
                state === "include"
                  ? "border-[var(--accent)]/50 bg-[var(--accent)]/20 text-[var(--accent)]"
                  : state === "exclude"
                  ? "border-red-500/40 bg-red-900/20 text-red-400"
                  : "border-[var(--accent)]/10 text-[var(--text-decorative)] hover:border-[var(--accent)]/30"
              }`}
            >
              <span aria-hidden>
                {state === "exclude" ? "−" : state === "include" ? "+" : "·"}
              </span>
              {genre}
            </button>
          );
        })}
      </div>
    </div>
  );
}
