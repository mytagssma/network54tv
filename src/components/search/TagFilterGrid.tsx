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
      <div className="flex flex-wrap gap-1.5">
        {GENRES.map((genre) => {
          const state = tags[genre];
          return (
            <button
              key={genre}
              type="button"
              aria-pressed={state === "include"}
              onClick={() => onToggle(genre)}
              className={`flex min-h-[44px] items-center gap-1 rounded-none border px-3 font-mono text-xs transition-colors ${
                state === "include"
                  ? "border-[var(--accent)]/50 bg-[var(--accent)]/20 text-[var(--accent)]"
                  : state === "exclude"
                  ? "border-red-500/40 bg-red-900/20 text-red-400"
                  : "border-[var(--accent)]/10 text-[var(--text-decorative)] hover:border-[var(--accent)]/30"
              }`}
            >
              {state === "exclude" ? "−" : state === "include" ? "+" : "·"} {genre}
            </button>
          );
        })}
      </div>
    </div>
  );
}
