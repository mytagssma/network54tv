"use client";

import type { ComponentProps, ReactNode, RefObject } from "react";
import Button from "@/components/ui/Button";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Forward10Icon,
  PlayIcon,
  XIcon,
} from "@/components/ui/icons";
import SubtitlePickerContent from "./SubtitlePickerContent";

/**
 * The ⋯ (More) overflow menu — one panel, one popup language.
 *
 * Everything the player's control row hides at the current width lands here:
 * the SUB/DUB segmented control (below lg), the settings rows that drill one
 * level (provider / server / quality / speed / subtitles / filter) and the
 * always-on toggles (auto-play next, auto-skip intro).
 *
 * The MENU is a pure view. Every value it shows and every action it fires is
 * a prop, so `Player.tsx` keeps the state, the refs and the effects and this
 * file keeps only the markup — which is why the two can't drift.
 */

// Sub-pages inside the ⋯ overflow menu
export type MoreSection = "provider" | "server" | "quality" | "speed" | "filter" | "subs";

// ─── ⋯ "More" menu — one panel, one popup language ───────────────
// The panel never picks its own spot: `moreMenuAnchor` below does, and
// every offset in it resolves against the `relative overflow-hidden`
// container, so the menu can never render past the player's frame.
// ROOT LIST and DRILL-DOWN both use the SAME shape at every width: a
// content-sized popup anchored bottom-right on the 76px line, above the
// ⋯ trigger — the desktop silhouette, not a full-width band.
// • Width `w-56` (root) / `w-52` (drill) at ≥640px; below 640px the
//   shared cap `min(15rem, 100% - 1.5rem)` keeps that same ~15rem column
//   while guaranteeing ≥1.5rem of player on EACH side — the `right-3`
//   offset matches desktop exactly, and the `1.5rem` term only wins on
//   players narrower than ~15rem + 1.5rem, so the panel never reaches an
//   edge (let alone past it). It is content-height by default (absolute,
//   `bottom-` set, no `top`/`height`) — dead vertical space can't happen.
// • `max-h` subtracts the 76px control line + ~20px headroom, so a short
//   windowed player scrolls the list instead of pushing it off the top.
//   Floor split below 640: the ROOT panel floors only its direct-child
//   rows (`[&>button]:min-h-9` = MoreRow + toggles at 36px; the nested
//   ✕ and SUB/DUB halves pick their own smaller sizes), while the DRILL
//   panel carries NO floor — submenu options render at their natural
//   28px like desktop. ≥640px is floor-free everywhere (natural ~28px).

// One row of the ⋯ menu's root list: label + current value + chevron.
// Kept at module scope so rows keep their identity across re-renders.
function MoreRow({
  label,
  value,
  onClick,
  className = "",
  active = false,
}: {
  label: string;
  value?: ReactNode;
  onClick: () => void;
  className?: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors rounded-none ${
        active
          ? "bg-[var(--accent)]/10 text-[var(--accent)]"
          : "text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
      } ${className}`}
    >
      <span className="truncate">{label}</span>
      {/* The value may be a long provider/server name — it truncates at the
          band edge (min-w-0 lets the flex child shrink) instead of forcing a
          horizontal overflow inside the menu panel. Only the chevron stays rigid. */}
      <span className="flex min-w-0 items-center gap-1 label-micro text-[var(--accent)]/50">
        <span className="truncate">{value}</span>
        <ChevronRightIcon className="h-3 w-3 shrink-0" />
      </span>
    </button>
  );
}

/** The slice of player state the menu renders, plus the actions it fires. */
export interface PlayerMoreMenuProps {
  /** The popup element — the outside-click / Escape handler tests containment. */
  wrapRef: RefObject<HTMLDivElement | null>;
  /** `null` = root list, otherwise the drill-down sub-page inside the same popup. */
  section: MoreSection | null;
  /** Drill into a sub-page, or back to the root list with `null`. */
  onSectionChange: (section: MoreSection | null) => void;
  /** The single dismiss path (outside click, Escape, ✕, picking an option). */
  onClose: () => void;
  /** <640px — the same breakpoint the controls use to switch to touch sizing. */
  isCompact: boolean;

  /* ── root list: values ─────────────────────────────────────────────── */
  showAudioToggle: boolean;
  audioType: "sub" | "dub";
  dubEnabled: boolean;
  onSwitchAudioType: (type: "sub" | "dub") => void;

  /** `{ id, label }` — the id is what `onSelectProvider` / `onSelectFilter` get. */
  providerOptions: readonly { id: string; label: string }[];
  /** The active provider's id ("" = Auto). */
  providerCurrent: string;
  /** The active provider's label for the root row (falls back to "Auto"). */
  providerValue: string;

  availableServers: string[];
  activeServer: string | null;
  availableQualities: string[];
  currentQuality: string;
  speedOptions: number[];
  playbackRate: number;
  activeSubtitle: string | null;
  filterOptions: readonly { id: string; label: string }[];
  videoFilter: string;

  autoPlayNext: boolean;
  onToggleAutoPlayNext: () => void;
  autoSkipEnabled: boolean;
  onToggleAutoSkip: () => void;

  /* ── drill-down: pickers (each one closes the menu) ────────────────── */
  onSelectProvider: (id: string) => void;
  onSelectServer: (server: string) => void;
  onSelectQuality: (quality: string) => void;
  onSelectSpeed: (rate: number) => void;
  onSelectFilter: (id: string) => void;

  /* ── drill-down: the subtitles sub-page ────────────────────────────── */
  /** Passed straight through to `SubtitlePickerContent`. */
  subtitle: ComponentProps<typeof SubtitlePickerContent>;
}

export default function PlayerMoreMenu({
  wrapRef,
  section,
  onSectionChange,
  onClose,
  isCompact,
  showAudioToggle,
  audioType,
  dubEnabled,
  onSwitchAudioType,
  providerOptions,
  providerCurrent,
  providerValue,
  availableServers,
  activeServer,
  availableQualities,
  currentQuality,
  speedOptions,
  playbackRate,
  activeSubtitle,
  filterOptions,
  videoFilter,
  autoPlayNext,
  onToggleAutoPlayNext,
  autoSkipEnabled,
  onToggleAutoSkip,
  onSelectProvider,
  onSelectServer,
  onSelectQuality,
  onSelectSpeed,
  onSelectFilter,
  subtitle,
}: PlayerMoreMenuProps) {
  // ─── root ⇄ submenu drill transition ─────────────────────────────────────
  // Swapping between the root list and a drill-down sub-page fades + nudges
  // instead of hard-cutting, driven by the `view` key below (a unique key per
  // panel state, so React remounts the branch and the CSS animation replays).
  // House style, same as the skip-chip entrance (`n54-skip-in`) and the
  // episode-drawer fade: a short opacity + tiny translateX on the incoming
  // layer, ~160ms ease-out — a fast, weighted nudge, not a flourish, and well
  // under the ~200ms popup budget so navigation never feels laggy.
  //
  // Direction mirrors the navigation: drilling in nudges the submenu in from
  // the right (+8px → 0), going back nudges the root back in from the left
  // (-8px → 0), each with a fade. The panel wrapper, its computed anchor and
  // its width class are untouched — only the content inside the (unchanged)
  // box animates, so geometry, the 36px rows, the drill back-header/options
  // sizing, keyboard, click-outside and focus management are all byte-identical.
  //
  // Reduced-motion: the `@media (prefers-reduced-motion: reduce)` override in
  // the style block disables the keyframes entirely, so the layer swaps with
  // no animation at all — exactly today's behaviour. No JS branch, no timing
  // change, nothing to get wrong for motion-sensitive viewers.
  //
  // `view` is a unique key per panel state, so React remounts the branch on
  // every root⇄submenu change and the CSS animation replays. Opening the panel
  // is a mount, not a view change, so it carries no animation (same as today).
  const view = section ?? "root";

  const moreMenuAnchor =
    section !== null
      ? isCompact
        ? "absolute right-3 bottom-[76px] w-[min(15rem,calc(100%_-_1.5rem))] max-h-[calc(100%_-_96px)]"
        : "absolute right-3 bottom-[76px] w-52 max-h-[calc(100%_-_84px)]"
      : isCompact
      ? "absolute right-3 bottom-[76px] w-[min(15rem,calc(100%_-_1.5rem))] max-h-[calc(100%_-_96px)] [&>button]:min-h-9"
      : "absolute right-2 bottom-[76px] w-56 max-h-[calc(100%_-_84px)] sm:right-3";

  return (
    <div
      ref={wrapRef}
      role="menu"
      aria-label="More controls"
      className={`rounded-none border border-[var(--accent)]/20 bg-[var(--panel)] pt-1 pb-2 shadow-xl backdrop-blur-sm z-50 overflow-y-auto overscroll-contain ${moreMenuAnchor}`}
    >
      {/* Drill transition keyframes — scoped to this panel, following the
          player's existing inline-`<style>` + `n54-*` naming convention
          (see `n54-skip-in` in Player.tsx). Two directions, so drilling in
          and going back read as mirror images; reduced-motion disables them
          all for an instant swap. */}
      <style>{`
        @keyframes n54-more-in-right {
          from { opacity: 0; transform: translateX(8px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes n54-more-in-left {
          from { opacity: 0; transform: translateX(-8px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .n54-more-in-right { animation: n54-more-in-right 160ms ease-out; }
        .n54-more-in-left { animation: n54-more-in-left 160ms ease-out; }
        @media (prefers-reduced-motion: reduce) {
          .n54-more-in-right,
          .n54-more-in-left { animation: none; }
        }
        /* SUBTITLES drill: hide SubtitlePickerContent's redundant first-child
           "Subtitles" label (it duplicates the back-header title and leaves a
           ~21px dead band the other submenus don't have), so options start
           flush under the header like Provider / Server / Quality / Filter. */
        .n54-subs-body > div:first-child { display: none; }
      `}</style>

      {section === null ? (
        // Root list. `n54-more-in-left` plays on a fresh open (the component's
        // first mount) and again on a back-navigation (this branch remounts
        // because its `key` flips from the submenu's section id to `"root"`),
        // so both entering the panel and returning from a submenu share the
        // same gentle left-in fade.
        <div key={view} className="n54-more-in-left">
          <div className="flex items-center justify-between gap-2 px-3 text-[10px] uppercase tracking-wider text-[var(--accent)]/30 font-semibold font-mono">
            <span className="py-1">More</span>
            {/* Touch-only dismiss target: on phones the ✕ is a clearer
                close affordance than the transparent catcher (desktop uses
                catcher/⋯); the popup no longer covers the ⋯ trigger, so this
                is a convenience, not a necessity. */}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close more controls"
              className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center text-[var(--accent)]/60 transition-colors hover:text-[var(--accent)] sm:hidden"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>

          {/* Sub / Dub — rendered whenever the episode list answers (even
              with "no dub"): the DUB half then reads muted and refuses the
              click, instead of silently vanishing. Styled as a segmented
              control, not a highlighter fill — active half = 15% accent tint
              + accent text + a full 1px accent border (the .header-search
              focus language), inactive = muted mono text on the panel glass.
              The halves overlap their adjacent borders (-ml-px) into one
              seam; the active half carries z-10 so it owns that seam. */}
          {showAudioToggle && (
            <>
              {/* Compact at <640 (28px halves inside a 4px wrapper = 34px
                  block); ≥640 keeps the round-4 sizing (py-1.5, 8px wrapper). */}
              <div className="px-2 pt-1 pb-1 max-sm:pt-0.5 max-sm:pb-0.5 lg:hidden">
                <div className="flex rounded-none">
                  <button
                    type="button"
                    onClick={() => onSwitchAudioType("sub")}
                    aria-pressed={audioType === "sub"}
                    className={`flex-1 rounded-none border px-3 py-1.5 max-sm:py-1 min-h-7 font-mono text-[11px] font-medium uppercase tracking-[0.14em] transition-colors ${
                      audioType === "sub" || !dubEnabled
                        ? "z-10 border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] text-[var(--accent)]"
                        : "border-[var(--accent)]/20 bg-black/40 text-[var(--accent)]/50 hover:border-[var(--accent)]/50 hover:text-[var(--accent)]"
                    }`}
                  >
                    SUB
                  </button>
                  <button
                    type="button"
                    onClick={() => onSwitchAudioType("dub")}
                    disabled={!dubEnabled}
                    aria-pressed={audioType === "dub" && dubEnabled}
                    title={dubEnabled ? undefined : "No dub for this episode"}
                    className={`-ml-px flex-1 rounded-none border px-3 py-1.5 max-sm:py-1 min-h-7 font-mono text-[11px] font-medium uppercase tracking-[0.14em] transition-colors ${
                      audioType === "dub" && dubEnabled
                        ? "z-10 border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] text-[var(--accent)]"
                        : dubEnabled
                        ? "border-[var(--accent)]/20 bg-black/40 text-[var(--accent)]/50 hover:border-[var(--accent)]/50 hover:text-[var(--accent)]"
                        : "cursor-not-allowed border-[var(--accent)]/10 bg-black/40 text-[var(--accent)]/25"
                    }`}
                  >
                    DUB
                  </button>
                </div>
              </div>
              {/* Section rhythm: a tight hairline break under the toggle
                  group before the settings rows (4px + 1px + 4px — desktop
                  density, not the old 16px sheet gap; both sides only exist
                  below lg, where the row itself carries SUB/DUB). */}
              <div
                aria-hidden="true"
                className="mx-3 my-1 h-px bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] lg:hidden"
              />
            </>
          )}

          {/* Settings rows — provider / server / quality / subtitles no
              longer sit inline anywhere, so they show at EVERY width. Only
              Speed (and the SUB/DUB copy above) still hide at lg, where the
              row itself carries them — a control is never offered twice. */}
          <MoreRow
            label="Provider"
            value={providerOptions.find((p) => p.id === providerValue)?.label ?? "Auto"}
            onClick={() => onSectionChange("provider")}
          />
          {availableServers.length > 0 && (
            <MoreRow
              label="Server"
              value={activeServer || "Auto"}
              onClick={() => onSectionChange("server")}
            />
          )}
          {availableQualities.length > 0 && (
            <MoreRow
              label="Quality"
              value={currentQuality === "auto" ? "Auto" : currentQuality}
              onClick={() => onSectionChange("quality")}
            />
          )}
          <MoreRow
            className="lg:hidden"
            label="Speed"
            value={`${playbackRate}x`}
            onClick={() => onSectionChange("speed")}
          />
          <MoreRow
            label="Subtitles"
            value={activeSubtitle ? "On" : "Off"}
            onClick={() => onSectionChange("subs")}
          />

          {/* Always here — lowest priority, never on the row */}
          <MoreRow
            label="Filter"
            value={filterOptions.find((f) => f.id === videoFilter)?.label ?? "Off"}
            onClick={() => onSectionChange("filter")}
          />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={autoPlayNext}
            onClick={() => onToggleAutoPlayNext()}
            className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors rounded-none ${
              autoPlayNext
                ? "text-[var(--accent)]"
                : "text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
            }`}
          >
            <span className="flex items-center gap-2">
              <PlayIcon className="h-3.5 w-3.5 shrink-0" />
              Auto-Play Next
            </span>
            <span className={`label-micro ${autoPlayNext ? "text-[var(--accent)]" : "text-[var(--accent)]/30"}`}>
              {autoPlayNext ? "On" : "Off"}
            </span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={autoSkipEnabled}
            onClick={() => onToggleAutoSkip()}
            className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors rounded-none ${
              autoSkipEnabled
                ? "text-[var(--accent)]"
                : "text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
            }`}
          >
            <span className="flex items-center gap-2">
              <Forward10Icon className="h-3.5 w-3.5 shrink-0" />
              Auto-Skip Intro
            </span>
            <span className={`label-micro ${autoSkipEnabled ? "text-[var(--accent)]" : "text-[var(--accent)]/30"}`}>
              {autoSkipEnabled ? "On" : "Off"}
            </span>
          </button>
        </div>
      ) : (
        // Drilling in → the submenu enters from the right.
        <div key={view} className="n54-more-in-right">
          {/* Section header — back one level, name the level. A chevron-only
              target (not a ✕, not a word) so the bar stays narrow enough for
              the sub-panel's compact popover at every width. Compact cuts:
              py-0.5 + a 24px chevron (was py-1 + 28px) = 28px + hairline;
              ≥640 keeps the round-4 sizing via the sm: fallbacks. */}
          <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--accent)]/15 bg-[var(--panel)] px-1.5 py-1 max-sm:py-0.5">
            <button
              type="button"
              onClick={() => onSectionChange(null)}
              aria-label="Back to more controls"
              className="flex h-7 w-7 max-sm:h-6 max-sm:w-6 shrink-0 items-center justify-center text-[var(--accent)]/50 transition-colors hover:text-[var(--accent)]"
            >
              <ChevronLeftIcon className="h-3.5 w-3.5" />
            </button>
            <span className="truncate label-micro text-[var(--accent)]/40">
              {section === "provider"
                ? "Provider"
                : section === "server"
                ? "Server"
                : section === "quality"
                ? "Quality"
                : section === "speed"
                ? "Speed"
                : section === "filter"
                ? "Filter"
                : "Subtitles"}
            </span>
          </div>

          {section === "provider" &&
            providerOptions.map((p) => (
              <Button
                key={p.id}
                type="button"
                variant="menuRow"
                active={providerCurrent === p.id}
                onClick={() => onSelectProvider(p.id)}
              >
                {p.label}
              </Button>
            ))}

          {section === "server" &&
            availableServers.map((srv) => (
              <Button
                key={srv}
                type="button"
                variant="menuRow"
                active={activeServer === srv}
                onClick={() => onSelectServer(srv)}
              >
                {srv}
              </Button>
            ))}

          {section === "quality" &&
            availableQualities.map((q) => (
              <Button
                key={q}
                type="button"
                variant="menuRow"
                active={q === currentQuality}
                onClick={() => onSelectQuality(q)}
              >
                {q === "auto" ? "Auto" : q}
              </Button>
            ))}

          {section === "speed" &&
            speedOptions.map((r) => (
              <Button
                key={r}
                type="button"
                variant="menuRow"
                active={playbackRate === r}
                onClick={() => onSelectSpeed(r)}
              >
                {r}x
              </Button>
            ))}

          {section === "filter" &&
            filterOptions.map((f) => (
              <Button
                key={f.id}
                type="button"
                variant="menuRow"
                active={videoFilter === f.id}
                onClick={() => onSelectFilter(f.id)}
              >
                {f.label}
              </Button>
            ))}

          {section === "subs" && (
            /* `SubtitlePickerContent` renders its own "Subtitles" section
               label as its first child — which duplicates the back-header
               title above it and leaves a ~21px dead band before the first
               option ("Off"). Every other drill submenu (Provider / Server /
               Quality / Speed / Filter) starts its options flush under the
               header, so this is the odd one out. The `n54-subs-body` hook
               lets the scoped style block below hide just that redundant
               first-child label (the OpenSubtitles divider is a later
               sibling and stays), and dropping `py-0.5` removes the wrapper's
               own 2px so the options sit flush like the majority pattern. */
            <div className="n54-subs-body px-1">
              <SubtitlePickerContent {...subtitle} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
