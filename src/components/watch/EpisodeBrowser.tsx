"use client";

import { useMemo, useState } from "react";
import type { Episode } from "@/types/anime";
import EpisodeSelector from "./EpisodeSelector";

/**
 * Section-aware wrapper around the paged episode selector.
 *
 * ── Data limitation ────────────────────────────────────────────────
 * Neither `Episode` (id, number, title, image, providerId, hasDub/hasSub,
 * airDate, available) nor `Anime` (season/seasonYear = the show's *broadcast
 * season*, not per-episode) carries real per-season metadata for a single
 * show's episode run. So no fake seasons are invented. Sections are derived
 * from what actually exists:
 *
 *   1. Real broadcast breaks — when ≥70% of episodes carry a parseable
 *      `airDate`, split where consecutive air dates are ≥45 days apart
 *      (genuine cour/season gaps). Only used when that yields 2–12 sections
 *      and no section runs longer than 120 episodes.
 *   2. Otherwise cours-style blocks (12/24/26/50/100 — smallest that keeps
 *      the tab strip ≤12 tabs), with a tiny tail folded into its neighbour.
 *
 * Tabs filter the list; "Group by section" switches to a grouped view where
 * section headers sit sticky inside the same bounded, scrolling panel.
 */

export interface EpisodeSection {
  /** `SECTION 01` */
  label: string;
  /** `EP 01–12` */
  rangeLabel: string;
  /** Air-date span (real data) when enough dates exist, e.g. `2021`. */
  hint?: string;
  episodes: Episode[];
}

const COURSE_SIZES = [12, 24, 26, 50, 100];
const MAX_SECTIONS = 12;
const MIN_SECTION_SIZE = 4;
const BREAK_GAP_DAYS = 45;
const AIRDATE_COVERAGE = 0.7;
const MAX_AIR_SECTION = 120;

const pad = (n: number) => String(n).padStart(2, "0");

function parseDate(value?: string): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Fold sub-minimum chunks into a neighbour so no 1–3 episode sections exist. */
function foldTiny(chunks: Episode[][]): Episode[][] {
  const out: Episode[][] = [];
  for (const chunk of chunks) {
    if (chunk.length < MIN_SECTION_SIZE && out.length > 0) {
      out[out.length - 1].push(...chunk);
    } else {
      out.push([...chunk]);
    }
  }
  if (out.length > 1 && out[0].length < MIN_SECTION_SIZE) {
    const head = out.shift()!;
    out[0].unshift(...head);
  }
  return out;
}

/** Air-date span of a section — only when most episodes actually have dates. */
function dateHint(eps: Episode[]): string | undefined {
  const times = eps
    .map((ep) => parseDate(ep.airDate))
    .filter((t): t is number => t !== null);
  if (times.length < eps.length / 2) return undefined;
  const first = new Date(Math.min(...times)).getUTCFullYear();
  const last = new Date(Math.max(...times)).getUTCFullYear();
  return first === last ? String(first) : `${first}–${last}`;
}

function toSections(chunks: Episode[][]): EpisodeSection[] {
  return chunks.map((eps, i) => ({
    label: `SECTION ${pad(i + 1)}`,
    rangeLabel: `EP ${pad(eps[0].number)}–${pad(eps[eps.length - 1].number)}`,
    hint: dateHint(eps),
    episodes: eps,
  }));
}

export function buildEpisodeSections(episodes: Episode[]): EpisodeSection[] {
  if (episodes.length === 0) return [];
  const sorted = [...episodes].sort((a, b) => a.number - b.number);

  // 1) Genuine broadcast gaps in air dates
  const times = sorted.map((ep) => parseDate(ep.airDate));
  const coverage = times.filter((t) => t !== null).length / sorted.length;
  if (coverage >= AIRDATE_COVERAGE) {
    const airChunks: Episode[][] = [[sorted[0]]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = times[i - 1];
      const cur = times[i];
      const gapDays = prev !== null && cur !== null ? (cur - prev) / 86_400_000 : 0;
      if (gapDays >= BREAK_GAP_DAYS && airChunks[airChunks.length - 1].length >= MIN_SECTION_SIZE) {
        airChunks.push([]);
      }
      airChunks[airChunks.length - 1].push(sorted[i]);
    }
    const folded = foldTiny(airChunks);
    const longest = Math.max(...folded.map((chunk) => chunk.length));
    if (folded.length > 1 && folded.length <= MAX_SECTIONS && longest <= MAX_AIR_SECTION) {
      return toSections(folded);
    }
  }

  // 2) Cours-style blocks sized so the tab strip stays navigable
  const size =
    COURSE_SIZES.find((s) => Math.ceil(sorted.length / s) <= MAX_SECTIONS) ?? 100;
  const chunks: Episode[][] = [];
  for (let i = 0; i < sorted.length; i += size) {
    chunks.push(sorted.slice(i, i + size));
  }
  return toSections(foldTiny(chunks));
}

interface EpisodeBrowserProps {
  episodes: Episode[];
  animeId: number;
  provider?: string;
  currentEpisode: number;
}

export default function EpisodeBrowser({
  episodes,
  animeId,
  provider,
  currentEpisode,
}: EpisodeBrowserProps) {
  const sorted = useMemo(
    () => [...episodes].sort((a, b) => a.number - b.number),
    [episodes]
  );
  const sections = useMemo(() => buildEpisodeSections(sorted), [sorted]);

  const [activeSection, setActiveSection] = useState<number | null>(null);
  const [grouped, setGrouped] = useState(false);

  const showBar = sections.length > 1;
  const active =
    activeSection !== null && activeSection < sections.length ? activeSection : null;
  const visible = active === null ? sorted : sections[active].episodes;

  const sectionByNumber = useMemo(() => {
    const map = new Map<number, EpisodeSection>();
    if (grouped) {
      for (const section of sections) {
        for (const ep of section.episodes) map.set(ep.number, section);
      }
    }
    return map;
  }, [grouped, sections]);

  const getSectionLabel = grouped
    ? (ep: Episode) => {
        const section = sectionByNumber.get(ep.number);
        if (!section) return null;
        return `${section.label} · ${section.rangeLabel}${
          section.hint ? ` · ${section.hint}` : ""
        }`;
      }
    : undefined;

  const heading = grouped
    ? "// Episodes · grouped"
    : active !== null
      ? `// Episodes · section ${pad(active + 1)}`
      : "// Episodes";

  const tabClass = (isActive: boolean) =>
    isActive
      ? "whitespace-nowrap rounded-none border border-[var(--accent)] bg-[var(--accent)] px-3 py-2 sm:px-2.5 sm:py-1 min-h-[36px] sm:min-h-0 font-mono text-[10px] font-bold uppercase tracking-wider text-black"
      : "whitespace-nowrap rounded-none border border-[var(--accent)]/20 px-3 py-2 sm:px-2.5 sm:py-1 min-h-[36px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider text-[var(--accent)]/60 transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--accent)]";

  return (
    <div>
      {showBar && (
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold text-[var(--accent)] uppercase tracking-wider shrink-0">
              // Sections
            </h2>
            <button
              type="button"
              onClick={() => setGrouped((g) => !g)}
              aria-pressed={grouped}
              className={`ml-auto shrink-0 rounded-none border px-3 py-2 sm:px-2.5 sm:py-1 min-h-[36px] sm:min-h-0 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                grouped
                  ? "border-[var(--accent)]/60 bg-[var(--accent)]/15 text-[var(--accent)]"
                  : "border-[var(--accent)]/20 text-[var(--accent)]/50 hover:border-[var(--accent)]/50 hover:text-[var(--accent)]"
              }`}
            >
              {grouped ? "[−] grouped" : "[+] group by section"}
            </button>
          </div>

          {!grouped && (
            <div className="overflow-x-auto pb-0.5">
              <div className="flex w-max gap-1.5">
                <button
                  type="button"
                  onClick={() => setActiveSection(null)}
                  className={tabClass(active === null)}
                >
                  all · {pad(sorted.length)}
                </button>
                {sections.map((section, i) => (
                  <button
                    key={section.label}
                    type="button"
                    onClick={() => setActiveSection(i)}
                    className={tabClass(active === i)}
                  >
                    <span className="font-bold">{pad(i + 1)}</span>
                    {" · "}
                    {section.rangeLabel}
                    {section.hint && (
                      <span className="text-[#6b6b70]"> · {section.hint}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <EpisodeSelector
        key={grouped ? "grouped" : `section-${active ?? "all"}`}
        episodes={visible}
        animeId={animeId}
        provider={provider}
        currentEpisode={currentEpisode}
        heading={heading}
        getSectionLabel={getSectionLabel}
      />
    </div>
  );
}
