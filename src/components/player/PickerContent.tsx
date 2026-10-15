"use client";

import type { ComponentProps, ReactNode } from "react";
import Button from "@/components/ui/Button";
import {
  AudioFilterIcon,
  GlobeIcon,
  ServerIcon,
  SpeedIcon,
  SubtitleIcon,
  VideoFilterIcon,
} from "@/components/ui/icons";
import SubtitlePickerContent from "./SubtitlePickerContent";

/**
 * The six drill-down pickers' LIST UI, extracted so it exists exactly once —
 * `PlayerMoreMenu`'s drill-down and every control-row popover (see
 * `togglePicker` in Player.tsx) render THIS component, with the selection
 * handlers their surface wires. The two surfaces can't drift: there is no
 * second copy of the provider/server/speed/filter/audio/subs markup to keep
 * in sync.
 *
 * `PICKER_LABEL` / `PICKER_ICON` are shared too, so the glyph + name that
 * greet you in a row popover's header, in the ⋯ menu's drill header and on
 * the menu's root rows are the same strings and the same glyphs — one map,
 * three surfaces.
 *
 * Like everything under `components/player`, this file is LOCAL-ONLY (the
 * design site never imports it), so it may use `"use client"` + hooks freely.
 */

/** The drill-down pickers' ids — the one enum both surfaces share. */
export type PickerId = "provider" | "server" | "speed" | "filter" | "audio" | "subs";

/** The display name of each picker — headers on both surfaces read from here. */
export const PICKER_LABEL: Record<PickerId, string> = {
  provider: "Provider",
  server: "Server",
  speed: "Speed",
  filter: "Filter",
  audio: "Audio",
  subs: "Subtitles",
};

/** The glyph each picker is filed under — the SAME icon its control-row
 *  trigger and its ⋯ menu root row use (row glyph at its own size, here at
 *  the shared 14px header size), so "I clicked the waveform, I'm in Audio"
 *  reads at a glance wherever you came from. */
export const PICKER_ICON: Record<PickerId, ReactNode> = {
  provider: <GlobeIcon className="h-3.5 w-3.5 shrink-0" />,
  server: <ServerIcon className="h-3.5 w-3.5 shrink-0" />,
  speed: <SpeedIcon className="h-3.5 w-3.5 shrink-0" />,
  filter: <VideoFilterIcon className="h-3.5 w-3.5 shrink-0" />,
  audio: <AudioFilterIcon className="h-3.5 w-3.5 shrink-0" />,
  subs: <SubtitleIcon className="h-3.5 w-3.5 shrink-0" />,
};

/** The option lists + the actions each one fires. Both surfaces pass the
 *  SAME handler objects (Player.tsx builds them once, parameterised only by
 *  which surface dismisses itself after a pick). */
export interface PickerContentProps {
  section: PickerId;
  providerOptions: readonly { id: string; label: string }[];
  /** The active provider's id ("" = Auto). */
  providerCurrent: string;
  availableServers: string[];
  activeServer: string | null;
  speedOptions: number[];
  playbackRate: number;
  filterOptions: readonly { id: string; label: string }[];
  videoFilter: string;
  /** `{ id, label, description? }` — `description` rides on the row's title. */
  audioFilterOptions: readonly { id: string; label: string; description?: string }[];
  /** The active audio-filter preset's id ("off" = unprocessed). */
  audioFilter: string;
  onSelectProvider: (id: string) => void;
  onSelectServer: (server: string) => void;
  onSelectSpeed: (rate: number) => void;
  onSelectFilter: (id: string) => void;
  onSelectAudioFilter: (id: string) => void;
  /** Passed straight through to `SubtitlePickerContent` (the subs page). */
  subtitle: ComponentProps<typeof SubtitlePickerContent>;
}

/** The body of one drill-down page. A fragment of option rows at the panel's
 *  own density (the `menuRow` Button — the house 28px row, identical in the
 *  ⋯ drill and in a row popover); each row highlights when it is the current
 *  value and fires its picker's handler on click. */
export default function PickerContent({
  section,
  providerOptions,
  providerCurrent,
  availableServers,
  activeServer,
  speedOptions,
  playbackRate,
  filterOptions,
  videoFilter,
  audioFilterOptions,
  audioFilter,
  onSelectProvider,
  onSelectServer,
  onSelectSpeed,
  onSelectFilter,
  onSelectAudioFilter,
  subtitle,
}: PickerContentProps) {
  return (
    <>
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

      {/* Audio filter — byte-identical row shape to the Filter list above;
          only the option source and the selected-state id differ.
          `description` rides on the native `title` tooltip (no second line /
          no new row styling). */}
      {section === "audio" &&
        audioFilterOptions.map((f) => (
          <Button
            key={f.id}
            type="button"
            variant="menuRow"
            active={audioFilter === f.id}
            title={f.description}
            onClick={() => onSelectAudioFilter(f.id)}
          >
            {f.label}
          </Button>
        ))}

      {section === "subs" && (
        /* `SubtitlePickerContent` renders its own "Subtitles" section label as
           its first child — which duplicates the surface's own header (the ⋯
           drill's back-header, or a row popover's label bar) and leaves a
           ~21px dead band before the first option ("Off"). Every other picker
           starts its options flush under the header, so this is the odd one
           out. The `n54-subs-body` hook lets this scoped style hide just that
           redundant first-child label (the OpenSubtitles divider is a later
           sibling and stays), and the wrapper carries no vertical padding, so
           the options sit flush like the majority pattern. */
        <>
          <style>{`
            /* SUBTITLES picker: hide SubtitlePickerContent's redundant
               first-child label (see the comment above). */
            .n54-subs-body > div:first-child { display: none; }
          `}</style>
          <div className="n54-subs-body px-1">
            <SubtitlePickerContent {...subtitle} />
          </div>
        </>
      )}
    </>
  );
}
