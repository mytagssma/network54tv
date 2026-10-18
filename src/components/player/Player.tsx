"use client";

import { useEffect, useRef, useState, useCallback, useMemo, Fragment, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Hls from "hls.js";
import SubtitleOverlay from "./SubtitleOverlay";
import Button, { buttonClass } from "@/components/ui/Button";
import {
  AudioFilterIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Forward10Icon,
  FullscreenIcon,
  GlobeIcon,
  MoreIcon,
  NextTrackIcon,
  PauseIcon,
  PlayIcon,
  PrevTrackIcon,
  QualityIcon,
  Rewind10Icon,
  ServerIcon,
  SkipChevronIcon,
  SpeedIcon,
  SubtitleIcon,
  VideoFilterIcon,
  VolumeIcon,
  VolumeMutedIcon,
} from "@/components/ui/icons";
import PlayerMoreMenu, { type MoreSection } from "./PlayerMoreMenu";
import PickerContent, { PICKER_ICON, PICKER_LABEL } from "./PickerContent";
import { proxyUrl } from "@/lib/utils";
import {
  migrateIntoGlobal,
  readSettings,
  writeSettings,
  type GlobalSettings,
} from "@/lib/settings";
import { AvailabilityChip, EmptyState } from "@/components/anime/Availability";
import type { StreamSource, Subtitle } from "@/types/anime";
import { franchiseSortGroups, type FranchiseEntry } from "@/components/watch/franchiseEntries";
import { useFranchiseSort } from "@/hooks/useFranchiseSort";

interface PlayerProps {
  animeTitle: string;
  episodeNumber: number;
  anilistId?: number;
  malId?: number;
  nextEpisodeNumber?: number;
  providerId?: string;
  /** `?provider=` from the watch page — carried through episode navigation */
  providerQuery?: string;
  /**
   * Compact episode list for the drawer (passed down; never re-fetched here).
   * Availability rides along OPTIONAL so the drawer can MARK a known-dead row
   * (N/A + inert) instead of rendering it as playable — `undefined` stays
   * "unknown" and renders exactly as it always did.
   */
  episodes?: {
    number: number;
    title?: string;
    available?: boolean;
    hasSub?: boolean | null;
    hasDub?: boolean | null;
  }[];
  /**
   * Franchise / season entries (same set the watch page's `// Franchise`
   * grid lists) — the dropdown docked at the top of the episode drawer.
   */
  franchise?: FranchiseEntry[];
  /**
   * The CURRENT episode's dub flag, straight from the episode list the watch
   * page already resolved (`Episode.hasDub`):
   *   `true`  this episode carries a dub        → DUB is offered
   *   `false` this episode has no dub           → DUB renders muted + inert
   *   `null`  the provider didn't say (megaplay ships `null` for everything)
   *           → resolved through `/api/episodes?audio=1` below, and only if
   *           that can't tell either does the old stream probe have a say.
   * Data decides; the probe never overrides a known answer.
   */
  episodeHasDub?: boolean | null;
}

const SERVERS = ["vidstream-2", "vidcloud-1", "vidstream-1"];

// Provider options shown in the error overlay when a stream fails
const PROVIDER_OPTIONS = [
  { id: "", label: "Auto" },
  { id: "kickassanime", label: "Kickass" },
  { id: "anikoto", label: "Anikoto" },
  { id: "anizone", label: "AniZone" },
  { id: "allmanga", label: "AllManga" },
  { id: "anineko", label: "AniNeko" },
  { id: "megaplay", label: "MegaPlay" },
  { id: "animeunity", label: "AnimeUnity" },
];

/* ─── Mount-only stream handoff (schedule → provider reality) ─────────
 * The watch URL's episode number is AniList SCHEDULE truth (the home
 * strip's "Play latest", a shared link, a bookmark), but the providers
 * can lag it: the newest aired episode often has no uploaded stream yet
 * (the classic latest-episode lag), and for some titles no episode
 * streams at all. A card can't know any of this — walking 10 providers
 * per home card is infeasible — so the correction happens HERE, once,
 * on the first lookup after mount: when the landing episode comes back
 * with the route's definitive "exhausted providers" miss (and ONLY that
 * class — a transient failure must never silently redirect the viewer),
 * step down to the newest episode the list marks available and play
 * that instead, rewriting the URL so it tells the truth.
 *
 * The gate string below is verbatim /api/stream's walk-miss body
 * (src/app/api/stream/route.ts). Everything else that lands in
 * `data.error` or in a non-OK/network failure is transient (provider
 * outage, thrown walk) and keeps the normal error state.
 */
const EXHAUSTED_SOURCES_ERROR = "No streaming sources available for this episode";

function isExhaustedSourcesError(err: string | null | undefined): boolean {
  return typeof err === "string" && err.startsWith(EXHAUSTED_SOURCES_ERROR);
}

/**
 * Hard cap on stream lookups during ONE mount: the landing episode's own
 * lookup counts as the first, so the handoff may try at most two lower
 * candidates. Each miss is a full provider walk (~10–20s), so the cap
 * bounds the worst case at ~3 walks before the error overlay takes over —
 * unbounded stair-stepping down a dead run would strand the viewer on a
 * loading bar for minutes.
 */
const MOUNT_HANDOFF_MAX_LOOKUPS = 3;

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * Priority order of the control row's icon-only toolbar — HIGHEST FIRST.
 * The row surfaces the ⋯ menu's options as icons, but only while they fit
 * beside the left group (transport, volume, time); whatever falls off the
 * end stays in the ⋯ menu, which is always present. The order is ranked
 * STRICTLY by how often the control changes DURING watching (frequency of
 * use), not by how important it is:
 *   1. Subtitles  — flips constantly: signs on/off, sub vs dub viewing
 *   2. Speed      — changes often: recaps, slow dialogue
 *   3. Server     — the first response to a failing stream (and streams fail)
 *   4. Auto Skip  — a per-taste switch, flipped occasionally …
 *   5. Auto Play  — … and auto-skip is flipped more often than auto-play
 *   6. Provider   — only follows REPEATED server failure
 *   7. Filter     — a set-once picture-taste option
 *   8. Audio      — a set-once sound-taste option
 * Quality is NOT in the list: its trigger is fixed on the row at every width
 * (it only lost its text label), and ⋯ / fullscreen are fixed too.
 */
const ROW_ICON_PRIORITY = [
  "subs",
  "speed",
  "server",
  "autoSkip",
  "autoPlay",
  "provider",
  "filter",
  "audio",
] as const;
type RowIconId = (typeof ROW_ICON_PRIORITY)[number];

/**
 * Where a row popover sits — measured against the PLAYER container the moment
 * it opens (and re-measured by the fit effect's ResizeObserver, so a live
 * panel re-clamps instead of going stale on a fullscreen toggle or resize):
 * `side` picks which edge of its trigger the panel hangs from (the side with
 * more room, so a popover on a left-side icon grows rightward and can never
 * cross the player's left edge), and the two caps are hard pixel ceilings the
 * panel's inline styles enforce — width for the horizontal frame margins,
 * height for the room actually above the trigger. The container's
 * `overflow-hidden` is the backstop that clips anything pathological.
 */
type PickerAnchor = { side: "left" | "right"; maxW: number; maxH: number };
/** The two popover widths — quality's compact list, the pickers' column. */
const QUALITY_POPOVER_W = 112; // w-28 — what the quality list has always been
const PICKER_POPOVER_W = 176; // w-44 — room for "Anime Vivid" / "Voice Boost"

/** Pure geometry for a row popover: which side to hang from and how big it
 *  may grow, given the trigger element and the player container it lives in
 *  (see `PickerAnchor`). Kept at module scope so both the open path and the
 *  live re-measure call the identical math. */
function computePickerAnchor(
  container: HTMLElement | null,
  el: HTMLElement,
  desiredW: number
): PickerAnchor {
  const b = el.getBoundingClientRect();
  if (!container) return { side: "right", maxW: desiredW, maxH: 224 };
  const c = container.getBoundingClientRect();
  const EDGE = 12; // minimum frame kept between panel edge and player edge
  // Room for a panel hanging LEFT of the trigger (right-anchored, `right-0`,
  // growing leftward) vs RIGHT of it (left-anchored, growing rightward) —
  // each measured from the trigger's own edge, so the cap is exactly the
  // space that exists whatever the row's layout is.
  const roomRight = b.right - c.left - EDGE;
  const roomLeft = c.right - b.left - EDGE;
  const side = roomRight >= roomLeft ? "right" : "left";
  const room = side === "right" ? roomRight : roomLeft;
  // Up is always the roomier direction (the row sits ~40px above the
  // player's bottom edge), but a short windowed player can still hold less
  // than the panel wants — cap to the real gap and let the panel scroll.
  // The 48px floors only ever bind on a pathologically small player, where
  // a sliver of scrollable panel beats a 10px one (and the container clips
  // the rest either way).
  const roomUp = b.top - c.top - EDGE;
  return {
    side,
    maxW: Math.max(48, Math.min(desiredW, room)),
    maxH: Math.max(48, Math.min(288, roomUp)),
  };
}

/* ─── Quality labels ─────────────────────────────────────────────────────
 * The picker must name levels the way people ask for them — "1080p",
 * "720p" — not by raw pixel count. Anime masters are routinely ultra-wide
 * (this app's own megaplay/anikoto masters ship `RESOLUTION=1920x816` and
 * `1280x544`), so a level's `height` is the *letterboxed* frame height, and
 * labelling straight off it produced "816p"/"544p" — a menu with no 1080p on
 * it even though the stream is a genuine 1080-wide master. Width carries the
 * intent: 1920 → 1080p, 1280 → 720p, which is just `width * 9/16` snapped to
 * the nearest standard vertical size.
 */
const STANDARD_HEIGHTS = [144, 216, 240, 360, 480, 540, 720, 1080, 1440, 2160];

function qualityLabel(level: { width?: number; height?: number }, index: number): string {
  const width = level.width || 0;
  const height = level.height || 0;
  if (width <= 0 && height <= 0) return `Level ${index}`;
  // Prefer width; a height-only level is already a vertical size, so use it as-is.
  const target = width > 0 ? (width * 9) / 16 : height;
  let best = STANDARD_HEIGHTS[0];
  for (const candidate of STANDARD_HEIGHTS) {
    if (Math.abs(candidate - target) < Math.abs(best - target)) best = candidate;
  }
  return `${best}p`;
}

/* ─── Series / episode switch handoff ───────────────────────────────────
 * A route-param change (`…/watch/5` → `…/watch/6`, or a different `[id]`)
 * changes the App Router segment's *state key* (`createRouterCacheKey`
 * bakes the param value in), and with `cacheComponents` off the bfcache
 * keeps only 1 entry — so React unmounts the entire previous segment,
 * player included, and mounts a fresh one. Anything that has to survive
 * that trip is stashed here in sessionStorage and read back by the NEXT
 * Player instance: the switch overlay's payload, and the "we were in
 * fullscreen" intent used to restore it.
 */
const SWITCH_KEY = "n54tv-switch";
/** Never let an instant load flash the overlay — hold it at least this long. */
const SWITCH_MIN_MS = 700;
/** Older than this is a leftover from a dead tab, not a live switch. */
const SWITCH_STALE_MS = 20_000;

interface SwitchHandoff {
  /** Epoch ms of the click that started the switch (drives the min hold). */
  t: number;
  /** The player was fullscreen then — the new instance must restore it. */
  fs: boolean;
  /** What the overlay announces. */
  kind: "episode" | "series";
  /** Series title to show (the *target* series on a series switch). */
  series: string;
  /** Target episode number. */
  episode: number;
  /** Episode title when hopping within the same series. */
  epTitle?: string;
}

function readSwitchHandoff(): SwitchHandoff | null {
  try {
    const raw = sessionStorage.getItem(SWITCH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SwitchHandoff;
    if (!parsed || typeof parsed.t !== "number") return null;
    if (Date.now() - parsed.t > SWITCH_STALE_MS) {
      sessionStorage.removeItem(SWITCH_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeSwitchHandoff(h: SwitchHandoff): void {
  try {
    sessionStorage.setItem(SWITCH_KEY, JSON.stringify(h));
  } catch {
    /* private mode / quota — the overlay then only lives on this instance */
  }
}

function clearSwitchHandoff(): void {
  try {
    sessionStorage.removeItem(SWITCH_KEY);
  } catch {
    /* ignore */
  }
}

/* ─── Sub/dub flags cache (shared with the episode list) ───────────────
 * The `?audio=1` second pass behind `/api/episodes` costs a megaplay probe
 * (~1-3s) and answers the SAME question for every consumer in the tab: the
 * detail page's episode list and the player's DUB toggle both ask it per
 * AniList ID. One sessionStorage slot makes the second ask free — this was
 * the last refire of an identical URL inside a single navigation (detail →
 * watch used to pay it twice, once per page).
 *
 * Contract (shared with the episode list side): key `n54tv-audio:{id}`,
 * JSON `{subCount, dubCount, subOfTotal?, dubOfTotal?, at}` — the counts are
 * `null` while unknown (never `false`; a non-null count means every listed
 * episode's flag is KNOWN and the count is how many carry the audio), `at`
 * is epoch ms and the entry is trusted for AUDIO_FLAGS_TTL_MS.
 * `subOfTotal`/`dubOfTotal` are optional and tolerated, never required:
 * either side may land without them, and an absent pair just means the
 * counts stand alone. The player additionally reads (and writes) an OPTIONAL
 * `dubByEpisode` map — extra keys are invisible to any other reader, and it
 * is what lets a later navigation answer THIS episode's flag outright.
 */
const AUDIO_FLAGS_KEY_PREFIX = "n54tv-audio:";
const AUDIO_FLAGS_TTL_MS = 5 * 60_000;

interface AudioFlagsCacheEntry {
  subCount: number | null;
  dubCount: number | null;
  subOfTotal?: number;
  dubOfTotal?: number;
  at: number;
  /** Optional player-side extra: per-episode dub answers (episode → hasDub). */
  dubByEpisode?: Record<string, boolean>;
}

function readAudioFlagsCache(anilistId?: number | null): AudioFlagsCacheEntry | null {
  if (!anilistId || typeof window === "undefined") return null;
  try {
    const key = `${AUDIO_FLAGS_KEY_PREFIX}${anilistId}`;
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AudioFlagsCacheEntry;
    if (!parsed || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > AUDIO_FLAGS_TTL_MS) {
      sessionStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Merge a fresh fact into the (possibly absent / just-expired) slot. The
 * `at` stamp refreshes on every write, so a probe-confirmed fact extends the
 * entry's life — the facts themselves don't expire faster than the provider
 * side's own flag cache, and a 5-minute re-ask is the contract either way.
 */
function mergeAudioFlagsCache(
  anilistId: number | null | undefined,
  patch: Partial<Omit<AudioFlagsCacheEntry, "at">>
): void {
  if (!anilistId) return;
  const existing = readAudioFlagsCache(anilistId); // stale reads as absent
  const merged: AudioFlagsCacheEntry = {
    subCount: patch.subCount !== undefined ? patch.subCount : existing?.subCount ?? null,
    dubCount: patch.dubCount !== undefined ? patch.dubCount : existing?.dubCount ?? null,
    at: Date.now(),
    ...(patch.subOfTotal !== undefined
      ? { subOfTotal: patch.subOfTotal }
      : existing?.subOfTotal !== undefined
        ? { subOfTotal: existing.subOfTotal }
        : {}),
    ...(patch.dubOfTotal !== undefined
      ? { dubOfTotal: patch.dubOfTotal }
      : existing?.dubOfTotal !== undefined
        ? { dubOfTotal: existing.dubOfTotal }
        : {}),
    ...((patch.dubByEpisode ?? existing?.dubByEpisode) && {
      dubByEpisode: { ...(existing?.dubByEpisode ?? {}), ...(patch.dubByEpisode ?? {}) },
    }),
  };
  try {
    sessionStorage.setItem(`${AUDIO_FLAGS_KEY_PREFIX}${anilistId}`, JSON.stringify(merged));
  } catch {
    /* private mode / quota — the flags simply refetch next time */
  }
}

/**
 * Last-resort fullscreen recovery: browsers only grant `requestFullscreen()`
 * inside user activation, so when the instant post-navigation attempt above
 * has been rejected, the honest way back in is the viewer's *next* real
 * gesture. One shot (first click or key), disarmed after 15s so a stray
 * later tap can never yank someone into fullscreen.
 */
function armFullscreenRetry(): void {
  const tryIt = () => {
    disarm();
    const el = document.documentElement as any;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try {
      const p = req.call(el);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* still refused — leave the viewer where they are */
    }
  };
  const disarm = () => {
    window.removeEventListener("pointerdown", tryIt);
    window.removeEventListener("keydown", tryIt);
    clearTimeout(timer);
  };
  const timer = setTimeout(disarm, 15_000);
  window.addEventListener("pointerdown", tryIt, { once: true });
  window.addEventListener("keydown", tryIt, { once: true });
}

const FILTER_PRESETS = [
  { id: "off", label: "Off", css: "none" },
  { id: "vivid", label: "Anime Vivid", css: "brightness(1.05) contrast(1.1) saturate(1.3)" },
  { id: "soft", label: "Anime Soft", css: "brightness(1.02) contrast(0.95) saturate(1.1)" },
  { id: "cinema", label: "Cinema", css: "brightness(0.95) contrast(1.15) saturate(0.85) sepia(0.05)" },
  { id: "sharp", label: "Sharp", css: "brightness(1) contrast(1.1) saturate(1.3)" },
] as const;

type FilterId = (typeof FILTER_PRESETS)[number]["id"];

// The ⋯ menu's Filter drill list — FILTER_PRESETS also carries each preset's
// CSS, which the menu doesn't need.
const FILTER_MENU_OPTIONS: { id: string; label: string }[] = FILTER_PRESETS.map(
  (f) => ({ id: f.id, label: f.label })
);

/* ─── Audio filter presets (Web Audio API) ─────────────────────────────
 * The video filter above is CSS; CSS can't touch audio, so these presets
 * describe real Web Audio graphs built by `ensureAudioGraph` in the Player
 * (mid-side cancellation, biquads, a compressor). `description` is the
 * graph's documentation and the drill row's hover hint — the ⋯ menu itself
 * only needs id/label, same as FILTER_MENU_OPTIONS.
 */
const AUDIO_FILTER_PRESETS = [
  { id: "off", label: "Off", description: "No audio processing" },
  { id: "vocal-remove", label: "Vocal Remove", description: "Karaoke: cancels the centre-panned vocal (L−R)" },
  { id: "voice-boost", label: "Voice Boost", description: "+8 dB at 2.5 kHz — dialogue clarity" },
  { id: "voice-only", label: "Voice Only", description: "Centre extraction + 200 Hz highpass + 3 kHz lift" },
  { id: "bass-boost", label: "Bass Boost", description: "+8 dB low shelf at 120 Hz" },
  { id: "treble-boost", label: "Treble Boost", description: "+6 dB high shelf at 4 kHz" },
  { id: "night", label: "Night Mode", description: "Compressor + makeup: tames loud, lifts quiet" },
] as const;

type AudioFilterId = (typeof AUDIO_FILTER_PRESETS)[number]["id"];

// The ⋯ menu's Audio drill list — same shape as FILTER_MENU_OPTIONS, plus
// the hover hint.
const AUDIO_FILTER_MENU_OPTIONS: { id: string; label: string; description: string }[] =
  AUDIO_FILTER_PRESETS.map((f) => ({ id: f.id, label: f.label, description: f.description }));

/* ─── Preference stores (two tiers) ─────────────────────────────────────
 * Viewer settings live in TWO localStorage buckets, split by scope:
 *
 *   • GLOBAL — `n54tv-settings` (src/lib/settings.ts). Device & behaviour
 *     settings that should follow the viewer across every show: quality,
 *     auto-play-next, auto-skip, video/audio filters, the subtitle
 *     on/off + lang/offset/size defaults, and speed/volume/mute — the
 *     last three used to live only in the per-EPISODE progress blob
 *     (`n54tv-progress-{anime}-{episode}`), where `saveProgress` deletes
 *     the whole key within 5s of an episode finishing, so they reset
 *     every time an episode completed.
 *   • PER-ANIME — `n54tv-prefs:{id}` (this file), shrunk to what
 *     genuinely belongs to one show:
 *       - audioType (sub/dub),
 *       - providerId (the control-bar provider override — the page's
 *         `providerId` prop is the default; a stored value wins),
 *       - the four subtitle fields as an OVERRIDE layer: a show can pin
 *         its own lang/on-off/offset/size on top of the global default.
 *         Changing any subtitle control dual-writes BOTH buckets (global
 *         = the new default for future shows, per-anime = this show's
 *         pin); these fields are never stripped.
 *     The old per-anime copies of quality/toggles/filters migrate into
 *     the global bucket on first hydration (migrateIntoGlobal) and are
 *     stripped from this bucket after that.
 *
 * Nothing here runs during render: reads happen in effects / event
 * handlers, so SSR never touches localStorage and hydration can't mismatch.
 *
 * BEHAVIOUR MATRIX (what the split must deliver):
 *   • First visit, no buckets → defaults (quality auto, speed 1, volume 1,
 *     toggles per the defaults hydration applies).
 *   • Legacy per-anime prefs + legacy progress blob, no global → migration
 *     seeds the global bucket; nothing the viewer picked is lost, and the
 *     show's subtitle fields keep overriding.
 *   • Change speed on Show A → the speed survives finishing the episode
 *     (the blob is deleted on completion, the global bucket is not),
 *     switching shows, and a reload.
 *   • Set subs to lang X on Show A → Show A keeps X after you set lang Y
 *     on Show B; Show C (no pin) defaults to Y.
 *   • Flip the provider on Show A → persists for Show A across reload;
 *     Show B starts from the page's default `providerId` prop.
 *   • sub/dub stays purely per-anime; the server choice stays unpersisted.
 */
interface AnimePrefs {
  audioType?: "sub" | "dub";
  /** The control-bar provider override; absent = use the page default. */
  providerId?: string;
  /** Subtitle OVERRIDE layer over the global defaults. The chosen track is
   *  remembered by its LANG label, never by URL — the URL is per-stream and
   *  differs every episode. */
  subtitles?: boolean;
  subtitleLang?: string;
  subtitleOffset?: number;
  subtitleSize?: "small" | "medium" | "large";
  ts?: number;
}

/** Loose view of a per-anime bucket that may still carry the pure-global
 *  fields migration is about to strip — legacy fallbacks only (quality at
 *  MANIFEST_PARSED can beat loadedmetadata, so they must be readable before
 *  migration has run). */
type LegacyAnimePrefs = AnimePrefs & Partial<GlobalSettings>;

function readLegacyPrefs(key: string): LegacyAnimePrefs | null {
  return readPrefsByKey(key) as LegacyAnimePrefs | null;
}

/** Same `anilistId || title` shape the progress key already uses. */
function prefsKeyFor(anilistId?: number, animeTitle?: string): string {
  return `n54tv-prefs:${anilistId || `t:${animeTitle || ""}`}`;
}

function readPrefsByKey(key: string): AnimePrefs | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data: unknown = JSON.parse(raw);
    // Corrupt / non-object payloads (a stray string, an array) fall back to
    // defaults rather than poisoning every setter below.
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data as AnimePrefs;
  } catch {
    return null; // private mode, quota, malformed JSON
  }
}

function writePrefsByKey(key: string, patch: AnimePrefs): void {
  try {
    const current = readPrefsByKey(key) || {};
    localStorage.setItem(key, JSON.stringify({ ...current, ...patch, ts: Date.now() }));
  } catch {
    // A storage failure must never break playback — the session just
    // behaves as if nothing were remembered.
  }
}

function getFilterCSS(id: FilterId): string {
  return FILTER_PRESETS.find((f) => f.id === id)?.css ?? "none";
}

function formatTime(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00";
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Touch swipe-to-seek (video surface) ─────────────────────────────────
// Constants for the horizontal scrub gesture — see the "Touch
// swipe-to-seek" block on the handlers for the full contract:
//   SWIPE_ACTIVATE_PX    |dx| that arms the gesture (must also dominate dy)
//   SWIPE_AXIS_RATIO     horizontal-dominance test — verticals pass through
//   SWIPE_RATE_S_PER_PX  scrub rate: 1px ≈ 100ms of time
//   SWIPE_MAX_DELTA_S    hard cap on the delta one gesture may produce
//   SWIPE_EPSILON_PX     released this close to the origin → no-op seek
//   SWIPE_FLASH_MS       post-release hold of the chip's final value
//   SWIPE_FADE_MS        chip fade-out once the hold expires
//   SWIPE_TAP_BLOCK_MS   how long a completed swipe swallows the tap-toggle
const SWIPE_ACTIVATE_PX = 44;
const SWIPE_AXIS_RATIO = 2.5;
const SWIPE_RATE_S_PER_PX = 0.1;
const SWIPE_MAX_DELTA_S = 60;
const SWIPE_EPSILON_PX = 12;
const SWIPE_FLASH_MS = 600;
const SWIPE_FADE_MS = 300;
const SWIPE_TAP_BLOCK_MS = 400;

/** Seek chip copy — ▸ forward / ◂ back, signed to one decimal, tabular. */
function formatSeekDelta(delta: number): string {
  return `${delta < 0 ? "◂" : "▸"} ${delta < 0 ? "-" : "+"}${Math.abs(delta).toFixed(1)}s`;
}

// Pathname (lowercased, query/hash ignored) for extension checks
function getUrlPathname(url: string): string {
  try {
    return new URL(url, window.location.href).pathname.toLowerCase();
  } catch {
    return url.split(/[?#]/)[0].toLowerCase();
  }
}

// DASH manifests — unplayable here (hls.js only, no dash.js)
function isDashUrl(url: string): boolean {
  return getUrlPathname(url).endsWith(".mpd");
}

// Progressive files the browser can play directly via video.src
function isProgressiveUrl(url: string): boolean {
  return /\.(mp4|m4v|webm|mov)$/.test(getUrlPathname(url));
}

// A source we can actually attempt: HLS (when hls.js is supported) or progressive —
// never DASH (.mpd), which would otherwise assign an unplayable URL and stall at 0:00
function isPlayableSource(s: StreamSource): boolean {
  if (isDashUrl(s.url)) return false;
  return (s.isM3U8 && Hls.isSupported()) || isProgressiveUrl(s.url);
}

export default function Player({ animeTitle, episodeNumber, anilistId, malId, nextEpisodeNumber, providerId, providerQuery, episodes, franchise, episodeHasDub }: PlayerProps) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchIdRef = useRef(0);
  const failoverQueueRef = useRef<string[]>([]);
  const workingServersRef = useRef<{ server: string; sources: StreamSource[]; subtitles: Subtitle[]; headers: Record<string, string>; providerId?: string }[]>([]);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressRef = useRef(false);
  const activeServerRef = useRef<string | null>(null);
  const currentQualityRef = useRef("auto");
  const lastTimeUpdateRef = useRef(0);
  // performance.now() stamp of the most recent `seeking`/`seeked` event.
  // stallCheck uses it to forgive the post-seek readyState dip (fragment
  // fetch keeps the element at readyState 1–2 for 1–4s — not a real stall).
  const lastSeekAtRef = useRef(0);
  const triedUrlsRef = useRef<Set<string>>(new Set()); // playable URLs already attempted this load
  // ─── Load-attempt lifecycle ───────────────────────────────
  // Each source choice is one bounded "attempt" (see loadHls below).
  // watchdogRef: 15s timer that fails an attempt when neither MANIFEST_PARSED
  //              nor a fatal error ever fires (silent black screen).
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "idle" → no attempt running, "pending" → waiting for media, "ready" → playing
  const attemptStateRef = useRef<"idle" | "pending" | "ready">("idle");
  // Fails the attempt that is currently running (null while idle).
  const failAttemptRef = useRef<(() => void) | null>(null);

  // Refs for close-on-outside-click
  const moreWrapRef = useRef<HTMLDivElement>(null); // the ⋯ menu (right-anchored popup, all widths)
  const moreBtnRef = useRef<HTMLButtonElement>(null); // the ⋯ trigger
  // The dismiss layer under the ⋯ menu (transparent catcher on wide
  // viewports, scrim on phones). Excluded from the pointerdown "outside"
  // test on purpose: it closes on its own click instead, so the menu is
  // still mounted when the click lands and the gesture can't fall through
  // to the video (which would toggle playback alongside the dismissal).
  const moreDismissRef = useRef<HTMLDivElement>(null);
  const qualityWrapRef = useRef<HTMLDivElement>(null);
  // One wrapper per row-picker popover (its trigger + panel inside), keyed by
  // picker id — the click-outside test treats each trigger+panel pair as one
  // unit, exactly like `qualityWrapRef` does for quality.
  const pickerWrapRefs = useRef<Partial<Record<MoreSection, HTMLDivElement | null>>>({});
  // ─── Control-row icon toolbar — fit measurement ───────────────────────
  // The four things that eat row width, watched by ONE ResizeObserver (see
  // the `rowIconCount` effect below): the row itself, the left group, the
  // fixed chunk of the right group (SUB/DUB + quality), and the two buttons
  // that always cap its right end (⋯ + fullscreen).
  const rowRef = useRef<HTMLDivElement>(null);
  const leftGroupRef = useRef<HTMLDivElement>(null);
  const fixedRightRef = useRef<HTMLDivElement>(null);
  const fullscreenBtnRef = useRef<HTMLButtonElement>(null);

  // Stream state
  const [sources, setSources] = useState<StreamSource[]>([]);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [streamHeaders, setStreamHeaders] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [streamError, setStreamError] = useState(false);
  /**
   * `/api/stream`'s own `data.error`, captured whenever a lookup answers with
   * no sources — the server knows better than any local fallback whether this
   * was "providers have nothing" versus a transport failure. Stays `null` for
   * playback-side failures (dead manifest, exhausted source pool), which keep
   * the generic copy. Rendered by `EmptyState` instead of it, only when set.
   */
  const [streamErrorDetail, setStreamErrorDetail] = useState<string | null>(null);
  /**
   * Scratch slot for the same string while a load window is in progress.
   * Probes that run *after* a successful load also report `data.error` for the
   * servers that missed, and materialising those would leave the card quoting a
   * reason from a success. So probes only write the ref; the three API-driven
   * failure sites below turn it into `streamErrorDetail`, and every load window
   * starts by clearing both.
   */
  const lastApiErrorRef = useRef<string | null>(null);
  // Manual provider override — set when the user picks a provider after a failure
  const [providerOverride, setProviderOverride] = useState<string | null>(null);
  const activeProvider = providerOverride ?? providerId;
  // Slow-load hint: armed at ~11s while the lookup is still running. Nothing
  // resets it here — every site that *opens* a loading window clears the flag
  // first, so a stale hint can never paint at the start of the next one.
  const [slowLoad, setSlowLoad] = useState(false);
  // ─── Mount-only stream handoff note ─────────────────────
  // Set while the mount handoff (see the bottom of the mount effect below)
  // is walking a lower candidate: "Episode 57 isn't available yet — playing
  // episode 56." Rendered inside the loading overlay, so it disappears the
  // moment playback starts (the overlay, and the note with it, unmount when
  // `loading` flips false) and can never stack on the error overlay, which
  // owns its own reason line on exhaustion. Every user-driven load window
  // (loadByType, the mount effect's own re-runs) clears it first.
  const [handoffNote, setHandoffNote] = useState<{ from: number; to: number } | null>(null);
  // One-shot arming for the handoff above: TRUE only for the FIRST stream
  // lookup this Player instance ever runs (the initial load of a watch URL).
  // Every later lookup — the provider-override re-run of the mount effect,
  // Retry / Try Dub / server switches via loadByType — is user-driven and
  // must show the normal error state instead of silently swapping episodes.
  // The mount chain retires the flag when it actually settles (success
  // included: a stream that PLAYED means there was nothing to hand off, and
  // a subsequent user-driven failure must not resurrect the behaviour); a
  // superseded run leaves it armed for its successor, and loadByType
  // additionally consumes it on entry.
  const mountLookupArmedRef = useRef(true);

  // ─── Slow-load hint ─────────────────────────────────────
  // One timer per loading window; the window closing tears it down.
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setSlowLoad(true), 11_000);
    return () => clearTimeout(t);
  }, [loading]);

  // Playback state
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  // Seeded from the document, not from `false`: a fresh page load can never be
  // fullscreen (both server and client render false → hydration matches), but
  // a *remount* mid-navigation must come back in cinematic shape on its very
  // first paint — otherwise a fullscreened <html> would flash the whole page
  // before this state caught up. The listener below keeps it live afterwards.
  // Both spellings, like every other fullscreen read in this file: on the
  // prefixed-only builds the guards below still cover, `fullscreenElement`
  // alone reads undefined and a surviving fullscreen would seed `false` —
  // with no change event left to fire, the player would paint windowed
  // inside a fullscreen page and never recover.
  const [isFullscreen, setIsFullscreen] = useState(() => {
    if (typeof document === "undefined") return false;
    const doc = document as any;
    return !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  });
  const isFullscreenRef = useRef(isFullscreen);
  isFullscreenRef.current = isFullscreen;
  const [showControls, setShowControls] = useState(true);
  // Seekbar buffer read-out — % ranges sampled from video.buffered (drawn as
  // a lighter segment under the input's translucent tail) plus a "starved"
  // flag driven purely by the media events (waiting/stalled vs playing/
  // canplay), so the pulse only shows while the browser is actually fetching
  // — never during normal playback.
  const [bufferedRanges, setBufferedRanges] = useState<{ start: number; end: number }[]>([]);
  const [isBuffering, setIsBuffering] = useState(false);
  const bufferedKeyRef = useRef("");

  // Audio type (sub / dub)
  const [audioType, setAudioType] = useState<"sub" | "dub">("sub");
  // ─── Dub availability — data first, probe last ──────────────────────
  // The episode's own `hasDub`, derived — never written during render or
  // from an effect body: the server prop when it's known, otherwise the
  // value the effect below fetched from the SAME `/api/episodes` endpoint
  // the episode list uses, so the answer comes from the provider's flags /
  // the shared megaplay probe instead of from a guess. The fetched value is
  // keyed by episode, so a slow answer for the previous episode can never
  // describe the current one (a key mismatch simply reads as "unknown").
  const [fetchedDub, setFetchedDub] = useState<{ key: string; value: boolean } | null>(null);
  // Legacy fallback only: did ANY server answer a `type=dub` stream request?
  // Consulted exclusively while the flag is still unknown (titles the shared
  // probe can't cover — e.g. >60 episodes with no per-episode flags).
  const [dubProbeOk, setDubProbeOk] = useState(false);
  const dubFlag: boolean | null =
    episodeHasDub ??
    (fetchedDub && fetchedDub.key === `${anilistId}:${episodeNumber}` ? fetchedDub.value : null);
  const dubKnown = dubFlag !== null;
  /** DUB may be switched to — a known "no dub" beats any probe result. */
  const dubEnabled = dubKnown ? dubFlag === true : dubProbeOk;
  /** The SUB/DUB control renders whenever we have ANY answer (yes *or* no). */
  const showAudioToggle = dubKnown || dubProbeOk;

  // Resolve a missing server flag once per episode, non-blocking: the toggle
  // simply appears the moment the API answers. `audio=1` asks the route to
  // run its (cached, ≤8s-budgeted) megaplay probe; a `null` back means the
  // flags are unknowable for this title and the legacy probe below decides.
  useEffect(() => {
    if (episodeHasDub !== null && episodeHasDub !== undefined) return;
    if (!anilistId) return;
    let cancelled = false;
    // Fresh cache first — the SAME `?audio=1` answer either this tab's detail
    // page or a previous episode hop already paid for. A hit skips the
    // network entirely; it can also answer the episode outright (the
    // per-episode map, or `dubCount === 0`, which rules a dub out for EVERY
    // listed episode), and when it can't say anything episode-specific it
    // simply leaves the flag unknown — the stream-level probe below still
    // decides the toggle, so nothing is guessed here.
    const cached = readAudioFlagsCache(anilistId);
    if (cached) {
      // Counts first: they are megaplay-VERIFIED for every listed episode,
      // while a probe-written map entry can be hearsay (until the route
      // honours `strict`, a stage-2 answer can hand a `type=dub` probe SUB
      // sources — a false "has dub"). Verified data beats probe data.
      const fromMap = cached.dubByEpisode?.[String(episodeNumber)];
      const answer =
        cached.dubCount === 0
          ? false
          : typeof fromMap === "boolean"
            ? fromMap
            : null;
      if (answer !== null) {
        // Deferred a tick — a setState straight from the effect body is a
        // cascading render (the same reasoning as the episode list's deferred
        // probe): behaviour is identical, the flag simply lands one microtask
        // after mount instead of inside the effect itself.
        queueMicrotask(() => {
          if (!cancelled) setFetchedDub({ key: `${anilistId}:${episodeNumber}`, value: answer });
        });
        return;
      }
      return; // fresh but not episode-specific — the stream probe answers
    }
    (async () => {
      try {
        const params = new URLSearchParams({
          title: animeTitle,
          id: String(anilistId),
          audio: "1",
        });
        const res = await fetch(`/api/episodes?${params}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const listed: { number?: number; hasDub?: boolean | null }[] | undefined = data?.episodes;
        const audio:
          | { subCount?: number | null; dubCount?: number | null; subOfTotal?: number; dubOfTotal?: number }
          | undefined = data?.audio;
        // Write what this answer learned — counts plus the per-episode map —
        // so the NEXT navigation (detail → watch, watch → watch) can take
        // the branch above instead of refiring an identical URL. Only
        // definitive booleans enter the map; `null` means unknown, never no.
        if (Array.isArray(listed) || audio) {
          const dubByEpisode: Record<string, boolean> = {};
          if (Array.isArray(listed)) {
            for (const e of listed) {
              if (typeof e?.number === "number" && typeof e?.hasDub === "boolean") {
                dubByEpisode[String(e.number)] = e.hasDub;
              }
            }
          }
          mergeAudioFlagsCache(anilistId, {
            subCount: typeof audio?.subCount === "number" ? audio.subCount : null,
            dubCount: typeof audio?.dubCount === "number" ? audio.dubCount : null,
            // Optional Lane A fields — forwarded verbatim when present,
            // silently absent when not (old count-only shape tolerated).
            ...(typeof audio?.subOfTotal === "number" ? { subOfTotal: audio.subOfTotal } : {}),
            ...(typeof audio?.dubOfTotal === "number" ? { dubOfTotal: audio.dubOfTotal } : {}),
            dubByEpisode,
          });
        }
        const ep = Array.isArray(listed) ? listed.find((e) => e.number === episodeNumber) : null;
        if (!cancelled && typeof ep?.hasDub === "boolean") {
          setFetchedDub({ key: `${anilistId}:${episodeNumber}`, value: ep.hasDub });
        }
      } catch {
        /* network hiccup — stay unknown, the stream probe still answers */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [episodeHasDub, anilistId, animeTitle, episodeNumber]);

  // Server / session state
  const [activeServer, setActiveServer] = useState<string | null>(null);
  const [availableServers, setAvailableServers] = useState<string[]>([]);

  // Quality / speed state
  const [currentQuality, setCurrentQuality] = useState<string>("auto");
  const [hlsLevels, setHlsLevels] = useState<{ index: number; height: number; name: string }[]>([]);
  const [playbackRate, setPlaybackRate] = useState(1);
  // ─── Row popovers — ONE slot for all seven (quality + the six pickers) ──
  // `null` = nothing open. A single slot is what makes mutual exclusion free:
  // opening one popover closes whatever was open, the ⋯ menu and this slot
  // clear each other (see the ⋯ trigger and `togglePicker`), and Escape /
  // click-outside only ever have one thing to test.
  const [openPicker, setOpenPicker] = useState<MoreSection | "quality" | null>(null);
  // Geometry for the open popover — measured against the player container the
  // moment it opens (`togglePicker`) and refreshed by the fit effect's
  // ResizeObserver, so the panel is always clamped to the room that actually
  // exists on THIS player: portrait fullscreen phone or short windowed box.
  const [pickerAnchor, setPickerAnchor] = useState<PickerAnchor | null>(null);
  // Derived read of the slot for the quality trigger + its popover — the
  // quality list keeps its identity, it just lives in the shared slot now.
  const showQualityPicker = openPicker === "quality";

  // Subtitle state
  const [activeSubtitle, setActiveSubtitle] = useState<string | null>(null);

  // Video filter state
  const [videoFilter, setVideoFilter] = useState<FilterId>("off");

  // Audio filter state (Web Audio, sibling to the video filter above)
  const [audioFilter, setAudioFilter] = useState<AudioFilterId>("off");

  // ─── Audio filter graph (Web Audio API) ────────────────────────────────
  // These presets rewire a Web Audio graph tapped off the SAME <video>
  // element (`crossOrigin="anonymous"` + the same-origin `/api/proxy` mean
  // the media-element source node taps the audio WITHOUT muting it). Three
  // facts drive the design:
  //
  //  1. LAZY BUILD. The AudioContext + graph are created on the FIRST
  //     non-`off` selection, inside the click gesture that picks it (autoplay
  //     policy), so a viewer who never touches a filter never pays for — or
  //     risks — a context. A selection restored from prefs on
  //     `loadedmetadata` may build outside a gesture, which is why the build
  //     only takes over the element's audio AFTER the context reports
  //     "running": a suspended context behind a MediaElementSource is
  //     permanent silence, so we never route the element into one.
  //  2. Creating the MediaElementAudioSourceNode is legal AT MOST ONCE per
  //     element and permanently reroutes the element's audio, so the node is
  //     created once, parked in a ref and never recreated. The graph is a
  //     FIXED fan-out: the source feeds EVERY preset branch in parallel, and
  //     each branch ends in a GainNode "gate" — switching presets only ramps
  //     the gates (one open at a time; `off` opens a straight bypass).
  //     No disconnect/reconnect of live audio, ever.
  //  3. TEARDOWN. The graph belongs to the element, and the element belongs
  //     to this Player instance (the player remounts per episode), so the
  //     context is closed in the UNMOUNT-ONLY cleanup below — deliberately
  //     NOT in the stream-load effect's cleanup (~line 1443), which also
  //     re-runs on a provider change where the element SURVIVES: closing
  //     there would strand the rerouted element on a dead context = silence.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  // Per-preset output gates — key === preset id, 1 = that branch is audible.
  // Non-null ⇔ the graph is built; publishing it is the build's last step.
  const audioGatesRef = useRef<Record<string, GainNode> | null>(null);
  // Desired preset, readable from async paths without a stale closure.
  const audioFilterRef = useRef<AudioFilterId>("off");
  // Build-in-flight latch: two rapid selections must not create two contexts.
  const audioBuildingRef = useRef(false);

  /** Open exactly one branch's gate (20ms ramp, so switching never clicks). */
  const routeAudioFilter = useCallback((id: string) => {
    const gates = audioGatesRef.current;
    const ctx = audioCtxRef.current;
    if (!gates || !ctx) return; // graph not built — the `off` path needs none
    for (const key of Object.keys(gates)) {
      const gate = gates[key];
      const target = key === id ? 1 : 0;
      try {
        const now = ctx.currentTime;
        gate.gain.cancelScheduledValues(now);
        gate.gain.setValueAtTime(gate.gain.value, now);
        gate.gain.linearRampToValueAtTime(target, now + 0.02);
      } catch {
        gate.gain.value = target;
      }
    }
  }, []);

  /**
   * Build the whole graph once: AudioContext → (one) MediaElementAudioSource
   * → a fixed fan-out of per-preset branches → destination. True once the
   * graph exists (already-built counts). Every failure path leaves the
   * element playing UNMUTED: the source node is only created after the
   * context is confirmed running, and if anything throws after that point a
   * straight-through bypass wire is re-established so audio can never go
   * silent. Wrapped so no exception can ever kill playback.
   */
  const ensureAudioGraph = useCallback(async (): Promise<boolean> => {
    if (audioGatesRef.current) return true; // already built
    if (audioBuildingRef.current) return false; // in flight — it routes for the latest ref
    const video = videoRef.current;
    if (!video) return false;
    audioBuildingRef.current = true;
    try {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        console.warn("[player] Web Audio unavailable — audio filter not applied");
        return false;
      }
      const ctx = audioCtxRef.current ?? new Ctor();
      audioCtxRef.current = ctx;
      // Autoplay policy: the context must be RUNNING before we take the
      // element's audio path. `resume()` is legal from the selecting click
      // (and from the sticky activation a play button leaves behind).
      if (ctx.state !== "running") {
        try { await ctx.resume(); } catch { /* stay suspended */ }
      }
      if (ctx.state !== "running") {
        // Filter simply won't apply — and because nothing is routed through
        // the context yet, closing it keeps playback (and the browser's
        // concurrent-context budget) exactly as it was.
        console.warn(`[player] AudioContext stayed "${ctx.state}" — audio filter not applied`);
        if (!audioSourceRef.current) {
          try { await ctx.close(); } catch { /* already closed */ }
          if (audioCtxRef.current === ctx) audioCtxRef.current = null;
        }
        return false;
      }
      // ── The source: once per element, EVER — guarded by the ref. ──
      let source = audioSourceRef.current;
      if (!source) {
        source = ctx.createMediaElementSource(video);
        audioSourceRef.current = source;
      }
      const gain = (value: number) => {
        const g = ctx.createGain();
        g.gain.value = value;
        return g;
      };
      const gates: Record<string, GainNode> = {};
      // Every branch is permanently wired source → … → destination; the GATE
      // is the only thing that ever moves.
      const wire = (node: AudioNode, id: string) => {
        const gate = gain(id === audioFilterRef.current ? 1 : 0);
        node.connect(gate);
        gate.connect(ctx.destination);
        gates[id] = gate;
      };
      // off — pure bypass: the source straight through, no processing
      wire(source, "off");
      // vocal-remove — mid-side cancellation: invert R, re-merge → L−R kills
      // the centre-panned vocal (works on OP/ED music).
      {
        const split = ctx.createChannelSplitter(2);
        const invert = gain(-1);
        const merge = ctx.createChannelMerger(2);
        source.connect(split);
        split.connect(merge, 0, 0); // L straight through
        split.connect(invert, 1);   // R inverted
        invert.connect(merge, 0, 1);
        wire(merge, "vocal-remove");
      }
      // voice-boost — one peaking band in the dialogue-clarity range
      {
        const bq = ctx.createBiquadFilter();
        bq.type = "peaking";
        bq.frequency.value = 2500;
        bq.Q.value = 1;
        bq.gain.value = 8;
        source.connect(bq);
        wire(bq, "voice-boost");
      }
      // voice-only — centre extraction (mid = (L+R)/2, duplicated to both
      // speakers) + rumble/music-bass kill + speech emphasis
      {
        const split = ctx.createChannelSplitter(2);
        const l = gain(0.5);
        const r = gain(0.5);
        const mid = gain(1); // summing bus — node inputs always sum
        const merge = ctx.createChannelMerger(2);
        source.connect(split);
        split.connect(l, 0);
        l.connect(mid); // (L+R)/2 …
        split.connect(r, 1);
        r.connect(mid);
        mid.connect(merge, 0, 0); // … duplicated to both speakers
        mid.connect(merge, 0, 1);
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 200;
        const pk = ctx.createBiquadFilter();
        pk.type = "peaking";
        pk.frequency.value = 3000;
        pk.Q.value = 1;
        pk.gain.value = 6;
        merge.connect(hp);
        hp.connect(pk);
        wire(pk, "voice-only");
      }
      // bass-boost — low shelf
      {
        const bq = ctx.createBiquadFilter();
        bq.type = "lowshelf";
        bq.frequency.value = 120;
        bq.gain.value = 8;
        source.connect(bq);
        wire(bq, "bass-boost");
      }
      // treble-boost — high shelf
      {
        const bq = ctx.createBiquadFilter();
        bq.type = "highshelf";
        bq.frequency.value = 4000;
        bq.gain.value = 6;
        source.connect(bq);
        wire(bq, "treble-boost");
      }
      // night — tame the peaks, then hand the average back (+6 dB makeup)
      {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -24;
        comp.knee.value = 30;
        comp.ratio.value = 12;
        comp.attack.value = 0.003;
        comp.release.value = 0.25;
        const makeup = gain(Math.pow(10, 6 / 20)); // +6 dB
        source.connect(comp);
        comp.connect(makeup);
        wire(makeup, "night");
      }
      // Drop any emergency bypass wire a previous failed attempt may have
      // laid, so the filtered and unfiltered signals can't sum (a no-op
      // throw when there is none — the normal case).
      try { source.disconnect(ctx.destination); } catch { /* no such wire */ }
      // Publish the graph in one shot: `routeAudioFilter` no-ops until this
      // lands, so a concurrent selection can never half-apply.
      audioGatesRef.current = gates;
      routeAudioFilter(audioFilterRef.current);
      return true;
    } catch (err) {
      console.warn("[player] audio filter graph failed — keeping unfiltered playback", err);
      if (!audioSourceRef.current) {
        // Nothing was routed: close the orphan context so repeated failures
        // can't exhaust the browser's concurrent-context budget.
        const ctx = audioCtxRef.current;
        audioCtxRef.current = null;
        if (ctx) { try { await ctx.close(); } catch { /* already closed */ } }
      } else if (!audioGatesRef.current && audioCtxRef.current) {
        // SAFETY NET: the source exists, so the element's audio only flows
        // through the graph — re-establish a straight path to the speakers
        // so playback can never be silent. Removed by the wire above on the
        // next successful build.
        try { audioSourceRef.current.connect(audioCtxRef.current.destination); } catch { /* keep playing */ }
      }
      return false;
    } finally {
      audioBuildingRef.current = false;
    }
  }, [routeAudioFilter]);

  /**
   * Select/apply an audio preset. `off` just closes every gate (and needs no
   * graph at all); the first non-`off` pick builds the graph — from the
   * selecting click, which is exactly the gesture the autoplay policy wants.
   */
  const applyAudioFilter = useCallback((id: AudioFilterId) => {
    audioFilterRef.current = id;
    if (audioGatesRef.current) routeAudioFilter(id);
    else if (id !== "off") void ensureAudioGraph();
  }, [routeAudioFilter, ensureAudioGraph]);

  // Applying is an effect of the STATE, not just of the click, so a value
  // restored from prefs on `loadedmetadata` is honoured too. The build is
  // safe off-gesture by construction (see ensureAudioGraph: it only takes
  // the element's audio path once the context is running).
  useEffect(() => {
    applyAudioFilter(audioFilter);
  }, [audioFilter, applyAudioFilter]);

  // ─── Audio teardown — UNMOUNT ONLY ────────────────────────────────
  // Browsers cap concurrent AudioContexts and the player remounts per
  // episode, so leaking one per episode is a real bug. Deliberately its own
  // []-deps effect: the stream-load cleanup at ~line 1443 also re-runs on a
  // PROVIDER change, where the video element survives — closing the context
  // there would strand the element's rerouted audio on a dead graph.
  useEffect(() => {
    return () => {
      const ctx = audioCtxRef.current;
      audioCtxRef.current = null;
      audioSourceRef.current = null;
      audioGatesRef.current = null;
      audioFilterRef.current = "off";
      if (ctx) {
        try { void ctx.close(); } catch { /* already closed */ }
      }
    };
  }, []);


  // "More" (⋯) overflow menu — the always-present home for every control the
  // row can't carry at this width: whatever the icon toolbar's fit dropped,
  // the SUB/DUB copy below lg, and the toggles (auto play, auto skip, FX).
  // One open flag + one section flag: `null` = root list, otherwise the
  // sub-page (provider / speed / …) inside the same popup. The row's picker
  // icons do NOT come here — each opens its own anchored popover on the row
  // over the SAME list component (`togglePicker` below); this menu stays the
  // overflow home, and the two surfaces exclude each other.
  const [showMore, setShowMore] = useState(false);
  const [moreSection, setMoreSection] = useState<MoreSection | null>(null);
  // SHAPE modifier for the ⋯ menu, not a different shape: the popup is
  // right-anchored at every width (see `moreMenuAnchor` below), and below
  // 640px — the same breakpoint the controls use to switch to touch-sized
  // buttons — it only keeps a 36px floor on the root list's own rows
  // (`[&>button]:min-h-9`; the drill panel is unfloored = desktop-density
  // 28px options) and the width/height cap shared with the desktop popup.
  // Read post-mount so the first render still matches the SSR output (the
  // menu starts closed, so there is nothing to flash).
  const [isCompact, setIsCompact] = useState(false);
  // Mirror for the controls auto-hide timer ([]-deps effects read this):
  // while EITHER overlay surface is open — the ⋯ menu or a row popover —
  // the bar must not fade out from under it. The picker id rides along so
  // the fit effect's re-measure knows which popover to re-clamp.
  const surfaceOpenRef = useRef<{ more: boolean; picker: MoreSection | "quality" | null }>({
    more: false,
    picker: null,
  });
  surfaceOpenRef.current = { more: showMore, picker: openPicker };
  // Single way to dismiss the ⋯ menu (outside click, Escape, picking an
  // option) — always drops back to the root list for the next open.
  const closeMore = useCallback(() => {
    setShowMore(false);
    setMoreSection(null);
  }, []);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639.98px)");
    const sync = () => setIsCompact(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // ─── Row popovers — open, toggle-close, and live re-clamping ───────────
  // Every picker icon on the row opens its OWN popover anchored at that icon
  // — the popup language quality has always used, now generalised — and the
  // list inside is `PickerContent`, the exact component the ⋯ menu drills
  // into, so each picker's list UI still exists exactly once.
  //
  // Semantics mirror the quality list: click the open icon again → close;
  // click a different picker (or quality, or ⋯) → that one wins; click
  // outside or Escape → everything closes. One `openPicker` slot carries all
  // seven, so exclusion is a single state write everywhere.
  const togglePicker = (id: MoreSection | "quality", trigger: HTMLElement) => {
    if (openPicker === id) {
      setOpenPicker(null); // the SAME icon again is the close gesture
      return;
    }
    setOpenPicker(id);
    // Measure now, while the trigger is where the user just clicked it: side
    // + hard caps for this player's current geometry (see computePickerAnchor).
    setPickerAnchor(
      computePickerAnchor(
        containerRef.current,
        trigger,
        id === "quality" ? QUALITY_POPOVER_W : PICKER_POPOVER_W
      )
    );
    // Mutual exclusion both ways: opening a popover drops the ⋯ menu, and
    // never open one on a bar that's about to fade.
    closeMore();
    setShowControls(true);
  };

  // Re-measure the open popover (fullscreen toggle, window resize, the fit
  // effect's ResizeObserver) — equality-guarded, so an unchanged measurement
  // can't feed a re-render back into the observer.
  const refreshPickerAnchor = useCallback(() => {
    const id = surfaceOpenRef.current.picker;
    if (id === null) return;
    const wrap = id === "quality" ? qualityWrapRef.current : pickerWrapRefs.current[id];
    const trigger = (wrap?.firstElementChild as HTMLElement | null) ?? wrap;
    if (!trigger) return;
    const next = computePickerAnchor(
      containerRef.current,
      trigger,
      id === "quality" ? QUALITY_POPOVER_W : PICKER_POPOVER_W
    );
    setPickerAnchor((prev) =>
      prev && prev.side === next.side && prev.maxW === next.maxW && prev.maxH === next.maxH
        ? prev
        : next
    );
  }, []);

  // ─── Icon toolbar fit — highest-priority icons that actually fit ───────
  // `rowIconCount` is how many entries of ROW_ICON_PRIORITY get to render as
  // icon-only buttons on the control row; the rest of that priority list
  // stays in the ⋯ menu (always present), so the row NEVER wraps, scrolls or
  // overflows. Starts at 0 — the first client measurement lands right after
  // mount and fills it in, so SSR and hydration always agree.
  //
  // The mechanism is measurement, not breakpoints: one ResizeObserver on the
  // four width consumers (row, left group, fixed right chunk, ⋯ + fullscreen
  // buttons) recomputes the leftover width whenever ANY of them changes —
  // windowed↔fullscreen, a window resize, the duration read-out gaining a
  // digit, or the volume slider expanding on hover all arrive as plain width
  // changes. The arithmetic can't feed back on itself: the row is `w-full`
  // and the left group's width never depends on the icons, so the count only
  // ever settles on a new integer (setRowIconCount no-ops when unchanged) —
  // no thrash, no loop. Windowed fullscreening the <html> element changes
  // the row's width, which the observer sees; the fullscreen BUTTON appearing
  // is covered by the `isFullscreen` dep re-running the setup.
  const [rowIconCount, setRowIconCount] = useState(0);
  useEffect(() => {
    const measure = () => {
      const row = rowRef.current;
      const left = leftGroupRef.current;
      const fixed = fixedRightRef.current;
      const more = moreBtnRef.current;
      const fs = fullscreenBtnRef.current;
      if (!row || !left || !fixed || !more) return;
      const rowW = row.getBoundingClientRect().width;
      if (rowW <= 0) return;
      // Server has no icon when there is no server to pick.
      const candidates = ROW_ICON_PRIORITY.filter(
        (id) => id !== "server" || availableServers.length > 0
      ).length;
      const iconBtnW = isCompact ? 36 : 32; // w-9 → sm:w-8, the ⋯ button's own widths
      const gap = 6; // gap-1.5, the right group's internal gap
      const rowGap = isCompact ? 8 : 24; // gap-2 → sm:gap-6, left↔right group
      const children = 3 + (fs ? 1 : 0); // fixed chunk, icons, ⋯, [fullscreen]
      const slack = 8; // breathing room — when in doubt, an icon drops out
      const avail =
        rowW -
        left.getBoundingClientRect().width -
        fixed.getBoundingClientRect().width -
        more.getBoundingClientRect().width -
        (fs ? fs.getBoundingClientRect().width : 0) -
        rowGap -
        gap * children - // budgeted one gap MORE than the real gaps
        slack;
      const n = Math.max(0, Math.min(candidates, Math.floor(avail / (iconBtnW + gap))));
      setRowIconCount((prev) => (prev === n ? prev : n));
      // A fit change that drops the OPEN popover's own icon closes it: its
      // trigger just unmounted, so the panel has nothing to hang from — and
      // the auto-hide must not stay suppressed by an invisible surface.
      // (Quality can't drop; it is fixed on the row at every width.)
      const openId = surfaceOpenRef.current.picker;
      if (openId !== null && openId !== "quality") {
        const idx = ROW_ICON_PRIORITY.indexOf(openId);
        const gone = idx < 0 || idx >= n || (openId === "server" && availableServers.length === 0);
        if (gone) setOpenPicker(null);
      }
      // While a row popover is open, this same width change may have moved
      // its trigger (fullscreen toggle, window resize) — re-clamp the panel
      // to the new room so it can't go stale and cross the player's frame.
      refreshPickerAnchor();
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [rowRef.current, leftGroupRef.current, fixedRightRef.current, moreBtnRef.current, fullscreenBtnRef.current]) {
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
  }, [isCompact, isFullscreen, availableServers.length, refreshPickerAnchor]);

  // Episode drawer — Netflix-style panel sliding in from the right, over the
  // video. Two flags: `drawerOpen` marks it open (or in its exit transition),
  // `drawerIn` drives the translate. The panel itself stays mounted whenever
  // there is anything to show — closed it sits `translate-x-full` behind
  // `pointer-events-none` + `inert` (unclickable, out of the tab order and
  // out of the a11y tree) — which lets the franchise dropdown docked at its
  // top ship in the initial HTML instead of materialising only after the
  // first fullscreen tap.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerIn, setDrawerIn] = useState(false);
  const drawerCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The slide-in is two chained animation frames; this holds whichever frame
  // is still pending so `closeDrawer` can cancel it. Without that, a close
  // landing inside the two-frame window (Escape right after the handle,
  // fullscreen dropping out from under the open) would be *undone* by the
  // late `setDrawerIn(true)` — stranding a fully on-screen drawer that is
  // simultaneously `inert` + pointer-events-none: visible, and dead.
  const drawerSlideRafRef = useRef<number | null>(null);
  const drawerCurrentRef = useRef<HTMLButtonElement>(null); // row to scroll into view
  const drawerListRef = useRef<HTMLDivElement>(null); // list scrolled to that row

  // Franchise / season dropdown — docked at the top of the drawer, above the
  // episode list. One open flag; the trigger's wrapper is the "inside" test
  // for the shared outside-click closer, and `franchiseOpenRef` mirrors the
  // flag for the []-deps keyboard handler (its Escape must drop the dropdown
  // first, only then the drawer).
  const [franchiseOpen, setFranchiseOpen] = useState(false);
  const franchiseOpenRef = useRef(franchiseOpen);
  franchiseOpenRef.current = franchiseOpen;
  const franchiseWrapRef = useRef<HTMLDivElement>(null);
  // Set on pointerdown on the drawer's scrim: was the franchise dropdown open
  // at that moment? The scrim then drops the dropdown only (its own click),
  // so one tap per layer — exactly how Escape unwinds it.
  const franchiseOnScrimRef = useRef(false);
  // The drawer exists whenever EITHER list does — episodes alone, a franchise
  // with nothing to page, or both.
  const hasEpisodeList = (episodes?.length ?? 0) > 0;
  const hasFranchise = (franchise?.length ?? 0) > 1;
  const hasDrawer = hasEpisodeList || hasFranchise;
  const currentFranchise = franchise?.find((entry) => entry.current);
  // Series dropdown order — the SAME persisted mode the watch page's
  // `// Franchise` grid uses (`useFranchiseSort`'s store notifies both), so
  // flipping Default/Time/Type up there re-orders this list live too.
  const [franchiseSort] = useFranchiseSort();
  const franchiseGroups = useMemo(
    () => (franchise ? franchiseSortGroups(franchise, franchiseSort) : []),
    [franchise, franchiseSort]
  );

  // ─── Series/episode switch overlay ───────────────────────────────
  // Armed by `beginSwitch` on the clicking instance, and re-armed from the
  // sessionStorage handoff on the *next* instance (the route change remounts
  // this whole subtree). Dismissal tracks the real load: `loading` flips false
  // when the attempt reports ready (MANIFEST_PARSED / loadedmetadata) or when
  // the error overlay takes over — never on a fixed delay.
  const [switchTo, setSwitchTo] = useState<SwitchHandoff | null>(null);
  const [switchFade, setSwitchFade] = useState(false);
  // Rule 1 — the full-screen "// LOADING EPISODE_" title card is a FULLSCREEN
  // affordance only. In windowed playback it made an already-slow switch feel
  // slower, so the card renders only while the player is actually fullscreen.
  // `isFullscreen` is the real Fullscreen API state (synced from
  // `fullscreenchange` below — not the optimistic value set at request time),
  // so this tracks the truth. Windowed switches fall back to the lighter plain
  // loading overlay (the terminal progress bar) — see its `!switchCardVisible`
  // gate below — which reuses existing markup and doesn't dominate the frame.
  const switchCardVisible = !!(switchTo && isFullscreen);

  // Mount: adopt the handoff the outgoing instance stashed (if this mount was
  // caused by a switch) and make sure fullscreen came through with us.
  useEffect(() => {
    const h = readSwitchHandoff();
    if (!h) return;
    clearSwitchHandoff();
    setSwitchFade(false);
    setSwitchTo(h);

    // Fullscreen intent. With <html> as the fullscreen element (see
    // `toggleFullscreen`) nothing in the route change *can* drop it — but if
    // this browser refused to fullscreen <html> in the first place (or the
    // platform dropped it anyway), ask again right now: this effect still
    // runs inside the click's transient-activation window, which is exactly
    // what Chrome/Safari check. A rejection arms one gesture-based retry.
    // The `standard || webkit` probe again: reading only `fullscreenElement`
    // on a prefixed-only build reports "dropped" when it never was, and we
    // would ask for a fullscreen we already have (denied → stray retry arm).
    const fsDoc = document as any;
    if (h.fs && (fsDoc.fullscreenElement || fsDoc.webkitFullscreenElement) == null) {
      const el = document.documentElement as any;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) {
        try {
          const p = req.call(el);
          if (p && typeof p.catch === "function") p.catch(() => armFullscreenRetry());
        } catch {
          armFullscreenRetry();
        }
      } else {
        armFullscreenRetry();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dismissal: stay up while `loading` is true (real fetch + manifest), then
  // hold at least SWITCH_MIN_MS from the click so an instant load fades
  // instead of flashing, then fade out over 320ms. Never a fixed delay.
  //
  // Rule 2 — never stack the switch card on the no-stream error: when an
  // episode resolves to no stream, `streamError` flips true and the
  // NO_STREAM_FOUND empty state renders (on `streamError && !loading`). If the
  // switch card were still up it would paint over that error, so the FIRST
  // branch below tears it down IMMEDIATELY — no SWITCH_MIN_MS hold, no fade —
  // and the error UI renders clean. (Folded into this effect, not a second
  // one, so the set-state-in-effect lint count stays at the 29e baseline.)
  useEffect(() => {
    if (!switchTo) {
      setSwitchFade(false);
      return;
    }
    if (streamError) {
      // No stream for this episode — drop the card now, cleanly.
      setSwitchFade(false);
      setSwitchTo(null);
      return;
    }
    if (loading) return; // still loading — re-run when `loading` flips
    const holdLeft = Math.max(0, switchTo.t + SWITCH_MIN_MS - Date.now());
    const fadeTimer = setTimeout(() => setSwitchFade(true), holdLeft);
    const dropTimer = setTimeout(() => setSwitchTo(null), holdLeft + 320);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(dropTimer);
    };
  }, [switchTo, loading, streamError]);

  /**
   * Start a switch from inside the player: arm the overlay on THIS instance
   * (so it covers the RSC fetch too) and stash the handoff for the next one.
   * Fullscreen is not touched here — it lives on <html> and survives.
   */
  const beginSwitch = useCallback(
    (next: { kind: "episode" | "series"; series?: string; episode: number; epTitle?: string }) => {
      const handoff: SwitchHandoff = {
        t: Date.now(),
        fs: isFullscreenRef.current,
        kind: next.kind,
        series: next.series ?? animeTitle,
        episode: next.episode,
        epTitle: next.epTitle,
      };
      writeSwitchHandoff(handoff);
      setSwitchFade(false);
      setSwitchTo(handoff);
    },
    [animeTitle]
  );

  // Auto-play next episode
  const [autoPlayNext, setAutoPlayNext] = useState(false);
  // Next-episode countdown (Netflix-style overlay) — set to 10 when the
  // episode ends with auto-play armed, ticks to 0, then navigates.
  // With auto-play ON the countdown is never armed at all (see onEnded).
  const [countdown, setCountdown] = useState<number | null>(null);
  // Latch for the instant auto-advance: `ended` must produce AT MOST one
  // navigation. Auto-skip-outro seeks to the segment end, which can land on
  // the very last frame and fire `ended` in the same breath as the natural
  // end of the file — one flag makes a second advance structurally impossible.
  const autoAdvancedRef = useRef(false);

  // Skip intro / outro — from AniSkip per-episode timestamps
  const [introSegment, setIntroSegment] = useState<{ start: number; end: number } | null>(null);
  const [outroSegment, setOutroSegment] = useState<{ start: number; end: number } | null>(null);
  const [autoSkipEnabled, setAutoSkipEnabled] = useState(false);

  // Subtitle timing offset (seconds)
  const [subtitleOffset, setSubtitleOffset] = useState(0);
  // Subtitle size: "small" | "medium" | "large"
  const [subtitleSize, setSubtitleSize] = useState<"small" | "medium" | "large">("medium");

  // OpenSubtitles state
  const [osResults, setOsResults] = useState<
    { file_id: number; language: string; release: string; hearing_impaired: boolean; ai_translated: boolean }[]
  >([]);
  const [osLoading, setOsLoading] = useState(false);
  const [osError, setOsError] = useState<string | null>(null);
  const [osSearched, setOsSearched] = useState(false);
  const [osPage, setOsPage] = useState(1);
  const [osFilterQuery, setOsFilterQuery] = useState("");
  const [activeOSSubtitleId, setActiveOSSubtitleId] = useState<number | null>(null);
  const [osDownloadError, setOsDownloadError] = useState<string | null>(null);
  const failedOSIdsRef = useRef(new Set<number>()); // track failed downloads

  // Refs for keyboard handler and callbacks (stable across renders)
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const showControlsRef = useRef(showControls);
  showControlsRef.current = showControls;
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;
  const spaceDownRef = useRef(0);
  const spaceWasPlayingRef = useRef(false);
  /**
   * Which skip segments the PROVIDER itself supplied, per segment.
   * A boolean was wrong: `/api/stream` answers intro and outro independently
   * (anikoto regularly returns an outro with no intro — measured on
   * 199448/ep1, `intro: null, outro: {1468→1544}`), and the old single flag
   * meant a provider that only knew the OUTRO permanently discarded the
   * INTRO AniSkip had. Track them separately so each side is only suppressed
   * when the provider actually had an answer for it.
   */
  const providerSkipRef = useRef({ intro: false, outro: false });
  /**
   * Current per-anime prefs key, refreshed every render so long-lived
   * callbacks (loadHls's MANIFEST_PARSED, whose deps deliberately exclude
   * animeTitle/anilistId) can read the right bucket without capturing a
   * stale id.
   */
  const prefsKeyRef = useRef(prefsKeyFor(anilistId, animeTitle));
  prefsKeyRef.current = prefsKeyFor(anilistId, animeTitle);
  /**
   * `loadedmetadata` can fire again when a stream is re-attached (server
   * failover, retry), and re-hydrating then would stomp a setting the viewer
   * just changed mid-episode. Hydrate the per-anime settings exactly once per
   * episode, alongside the countdown reset below.
   */
  const prefsHydratedRef = useRef(false);
  /**
   * The persistence effect must not fire on mount — at that point state is
   * still the defaults, and writing them would clobber the stored prefs the
   * hydration effect is about to read. Skip the first run only.
   */
  const prefsSkipFirstWriteRef = useRef(true);
  /**
   * Saved quality name, parked until MANIFEST_PARSED hands us the stream's
   * real levels — "1080p" means nothing before they're known, and if this
   * stream has no such level the picker falls back to auto.
   */
  const pendingQualityRef = useRef<string | null>(null);

  /**
   * Per-anime PROVIDER override — the one per-anime field that hydrates at
   * MOUNT, not at loadedmetadata: the stream-load effect starts as soon as
   * the page renders, so the stored override must be in state before that
   * first load (or at worst one aborted fetch after it). One-shot per show
   * key; the write side sits just below. Show B never sees Show A's value —
   * the key is per-anime, so a show without a stored override simply starts
   * from the page's `providerId` prop.
   */
  const providerHydratedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = prefsKeyRef.current;
    if (providerHydratedKeyRef.current === key) return;
    providerHydratedKeyRef.current = key;
    const stored = readPrefsByKey(key)?.providerId;
    // `null` (the mount default) is also the "use the page default" value,
    // so writing it back is a no-op bail in React when nothing is stored.
    setProviderOverride(typeof stored === "string" && stored ? stored : null);
  }, [anilistId, animeTitle]);

  // Write side: any non-null override the viewer lands on (control-bar
  // dropdown, error overlay) becomes this show's stored value. Hydration
  // re-triggering this with the value it just read is skipped, so a reload
  // doesn't bump the bucket's timestamp.
  useEffect(() => {
    if (!providerOverride) return;
    if (readPrefsByKey(prefsKeyRef.current)?.providerId === providerOverride) return;
    writePrefsByKey(prefsKeyRef.current, { providerId: providerOverride });
  }, [providerOverride]);

  // ─── Playback progress persistence ────────────────────
  const storageKey = useMemo(
    () => `n54tv-progress-${anilistId || animeTitle}-${episodeNumber}`,
    [anilistId, animeTitle, episodeNumber]
  );

  const saveProgress = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.duration < 1) return;
    // Don't save if within 5s of end — treat as finished
    if (video.duration - video.currentTime < 5) {
      try { localStorage.removeItem(storageKey); } catch {}
      return;
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        time: video.currentTime,
        volume: video.volume,
        speed: video.playbackRate,
        muted: video.muted,
        subtitle: activeSubtitle,
        subtitleOffset,
        subtitleSize,
        autoSkip: autoSkipEnabled,
        autoPlayNext,
        audioType,
        videoFilter,
        ts: Date.now(),
      }));
    } catch {}
  }, [storageKey, activeSubtitle, subtitleOffset, subtitleSize, autoSkipEnabled, autoPlayNext, audioType, videoFilter]);

  const restoreProgress = useCallback(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const data = JSON.parse(raw);
      // Expire after 30 days
      if (data.ts && Date.now() - data.ts > 30 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem(storageKey);
        return null;
      }
      return data;
    } catch { return null; }
  }, [storageKey]);

  // Derived
  const availableQualities = useMemo(
    () => hlsLevels.length > 0
      ? ["auto", ...hlsLevels.map((l) => l.name)]
      : Array.from(new Set(sources.map((s) => s.quality).filter(Boolean))),
    [hlsLevels, sources]
  );
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  /* A skip window is only usable if it actually fits the real episode.
   * Neither source is validated against the length before it reaches state —
   * `providers.ts` only requires `end > start` — so a window from a wrong
   * scale, a truncated stream or a stale guess sails straight through: the
   * chip then sits on screen the whole time, or "Skip" jumps to a timestamp
   * past the end of the video. AniSkip had no data at all for 187402/ep3, yet
   * a chip still appeared, driven by an unvalidated provider window. `duration`
   * is 0 until `loadedmetadata`, so this stays false until the real length is
   * known — which is also what already kept the chips hidden on load. */
  const skipWindowFits = (s: { start: number; end: number } | null): s is { start: number; end: number } =>
    !!s && s.start >= 0 && s.end > s.start && duration > 0 && s.end <= duration;
  const inIntro = skipWindowFits(introSegment) && currentTime >= introSegment.start && currentTime < introSegment.end;
  const inOutro = skipWindowFits(outroSegment) && currentTime >= outroSegment.start && currentTime < outroSegment.end;
  // Speed picker options: presets plus the current rate when it came from a
  // ±0.25 keyboard step, so the active rate is always highlighted
  const speedOptions = useMemo(() => {
    const opts = new Set(SPEED_PRESETS);
    opts.add(playbackRate);
    return [...opts].sort((a, b) => a - b);
  }, [playbackRate]);
  // Prev/next episode targets for the control bar (prev never goes below EP 1)
  const prevEpisodeTarget = episodeNumber > 1 && anilistId ? episodeNumber - 1 : null;
  const nextEpisodeTarget = nextEpisodeNumber && anilistId ? nextEpisodeNumber : null;
  // Title of that next episode, for the countdown card
  const nextEpisodeTitle = nextEpisodeTarget
    ? episodes?.find((ep) => ep.number === nextEpisodeTarget)?.title
    : undefined;

  // ─── Attempt watchdog ────────────────────────────────────
  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  // ─── Destroy HLS ────────────────────────────────────────
  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    // A torn-down instance can never report progress again — retire its
    // attempt so its watchdog/handlers can't fire against a newer load.
    clearWatchdog();
    attemptStateRef.current = "idle";
    failAttemptRef.current = null;
  }, [clearWatchdog]);

  // The running attempt produced a usable stream: dismiss the loading bar
  // here (HLS: MANIFEST_PARSED, progressive: loadedmetadata).
  const markAttemptReady = useCallback(() => {
    if (attemptStateRef.current !== "pending") return;
    clearWatchdog();
    attemptStateRef.current = "ready";
    setStreamError(false);
    setLoading(false);
  }, [clearWatchdog]);

  // ─── Load HLS stream ────────────────────────────────────
  const loadHls = useCallback(
    (srcs: StreamSource[], headers: Record<string, string> | null, autoPlay: boolean) => {
      const video = videoRef.current;
      if (!video) {
        // Nothing to attach media to — surface the error instead of hanging.
        setLoading(false);
        setStreamError(true);
        return;
      }

      destroyHls(); // also retires any previous attempt (watchdog + handlers)
      triedUrlsRef.current = new Set();

      // Restrict to sources the browser can actually play (.mpd/DASH is excluded)
      const playable = srcs.filter(isPlayableSource);
      if (playable.length === 0) {
        setLoading(false);
        setStreamError(true);
        return;
      }

      // Pick the source matching selected quality, or fallback
      const pick = (pool: StreamSource[]): StreamSource | undefined =>
        pool.find((s) => s.quality === currentQualityRef.current) ||
        pool.find((s) => s.quality === "1080p") ||
        pool.find((s) => s.quality === "720p") ||
        pool.find((s) => s.quality === "480p") ||
        pool.find((s) => s.isM3U8 && Hls.isSupported()) ||
        pool[0];

      // ── Attempt lifecycle ──────────────────────────────────────────
      // Each selected source is one bounded "attempt":
      //   • fatal NETWORK_ERROR → startLoad() at most 2×, then fail attempt
      //   • fatal MEDIA_ERROR   → recoverMediaError() at most 2×, then fail attempt
      //   • any other fatal     → fail attempt immediately
      //   • watchdog (15s)      → fail attempt if the stream never becomes ready
      // Failing = destroyHls → next untried source; when the pool is exhausted
      // → setStreamError(true) (the failover effect then rotates servers, or
      // the error overlay renders). No recovery path is unbounded any more.
      const tryLoad = (pool: StreamSource[]) => {
        const selected = pick(pool);
        if (!selected) {
          // Pool exhausted — the error overlay requires !loading, so error wins.
          setLoading(false);
          setStreamError(true);
          return;
        }
        triedUrlsRef.current.add(selected.url);

        // ── Arm a fresh attempt ──
        const netRecoveries = { used: 0 };
        const mediaRecoveries = { used: 0 };
        setLoading(true); // honest: the bar stays up until media is ready
        setSlowLoad(false);
        attemptStateRef.current = "pending";

        const fail = () => {
          if (failAttemptRef.current !== fail) return; // superseded attempt
          failAttemptRef.current = null;
          destroyHls(); // tears down hls and clears this attempt's watchdog
          const next = pool.filter((s) => !triedUrlsRef.current.has(s.url));
          if (next.length > 0) {
            tryLoad(next);
          } else {
            // Drop a broken direct-play src so it can't keep erroring.
            const v = videoRef.current;
            if (v?.getAttribute("src")) {
              try {
                v.removeAttribute("src");
                v.load();
              } catch {}
            }
            setLoading(false);
            setStreamError(true);
          }
        };
        failAttemptRef.current = fail;

        // Watchdog: no MANIFEST_PARSED / loadedmetadata / fatal error within
        // 15s means this attempt is silently stuck on a black frame — fail it.
        clearWatchdog();
        watchdogRef.current = setTimeout(() => {
          watchdogRef.current = null;
          fail();
        }, 15000);

        if (selected.isM3U8 && Hls.isSupported()) {
          // Always through /api/proxy: the CDN requires a Referer and sends no
          // CORS headers, so a direct cross-origin load fails silently.
          const loadUrl = proxyUrl(selected.url, headers);

          const hls = new Hls({
            // Startup — start low, ramp up fast
            startLevel: -1,
            testBandwidth: true,
            abrEwmaDefaultEstimate: 2_000_000,
            startFragPrefetch: true,
            maxLoadingDelay: 200,

            // Buffer — generous to avoid desktop stalling
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferSize: 60 * 1000 * 1000,
            backBufferLength: 30,
            maxBufferHole: 0.5,

            // VOD: disable LL-HLS
            lowLatencyMode: false,

            // Network — aggressive retries reduce stall duration
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 200,
            manifestLoadingMaxRetry: 4,
            manifestLoadingRetryDelay: 100,
            levelLoadingMaxRetry: 4,
            levelLoadingRetryDelay: 100,
            fragLoadingTimeOut: 15000,
            manifestLoadingTimeOut: 8000,
            levelLoadingTimeOut: 10000,

            // Cap quality to player size (saves bandwidth on mobile)
            capLevelToPlayerSize: true,

            enableWorker: true,
          });
          hls.loadSource(loadUrl);
          hls.attachMedia(video);
          hlsRef.current = hls;

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (failAttemptRef.current !== fail) return; // superseded attempt
            markAttemptReady(); // loading dismissed + watchdog cleared
            setStreamError(false);
            // Restore saved progress
            const saved = restoreProgress();
            if (saved && saved.time > 0) {
              video.currentTime = saved.time;
            }
            if (autoPlay) {
              video.play().catch(() => {});
            }
            // Expose HLS internal quality levels
            if (hls.levels?.length) {
              const levels = hls.levels.map((l, i) => ({
                index: i,
                height: l.height || 0,
                name: qualityLabel(l, i),
              }));
              setHlsLevels(levels);
              // Re-apply the remembered quality preference now that this
              // stream's REAL levels are known. `pendingQualityRef` covers the
              // case where metadata hasn't hydrated prefs yet (MANIFEST_PARSED
              // can beat loadedmetadata — which is also why the legacy
              // per-anime field is still read here: migration may not have
              // run yet); the direct reads cover the reverse. A remembered
              // quality that this stream doesn't carry falls back to auto
              // instead of sticking the picker on a missing entry.
              const wanted =
                pendingQualityRef.current ??
                readSettings()?.quality ??
                readLegacyPrefs(prefsKeyRef.current)?.quality;
              pendingQualityRef.current = null;
              const known = wanted === "auto" || levels.some((l) => l.name === wanted);
              const chosen = known && wanted ? wanted : "auto";
              setCurrentQuality(chosen);
              currentQualityRef.current = chosen;
              if (chosen !== "auto") {
                const level = levels.find((l) => l.name === chosen);
                if (level) hls.currentLevel = level.index;
              }
            }
          });

          // Track auto-selected level for display
          hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
            if (hls.currentLevel === -1 && hls.levels?.[data.level]) {
              // Same mapping as MANIFEST_PARSED, so the highlighted entry
              // always matches the label the menu actually rendered.
              const h = hls.levels[data.level].height;
              const name = qualityLabel(hls.levels[data.level], data.level);
              if (h) {
                setCurrentQuality(name);
                currentQualityRef.current = name;
              }
            }
          });

          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                if (netRecoveries.used < 2) {
                  netRecoveries.used += 1;
                  try {
                    hls.startLoad();
                  } catch {
                    fail();
                  }
                } else {
                  fail();
                }
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                if (mediaRecoveries.used < 2) {
                  mediaRecoveries.used += 1;
                  // Same detach caveat as recoverStream: recoverMediaError()
                  // resets currentTime to 0 and drops the SourceBuffers —
                  // restore position + play state or the element freezes at
                  // 0:00 while the buffer restarts at `pos`.
                  const pos = video.currentTime;
                  const wasPlaying = video.paused === false;
                  try {
                    hls.recoverMediaError();
                    if (Math.abs(video.currentTime - pos) > 1) video.currentTime = pos;
                    if (wasPlaying) video.play().catch(() => {});
                  } catch {
                    fail();
                  }
                } else {
                  fail();
                }
                break;
              default:
                // Any other fatal error fails the attempt right away; `fail`
                // moves on to the next untried playable source (tried-set
                // prevents re-selecting the same failing URL).
                fail();
            }
          });
        } else {
          // Direct play for progressive files — also through /api/proxy,
          // otherwise the CDN 403s (no Referer) and the browser blocks the
          // cross-origin response (no CORS headers).
          video.src = proxyUrl(selected.url, headers);
          if (autoPlay) {
            video.play().catch(() => {});
          }
        }
      };

      tryLoad(playable);
    },
    [destroyHls, clearWatchdog, markAttemptReady]
  );

  // ─── Fetch stream with server fallback ──────────────────
  const fetchStream = useCallback(
    async (type: "sub" | "dub") => {
      const fid = ++fetchIdRef.current;
      setLoading(true);
      setSlowLoad(false);
      setStreamError(false);
      setStreamErrorDetail(null);
      lastApiErrorRef.current = null;
      // Set once a load attempt owns the loading state (it dismisses the bar
      // on MANIFEST_PARSED / loadedmetadata).
      let handedOffToAttempt = false;

      try {
        for (const server of SERVERS) {
          if (fid !== fetchIdRef.current) return;

          const params = new URLSearchParams({
            title: animeTitle,
            episode: String(episodeNumber),
            type,
            server,
          });
          if (anilistId) params.set("anilistId", String(anilistId));
          if (activeProvider) params.set("providerId", activeProvider);
          // The audio type here is a known `sub`/`dub`, never "auto" — so
          // tell the route to skip its opposite-type stage-2 re-walk on a
          // miss (a silent extra provider walk per server otherwise, i.e.
          // up to double the wall time per failed lookup). Absent `strict`
          // keeps the old self-contained behaviour for direct callers.
          params.set("strict", "1");

          const res = await fetch(`/api/stream?${params}`);
          if (!res.ok) continue;

          const data = await res.json();
          if (fid !== fetchIdRef.current) return;

          if (data.sources?.length > 0) {
            setSources(data.sources);
            setSubtitles(data.subtitles || []);
            setStreamHeaders(data.headers || null);
            setStreamError(false);
            setStreamErrorDetail(null);
            lastApiErrorRef.current = null;
            handedOffToAttempt = true;
            loadHls(data.sources, data.headers || null, true);
            return;
          }
          // No sources here: remember the server's reason for the card below.
          if (typeof data?.error === "string" && data.error) lastApiErrorRef.current = data.error;
        }

        // If we exhausted all servers with no success
        if (fid === fetchIdRef.current) {
          setStreamErrorDetail(lastApiErrorRef.current);
          setStreamError(true);
        }
      } catch {
        if (fid === fetchIdRef.current) setStreamError(true);
      } finally {
        // Safety net so the loading overlay can never be stranded over an
        // error: error paths clear it here, successful loads clear it when
        // their attempt becomes ready.
        if (fid === fetchIdRef.current && !handedOffToAttempt) setLoading(false);
      }
    },
    [animeTitle, episodeNumber, anilistId, activeProvider, loadHls]
  );

  // ─── Probe a specific server for a given type ──────────
  // `fresh` bypasses /api/stream's failure cache — only ever set for an
  // explicit user retry (see loadByType), never for routine loads.
  const probeServer = useCallback(
    async (server: string, type: "sub" | "dub", fresh = false): Promise<{
      sources: StreamSource[];
      subtitles: Subtitle[];
      headers: Record<string, string>;
      providerId?: string;
    } | null> => {
      try {
        const params = new URLSearchParams({
          title: animeTitle,
          episode: String(episodeNumber),
          type,
          server,
        });
        if (anilistId) params.set("anilistId", String(anilistId));
        if (activeProvider) params.set("providerId", activeProvider);
        // Known type → skip the route's opposite-type stage-2 re-walk (see
        // fetchStream above). The cache key carries `strict`, so this also
        // keeps every player-originated lookup on ONE canonical key.
        params.set("strict", "1");
        if (fresh) params.set("fresh", "1");
        const res = await fetch(`/api/stream?${params}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.sources?.length > 0) {
          return {
            sources: data.sources,
            subtitles: data.subtitles || [],
            headers: data.headers || {},
            providerId: data.providerId,
          };
        }
        // Probe failed — record the server's reason for the error card.
        if (typeof data?.error === "string" && data.error) lastApiErrorRef.current = data.error;
      } catch { /* skip */ }
      return null;
    },
    [animeTitle, episodeNumber, anilistId, activeProvider]
  );

  // ─── Auto-detect all working servers ──────────────────
  const discoverServers = useCallback(
    async (type: "sub" | "dub", fresh = false): Promise<{ server: string; data: NonNullable<Awaited<ReturnType<typeof probeServer>>> }[]> => {
      const results = await Promise.all(
        SERVERS.map(async (s) => {
          const data = await probeServer(s, type, fresh);
          return data ? { server: s, data } : null;
        })
      );
      return results.filter(Boolean) as any;
    },
    [probeServer]
  );

  // ─── Load stream by type ────────────────────────────────
  // `opts.fresh` is set ONLY by explicit user retries (Retry / Try Dub / the
  // same-provider retry in the error overlay): it bypasses the route's 90s
  // failure cache so the retry actually re-walks providers instead of being
  // answered the same cached miss that caused the error in the first place.
  const loadByType = useCallback(
    async (type: "sub" | "dub", serverOverride?: string, opts?: { fresh?: boolean }) => {
      // User-driven from here on (Retry / Try Dub / server switches): drop
      // any stale handoff note and retire the one-shot mount handoff — a
      // manual load must show the normal error state, never silently swap
      // episodes (see mountLookupArmedRef).
      setHandoffNote(null);
      mountLookupArmedRef.current = false;
      setAudioType(type);
      setLoading(true);
      setSlowLoad(false);
      setStreamError(false);
      setStreamErrorDetail(null);
      lastApiErrorRef.current = null;

      // Get all working servers for this type
      const working = await discoverServers(type, opts?.fresh);
      if (working.length > 0) {
        setAvailableServers(working.map((w) => w.server));
        // Use provided server, or prefer current active, or first working
        const target = serverOverride
          ? working.find((w) => w.server === serverOverride) ?? working[0]
          : activeServerRef.current
            ? working.find((w) => w.server === activeServerRef.current) ?? working[0]
            : working[0];
        setActiveServer(target.server);
        activeServerRef.current = target.server;
        setSources(target.data.sources);
        setSubtitles(target.data.subtitles);
        setStreamHeaders(target.data.headers);
        // One of the probes answered — any reason they reported is obsolete.
        setStreamErrorDetail(null);
        lastApiErrorRef.current = null;
        // Populate failover queue with the other working servers
        workingServersRef.current = working.map((w) => ({
          server: w.server,
          sources: w.data.sources,
          subtitles: w.data.subtitles,
          headers: w.data.headers,
          providerId: w.data.providerId,
        }));
        failoverQueueRef.current = working
          .filter((w) => w.server !== target.server)
          .map((w) => w.server);
        setLoading(false);
        loadHls(target.data.sources, target.data.headers, true);
      } else {
        setLoading(false);
        setStreamErrorDetail(lastApiErrorRef.current);
        setStreamError(true);
      }
    },
    [discoverServers, loadHls]
  );

  // ─── Auto-load sub & detect dub on mount ────────
  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setSlowLoad(false);
    setHandoffNote(null);
    setStreamError(false);
    setStreamErrorDetail(null);
    lastApiErrorRef.current = null;
    setDubProbeOk(false);
    providerSkipRef.current = { intro: false, outro: false };
    hasSetInitialSubRef.current = false;

    // Reset OpenSubtitles state for new episode
    setOsSearched(false);
    setOsResults([]);
    setOsError(null);
    setOsDownloadError(null);
    setActiveOSSubtitleId(null);
    failedOSIdsRef.current.clear();
    hasAutoLoadedDubSubRef.current = false;
    setSubtitleOffset(0);
    setSubtitleSize("medium");
    setOsPage(1);
    setOsFilterQuery("");

    // Check saved progress for audio type preference. A saved "dub" is only
    // honoured when the episode doesn't already rule a dub out — data beats
    // habit, so a dub-less episode never boots into a dub request.
    //
    // Both tests below read `dubFlag`, the ONE derived dub truth declared next
    // to the prop (server prop, else the keyed `/api/episodes` answer). They
    // used to re-read the raw `episodeHasDub` prop directly, which is the same
    // value only until the fetched answer lands — two rules for one question
    // was the last remaining re-derivation of dub truth inside the player.
    const saved = restoreProgress();
    // Per-anime sub/dub choice first; the episode blob backs it up for
    // settings saved under the old scheme.
    const savedAudio: "sub" | "dub" | undefined =
      readPrefsByKey(prefsKeyRef.current)?.audioType ?? saved?.audioType;
    const preferredType: "sub" | "dub" =
      savedAudio === "dub" && dubFlag !== false ? "dub" : "sub";

    // Legacy dub probe — only while the episode list left the flags unknown
    // (megaplay ships `null`, and >60-episode titles can't be probed there).
    // When the flag IS known this is a no-op: no requests, no guess, and
    // `dubEnabled` reads straight from the data instead.
    //
    // It deliberately starts only ONCE THE PREFERRED STREAM HAS SETTLED
    // (see both call sites below) instead of racing it from mount: it is
    // more `/api/stream` calls, i.e. more provider walks fired at the
    // exact moment episode load is most congested. And it now runs the
    // servers SEQUENTIALLY with early abandon, capped at two probes: the
    // first positive answer settles it (`dubProbeOk`), so the common
    // "dub exists" case costs ONE walk instead of three parallel ones —
    // three parallel identical-purpose walks used to land exactly while the
    // route was still warm from the main load, doubling congestion. Only a
    // definitive negative (a server that answered, with no sources) moves
    // on to the next server; two negatives settle at "no dub found" the
    // same way the old three-negative did — the third server is never
    // asked, which is the accepted cost of the cap.
    const startDubProbe = () => {
      if (cancelled || dubFlag !== null) return;
      void (async () => {
        for (const s of SERVERS.slice(0, 2)) {
          if (cancelled) return;
          // Cleared so the answer test below can tell a server that
          // ANSWERED (its miss reason lands in the ref → definitive
          // negative) from one that failed silently (non-OK / network →
          // inconclusive). Clearing also stops the probe from leaving a
          // bogus miss reason behind an otherwise successful load.
          lastApiErrorRef.current = null;
          let found = false;
          try {
            found = !!(await probeServer(s, "dub"));
          } catch {
            found = false;
          }
          if (cancelled) return;
          if (found) {
            setDubProbeOk(true);
            // A positive probe is evidence about THIS episode — park it in
            // the shared flags cache so a later navigation can answer from
            // sessionStorage instead of probing again. Counts stay null
            // (the stream probe knows nothing about other episodes); null
            // means unknown, never "no". But never let probe hearsay
            // OVERRIDE megaplay-verified facts: while the route's stage-2
            // still answers `strict` misses with the opposite type's
            // sources, a probe "hit" on a sub-only title is an artifact —
            // `dubCount === 0` in the cache outranks it.
            if (readAudioFlagsCache(anilistId)?.dubCount !== 0) {
              mergeAudioFlagsCache(anilistId, {
                dubByEpisode: { [String(episodeNumber)]: true },
              });
            }
            return;
          }
          // Continue ONLY on a definitive negative. A silent failure proves
          // nothing about dub availability, so the chain stops there rather
          // than burning more provider walks on what may be a dead route —
          // `dubProbeOk` stays false exactly as the old all-negative did.
          if (!lastApiErrorRef.current) return;
        }
      })();
    };

    /** The slice of /api/stream's JSON body this effect consumes. */
    type EpisodeLookupData = {
      sources: StreamSource[];
      subtitles?: Subtitle[];
      headers?: Record<string, string> | null;
      intro?: { start: number; end: number };
      outro?: { start: number; end: number };
    };
    // ── One mount lookup: the sequential SERVERS walk for ONE episode ──
    // The old inline loop inlined exactly this per landing episode; the
    // mount handoff below needs the SAME walk runnable for lower
    // candidates, so it is one local function now. It answers with the
    // first server that returns sources, or with HOW the walk ended — the
    // handoff hinges on telling a definitive "providers have nothing" from
    // a transient failure.
    type EpisodeLookup =
      | { outcome: "sources"; server: string; data: EpisodeLookupData }
      | { outcome: "exhausted" | "transient" | "cancelled" };
    const lookupEpisode = async (ep: number, type: "sub" | "dub"): Promise<EpisodeLookup> => {
      for (const server of SERVERS) {
        if (cancelled) return { outcome: "cancelled" };
        try {
          const params = new URLSearchParams({
            title: animeTitle,
            episode: String(ep),
            type,
            server,
          });
          if (anilistId) params.set("anilistId", String(anilistId));
          if (activeProvider) params.set("providerId", activeProvider);
          // Known type ("sub" or "dub", never auto) → no opposite-type
          // stage-2 re-walk on the route side; same canonical cache key as
          // every other player lookup (probeServer/fetchStream).
          params.set("strict", "1");
          const res = await fetch(`/api/stream?${params}`);
          if (!res.ok) continue;
          const data = await res.json();
          if (cancelled) return { outcome: "cancelled" };

          if (data.sources?.length > 0) return { outcome: "sources", server, data };
          // No sources on this server — keep the reason for the error card.
          if (typeof data?.error === "string" && data.error) lastApiErrorRef.current = data.error;
        } catch { /* continue to next server */ }
      }
      if (cancelled) return { outcome: "cancelled" };
      // Classify the total miss. The route answers 200 + the exhausted-
      // sources body ONLY when its provider walk completed with nothing
      // (definitive); a thrown walk comes back 500 — skipped above, so it
      // never lands in the ref — and therefore reads as "transient". Only
      // the definitive class may trigger the handoff below.
      return {
        outcome: isExhaustedSourcesError(lastApiErrorRef.current) ? "exhausted" : "transient",
      };
    };

    (async () => {
      // ── Preferred-type load, with the mount stream handoff ──────────
      // Handoff candidates: episodes BELOW the landing one that the list
      // marks playable (`available !== false` — the same filter the watch
      // page's server-side next handoff applies), NEWEST first, so the
      // first hop lands straight on the highest playable below rather than
      // climbing from ep 1. At most MOUNT_HANDOFF_MAX_LOOKUPS − 1 of them:
      // the landing walk itself counts as attempt 1, so the two hop slots
      // below ARE the cap (see the module block for why a cap exists).
      //
      // The chain is deliberately UNROLLED — two flat hops, no loop around
      // the awaits. The React Compiler (which backs the react-hooks lint
      // rules) silently BAILS OUT of analyzing this entire component when a
      // locally-defined async function is awaited inside a loop, and that
      // bail suppresses every other compiler diagnostic in the file (refs,
      // immutability, set-state-in-effect…) — a false "improvement" that
      // would hide real bugs. The fixed unrolled shape keeps the compiler
      // engaged and makes the cap literally structural.
      const hopCandidates = (episodes ?? [])
        .filter((ep) => ep.number < episodeNumber && ep.available !== false)
        .sort((a, b) => b.number - a.number)
        .slice(0, MOUNT_HANDOFF_MAX_LOOKUPS - 1);
      // The episode the RUNNING lookup is for — the landing one until a hop
      // moves it. `episodeNumber` (the prop) deliberately never changes
      // here: re-keying it would rewire every episode-scoped callback in
      // this component. Instead the success branch rewrites the URL so it
      // tells the truth, and any later navigation remounts with real props.
      let tryingEpisode = episodeNumber;

      // Attempt 1 — the landing episode the URL asked for.
      let result = await lookupEpisode(tryingEpisode, preferredType);

      // Hop gate, checked before EACH hop: the definitive "providers
      // exhausted" miss only (a TRANSIENT miss proves nothing about the
      // episode and must never silently redirect the viewer), AND the
      // one-shot arm still live — this Player instance's FIRST load; the
      // ref retires when this chain settles, so Retry / Try Dub / server
      // switches / a provider-override re-run of this effect never hop —
      // AND an anilistId to rewrite the URL with (no /watch route to
      // reflect the real episode in would strand the viewer on a lie).
      //
      // Hop 1 — the NEWEST lower playable episode (one hop, not a climb).
      if (
        result.outcome === "exhausted" &&
        anilistId &&
        mountLookupArmedRef.current &&
        hopCandidates[0]
      ) {
        tryingEpisode = hopCandidates[0].number;
        // The note lives inside the loading overlay: it shows while the
        // hop's walk runs, unmounts the moment playback starts, and can
        // never stack on the error overlay (which owns its own reason line
        // when every candidate is dead).
        setHandoffNote({ from: episodeNumber, to: tryingEpisode });
        result = await lookupEpisode(tryingEpisode, preferredType);
      }
      // Hop 2 — the cap: at most three lookup attempts per mount, total
      // (landing + two hops); every miss is a full provider walk.
      if (
        result.outcome === "exhausted" &&
        anilistId &&
        mountLookupArmedRef.current &&
        hopCandidates[1]
      ) {
        tryingEpisode = hopCandidates[1].number;
        setHandoffNote({ from: episodeNumber, to: tryingEpisode });
        result = await lookupEpisode(tryingEpisode, preferredType);
      }

      // A superseded run (StrictMode's dev double-invoke, or an episode/
      // provider change mid-walk) stops here WITHOUT disarming: the arm
      // belongs to the instance's first LOAD, and its successor run is
      // still that load — only a run that actually settles may retire it.
      if (result.outcome === "cancelled") return;

      // The first load of this Player instance has settled — played or
      // errored. Retire the one-shot arm HERE (not per hop) so the hops
      // above stay allowed while every later lookup — Retry / Try Dub /
      // server switches via loadByType, a provider-override re-run of this
      // effect — shows the normal error state instead of silently swapping
      // episodes. Success consumes it too: a stream that PLAYED means there
      // was nothing to hand off, and a subsequent user-driven failure must
      // not resurrect the behaviour.
      mountLookupArmedRef.current = false;

      if (result.outcome === "sources") {
        const { server, data } = result;
        // Handed off? Reflect the REAL episode in the address bar (copy /
        // refresh / bookmark tell the truth from here on; the in-flight
        // note already told the viewer). history.replaceState, NOT
        // router.push/replace: a router navigation remounts this page —
        // re-running the very lookup that just failed for the episode we
        // escaped — an unbounded bounce loop. The query string (provider
        // override, …) rides along untouched, same as goToEpisode.
        if (tryingEpisode !== episodeNumber && anilistId) {
          window.history.replaceState(
            null,
            "",
            `/anime/${anilistId}/watch/${tryingEpisode}${window.location.search}`
          );
        }
        setSources(data.sources);
        setSubtitles(data.subtitles || []);
        setStreamHeaders(data.headers || null);
        setActiveServer(server);
        activeServerRef.current = server;
        setAvailableServers([server]);
        setStreamError(false);
        setStreamErrorDetail(null);
        lastApiErrorRef.current = null;
        setAudioType(preferredType);
        // Don't dismiss the loading bar here — the attempt owns it and
        // clears it on MANIFEST_PARSED / loadedmetadata (or fails over).
        loadHls(data.sources, data.headers || null, true);

        // Use provider skip times if available (more accurate than AniSkip)
        if (data.intro || data.outro) {
          if (data.intro && !introSegment) {
            providerSkipRef.current.intro = true;
            setIntroSegment(data.intro);
          }
          if (data.outro && !outroSegment) {
            providerSkipRef.current.outro = true;
            setOutroSegment(data.outro);
          }
        }

        // After a HOP, both follow-ups below would probe the LANDING
        // episode (probeServer is keyed on the `episodeNumber` prop) —
        // i.e. burn provider walks against the episode we just proved
        // dead — so a handed-off load skips them. Accepted cost: the dub
        // toggle and the extra-server list stay unknown for this session
        // (fixing either needs a prop re-key, far from surgical); manual
        // server switches still work and, per the mount-only rule, show
        // the normal error state if they miss.
        if (tryingEpisode === episodeNumber) {
          // Dub probe now that the stream itself is in hand.
          startDubProbe();

          // Discover remaining sub servers in background
          const otherServers = SERVERS.filter((s) => s !== server);
          const subExtras = await Promise.all(
            otherServers.map(async (s) => {
              const d = await probeServer(s, "sub");
              return d ? s : null;
            })
          );
          const allSub = [server, ...subExtras.filter(Boolean)] as string[];
          if (!cancelled) setAvailableServers(allSub);
        }

        return;
      }

      // No handoff taken, or every candidate dead: the error card exactly
      // as today. The error must not wait on the dub probe — start it in
      // the background so the toggle still gets its answer.
      startDubProbe();
      if (!cancelled) {
        setStreamErrorDetail(lastApiErrorRef.current);
        setStreamError(true);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      destroyHls();
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animeTitle, episodeNumber, activeProvider]);

  // ─── Warm the next episode's stream (#5) ─────────────────────
  // Switching episodes costs the *new* episode a full provider walk, and in
  // fullscreen that walk sits under the switch card with nothing else on
  // screen — so the same wait reads as "fullscreen is slower" while windowed
  // hides it behind a page that has already repainted. Arming the request as
  // soon as `nextEpisodeTarget` exists moves that walk off the click: by the
  // time the countdown fires or the user hits next, `/api/stream` for the next
  // episode is already in the route cache (5 min for a hit, 90 s for a miss,
  // so even an unplayable episode switches instantly).
  //
  // Gated on `!loading` so it never races this episode's own provider walk —
  // both would miss the shared (provider, title) session cache and duplicate
  // the search — and on a short delay so it also clears the "remaining servers"
  // discovery that runs right after a successful load. Omitting neither would
  // cost an extra walk for no benefit. `server` is pinned to the player's first
  // choice so an anikoto answer lands under the key the player will ask for.
  useEffect(() => {
    if (!nextEpisodeTarget || loading) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        title: animeTitle,
        episode: String(nextEpisodeTarget),
        type: audioType,
        server: SERVERS[0],
      });
      if (anilistId) params.set("anilistId", String(anilistId));
      if (activeProvider) params.set("providerId", activeProvider);
      // Known `audioType` → strict, AND the key must match the one the next
      // episode's mount loop will ask for (route cache keys carry `strict`),
      // or this warm-up would be written under a key nobody re-reads.
      params.set("strict", "1");
      void fetch(`/api/stream?${params}`, { signal: controller.signal }).catch(() => {
        /* aborted / offline — the switch simply pays the walk itself */
      });
    }, 1500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [nextEpisodeTarget, loading, audioType, animeTitle, anilistId, activeProvider]);

  // ─── Fetch AniSkip timestamps independently (non-blocking) ──
  useEffect(() => {
    if (!malId || !episodeNumber) return;
    let cancelled = false;

    (async () => {
      try {
        const params = new URLSearchParams({ malId: String(malId), episode: String(episodeNumber) });
        const res = await fetch(`/api/skip-times?${params}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) {
          // Only use AniSkip as fallback — provider skip times are preferred,
          // but only for the segment the provider actually answered. The old
          // single flag dropped AniSkip's intro whenever a provider returned
          // an outro alone.
          if (data.intro && !providerSkipRef.current.intro) setIntroSegment(data.intro);
          if (data.outro && !providerSkipRef.current.outro) setOutroSegment(data.outro);
        }
      } catch {
        // No skip data available — that's fine
      }
    })();

    return () => { cancelled = true; };
  }, [malId, episodeNumber]);

  // ─── Save progress periodically while playing ──────────
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(saveProgress, 15000); // every 15s
    return () => clearInterval(id);
  }, [playing, saveProgress]);

  // ─── Save on pause / unload ────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPause = () => saveProgress();
    video.addEventListener("pause", onPause);
    window.addEventListener("beforeunload", saveProgress);
    return () => {
      video.removeEventListener("pause", onPause);
      window.removeEventListener("beforeunload", saveProgress);
    };
  }, [saveProgress]);

  // ─── Initial subtitle auto-select (one-shot per stream) ──
  // Pre-feature chain: remembered lang → English → first, honouring the
  // `subtitles === false` OFF veto. The stored `"auto"` sentinel (written by
  // the since-removed Auto mode) is ignored — it falls through to the
  // default chain instead of being lang-matched. One-shot: the ref is reset
  // per stream by the stream-load effect above; tracks that arrive later
  // (OpenSubtitles download, the dub AI sub) do NOT re-trigger selection —
  // the viewer owns the track after this point.
  const hasSetInitialSubRef = useRef(false);
  useEffect(() => {
    if (hasSetInitialSubRef.current) return;
    const prefs = readPrefsByKey(prefsKeyRef.current);
    const global = readSettings();
    // OFF veto — the per-anime override wins, else the global default.
    if ((prefs?.subtitles ?? global?.subtitles) === false) {
      hasSetInitialSubRef.current = true;
      return; // leave the track unset
    }
    if (subtitles.length === 0) return; // wait for the track list
    hasSetInitialSubRef.current = true;
    // Remembered lang — the per-anime override wins, else the global default.
    const want = (prefs?.subtitleLang ?? global?.subtitleLang ?? "").toLowerCase();
    const remembered = want && want !== "auto"
      ? subtitles.find((s) => s.lang.toLowerCase() === want)
      : undefined;
    const resolved =
      remembered ||
      subtitles.find((s) => s.lang.toLowerCase().includes("en")) ||
      subtitles[0];
    // Apply in a microtask (lint-clean); the cleanup cancels it if the
    // stream changes before it lands.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setActiveSubtitle(resolved.url);
    });
    return () => {
      cancelled = true;
    };
  }, [subtitles, anilistId, animeTitle, episodeNumber, audioType]);

  // ─── Subtitle selection handler + dual-write persistence ──
  // Every subtitle CONTROL (track/off in either picker, the `c` shortcut,
  // offset/size, an OpenSubtitles download) dual-writes: the GLOBAL bucket
  // keeps the default for future shows, the PER-ANIME bucket pins it to the
  // show you're on. Only the fields the control actually changed are written
  // — a whole-group write would copy THIS show's auto-selected lang into the
  // global default and break every other show's remembered lang.
  // `undefined` values are dropped by JSON.stringify, so a patch can never
  // accidentally clear a stored field.
  const persistSubtitles = useCallback((patch: {
    subtitles?: boolean;
    subtitleLang?: string;
    subtitleOffset?: number;
    subtitleSize?: "small" | "medium" | "large";
  }) => {
    writeSettings(patch);
    writePrefsByKey(prefsKeyRef.current, patch);
  }, []);

  const pickSubtitle = useCallback((url: string | null) => {
    setActiveSubtitle(url);
    setActiveOSSubtitleId(null);
    if (url === null) {
      // OFF: the lang fields are left alone in both tiers, so re-enabling
      // restores the last track; only the visibility flag flips.
      persistSubtitles({ subtitles: false });
    } else {
      const lang = subtitles.find((s) => s.url === url)?.lang;
      persistSubtitles({ subtitles: true, ...(lang ? { subtitleLang: lang } : {}) });
    }
  }, [persistSubtitles, subtitles]);

  // Offset / size controls — same dual-write, one field at a time. The two
  // wiring sites used to pass the raw setters; these wrap them for persistence.
  const changeSubtitleOffset = useCallback((offset: number) => {
    setSubtitleOffset(offset);
    persistSubtitles({ subtitleOffset: offset });
  }, [persistSubtitles]);

  const changeSubtitleSize = useCallback((size: "small" | "medium" | "large") => {
    setSubtitleSize(size);
    persistSubtitles({ subtitleSize: size });
  }, [persistSubtitles]);

  // ─── Persist the viewer settings (split by scope) ─────────
  // Global-only fields (quality, toggles, filters) → `n54tv-settings`;
  // per-anime fields (sub/dub) → the show's bucket. The SUBTITLE fields are
  // NOT written here: they persist from their controls (the dual-write
  // above), because an effect write would echo the auto-selected track back
  // into both buckets and clobber the global lang default for every other
  // show. The provider override has its own write effect by the store.
  //
  // The first run is skipped because at mount the state is still the DEFAULTS
  // (prefsSkipFirstWriteRef) — and the window extends until hydration has
  // actually merged + applied the stored values (prefsHydratedRef): effects
  // like the subtitle auto-select can change state before loadedmetadata,
  // and echoing those values out early would hand migration a gutted bucket.
  // Once hydration has applied them, re-fires write the same values back —
  // an idempotent mirror.
  useEffect(() => {
    if (prefsSkipFirstWriteRef.current) {
      prefsSkipFirstWriteRef.current = false;
      return;
    }
    if (!prefsHydratedRef.current) return;
    writeSettings({
      quality: currentQuality,
      autoPlayNext,
      autoSkip: autoSkipEnabled,
      videoFilter,
      audioFilter,
    });
    writePrefsByKey(prefsKeyRef.current, { audioType });
  }, [
    autoPlayNext,
    autoSkipEnabled,
    audioType,
    currentQuality,
    videoFilter,
    audioFilter,
  ]);

  // ─── Auto-load AI English subs for dub episodes ─────────
  const hasAutoLoadedDubSubRef = useRef(false);
  useEffect(() => {
    if (audioType !== "dub" || hasAutoLoadedDubSubRef.current) return;
    if (!animeTitle || !episodeNumber) return;
    // Only auto-load if stream is loaded
    if (loading || sources.length === 0) return;

    hasAutoLoadedDubSubRef.current = true;

    (async () => {
      try {
        const params = new URLSearchParams({
          query: animeTitle,
          season_number: "1",
          episode_number: String(episodeNumber),
          languages: "en",
        });
        const res = await fetch(`/api/opensubtitles?${params}`);
        if (!res.ok) return;
        const data = await res.json();
        const results = data.results ?? [];
        if (results.length === 0) return;

        // Pick the best result — prefer AI-translated for dub (they're timed for dubbed audio)
        const ai = results.find((r: any) => r.ai_translated);
        const best = ai || results[0];

        // Download the subtitle
        const dlRes = await fetch(`/api/opensubtitles?file_id=${best.file_id}&sub_format=vtt`);
        if (!dlRes.ok) return;
        const blob = await dlRes.blob();
        if (blob.size < 50) return;

        const url = URL.createObjectURL(blob);
        // Add to subtitles list at the top. We do NOT select it here — the
        // one-shot auto-select above has already run for this stream, and a
        // viewer hand-pick is never overridden; the track simply becomes
        // available in the picker (and for the next episode's one-shot).
        const aiLabel = `English (AI)`;
        setSubtitles((prev) => {
          // Don't duplicate if already present
          if (prev.some((s) => s.url === url)) return prev;
          return [{ url, lang: aiLabel }, ...prev];
        });
        // Mark as searched so user can see results in picker
        setOsSearched(true);
        setOsResults(results);
      } catch {
        // Silent fail — user can manually search
      }
    })();
  }, [audioType, animeTitle, episodeNumber, loading, sources.length]);

  // ─── OpenSubtitles search ──────────────────────────────
  const searchOpenSubtitles = useCallback(async (page = 1) => {
    if (osLoading) return;

    setOsLoading(true);
    setOsError(null);
    if (page === 1) setOsSearched(true);

    try {
      const params = new URLSearchParams({
        query: animeTitle,
        season_number: "1",
        episode_number: String(episodeNumber),
        languages: "en",
        page: String(page),
      });

      const res = await fetch(`/api/opensubtitles?${params}`);
      if (!res.ok) {
        setOsError("Search failed");
        return;
      }
      const data = await res.json();
      const newResults = data.results ?? [];

      if (page === 1) {
        setOsResults(newResults);
      } else {
        setOsResults((prev) => [...prev, ...newResults]);
      }
      setOsPage(page);

      if (newResults.length === 0 && page === 1) {
        setOsError("No subtitles found");
      }
    } catch {
      setOsError("Search failed");
    } finally {
      setOsLoading(false);
    }
  }, [animeTitle, episodeNumber, osLoading]);

  // ─── Select an OpenSubtitles subtitle ──────────────────
  const selectOSSubtitle = useCallback(async (fileId: number) => {
    try {
      setOsDownloadError(null);
      const res = await fetch(`/api/opensubtitles?file_id=${fileId}&sub_format=vtt`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setOsDownloadError(data?.error || `Download failed (${res.status})`);
        failedOSIdsRef.current.add(fileId);
        return;
      }

      const blob = await res.blob();
      if (blob.size < 50) {
        setOsDownloadError("Subtitle file is empty");
        failedOSIdsRef.current.add(fileId);
        return;
      }
      const url = URL.createObjectURL(blob);

      // Revoke previous OS blob URL if any
      if (activeSubtitle?.startsWith("blob:")) {
        URL.revokeObjectURL(activeSubtitle);
      }

      // The viewer picked this track by hand.
      setActiveSubtitle(url);
      // Track which OS subtitle is active
      setActiveOSSubtitleId(fileId);
      // A blob URL isn't in the stream's track list, so there's no stable
      // lang label to remember — only flip visibility in both tiers.
      persistSubtitles({ subtitles: true });
      closeMore();
    } catch (e) {
      setOsDownloadError(e instanceof Error ? e.message : "Download failed");
      failedOSIdsRef.current.add(fileId);
    }
  }, [activeSubtitle, closeMore, persistSubtitles]);

  // ─── Controls auto-hide ────────────────────────────────
  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      // The ⋯ menu and the row popovers park right above the control bar —
      // never yank the bar out from under an open surface.
      if (playingRef.current && !surfaceOpenRef.current.more && surfaceOpenRef.current.picker === null) setShowControls(false);
    }, 3000);
  }, []);

  useEffect(() => {
    // Play/pause must not force the HUD visible — it used to flash the whole
    // control bar on every keyboard toggle. Only refresh the hide countdown
    // when the bar is already showing; otherwise leave it alone: the toggle
    // itself carries no overlay, so a hidden bar simply stays hidden.
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    if (showControlsRef.current) {
      controlsTimerRef.current = setTimeout(() => {
        if (playingRef.current && !surfaceOpenRef.current.more && surfaceOpenRef.current.picker === null) setShowControls(false);
      }, 3000);
    }
    return () => {
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    };
  }, [playing]);

  // ─── Close menus on outside click ───────────────────────
  useEffect(() => {
    const closeIfOutside = (e: PointerEvent) => {
      const t = e.target as Node;
      // Clicks inside the ⋯ panel must not dismiss it, and its trigger is
      // exempt too — the trigger toggles the menu itself (exposing it here
      // would close-then-reopen it on the same click).
      if (showMore && moreWrapRef.current && moreBtnRef.current &&
          !moreWrapRef.current.contains(t) && !moreBtnRef.current.contains(t) &&
          !moreDismissRef.current?.contains(t)) {
        closeMore();
      }
      // Row popovers: the open one's wrapper (trigger + panel as one unit)
      // is the "inside" — clicking the open trigger again reaches its own
      // toggle-close, clicking anything else drops the popover. Exactly how
      // the quality list has always behaved; now all seven share it.
      if (openPicker) {
        const wrap =
          openPicker === "quality" ? qualityWrapRef.current : pickerWrapRefs.current[openPicker];
        if (wrap && !wrap.contains(t)) setOpenPicker(null);
      }
      // Drawer's franchise dropdown: the trigger's wrapper counts as inside
      // (the trigger toggles it itself — exposing it would close-then-reopen
      // on the same tap). The drawer's own backdrop click closes the drawer,
      // which drops the dropdown with it.
      if (franchiseOpen && franchiseWrapRef.current && !franchiseWrapRef.current.contains(t)) {
        setFranchiseOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeIfOutside);
    return () => document.removeEventListener("pointerdown", closeIfOutside);
  }, [showMore, openPicker, franchiseOpen, closeMore]);

  // ─── Handlers ──────────────────────────────────────────
  const handleTimeUpdate = useCallback(() => {
    const now = performance.now();
    if (now - lastTimeUpdateRef.current >= 250) {
      lastTimeUpdateRef.current = now;
      if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
    }
  }, []);

  // Sample video.buffered → seekbar % ranges. Quantised to 0.5% and keyed so
  // the frequent `progress` events never re-render when nothing moved; an
  // empty buffer (episode switch, detach) clears the segment list.
  const handleBufferProgress = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.buffered.length === 0) {
      if (bufferedKeyRef.current !== "") {
        bufferedKeyRef.current = "";
        setBufferedRanges([]);
      }
      return;
    }
    if (!isFinite(v.duration) || v.duration <= 0) return;
    const ranges: { start: number; end: number }[] = [];
    for (let i = 0; i < v.buffered.length; i++) {
      ranges.push({
        start: (v.buffered.start(i) / v.duration) * 100,
        end: (v.buffered.end(i) / v.duration) * 100,
      });
    }
    const key = ranges.map((r) => `${Math.round(r.start * 2)}-${Math.round(r.end * 2)}`).join(",");
    if (key === bufferedKeyRef.current) return;
    bufferedKeyRef.current = key;
    setBufferedRanges(ranges);
  }, []);
  // ─── Content aspect — the windowed box follows the stream's own ratio ──
  // The frame starts at 16:9 (what it shows before any metadata exists) and
  // then adopts the element's real videoWidth:videoHeight. The dims guard
  // makes this stick: it only ever acts on an ACTUAL dimension change, so an
  // HLS level switch to another level with the same storage size — or a
  // different size at the same ratio — cannot oscillate the layout (the
  // functional update below also no-ops when the ratio is unchanged).
  const [contentAspect, setContentAspect] = useState(16 / 9);
  const contentDimsRef = useRef<{ w: number; h: number } | null>(null);
  const syncContentAspect = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) return; // metadata not there yet — keep the default
    const ratio = w / h;
    if (ratio < 0.5 || ratio > 3.5) return; // ignore nonsense metadata
    const prev = contentDimsRef.current;
    if (prev && prev.w === w && prev.h === h) return; // dimensions didn't change
    contentDimsRef.current = { w, h };
    setContentAspect((cur) => (Math.abs(cur - ratio) < 0.001 ? cur : ratio));
  }, []);

  // Dimensions can also change AFTER load (an HLS level switch to a level
  // stored at a different size) — the media element's `resize` event is the
  // exact signal that videoWidth/videoHeight changed, so re-read there.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.addEventListener("resize", syncContentAspect);
    return () => v.removeEventListener("resize", syncContentAspect);
  }, [syncContentAspect]);

  const handleLoadedMetadata = () => {
    // Progressive/direct-src attempt now has media metadata — it is playable,
    // so this is where its loading bar is dismissed (HLS dismisses on
    // MANIFEST_PARSED). No-op unless an attempt is still pending.
    markAttemptReady();
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
      // Metadata carries the real frame size — adopt it for the box aspect.
      syncContentAspect();
      // Restore saved preferences.
      //
      // Volume / mute / speed are GLOBAL (n54tv-settings) — they follow the
      // viewer across every show, and the per-episode progress blob's copies
      // (which `saveProgress` still writes, harmlessly) are only a legacy
      // fallback for when the global field is absent. Everything else is the
      // two-tier view: the per-anime bucket may pin a subtitle override,
      // migration fills/strips the rest, and the merged result is applied
      // once below.
      const saved = restoreProgress();
      const global = readSettings();
      const vol = global?.volume ?? saved?.volume;
      if (vol !== undefined) {
        videoRef.current.volume = vol;
        setVolume(vol);
      }
      const mutedNow = global?.muted ?? saved?.muted;
      if (mutedNow !== undefined) {
        videoRef.current.muted = mutedNow;
        setMuted(mutedNow);
      }
      const rate = global?.speed ?? saved?.speed;
      if (rate !== undefined) {
        videoRef.current.playbackRate = rate;
        setPlaybackRate(rate);
        playbackRateRef.current = rate;
      }
      // Once per episode: `loadedmetadata` re-fires on stream re-attach, and
      // re-applying then would undo a toggle the viewer just flipped.
      if (!prefsHydratedRef.current) {
        prefsHydratedRef.current = true;
        const prefs = readLegacyPrefs(prefsKeyRef.current);
        // One-shot migration: seeds the global bucket from this show's legacy
        // per-anime prefs + the episode blob (when the global bucket is
        // absent), fills any fields it never got, then strips the pure-global
        // fields out of this show's bucket. Runs BEFORE the reads below so
        // they see the post-strip world.
        migrateIntoGlobal({
          animeKey: prefsKeyRef.current,
          prefs,
          legacy: saved
            ? { volume: saved.volume, muted: saved.muted, speed: saved.speed }
            : null,
        });
        // Fresh read — migration may have just created/filled the bucket.
        const store = readSettings();
        const pick = <T,>(next: T | undefined, prev: T | undefined): T | undefined =>
          next !== undefined ? next : prev;
        // Global wins; the episode blob is the legacy fallback for buckets
        // saved before the global store existed; per-anime leftovers (strip
        // failed / private mode) sit last.
        const skip = pick(store?.autoSkip, pick(saved?.autoSkip, prefs?.autoSkip));
        if (skip !== undefined) setAutoSkipEnabled(skip);
        const playNext = pick(store?.autoPlayNext, pick(saved?.autoPlayNext, prefs?.autoPlayNext));
        if (playNext !== undefined) setAutoPlayNext(playNext);
        const offset = pick(store?.subtitleOffset, pick(saved?.subtitleOffset, prefs?.subtitleOffset));
        if (typeof offset === "number") setSubtitleOffset(offset);
        const size = pick(store?.subtitleSize, pick(saved?.subtitleSize, prefs?.subtitleSize));
        if (size === "small" || size === "medium" || size === "large") setSubtitleSize(size);
        const filter = pick(store?.videoFilter, pick(saved?.videoFilter, prefs?.videoFilter));
        if (filter && FILTER_PRESETS.some((f) => f.id === filter)) setVideoFilter(filter);
        // Like the video filter, only a known id is ever adopted — the
        // `some` guard is the narrowing (the stored type is a plain string,
        // same as the global bucket). The global bucket is the first-class
        // home now; per-anime leftovers still read as a legacy fallback.
        const audio = pick(store?.audioFilter, prefs?.audioFilter);
        if (audio && AUDIO_FILTER_PRESETS.some((f) => f.id === audio)) {
          setAudioFilter(audio as AudioFilterId);
        }
        // Quality can only be applied once the real HLS levels are known —
        // MANIFEST_PARSED does that. Remember the wanted name for it.
        const quality = store?.quality ?? prefs?.quality;
        if (quality) pendingQualityRef.current = quality;
      }
    }
  };

  // Media-element failures (progressive 403/decode, MSE attach errors) are
  // never reported by hls.js and used to vanish silently — fail the current
  // attempt so we rotate to the next source instead of freezing on black.
  const handleVideoError = () => {
    if (attemptStateRef.current === "idle") return; // no attempt running
    if (!videoRef.current?.error) return; // stale/reset event
    failAttemptRef.current?.();
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    // Pressing play after the episode ended restarts it — the countdown is off
    setCountdown(null);
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
      videoRef.current.playbackRate = playbackRateRef.current;
      setPlaying(true);
    } else {
      videoRef.current.pause();
      setPlaying(false);
    }
  };

  // ─── Persist device settings (speed / volume / mute) ─────
  // Global bucket only — these follow the viewer across every show, so the
  // progress blob's copies (still written by saveProgress) are just the
  // legacy read fallback. Speed and mute persist on their discrete handlers;
  // the volume SLIDER fires per tick, so its writes coalesce into one flush
  // ~350ms after the last tick (patch buffer + timer below). Hydration never
  // feeds these — it only applies stored values, it never echoes them back.
  const devicePatchRef = useRef<Partial<GlobalSettings>>({});
  const deviceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistDevice = useCallback((patch: Partial<GlobalSettings>) => {
    devicePatchRef.current = { ...devicePatchRef.current, ...patch };
    if (deviceTimerRef.current) clearTimeout(deviceTimerRef.current);
    deviceTimerRef.current = setTimeout(() => {
      deviceTimerRef.current = null;
      const out = devicePatchRef.current;
      devicePatchRef.current = {};
      writeSettings(out);
    }, 350);
  }, []);

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.volume = v;
      videoRef.current.muted = v === 0;
      setVolume(v);
      setMuted(v === 0);
      persistDevice({ volume: v, muted: v === 0 });
    }
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    videoRef.current.muted = !videoRef.current.muted;
    setMuted(videoRef.current.muted);
    persistDevice({ muted: videoRef.current.muted });
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = t;
      setCurrentTime(t);
    }
    // Still interacting with this episode — cancel a running "up next" card
    setCountdown(null);
  };

  // ─── Skip ±10s (control-bar buttons; j/l are its keyboard twins) ──
  const seekBy = (delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    const max = isFinite(video.duration) && video.duration > 0 ? video.duration : Number.MAX_SAFE_INTEGER;
    video.currentTime = Math.max(0, Math.min(max, video.currentTime + delta));
    setCurrentTime(video.currentTime);
    // Skipping around means the viewer is still engaged with THIS episode —
    // drop the "up next" card instead of yanking them forward.
    setCountdown(null);
    resetControlsTimer();
  };

  // ─── Episode navigation (control-bar prev/next, drawer, countdown) ──
  const goToEpisode = useCallback(
    (n: number) => {
      if (!anilistId) return;
      // One exit door for every route change (drawer, next/prev, countdown):
      // retire the card first so it can never fire a second navigation from
      // the episode we're navigating to.
      setCountdown(null);
      saveProgress(); // SPA navigation never fires beforeunload — persist here
      // Keep the provider the user picked — dropping it would silently switch
      // back to the default provider on the next episode
      const qs = providerQuery ? `?provider=${encodeURIComponent(providerQuery)}` : "";
      // Arm the feedback overlay before the push: it paints on this instance
      // (covering the RSC fetch), then the handoff re-arms it on the next one.
      beginSwitch({
        kind: "episode",
        episode: n,
        epTitle: episodes?.find((ep) => ep.number === n)?.title,
      });
      router.push(`/anime/${anilistId}/watch/${n}${qs}`);
    },
    [anilistId, providerQuery, router, saveProgress, beginSwitch, episodes]
  );

  // ─── Episode drawer open/close (250ms slide either way) ─────
  // Drop a slide-in that hasn't painted yet (see `drawerSlideRafRef`).
  const cancelDrawerSlide = useCallback(() => {
    if (drawerSlideRafRef.current !== null) {
      cancelAnimationFrame(drawerSlideRafRef.current);
      drawerSlideRafRef.current = null;
    }
  }, []);

  const openDrawer = useCallback(() => {
    if (drawerCloseTimerRef.current) {
      clearTimeout(drawerCloseTimerRef.current);
      drawerCloseTimerRef.current = null;
    }
    cancelDrawerSlide();
    franchiseOnScrimRef.current = false;
    // Opening a surface drops the others — the same set the ⋯ trigger clears
    // when it opens: a row popover left open underneath would reappear the
    // moment the drawer closes, and the drawer is the modal now. No-ops
    // (null → null) in the normal flow, so the usual path stays put.
    setOpenPicker(null);
    setDrawerOpen(true);
    // The panel is already in the DOM (closed, off-screen); slide it in on
    // the next frame so the browser has a style to transition from. Each
    // frame's id is parked in `drawerSlideRafRef` — including the inner one —
    // so a close arriving before the slide starts can still cancel it.
    drawerSlideRafRef.current = requestAnimationFrame(() => {
      drawerSlideRafRef.current = requestAnimationFrame(() => {
        drawerSlideRafRef.current = null;
        setDrawerIn(true);
      });
    });
  }, [cancelDrawerSlide]);

  const closeDrawer = useCallback(() => {
    // The dropdown lives inside the drawer — never strand it open.
    setFranchiseOpen(false);
    // …and never strand a queued slide-in either: it would flip `drawerIn`
    // back to true after this close and pin the panel on screen.
    cancelDrawerSlide();
    setDrawerIn(false);
    if (drawerCloseTimerRef.current) clearTimeout(drawerCloseTimerRef.current);
    drawerCloseTimerRef.current = setTimeout(() => {
      drawerCloseTimerRef.current = null;
      setDrawerOpen(false);
    }, 260);
  }, [cancelDrawerSlide]);

  // Don't leave a pending unmount timer (or frame) behind
  useEffect(() => () => {
    if (drawerCloseTimerRef.current) clearTimeout(drawerCloseTimerRef.current);
    if (drawerSlideRafRef.current !== null) cancelAnimationFrame(drawerSlideRafRef.current);
  }, []);

  // Bring the current episode's row into view when the drawer opens.
  // Manual scrollTop rather than scrollIntoView: scrollIntoView would also
  // centre the row in the *document*, yanking the page under the player.
  useEffect(() => {
    if (!drawerOpen) return;
    const id = requestAnimationFrame(() => {
      const box = drawerListRef.current;
      const row = drawerCurrentRef.current;
      if (!box || !row) return;
      box.scrollTop = Math.max(
        0,
        row.offsetTop - box.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2
      );
    });
    return () => cancelAnimationFrame(id);
  }, [drawerOpen]);

  // The drawer is a fullscreen-only surface — leaving fullscreen (or any
  // route that keeps this component mounted) must not strand it open over
  // the windowed player, where there is no trigger to close it from.
  useEffect(() => {
    if (!isFullscreen && drawerOpen) closeDrawer();
  }, [isFullscreen, drawerOpen, closeDrawer]);

  // The drawer and the ⋯ menu are the player's only z-50 top surfaces, and
  // the ⋯ panel is LAST in the DOM — stacked, it would punch straight through
  // the drawer's scrim and sit on the episode list. The mouse can't get there
  // (each surface's own layer covers the other's trigger), but both triggers
  // stay keyboard-focusable while covered, so both orders are reachable.
  // One rule closes the gap: whenever they overlap, the drawer — the modal —
  // wins and the menu drops.
  useEffect(() => {
    if (drawerOpen && showMore) closeMore();
  }, [drawerOpen, showMore, closeMore]);

  // ─── Next-episode countdown ────────────────────────────────
  // One tick per second; at 0 we navigate. Every re-render (time updates land
  // ~4×/s) must NOT restart the tick, so this only re-runs when `countdown`
  // itself — or a stable dep — changes.
  useEffect(() => {
    if (countdown === null) return;
    // Never auto-advance without auto-play armed or a next episode to go to
    if (!autoPlayNext || !nextEpisodeTarget) {
      setCountdown(null);
      return;
    }
    if (countdown <= 0) {
      // Short hold on 0 so the last number actually reads before we leave
      const t = setTimeout(() => {
        setCountdown(null);
        goToEpisode(nextEpisodeTarget);
      }, 700);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, autoPlayNext, nextEpisodeTarget, goToEpisode]);

  // Leaving this episode any other way (drawer row, prev/next button) must not
  // strand a card that would navigate a second time off the new page.
  useEffect(() => {
    setCountdown(null);
    // Player remounts per episode in practice, but if this instance is ever
    // reused the auto-advance latch must re-arm for the new episode too.
    autoAdvancedRef.current = false;
    // Same reasoning for the per-anime settings: the next episode must
    // re-read the (shared) prefs bucket rather than trust a hydration that
    // belonged to the previous one.
    prefsHydratedRef.current = false;
    pendingQualityRef.current = null;
  }, [episodeNumber]);

  // Fullscreen is anchored to <html>, NOT to this container. A route change
  // (`…/watch/5` → `…/watch/6`, or another `[id]`) changes the App Router
  // segment's state key, so React unmounts the whole player subtree and
  // mounts a fresh one — any fullscreen element inside it is disconnected
  // and the browser drops fullscreen (Chrome/Safari: same-document
  // navigation keeps *user activation*, but it cannot keep a dead element).
  // <html> is never unmounted, so the mode itself survives; the container
  // then pins itself to the viewport with `fixed inset-0` while fullscreen
  // (see the root className) and presents exactly like the old
  // element-fullscreen did.
  const exitFullscreen = useCallback(() => {
    const doc = document as any;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc);
    }
    // Unlock orientation when exiting fullscreen
    if (screen.orientation && typeof screen.orientation.unlock === "function") {
      screen.orientation.unlock();
    }
  }, []);

  const toggleFullscreen = () => {
    const doc = document as any;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      exitFullscreen();
    } else {
      const el = document.documentElement as any;
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
      // Lock to landscape when entering fullscreen
      if (screen.orientation && typeof screen.orientation.lock === "function") {
        screen.orientation.lock("landscape").catch(() => {
          // Ignore if not supported or user denied
        });
      }
    }
  };

  // Sync isFullscreen state from actual fullscreen events (not optimistic)
  useEffect(() => {
    const doc = document as any;
    const handleFullscreenChange = () => {
      const inFs = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
      setIsFullscreen(inFs);
      if (!inFs && screen.orientation && typeof screen.orientation.unlock === "function") {
        screen.orientation.unlock();
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
    };
  }, []);

  const changeQuality = (q: string) => {
    // Dismiss the row dropdown on any pick (same-value clicks too) — the
    // menu drill used to close itself via closeMore(); this is its twin.
    setOpenPicker(null);
    // No change needed if already at this quality
    if (q === currentQuality) return;

    setCurrentQuality(q);
    currentQualityRef.current = q;

    if (q === "auto" && hlsRef.current) {
      hlsRef.current.currentLevel = -1;
      return;
    }

    // If an HLS level was selected, use nextLevel for smooth switching (no rebuffer)
    if (hlsLevels.length > 0 && hlsRef.current) {
      const level = hlsLevels.find((l) => l.name === q);
      if (level) {
        hlsRef.current.nextLevel = level.index;
        return;
      }
    }

    // Fallback: reload source with matching quality
    if (sources.length > 0) {
      loadHls(sources, streamHeaders, playing);
    }
  };

  const changeSpeed = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
    // Discrete handler (preset click) — write immediately.
    writeSettings({ speed: rate });
  };

  // Keyboard speed steps (shift+, / shift+.): ±0.25, clamped to 0.25–4.
  // Updates the rate state too, so the speed picker stays in sync.
  const stepPlaybackRate = (delta: number) => {
    const next = Math.min(4, Math.max(0.25, Math.round((playbackRateRef.current + delta) * 100) / 100));
    if (next === playbackRateRef.current) return;
    playbackRateRef.current = next;
    setPlaybackRate(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
    // Discrete handler (one keypress = one step) — write immediately.
    writeSettings({ speed: next });
  };

  // ─── Pick a streaming provider (control-bar dropdown) ───────
  // Reuses the manual override the error overlay uses: flipping the
  // override changes `activeProvider`, which re-runs the load effect
  // and reloads the stream with that provider.
  const selectProvider = (id: string) => {
    const current = providerOverride ?? providerId ?? "";
    if (id === current) {
      // Already the active provider — on a failed stream, retry it (fresh:
      // bypasses the failure cache so the retry actually re-walks)
      if (streamError) {
        destroyHls();
        loadByType(audioType, undefined, { fresh: true });
      }
      return;
    }
    setProviderOverride(id);
  };

  // ─── Switch sub ↔ dub ─────────────────────────────────
  const switchAudioType = useCallback(
    (type: "sub" | "dub") => {
      if (type === audioType) return;
      // Defence in depth for the muted DUB button: keyboard/AT activation can
      // reach a control a pointer never could, and the data says no dub.
      if (type === "dub" && !dubEnabled) return;
      destroyHls();
      loadByType(type);
    },
    [audioType, dubEnabled, destroyHls, loadByType]
  );

  const handleMouseMove = () => {
    resetControlsTimer();
  };

  // ─── Hold-to-2x (touch / pointer) ────────────────────
  const handlePointerDown = useCallback(() => {
    longPressRef.current = false;
    holdTimerRef.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.playbackRate = 2;
        longPressRef.current = true;
        resetControlsTimer();
      }
    }, 300);
  }, [resetControlsTimer]);

  const handlePointerUp = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (longPressRef.current && videoRef.current) {
      videoRef.current.playbackRate = playbackRateRef.current;
      longPressRef.current = false;
    }
  }, []);

  // ─── Touch swipe-to-seek (video surface, touch only) ─────────────
  // ONE horizontal finger on the bare video scrubs time: swipe RIGHT =
  // forward, swipe LEFT = back, distance-proportional (1px ≈ 100ms,
  // ±60s cap per gesture), committed as a SINGLE seek on release — never
  // per-frame. The live chip is written straight to the DOM (textContent)
  // so a 60–120Hz gesture never re-renders this component; state flips only
  // at the phase boundaries: "live" (finger down, armed) → "flash" (final
  // value held ~600ms after release) → "fade" (~300ms) → null.
  //
  // Recognition: |dx| ≥ 44px AND |dx| ≥ 2.5×|dy|. Vertical-dominant
  // movement never arms, and `touch-action: pan-y pinch-zoom` on the
  // <video> lets the BROWSER own those natively — it scrolls the page
  // (phase 1) or the pinned sections (phase 2) and fires pointercancel,
  // which aborts the gesture. Nothing here ever calls preventDefault; all
  // listeners are the passive-by-nature pointer events on the element
  // itself, not blocking window listeners.
  //
  // Exclusions come from event TARGETING: the controls overlay (its whole
  // gradient box, progress strip included), the drawer handle, the countdown
  // scrim, the skip chips and every popover are SIBLINGS above the video, so
  // a touch that starts on any of them never reaches these handlers; the
  // overlay is pointer-events-none while the HUD is hidden — exactly when
  // that strip should be free surface. A pointerdown while the ⋯ menu or a
  // picker is open also opts out (that tap is for dismissing them), as do
  // the loading/error states (nothing seekable yet).
  //
  // The long-press 2× hold is retired the moment a swipe arms, so a slow
  // scrub can't trigger (or keep) fast-forward underneath it; the release
  // path restores the rate via handlePointerUp either way. Desktop mouse
  // drags never arm (pointerType gate) — they're untouched.
  const swipeRef = useRef<{
    id: number;
    x0: number;
    y0: number;
    base: number; // currentTime at touchstart — the scrub's origin
    delta: number; // clamped live delta; release seeks base + delta once
    armed: boolean;
  } | null>(null);
  const swipeChipRef = useRef<HTMLDivElement>(null); // textContent-written each move
  const swipeFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeTapBlockRef = useRef(0); // performance.now() stamp of the last armed release
  const [seekChip, setSeekChip] = useState<"live" | "flash" | "fade" | null>(null);

  const clearSeekChipTimers = () => {
    if (swipeFlashTimerRef.current) {
      clearTimeout(swipeFlashTimerRef.current);
      swipeFlashTimerRef.current = null;
    }
    if (swipeFadeTimerRef.current) {
      clearTimeout(swipeFadeTimerRef.current);
      swipeFadeTimerRef.current = null;
    }
  };

  // Release path shared by commit and cancel: hold the chip for holdMs
  // (0 → straight into the fade for a no-op/cancel), then fade and drop it.
  // The setState calls live in the timeout CALLBACKS — never in an effect
  // body — so this stays clear of the setState-in-effect rule.
  const releaseSeekChip = (holdMs: number) => {
    clearSeekChipTimers();
    swipeFlashTimerRef.current = setTimeout(() => {
      setSeekChip("fade");
      swipeFadeTimerRef.current = setTimeout(() => setSeekChip(null), SWIPE_FADE_MS);
    }, holdMs);
  };

  const swipePointerDown = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (e.pointerType !== "touch") return; // mouse drag stays untouched
    if (loading || streamError) return; // nothing seekable yet
    if (showMore || openPicker !== null) return; // that tap dismisses a menu
    if (drawerOpen) return; // the drawer's scrim owns the surface
    if (swipeRef.current) return; // a second finger never retargets the gesture
    swipeRef.current = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      base: videoRef.current?.currentTime ?? 0,
      delta: 0,
      armed: false,
    };
  };

  const swipePointerMove = (e: React.PointerEvent<HTMLVideoElement>) => {
    const sw = swipeRef.current;
    if (!sw || sw.id !== e.pointerId) return;
    const dx = e.clientX - sw.x0;
    const dy = e.clientY - sw.y0;
    if (!sw.armed) {
      // Horizontal-dominant AND far enough to be deliberate. Anything else
      // (vertical scrolls, tiny jitters) stays unarmed and the event stream
      // untouched — the browser may claim verticals freely.
      if (Math.abs(dx) < SWIPE_ACTIVATE_PX || Math.abs(dx) < SWIPE_AXIS_RATIO * Math.abs(dy)) return;
      sw.armed = true;
      // The finger is scrubbing now — retire the long-press 2× hold so a
      // slow swipe can't arm (or keep) fast-forward underneath it.
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (longPressRef.current && videoRef.current) {
        videoRef.current.playbackRate = playbackRateRef.current;
        longPressRef.current = false;
      }
      clearSeekChipTimers(); // a fresh gesture owns the chip again
      setSeekChip("live"); // the ONE render this gesture causes
    }
    // Live scrub from the ORIGIN: distance-proportional, ±60s capped, then
    // clamped to the media's own ends — so the chip always shows exactly
    // the delta release will apply ("back" at t=2s honestly reads ◂ -2.0s).
    let delta = dx * SWIPE_RATE_S_PER_PX;
    delta = Math.max(-SWIPE_MAX_DELTA_S, Math.min(SWIPE_MAX_DELTA_S, delta));
    const video = videoRef.current;
    if (video && isFinite(video.duration) && video.duration > 0) {
      delta = Math.max(-sw.base, Math.min(video.duration - sw.base, delta));
    }
    sw.delta = delta;
    const chip = swipeChipRef.current;
    if (chip) chip.textContent = formatSeekDelta(delta); // DOM write — no re-render
  };

  const swipePointerUp = (e: React.PointerEvent<HTMLVideoElement>) => {
    const sw = swipeRef.current;
    if (!sw || sw.id !== e.pointerId) return;
    swipeRef.current = null;
    if (!sw.armed) return;
    // A completed swipe is a swipe: swallow the tap-to-toggle click some
    // browsers still emit after a touch move.
    swipeTapBlockRef.current = performance.now();
    // Released this close to where it started → the gesture returned to
    // origin: NO seek at all; the chip just retires.
    if (Math.abs(e.clientX - sw.x0) < SWIPE_EPSILON_PX) {
      releaseSeekChip(0);
      return;
    }
    // Commit: ONE seek to the final target — never per-frame — mirroring
    // seekBy's clamps; then the chip flashes that final value before fading.
    const video = videoRef.current;
    if (video) {
      const max = isFinite(video.duration) && video.duration > 0 ? video.duration : Number.MAX_SAFE_INTEGER;
      video.currentTime = Math.max(0, Math.min(max, sw.base + sw.delta));
      setCurrentTime(video.currentTime);
      // Seeking around means the viewer is engaged with THIS episode — drop
      // a pending "up next" card, exactly like the skip buttons do.
      setCountdown(null);
    }
    const chip = swipeChipRef.current;
    if (chip) chip.textContent = formatSeekDelta(sw.delta);
    releaseSeekChip(SWIPE_FLASH_MS);
  };

  const swipePointerCancel = (e: React.PointerEvent<HTMLVideoElement>) => {
    const sw = swipeRef.current;
    if (!sw || sw.id !== e.pointerId) return;
    swipeRef.current = null;
    if (!sw.armed) return;
    // The browser claimed the gesture (native vertical scroll / a second
    // finger / pinch): abort — no seek — and retire the chip into the fade.
    swipeTapBlockRef.current = performance.now();
    releaseSeekChip(0);
  };

  // Chip timers must not outlive the component — a fade scheduled right as
  // the route changes would otherwise setState on a dead tree. Cleanup only
  // clears timers (no setState here).
  useEffect(() => {
    return () => {
      if (swipeFlashTimerRef.current) clearTimeout(swipeFlashTimerRef.current);
      if (swipeFadeTimerRef.current) clearTimeout(swipeFadeTimerRef.current);
    };
  }, []);

  // ─── Auto-failover: try next server when stream errors ─────
  useEffect(() => {
    if (streamError && failoverQueueRef.current.length > 0 && !loading) {
      const nextServer = failoverQueueRef.current.shift()!;
      const cached = workingServersRef.current.find((w) => w.server === nextServer);
      if (cached) {
        setActiveServer(cached.server);
        activeServerRef.current = cached.server;
        setSources(cached.sources);
        setSubtitles(cached.subtitles);
        setStreamHeaders(cached.headers);
        destroyHls();
        setStreamError(false);
        loadHls(cached.sources, cached.headers, true);
      }
    }
  }, [streamError, loading, destroyHls, loadHls]);

  // ─── Auto-skip intro/outro ─────────────────────────────
  useEffect(() => {
    if (!autoSkipEnabled || !videoRef.current) return;
    if (inIntro && introSegment && videoRef.current) {
      videoRef.current.currentTime = introSegment.end;
    } else if (inOutro && outroSegment && videoRef.current) {
      videoRef.current.currentTime = outroSegment.end;
    }
  }, [autoSkipEnabled, inIntro, inOutro, introSegment, outroSegment]);

  // ─── Network recovery: reconnect HLS on network change ─────
  // Handles: online/offline events, VPN/WiFi↔mobile data switches
  // (navigator.connection), and periodic stall detection.
  useEffect(() => {
    // Stamp every seek (both start and finish). A seek loads the target
    // fragment with readyState pinned at 1–2 for 1–4s, which is otherwise
    // indistinguishable from a genuine stall — stallCheck must not recover
    // mid-seek (see the stallCheck guard below).
    const seekedAt = () => { lastSeekAtRef.current = performance.now(); };
    const videoEl = videoRef.current;
    videoEl?.addEventListener("seeking", seekedAt);
    videoEl?.addEventListener("seeked", seekedAt);

    const recoverStream = () => {
      const hls = hlsRef.current;
      const video = videoRef.current;
      if (!hls || !video || !hls.url) return;

      const pos = video.currentTime;
      const wasPlaying = video.paused === false;
      const srcs = sources;
      const hdrs = streamHeaders;

      // Try lightweight recover first, fall back to full reload
      try {
        hls.recoverMediaError();
        // recoverMediaError() detaches → reattaches the media element, and
        // the detach (removeAttribute('src') + load()) resets currentTime to
        // 0 and tears down every SourceBuffer — hls.js never seeks back.
        // Restore position + play state here or the element sits at 0 while
        // the buffer starts at `pos`: readyState stays <3 forever and every
        // later stall tick re-fires recovery (frozen at 0:00).
        if (Math.abs(video.currentTime - pos) > 1) video.currentTime = pos;
        if (wasPlaying) video.play().catch(() => {});
      } catch {
        if (srcs.length > 0) {
          loadHls(srcs, hdrs, false);
          const onManifestParsed = () => {
            if (videoRef.current) {
              videoRef.current.currentTime = pos;
              if (wasPlaying) videoRef.current.play().catch(() => {});
            }
            hls?.off(Hls.Events.MANIFEST_PARSED, onManifestParsed);
          };
          hls.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);
        }
      }
    };

    const handleOnline = () => recoverStream();

    const handleOffline = () => {
      // Don't pause — just let HLS buffer drain gracefully.
      // When the network comes back (online/connection change),
      // recoverStream will kick in.
    };

    // navigator.connection fires on WiFi↔mobile/VPN switches that
    // don't trigger the online/offline events.
    const conn = typeof navigator !== "undefined" ? (navigator as any).connection : null;
    const handleConnectionChange = () => {
      // Small delay so the OS has time to establish the new route
      setTimeout(recoverStream, 500);
    };

    // Periodic stall detection — if playback is frozen for >8s (two ticks),
    // try to recover even without a network event.
    // Two guards keep this from nuking a healthy seek:
    //  • skip while seeking / <3s after a seek (fragment fetch holds
    //    readyState at 1–2 the whole time), and
    //  • demand 2 consecutive stalled ticks, so one slow buffer refill can't
    //    trigger recoverMediaError() (which detaches the media and resets
    //    currentTime — recoverStream now repairs that, but avoid it anyway).
    let stalledTicks = 0;
    const stallCheck = setInterval(() => {
      const video = videoRef.current;
      const hls = hlsRef.current;
      if (!video || !hls || !hls.url || video.paused) { stalledTicks = 0; return; }
      if (video.readyState >= 3) { stalledTicks = 0; return; } // enough data, not stalled
      // Mid-seek or just-seeked → not a stall, don't count it either way.
      if (video.seeking || performance.now() - lastSeekAtRef.current < 3000) return;
      // Stalled and was playing — 2nd consecutive tick → try to recover
      stalledTicks += 1;
      if (stalledTicks < 2) return;
      stalledTicks = 0;
      recoverStream();
    }, 8000);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    conn?.addEventListener("change", handleConnectionChange);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      conn?.removeEventListener("change", handleConnectionChange);
      videoEl?.removeEventListener("seeking", seekedAt);
      videoEl?.removeEventListener("seeked", seekedAt);
      clearInterval(stallCheck);
    };
  }, [sources, streamHeaders, loadHls]);

  // ─── Recover stream when tab becomes visible again (mobile background) ──
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const video = videoRef.current;
      const hls = hlsRef.current;
      if (!video || !hls) return;

      // If video is stalled, try to recover
      if (video.readyState < 3 && hls.url) {
        // Capture state before recovery: same detach caveat as recoverStream —
        // recoverMediaError() does detachMedia()→attachMedia(), and the detach
        // (removeAttribute('src') + load()) resets currentTime to 0 and drops
        // the SourceBuffers, so the resume below is mandatory or the tab
        // comes back frozen at 0:00.
        const pos = video.currentTime;
        const wasPlaying = video.paused === false;
        try {
          hls.recoverMediaError();
          if (Math.abs(video.currentTime - pos) > 1) video.currentTime = pos;
          if (wasPlaying) video.play().catch(() => {});
        } catch { /* ignore */ }
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // ─── Keyboard shortcuts ──────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when user is typing in an input/select/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;

      const video = videoRef.current;
      if (!video) return;

      // shift + ,/. — step playback speed by 0.25 (clamped 0.25–4).
      // Matched on the physical key (e.code) so it works on any layout,
      // where e.key may report '<', ';', etc.
      if (e.shiftKey && (e.code === "Comma" || e.code === "Period")) {
        e.preventDefault();
        stepPlaybackRate(e.code === "Comma" ? -0.25 : 0.25);
        resetControlsTimer();
        return;
      }

      switch (e.key) {
        case ' ':
          e.preventDefault();
          // Ignore key repeat
          if (e.repeat) return;
          // Start hold-to-2x timer (same logic as pointer-based hold)
          spaceDownRef.current = performance.now();
          spaceWasPlayingRef.current = !video.paused;
          holdTimerRef.current = setTimeout(() => {
            if (video && !video.paused) {
              video.playbackRate = 2;
              longPressRef.current = true;
              resetControlsTimer();
            }
          }, 300);
          break;
        case 'k':
          e.preventDefault();
          // No HUD flash for keyboard toggles — the toggle is silent; the
          // controls surface only if the viewer already has them open
          togglePlay();
          break;
        // j / l — YouTube-style ±10s seek, the keyboard twins of the skip
        // buttons (whose tooltips name them). Holding the key repeats, so a
        // press-and-hold scrubs, exactly like the arrow keys.
        case 'j':
          e.preventDefault();
          seekBy(-10);
          break;
        case 'l':
          e.preventDefault();
          seekBy(10);
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
          e.preventDefault();
          video.muted = !video.muted;
          setMuted(video.muted);
          persistDevice({ muted: video.muted });
          resetControlsTimer();
          break;
        // c — subtitles on/off. Only when a track exists (no-op otherwise);
        // repeat-guarded so a held key can't flicker the track. Turning back
        // ON re-applies the default chain (English → first). Both branches
        // dual-write through `persistSubtitles` like every subtitle control.
        // The handler's deps re-subscribe on subtitle changes, so these
        // values are never stale inside the []-style closure.
        case 'c':
          e.preventDefault();
          if (!e.repeat && subtitles.length > 0) {
            if (activeSubtitle) {
              setActiveSubtitle(null);
              persistSubtitles({ subtitles: false });
            } else {
              const fallback =
                subtitles.find((s) => s.lang.toLowerCase().includes("en")) ||
                subtitles[0];
              setActiveSubtitle(fallback.url);
              persistSubtitles({ subtitles: true, subtitleLang: fallback.lang });
            }
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 10);
          setCurrentTime(video.currentTime);
          // Manual seek = still watching — dismiss the up-next card
          setCountdown(null);
          resetControlsTimer();
          break;
        case 'ArrowRight':
          e.preventDefault();
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
          setCurrentTime(video.currentTime);
          setCountdown(null);
          resetControlsTimer();
          break;
        case 'ArrowUp':
          e.preventDefault();
          { const nv = Math.min(1, video.volume + 0.1);
          video.volume = nv;
          video.muted = false;
          setVolume(nv);
          setMuted(false);
          persistDevice({ volume: nv, muted: false }); }
          resetControlsTimer();
          break;
        case 'ArrowDown':
          e.preventDefault();
          { const nv = Math.max(0, video.volume - 0.1);
          video.volume = nv;
          video.muted = nv === 0;
          setVolume(nv);
          setMuted(nv === 0);
          persistDevice({ volume: nv, muted: nv === 0 }); }
          resetControlsTimer();
          break;
        case 'Escape':
          // Open dropdowns unwind one layer per press: the franchise list
          // first, then the rest (⋯ menu, pickers, the drawer itself).
          if (franchiseOpenRef.current) {
            setFranchiseOpen(false);
            break;
          }
          setCountdown(null);
          closeMore();
          setOpenPicker(null);
          closeDrawer();
          break;
        // speed steps are handled above via e.code (shift + ,/.)
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === ' ') {
        // Clear hold timer
        if (holdTimerRef.current) {
          clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
        }
        // Restore 2x if hold fired
        if (longPressRef.current && videoRef.current) {
          videoRef.current.playbackRate = playbackRateRef.current;
          longPressRef.current = false;
        } else if (!e.repeat) {
          // Short tap — toggle play/pause (silent toggle, no HUD flash)
          togglePlay();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
    };
    // Subtitle state is a dep so the `c` handler reads the current track;
    // persistSubtitles/persistDevice are stable useCallbacks used by the `c`,
    // `m` and volume-key branches (everything else in here is refs/stable
    // setters).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitles, activeSubtitle, persistSubtitles, persistDevice]);

  // ─── ⋯ "More" menu ──────────────────────────────────────────────────────
  // The panel never picks its own spot: `PlayerMoreMenu` computes the anchor
  // (`moreMenuAnchor`) and every offset in it resolves against the
  // `relative overflow-hidden` container, so the menu can never render past
  // the player's frame. Below is the slice of live state the menu renders —
  // state, refs and effects stay here; the markup lives in PlayerMoreMenu.
  const providerCurrent = providerOverride ?? providerId ?? "";
  // The active provider's display name — one string, used by BOTH the ⋯
  // menu's Provider row and the row icon's tooltip.
  const providerValue = PROVIDER_OPTIONS.find((p) => p.id === providerCurrent)?.label ?? "Auto";
  const moreMenu = (
    <PlayerMoreMenu
      wrapRef={moreWrapRef}
      section={moreSection}
      onSectionChange={setMoreSection}
      onClose={closeMore}
      isCompact={isCompact}
      showAudioToggle={showAudioToggle}
      audioType={audioType}
      dubEnabled={dubEnabled}
      onSwitchAudioType={switchAudioType}
      providerOptions={PROVIDER_OPTIONS}
      providerCurrent={providerCurrent}
      providerValue={providerValue}
      availableServers={availableServers}
      activeServer={activeServer}
      speedOptions={speedOptions}
      playbackRate={playbackRate}
      activeSubtitle={activeSubtitle}
      filterOptions={FILTER_MENU_OPTIONS}
      videoFilter={videoFilter}
      audioFilterOptions={AUDIO_FILTER_MENU_OPTIONS}
      audioFilter={audioFilter}
      autoPlayNext={autoPlayNext}
      onToggleAutoPlayNext={() => setAutoPlayNext(!autoPlayNext)}
      autoSkipEnabled={autoSkipEnabled}
      onToggleAutoSkip={() => setAutoSkipEnabled(!autoSkipEnabled)}
      // Inline arrows on purpose (same shape the row popovers' PickerContent
      // block below mirrors): the compiler's ref rules flag handler FACTORIES
      // but accept these, and each pick performs the SAME mutation on both
      // surfaces — only the dismissed surface differs. Keep the popover's
      // twin block in sync with this one.
      onSelectProvider={(id) => { selectProvider(id); closeMore(); }}
      onSelectServer={(srv) => {
        setActiveServer(srv);
        activeServerRef.current = srv;
        closeMore();
        loadByType(audioType, srv);
      }}
      onSelectSpeed={(r) => { changeSpeed(r); closeMore(); }}
      onSelectFilter={(id) => { setVideoFilter(id as FilterId); closeMore(); }}
      onSelectAudioFilter={(id) => {
        // Apply inside the click gesture (that's the user activation the
        // AudioContext resume wants), then mirror it into state — the
        // `[audioFilter]` effect re-applies idempotently for hydration.
        applyAudioFilter(id as AudioFilterId);
        setAudioFilter(id as AudioFilterId);
        closeMore();
      }}
      subtitle={{
        activeSubtitle,
        subtitles,
        onSelect: (url) => {
          pickSubtitle(url);
          closeMore();
        },
        subtitleOffset,
        onOffsetChange: changeSubtitleOffset,
        subtitleSize,
        onSizeChange: changeSubtitleSize,
        osSearched,
        osLoading,
        osError,
        // Render-phase failedOSIdsRef read: the Set only ever mutates from
        // click handlers, so it is stable within a pass — the pre-existing
        // shape of this prop, before the row popovers shared the list.
        // eslint-disable-next-line react-hooks/refs
        osResults: osResults.filter((r) => !failedOSIdsRef.current.has(r.file_id)),
        osPage,
        osFilterQuery,
        onSearchOpenSubtitles: (page) => { searchOpenSubtitles(page); },
        onFilterChange: setOsFilterQuery,
        onSelectOpenSubtitle: (fileId) => selectOSSubtitle(fileId),
        onResetOpenSubtitles: () => {
          setOsSearched(false);
          setOsResults([]);
          setOsError(null);
          setOsPage(1);
          setOsFilterQuery("");
          failedOSIdsRef.current.clear();
        },
        activeOSSubtitleId,
        osDownloadError,
        onClearDownloadError: () => setOsDownloadError(null),
      }}
    />
  );

  // ─── Control-row icon toolbar — the ⋯ menu's options, surfaced ──────────
  // Every entry is EITHER a direct toggle (the two auto flags — the very
  // state the menu rows flip, so there is one source of truth) OR a picker
  // whose OWN popover opens right there on the row (`togglePicker` above),
  // showing the same `PickerContent` list the ⋯ menu drills into. Quality is
  // the seventh popover — same slot, same anchoring, same click-outside and
  // Escape handling (see the quality trigger below). Titles/aria-labels
  // carry the current value, so an icon-only button never leaves you guessing.
  const rowIconCls = (on: boolean) =>
    `w-9 h-10 shrink-0 sm:w-8 sm:h-8 flex items-center justify-center border transition-colors rounded-none ${
      on
        ? "text-[var(--accent)] bg-[var(--accent)]/20 border-[var(--accent)]/50"
        : "text-[var(--accent)]/50 bg-black/40 border-[var(--accent)]/20 hover:text-[var(--accent)] hover:border-[var(--accent)]/50"
    }`;
  const rowIconGlyph = "w-5 h-5 sm:w-4 sm:h-4";
  // Descriptors in ROW_ICON_PRIORITY order — the fit effect's slice(0, n)
  // takes the FIRST n, so this array must stay in that exact order.
  const rowIcons: {
    id: RowIconId;
    label: string;
    title: string;
    icon: ReactNode;
    /** Present → it is a toggle (`aria-pressed`); absent → `picker` opens. */
    pressed?: boolean;
    toggle?: () => void;
    /** Opens this picker's OWN anchored popover on the row (`togglePicker`). */
    picker?: MoreSection;
  }[] = [
    {
      id: "subs",
      label: "Subtitles",
      title: `Subtitles: ${activeSubtitle ? "On" : "Off"}`,
      icon: <SubtitleIcon className={rowIconGlyph} />,
      picker: "subs",
    },
    {
      id: "speed",
      label: "Speed",
      title: `Speed: ${playbackRate}x`,
      icon: <SpeedIcon className={rowIconGlyph} />,
      picker: "speed",
    },
    // Same condition as the ⋯ menu's Server row: no servers, no icon.
    ...(availableServers.length > 0
      ? [
          {
            id: "server" as const,
            label: "Server",
            title: `Server: ${activeServer || "Auto"}`,
            icon: <ServerIcon className={rowIconGlyph} />,
            picker: "server" as const,
          },
        ]
      : []),
    {
      id: "autoSkip",
      label: "Auto Skip",
      title: `Auto Skip: ${autoSkipEnabled ? "On" : "Off"}`,
      icon: <Forward10Icon className={rowIconGlyph} />,
      pressed: autoSkipEnabled,
      toggle: () => setAutoSkipEnabled(!autoSkipEnabled),
    },
    {
      id: "autoPlay",
      label: "Auto Play",
      title: `Auto Play: ${autoPlayNext ? "On" : "Off"}`,
      icon: <PlayIcon className={rowIconGlyph} />,
      pressed: autoPlayNext,
      toggle: () => setAutoPlayNext(!autoPlayNext),
    },
    {
      id: "provider",
      label: "Provider",
      title: `Provider: ${providerValue}`,
      icon: <GlobeIcon className={rowIconGlyph} />,
      picker: "provider",
    },
    {
      id: "filter",
      label: "Filter",
      title: `Filter: ${FILTER_MENU_OPTIONS.find((f) => f.id === videoFilter)?.label ?? "Off"}`,
      icon: <VideoFilterIcon className={rowIconGlyph} />,
      picker: "filter",
    },
    {
      id: "audio",
      label: "Audio",
      title: `Audio: ${AUDIO_FILTER_MENU_OPTIONS.find((f) => f.id === audioFilter)?.label ?? "Off"}`,
      icon: <AudioFilterIcon className={rowIconGlyph} />,
      picker: "audio",
    },
  ];

  return (
    <div className="w-full">
    <div
      ref={containerRef}
      // Windowed: in-flow, and the BOX follows the content's own aspect ratio
      // (16:9 until metadata, then videoWidth:videoHeight via
      // syncContentAspect) — edge-to-edge at full column width, with the
      // video contained inside it. Fullscreen: <html> is the fullscreen
      // element, so the player pins itself to the viewport — above every page
      // layer (the navbar is z-50) — and fills the screen exactly like the old
      // element-fullscreen did, with nothing else visible underneath; no
      // aspect or height constraint there, the viewport wins and the video
      // letterboxes itself.
      className={`w-full bg-black overflow-hidden group outline-none ${
        isFullscreen
          ? "fixed inset-0 z-[100]"
          : `relative${
              // Height cap only for content TALLER than 16:9 (its job is
              // keeping 4:3 from taking over a short viewport). When the cap
              // clamps, the box ends up wider than the ratio and the
              // contained video simply pillarboxes — still never stretched.
              // 16:9/wide content is never capped, so it keeps exactly the
              // look it has today.
              contentAspect < 16 / 9 ? " max-h-[calc(100vh_-_8rem)]" : ""
            }`
      }`}
      style={isFullscreen ? undefined : { aspectRatio: contentAspect }}
      tabIndex={0}
      onMouseMove={handleMouseMove}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && containerRef.current && !containerRef.current.contains(next)) {
          // Focus left the player entirely — drop whatever row popover was
          // open (the old quality-only equivalent; one slot holds all seven).
          setOpenPicker(null);
        }
      }}
    >
      {/* Switch-overlay + skip-chip keyframes (inline so they ship with the player) */}
      <style>{`
        /* Accent band sweeping down the switch overlay — the "scan" read */
        @keyframes n54-switch-sweep {
          0% { transform: translateY(-60%); opacity: 0; }
          15% { opacity: 1; }
          85% { opacity: 1; }
          100% { transform: translateY(320%); opacity: 0; }
        }
        .n54-switch-sweep {
          animation: n54-switch-sweep 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        @keyframes n54-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
        .n54-blink { animation: n54-blink 900ms steps(1, end) infinite; }
        /* Skip chip entrance — fades up the moment a segment window opens */
        @keyframes n54-skip-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .n54-skip-in { animation: n54-skip-in 240ms cubic-bezier(0.16, 1, 0.3, 1); }
        /* ── Item 1: real seek-thumb buffering pulse ──────────────────────
           While the media is starved the ACTUAL seek thumb (the accent square
           you scrub with) breathes 1 → 1.35 → 1 on a ~900ms ease-in-out loop
           — no separate overlay head. Scale-only (the thumb is positioned by
           the range input itself; a translate would knock it off the track),
           so the resting w-3/h-3 geometry and the hover:scale-125 behaviour are
           untouched — the animation only overrides transform while it runs. */
        @keyframes n54-thumb-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.35); }
        }
        /* Scoped to the input via a conditional class so both engine thumbs
           (::-webkit-slider-thumb / ::-moz-range-thumb) pulse together. */
        .thumb-buffering::-webkit-slider-thumb { animation: n54-thumb-pulse 900ms ease-in-out infinite; }
        .thumb-buffering::-moz-range-thumb { animation: n54-thumb-pulse 900ms ease-in-out infinite; }
        /* ── Item 2: drawer chevron entrances ────────────────────────────
           The open handle's left-chevron slides in from the right (the side
           the drawer arrives from); the close right-chevron mirrors it,
           sliding in from the left. ~180ms ease-out, matching the drawer's
           own 250ms slide. */
        @keyframes n54-chevron-in-right {
          from { opacity: 0; transform: translateX(8px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes n54-chevron-in-left {
          from { opacity: 0; transform: translateX(-8px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .n54-chevron-in-right { animation: n54-chevron-in-right 180ms ease-out; }
        .n54-chevron-in-left { animation: n54-chevron-in-left 180ms ease-out; }
        @media (prefers-reduced-motion: reduce) {
          .n54-switch-sweep { animation: none; opacity: 0.6; }
          .n54-blink { animation: none; }
          .n54-skip-in { animation: none; }
          .thumb-buffering::-webkit-slider-thumb,
          .thumb-buffering::-moz-range-thumb { animation: none; }
          .n54-chevron-in-right,
          .n54-chevron-in-left { animation: none; }
        }
      `}</style>

      {/* Video element — also the swipe-to-seek surface (see the "Touch
          swipe-to-seek" block on swipePointerDown). `touch-action:
          pan-y pinch-zoom` is what makes the pass-through real: vertical pans
          and pinch zoom stay the BROWSER's to claim (page scroll in phase 1,
          the pinned sections in phase 2), which cancels the gesture via
          pointercancel; horizontal movement is never claimable, so the scrub
          always keeps its events. No preventDefault anywhere. */}
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        style={{
          filter: videoFilter === "off" ? undefined : getFilterCSS(videoFilter),
          touchAction: "pan-y pinch-zoom",
        }}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onError={handleVideoError}
        onPlay={() => {
          setPlaying(true);
          // Playback restarted for any reason → the viewer is watching again,
          // so a pending up-next card has no business auto-advancing.
          setCountdown(null);
        }}
        onPause={() => {
          setPlaying(false);
          setIsBuffering(false);
        }}
        // Buffer read-out (queue #4): `progress` feeds the seekbar's buffered
        // segments; waiting/stalled vs playing/canplay flip the "starved"
        // flag that drives the playhead pulse — normal playback never sets it.
        onProgress={handleBufferProgress}
        onWaiting={() => setIsBuffering(true)}
        onStalled={() => setIsBuffering(true)}
        onPlaying={() => setIsBuffering(false)}
        onCanPlay={() => setIsBuffering(false)}
        onEnded={() => {
          setPlaying(false);
          // AUTO-PLAY ON → NO countdown prompt at all: advance immediately
          // through the very seam the countdown used to fire (goToEpisode
          // arms the switch card via beginSwitch and router.pushes — no
          // video.play(), so the browser's autoplay policy is never fought,
          // and the fullscreen loading-card rules are unchanged).
          //
          // AUTO-PLAY OFF → nothing happens, exactly as before (the countdown
          // was never an OFF-path feature: this was its only arming site).
          // No next episode to go to — end of season, or a provider that
          // stopped mid-list — → nothing happens either, so the episode just
          // sits at its end with the control bar up.
          //
          // Skip-outro ordering: auto-skip seeks to the segment END, which
          // can land on the last frame and fire `ended` in the same breath as
          // the natural end of the file. The latch makes that a single
          // advance instead of two.
          if (!autoPlayNext || !nextEpisodeTarget || autoAdvancedRef.current) return;
          autoAdvancedRef.current = true;
          goToEpisode(nextEpisodeTarget);
        }}
        playsInline
        crossOrigin="anonymous"
        onClick={() => {
          // A completed (or cancelled) swipe owns this tap — some browsers
          // still emit a click after a touch move, and it must not toggle
          // playback the gesture never asked for.
          if (performance.now() - swipeTapBlockRef.current < SWIPE_TAP_BLOCK_MS) return;
          togglePlay();
        }}
        onPointerDown={(e) => {
          handlePointerDown();
          swipePointerDown(e);
        }}
        onPointerMove={swipePointerMove}
        onPointerUp={(e) => {
          swipePointerUp(e);
          handlePointerUp();
        }}
        onPointerCancel={(e) => {
          swipePointerCancel(e);
          handlePointerUp();
        }}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* Swipe-to-seek chip — centered on the frame, pure feedback
          (pointer-events-none, aria-hidden): the live scrub delta while the
          finger is down — "▸ +12.4s" swiped right (forward), "◂ -8.1s"
          swiped left (back) — then the final value flashed on release
          (~600ms) and a ~300ms fade. It stays MOUNTED at opacity-0 so the
          per-frame textContent writes (swipePointerMove) always have a
          target — the move that arms the gesture lands its first value in
          the same frame, no empty flash, no re-render. z-30: over the HUD
          (z-20), under the drawer handle / countdown / drawer (z-40+). */}
      <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center" aria-hidden="true">
        <div
          ref={swipeChipRef}
          className={`rounded-none border border-[var(--accent)]/40 bg-black/70 px-3 py-1.5 font-mono text-xs leading-none tabular-nums tracking-wide text-[var(--accent)] shadow-lg transition-opacity motion-reduce:transition-none ${
            seekChip === "live" || seekChip === "flash"
              ? "opacity-100 duration-150"
              : "opacity-0 duration-300"
          }`}
        />
      </div>

{/* Loading overlay — simple terminal progress bar.
          Item 3 / Rule 1: suppressed while the LOADING-EPISODE switch card is
          actually rendering (`!switchCardVisible` — fullscreen only). During a
          seamless FULLSCREEN switch both `loading` and `switchTo` are true at
          once; this z-10 overlay used to stack under the z-60 card as a SECOND
          visible loader. In WINDOWED playback the card is hidden (Rule 1), so
          this lighter overlay is the switch's loader there. Once the card
          fades (`switchCardVisible` → false) normal loading behaviour resumes. */}
      {loading && !switchCardVisible && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10 pointer-events-none">
          <div className="flex flex-col items-center gap-4 w-80 max-w-[85%]">
            <div className="w-full h-2 bg-[var(--background)] border border-[var(--accent)]/30 relative overflow-hidden">
              <div className="absolute inset-y-0 left-0 h-full bg-[var(--accent)] animate-loading-bar" />
            </div>
            <div className="font-mono text-[10px] text-[var(--accent)]/50 tracking-[0.2em]">
              [ {animeTitle?.substring(0, 20) || "STREAM"} ]
            </div>
            {/* Slow-load honesty: the provider chain can legitimately take
                ~20s, so say so instead of spinning in silence. The timer that
                arms this lives with `loading` and is torn down when it settles. */}
            {slowLoad && (
              <div
                role="status"
                aria-live="polite"
                className="font-mono text-[10px] tracking-[0.15em] text-[var(--accent)]/70"
              >
                Still checking providers…
              </div>
            )}
            {/* Mount handoff note — "Episode 57 isn't available yet — playing
                episode 56." Only the mount-time handoff ever sets it (every
                user-driven load window clears it first), so it can only
                describe the one episode swap that got THIS load moving. It
                lives and dies with this overlay: playback start unmounts it,
                and exhaustion hands the screen to the error card, which owns
                its own reason line. */}
            {handoffNote && (
              <p
                role="status"
                aria-live="polite"
                className="font-mono text-[10px] tracking-[0.15em] text-[var(--accent)]/70"
              >
                Episode {handoffNote.from} isn&rsquo;t available yet — playing
                episode {handoffNote.to}.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Switch feedback — armed by the drawer's series dropdown and episode
          rows (the prev/next + up-next controls share `goToEpisode`, so they
          get it too). Sits above the HUD (z-20/40), the up-next card (z-45)
          and the drawer (z-50); pointer-transparent so it can never trap the
          viewer — it tracks the real load and fades out (dismissal effect
          above), with a 700ms floor so an instant load never flashes. */}
      {switchCardVisible && (
        <div
          role="status"
          aria-live="polite"
          aria-label={`Switching to ${switchTo.series}, episode ${switchTo.episode}`}
          className={`absolute inset-0 z-[60] flex flex-col justify-center overflow-hidden bg-black/90 px-6 transition-opacity duration-300 pointer-events-none sm:px-12 ${
            switchFade ? "opacity-0" : "opacity-100"
          }`}
        >
          {/* CRT scanlines */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg, rgba(0,0,0,0.5) 0px, rgba(0,0,0,0.5) 1px, transparent 1px, transparent 3px)",
            }}
          />
          {/* Accent band sweeping down — the "scan" read */}
          <div
            aria-hidden="true"
            className="n54-switch-sweep pointer-events-none absolute inset-x-0 top-0 h-1/4 bg-gradient-to-b from-transparent via-[var(--accent)]/25 to-transparent"
          />

          <div className="relative min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.35em] text-[var(--accent)]/70">
              {switchTo.kind === "series" ? "// switching series" : "// loading episode"}
              <span className="n54-blink">_</span>
            </div>

            <div className="mt-2 truncate text-2xl font-bold uppercase tracking-wider text-[var(--accent)] sm:text-4xl">
              {switchTo.series}
            </div>

            <div className="mt-2 flex min-w-0 items-center gap-2">
              <span className="shrink-0 border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-[var(--accent)]">
                {`EP ${String(switchTo.episode).padStart(2, "0")}`}
              </span>
              {switchTo.epTitle && (
                <span className="min-w-0 truncate font-mono text-xs text-[var(--text-secondary)]">
                  {switchTo.epTitle}
                </span>
              )}
            </div>

            <div className="relative mt-5 h-2 w-full max-w-xs overflow-hidden border border-[var(--accent)]/30 bg-[var(--background)] sm:max-w-sm">
              <div className="absolute inset-y-0 left-0 h-full bg-[var(--accent)] animate-loading-bar" />
            </div>

            <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--accent)]/40">
              {"> awaiting source\u2026"}
            </div>
          </div>
        </div>
      )}

      {/* Subtitle overlay */}
      {activeSubtitle && !loading && (
        <SubtitleOverlay
          subtitleUrl={activeSubtitle}
          videoRef={videoRef}
          headers={streamHeaders || undefined}
          offset={subtitleOffset}
          size={subtitleSize}
          controlsVisible={showControls}
        />
      )}

      {/* Error overlay — a real "no stream" state, not a generic error string.
          Retry re-runs the whole lookup (server → provider chain); the escape
          hatch goes back to the episode list rather than leaving the viewer
          stuck on a player that has nothing to play. */}
      {streamError && !loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
          <div className="text-center max-w-sm px-4">
            {/* Heading + reason are the shared card's. `note` is whatever
                `/api/stream` told us; when it had nothing to add we fall back
                to the generic line. */}
            <EmptyState code="NO_STREAM_FOUND" note={streamErrorDetail} className="" />
            <div className="flex flex-wrap gap-2 justify-center">
              <Button variant="accent" onClick={() => { destroyHls(); loadByType(audioType, undefined, { fresh: true }); }}>
                Retry
              </Button>
              {/* The dub escape hatch is gated by the same data as the SUB/DUB
                  control — offering "Try Dub" for an episode the list says has
                  no dub would be the guess we just removed. A dub track that IS
                  playing still offers "Try Sub". */}
              {(audioType !== "sub" || dubEnabled) && (
                <Button
                  variant="quiet"
                  onClick={() => { destroyHls(); loadByType(audioType === "sub" ? "dub" : "sub", undefined, { fresh: true }); }}
                >
                  {audioType === "sub" ? "Try Dub" : "Try Sub"}
                </Button>
              )}
              {anilistId && (
                <Link
                  href={`/anime/${anilistId}${providerQuery ? `?provider=${encodeURIComponent(providerQuery)}` : ""}`}
                  className={buttonClass("quietLink")}
                >
                  All Episodes
                </Link>
              )}
            </div>
            {/* Provider picker — only shown when the stream fails */}
            <div className="mt-4 pt-3 border-t border-white/10">
              <p className="text-[var(--text-decorative)] text-[10px] uppercase tracking-widest mb-2 font-mono">
                // Switch Provider
              </p>
              <div className="flex flex-wrap gap-1.5 justify-center">
                {PROVIDER_OPTIONS.map((p) => {
                  const current = providerOverride ?? providerId ?? "";
                  const isActive = current === p.id;
                  return (
                    <Button
                      key={p.id}
                      variant="provider"
                      active={isActive}
                      onClick={() => {
                        if (p.id === current) {
                          // Same provider — force a retry (fresh: bypasses the
                          // failure cache so it actually re-walks providers)
                          destroyHls();
                          loadByType(audioType, undefined, { fresh: true });
                        } else {
                          // Different provider — override triggers the load effect
                          setProviderOverride(p.id);
                        }
                      }}
                    >
                      {p.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Skip intro/outro — the PRIMARY action while a segment window is
          open: solid accent chip (mono uppercase, rounded-none, house
          glow), parked bottom-20 / right-3 — the measured 80px clearance
          over the control cluster (80px tall mobile / 68px desktop) — so it
          mirrors the right-hand controls and never covers the transport.
          The drain strip under the label shows the window emptying; the chip
          auto-dismisses the instant the window closes (armed auto-skip still
          jumps at that same end), and the 240ms entrance gives the moment
          the window opens a beat of its own. z-30 keeps it over the HUD
          while stepping to z-[19] when a row popover is open, so the
          popover — which lives inside the HUD's z-20 stacking context —
          always paints over it; the ⋯ panel and drawer are top-level z-50
          and need no such help. */}
      {!loading && sources.length > 0 && (inIntro || inOutro) && (
        <div className={`absolute bottom-20 right-3 flex justify-end gap-2 sm:gap-3 ${openPicker !== null ? "z-[19]" : "z-30"}`}>
          {inIntro && introSegment && (
            <button
              onClick={() => { if (videoRef.current) videoRef.current.currentTime = introSegment.end; }}
              className="n54-skip-in group relative overflow-hidden rounded-none border border-[var(--accent)] bg-[var(--accent)] px-4 py-2.5 text-black accent-shadow-sm transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              <span className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.18em]">
                Skip Intro
                <SkipChevronIcon className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
              {/* Drain strip: width = share of the segment window left */}
              <span
                className="absolute inset-x-0 bottom-0 h-[3px] bg-black/30"
                style={{ width: `${Math.max(0, Math.min(100, ((introSegment.end - currentTime) / Math.max(1, introSegment.end - introSegment.start)) * 100))}%` }}
              />
            </button>
          )}
          {inOutro && outroSegment && (
            <button
              onClick={() => { if (videoRef.current) videoRef.current.currentTime = outroSegment.end; }}
              className="n54-skip-in group relative overflow-hidden rounded-none border border-[var(--accent)] bg-[var(--accent)] px-4 py-2.5 text-black accent-shadow-sm transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              <span className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.18em]">
                Skip Outro
                <SkipChevronIcon className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
              <span
                className="absolute inset-x-0 bottom-0 h-[3px] bg-black/30"
                style={{ width: `${Math.max(0, Math.min(100, ((outroSegment.end - currentTime) / Math.max(1, outroSegment.end - outroSegment.start)) * 100))}%` }}
              />
            </button>
          )}
        </div>
      )}

        {/* Controls overlay (bottom) */}
      <div
        className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent pt-12 pb-3 px-2 sm:px-3 transition-opacity duration-300 z-20 ${
          showControls ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Progress bar — buffered ranges paint a lighter segment UNDER the
            input (its tail is translucent white, so they read through); the
            pulse + label ride the playhead (edge-clamped) only while the
            media is starved — waiting/stalled — never in normal playback. */}
        <div className="group/bar relative mb-2 h-4 flex items-center">
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2" aria-hidden="true">
            {bufferedRanges.map((r, i) => (
              <div
                key={i}
                className="absolute top-0 h-full bg-white/25"
                style={{ left: `${r.start}%`, width: `${Math.max(0, r.end - r.start)}%` }}
              />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
            aria-label="Seek"
            className={`progress-range w-full h-1 appearance-none cursor-pointer relative z-10 ${
              // Item 1: while the media is starved the REAL thumb pulses (see
              // `.thumb-buffering` in the style block above). Gated on
              // !switchCardVisible so the LOADING-EPISODE card (fullscreen
              // only) owns the seamless-switch window. Windowed switches keep
              // the thumb pulse (the card is hidden there).
              isBuffering && !switchCardVisible ? "thumb-buffering" : ""
            }
                       [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                       [&::-webkit-slider-thumb]:-mt-[4px] [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:rounded-none
                       [&::-webkit-slider-thumb]:shadow-md
                       [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-150
                       [&::-webkit-slider-thumb]:hover:scale-125
                       [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-none
                       [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-none
                       [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3
                       [&::-moz-range-thumb]:-mt-[4px] [&::-moz-range-thumb]:bg-[var(--accent)] [&::-moz-range-thumb]:rounded-none
                       [&::-moz-range-thumb]:border-none`}
            style={{
              background: `linear-gradient(to right, rgba(var(--accent-rgb),0.9) ${progress}%, rgba(var(--accent-rgb),0.2) ${progress}%, rgba(255,255,255,0.1) ${progress}%)`,
            }}
          />
          {isBuffering && (
            // Item 1: the separate overlay head is GONE — the real seek thumb
            // pulses in place (see `.thumb-buffering` above). Only the screen-
            // reader path remains, so removing the visual element loses no
            // information for SR. Gated on !switchCardVisible so the LOADING-
            // EPISODE card (fullscreen only) owns the seamless-switch window
            // (Item 3 / Rule 1) — no double signal. Windowed switches keep the
            // sr-only region (the card is hidden there, so nothing stacks).
            !switchCardVisible && (
              <span role="status" aria-live="polite" className="sr-only">
                Buffering
              </span>
            )
          )}
        </div>

        {/* Controls row — grouped by priority, never scrolled. Left group:
            the always-on essentials (transport, volume, time); right group:
            quality, then as many priority-ordered icon-only buttons as fit
            (see ROW_ICON_PRIORITY / the rowIconCount effect), then the ⋯ menu
            that parks everything else. No horizontal strip, no edge chevrons
            — the row always fits; when in doubt an icon drops out.

            `z-20` is load-bearing: the seekbar input is `relative z-10`, so
            without an explicit z-index here the picker menus (z-50) open
            *under* the seekbar. The row lifts itself — menus included — above it. */}
        <div ref={rowRef} className="relative z-20 flex w-full items-center justify-between gap-2 sm:gap-6 select-none">
          {/* Left group: prev/next episode, transport, volume, time — the
              essentials, always first so they are on screen at offset 0 */}
          <div ref={leftGroupRef} className="flex items-center gap-1 sm:gap-3 shrink-0">
            {/* Previous episode — first thing to go when the row gets tight */}
            <button
              onClick={() => { if (prevEpisodeTarget) goToEpisode(prevEpisodeTarget); }}
              disabled={!prevEpisodeTarget}
              title={prevEpisodeTarget ? `Episode ${prevEpisodeTarget}` : "First episode"}
              aria-label="Previous episode"
              className={`hidden sm:flex items-center justify-center transition-colors w-10 h-10 sm:w-8 sm:h-8 ${
                prevEpisodeTarget
                  ? "text-[var(--accent)]/50 hover:text-[var(--accent)]"
                  : "text-[var(--accent)]/50 opacity-30 cursor-not-allowed"
              }`}
            >
              <PrevTrackIcon className="w-6 h-6 sm:w-5 sm:h-5" />
            </button>

            {/* Skip back 10s — double-chevron rewind (`<<`); J is its
                keyboard twin, and the tooltip says so */}
            <button
              onClick={() => seekBy(-10)}
              title="Back 10 seconds (J)"
              aria-label="Skip back 10 seconds"
              className="flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors w-10 h-10 sm:w-8 sm:h-8"
            >
              <Rewind10Icon className="w-6 h-6 sm:w-5 sm:h-5" />
            </button>

            {/* Play/Pause */}
            <button
              onClick={() => togglePlay()}
              aria-label={playing ? "Pause" : "Play"}
              className="flex items-center justify-center text-[var(--accent)] hover:text-white transition-colors w-10 h-10 sm:w-8 sm:h-8"
            >
              {playing ? (
                <PauseIcon className="w-6 h-6 sm:w-5 sm:h-5" />
              ) : (
                <PlayIcon className="w-6 h-6 sm:w-5 sm:h-5" />
              )}
            </button>

            {/* Skip forward 10s — double-chevron fast-forward (`>>`); L is
                its keyboard twin */}
            <button
              onClick={() => seekBy(10)}
              title="Forward 10 seconds (L)"
              aria-label="Skip forward 10 seconds"
              className="flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors w-10 h-10 sm:w-8 sm:h-8"
            >
              <Forward10Icon className="w-6 h-6 sm:w-5 sm:h-5" />
            </button>

            {/* Next episode */}
            <button
              onClick={() => { if (nextEpisodeTarget) goToEpisode(nextEpisodeTarget); }}
              disabled={!nextEpisodeTarget}
              title={nextEpisodeTarget ? `Episode ${nextEpisodeTarget}` : "No next episode"}
              aria-label="Next episode"
              className={`hidden sm:flex items-center justify-center transition-colors w-10 h-10 sm:w-8 sm:h-8 ${
                nextEpisodeTarget
                  ? "text-[var(--accent)]/50 hover:text-[var(--accent)]"
                  : "text-[var(--accent)]/50 opacity-30 cursor-not-allowed"
              }`}
            >
              <NextTrackIcon className="w-6 h-6 sm:w-5 sm:h-5" />
            </button>

            {/* Volume */}
            <div className="flex items-center gap-1 group/vol">
              <button
                onClick={toggleMute}
                aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
                className="flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors w-10 h-10 sm:w-8 sm:h-8"
              >
                {muted || volume === 0 ? (
                  <VolumeMutedIcon className="w-6 h-6 sm:w-5 sm:h-5" />
                ) : (
                  <VolumeIcon className="w-6 h-6 sm:w-5 sm:h-5" />
                )}
              </button>
              <div className="overflow-hidden w-0 sm:group-hover/vol:w-24 transition-all duration-200 h-8 flex items-center">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={handleVolume}
                  aria-label="Volume"
                  className="w-20 sm:w-24 h-1 appearance-none cursor-pointer
                             [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                             [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:rounded-none"
                  style={{
                    background: `linear-gradient(to right, rgba(var(--accent-rgb),0.5) ${(muted ? 0 : volume) * 100}%, rgba(255,255,255,0.1) ${(muted ? 0 : volume) * 100}%)`,
                  }}
                />
              </div>
            </div>

            {/* Time — ONE spec at every width and control state (was
                text-[10px] sm:text-sm, which jumped sizes between a portrait
                phone and landscape/fullscreen — the "it shrinks" read):
                text-xs mono, tabular-nums (no digit-width jitter), nowrap,
                and the current-time box min-width pinned to its worst-case
                digit count so the 9:59 → 10:00 flip can't reflow the row (the
                fit observer sees a stable box instead). The full "cur / dur"
                readout stays sm+ — below sm only the elapsed clock fits in
                the 360px row budget; that's CONTENT gating, not a size
                switch: the glyphs are text-xs in both states. */}
            <span className="shrink-0 select-none whitespace-nowrap font-mono text-xs leading-none tabular-nums text-[var(--accent)]/50">
              <span className="inline-block min-w-[5ch]">{formatTime(currentTime)}</span>
              <span className="hidden sm:inline"> / {formatTime(duration)}</span>
            </span>
          </div>

          {/* Right group: the fixed chunk (SUB/DUB at lg+, quality), then
              the priority-ordered icon toolbar (as many as fit — see
              ROW_ICON_PRIORITY), then ⋯ and fullscreen, which always stay.
              (The episode drawer is NOT here — it is an edge handle, see below) */}
          <div className="flex items-center gap-1.5 justify-end shrink-0">
            {/* Fixed chunk — measured as ONE unit by the fit effect. */}
            <div ref={fixedRightRef} className="flex items-center gap-1.5">
            {/* Second tier — lg+ only inline; below lg the same controls
                live in the ⋯ menu, so nothing is ever offered twice */}
            <div className="hidden lg:contents">
            {/* Sub / Dub segmented toggle — data-gated: shown as soon as the
                episode's flag is known, with DUB dimmed + inert when it isn't
                there. Never a guess: a known "no dub" wins over any probe. */}
            {showAudioToggle && (
              <div className="flex items-center bg-black/40 border border-[var(--accent)]/20 overflow-hidden rounded-none">
                <button
                  onClick={() => switchAudioType("sub")}
                  aria-pressed={audioType === "sub"}
                  className={`px-3 text-[11px] font-semibold tracking-wide transition-colors h-7 ${
                    audioType === "sub" || !dubEnabled
                      ? "bg-[var(--accent)] text-black"
                      : "text-[var(--accent)]/50 hover:text-[var(--accent)]"
                  }`}
                >
                  SUB
                </button>
                <div className="w-px h-4 bg-[var(--accent)]/20" />
                <button
                  onClick={() => switchAudioType("dub")}
                  disabled={!dubEnabled}
                  aria-pressed={audioType === "dub" && dubEnabled}
                  title={dubEnabled ? undefined : "No dub for this episode"}
                  className={`px-3 text-[11px] font-semibold tracking-wide transition-colors h-7 ${
                    audioType === "dub" && dubEnabled
                      ? "bg-[var(--accent)] text-black"
                      : dubEnabled
                      ? "text-[var(--accent)]/50 hover:text-[var(--accent)]"
                      : "cursor-not-allowed text-[var(--accent)]/25"
                  }`}
                >
                  DUB
                </button>
              </div>
            )}
            </div>

            {/* Quality selector — icon-only now, but still ALWAYS on the row
                (the second tier stays lg+-only, and quality must remain
                reachable at every width since its ⋯ drill is gone; ⋯ carries
                Speed instead). The label text moved into the title/aria-label;
                the popover keeps its compact w-28 list but joins the picker
                slot: same toggle-close, same measured side + caps, same
                click-outside / Escape handling as the six picker popovers. */}
            <div ref={qualityWrapRef} className="relative h-full flex items-center">
              <button
                onClick={(e) => togglePicker("quality", e.currentTarget)}
                aria-label={`Quality: ${currentQuality === "auto" ? "Auto" : currentQuality}`}
                aria-haspopup="true"
                aria-expanded={showQualityPicker}
                title={`Quality: ${currentQuality === "auto" ? "Auto" : currentQuality}`}
                className={rowIconCls(showQualityPicker)}
              >
                <QualityIcon className={rowIconGlyph} />
              </button>
              {showQualityPicker && pickerAnchor && (
                <div
                  role="group"
                  aria-label="Quality options"
                  className={`absolute bottom-full mb-1.5 z-50 w-28 overflow-y-auto overflow-x-hidden overscroll-contain rounded-none border border-[var(--accent)]/20 bg-[var(--panel)] shadow-xl backdrop-blur-sm ${pickerAnchor.side === "right" ? "right-0" : "left-0"}`}
                  style={{ maxWidth: pickerAnchor.maxW, maxHeight: pickerAnchor.maxH }}
                >
                  <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] text-[var(--accent)]/30 uppercase tracking-wider font-semibold font-mono">
                    Quality
                  </div>
                  {availableQualities.map((q) => (
                    <button
                      key={q}
                      onClick={() => changeQuality(q)}
                      className={`w-full text-left px-2.5 py-1.5 text-xs transition-colors rounded-none ${
                        currentQuality === q
                          ? "bg-[var(--accent)]/20 text-[var(--accent)] border-l-2 border-[var(--accent)]"
                          : "text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5"
                      }`}
                    >
                      {q === "auto" ? "Auto" : q}
                    </button>
                  ))}
                </div>
              )}
            </div>
            </div>

            {/* Icon toolbar — the ⋯ menu's options as icon-only buttons, in
                ROW_ICON_PRIORITY order, cut at whatever the fit effect says
                fits (0..N; drop-outs simply live on in the ⋯ menu). The two
                toggles are plain buttons; every picker is wrapped with its
                popover in one `relative` unit, so the panel hangs off its own
                icon and the click-outside test sees trigger + panel together.
                Same glyph as the option's menu row; title + aria-label always
                carry the word AND the current value, and the two toggles also
                carry aria-pressed. */}
            <div className="flex items-center gap-1.5">
              {rowIcons.slice(0, rowIconCount).map((it) => {
                // Toggle (auto play / auto skip) — one press, one state flip,
                // the exact state the ⋯ menu's checkbox rows flip.
                if (it.pressed !== undefined) {
                  const pressed = it.pressed;
                  const toggle = it.toggle;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => toggle?.()}
                      aria-label={it.label}
                      aria-pressed={pressed}
                      title={it.title}
                      className={rowIconCls(pressed)}
                    >
                      {it.icon}
                    </button>
                  );
                }
                // Picker — its OWN popover anchored at this icon, rendering
                // the same `PickerContent` the ⋯ menu drills into.
                const pickerId = it.picker;
                if (!pickerId) return null;
                const open = openPicker === pickerId;
                return (
                  <div
                    key={it.id}
                    ref={(el) => { pickerWrapRefs.current[pickerId] = el; }}
                    className="relative flex items-center"
                  >
                    <button
                      type="button"
                      onClick={(e) => togglePicker(pickerId, e.currentTarget)}
                      aria-label={it.label}
                      aria-haspopup="true"
                      aria-expanded={open}
                      title={it.title}
                      className={rowIconCls(open)}
                    >
                      {it.icon}
                    </button>
                    {open && pickerAnchor && (
                      <div
                        role="group"
                        aria-label={`${PICKER_LABEL[pickerId]} options`}
                        className={`absolute bottom-full mb-1.5 z-50 w-44 overflow-y-auto overflow-x-hidden overscroll-contain rounded-none border border-[var(--accent)]/20 bg-[var(--panel)] shadow-xl backdrop-blur-sm ${pickerAnchor.side === "right" ? "right-0" : "left-0"}`}
                        style={{ maxWidth: pickerAnchor.maxW, maxHeight: pickerAnchor.maxH }}
                      >
                        {/* Label bar — the same glyph + name the ⋯ drill's
                            back-header shows, minus the back chevron (the
                            row popover has no parent level to go back to). */}
                        <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--accent)]/15 bg-[var(--panel)] px-2 py-1">
                          <span className="flex min-w-0 items-center gap-1.5 truncate label-micro text-[var(--accent)]/40">
                            {PICKER_ICON[pickerId]}
                            {PICKER_LABEL[pickerId]}
                          </span>
                        </div>
                        {/* Twin of the ⋯ menu's handler block (see the note
                            there): same mutations, but the pick dismisses
                            THIS popover instead of the menu. */}
                        <PickerContent
                          section={pickerId}
                          providerOptions={PROVIDER_OPTIONS}
                          providerCurrent={providerCurrent}
                          availableServers={availableServers}
                          activeServer={activeServer}
                          speedOptions={speedOptions}
                          playbackRate={playbackRate}
                          filterOptions={FILTER_MENU_OPTIONS}
                          videoFilter={videoFilter}
                          audioFilterOptions={AUDIO_FILTER_MENU_OPTIONS}
                          audioFilter={audioFilter}
                          onSelectProvider={(id) => { selectProvider(id); setOpenPicker(null); }}
                          onSelectServer={(srv) => {
                            setActiveServer(srv);
                            activeServerRef.current = srv;
                            setOpenPicker(null);
                            loadByType(audioType, srv);
                          }}
                          onSelectSpeed={(r) => { changeSpeed(r); setOpenPicker(null); }}
                          onSelectFilter={(id) => { setVideoFilter(id as FilterId); setOpenPicker(null); }}
                          onSelectAudioFilter={(id) => {
                            applyAudioFilter(id as AudioFilterId);
                            setAudioFilter(id as AudioFilterId);
                            setOpenPicker(null);
                          }}
                          subtitle={{
                            activeSubtitle,
                            subtitles,
                            onSelect: (url) => {
                              pickSubtitle(url);
                              setOpenPicker(null);
                            },
                            subtitleOffset,
                            onOffsetChange: changeSubtitleOffset,
                            subtitleSize,
                            onSizeChange: changeSubtitleSize,
                            osSearched,
                            osLoading,
                            osError,
                            osResults: osResults.filter((r) => !failedOSIdsRef.current.has(r.file_id)),
                            osPage,
                            osFilterQuery,
                            onSearchOpenSubtitles: (page) => { searchOpenSubtitles(page); },
                            onFilterChange: setOsFilterQuery,
                            onSelectOpenSubtitle: (fileId) => selectOSSubtitle(fileId),
                            onResetOpenSubtitles: () => {
                              setOsSearched(false);
                              setOsResults([]);
                              setOsError(null);
                              setOsPage(1);
                              setOsFilterQuery("");
                              failedOSIdsRef.current.clear();
                            },
                            activeOSSubtitleId,
                            osDownloadError,
                            onClearDownloadError: () => setOsDownloadError(null),
                          }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* More (⋯) — always present, never scrolls away. It is the
                overflow home for whatever the icon toolbar had to drop (plus
                SUB/DUB below lg), and every row in it carries the same glyph
                its row trigger uses. */}
            <button
              ref={moreBtnRef}
              onClick={() => {
                if (showMore) {
                  closeMore();
                } else {
                  setShowMore(true);
                  setMoreSection(null);
                  setShowControls(true);
                }
                // Opening the menu drops any open row popover (and the
                // pointerdown outside-click already closed it — this keeps
                // the exclusion deterministic either way).
                setOpenPicker(null);
              }}
              aria-label="More controls"
              aria-haspopup="menu"
              aria-expanded={showMore}
              title="More"
              className={`w-9 h-10 shrink-0 sm:w-8 sm:h-8 flex items-center justify-center border transition-colors rounded-none ${
                showMore
                  ? "text-[var(--accent)] bg-[var(--accent)]/20 border-[var(--accent)]/50"
                  : "text-[var(--accent)]/50 bg-black/40 border-[var(--accent)]/20 hover:text-[var(--accent)] hover:border-[var(--accent)]/50"
              }`}
            >
              <MoreIcon className="w-5 h-5 sm:w-4 sm:h-4" />
            </button>

            {/* Enter fullscreen (hidden when already fullscreen — top-right exit button handles that). The fit effect watches this button: it appearing/disappearing changes what the row has to make room for. */}
            {!isFullscreen && (
              <button
                ref={fullscreenBtnRef}
                onClick={toggleFullscreen}
                aria-label="Enter fullscreen"
                title="Fullscreen"
                className="w-9 h-10 shrink-0 sm:w-8 sm:h-8 flex items-center justify-center text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors"
              >
                <FullscreenIcon className="w-5 h-5 sm:w-4 sm:h-4" />
              </button>
            )}

          </div>

        </div>

      </div>

      {/* Exit fullscreen button (mobile only, when fullscreen) */}
      {isFullscreen && (
        <button
          onClick={toggleFullscreen}
          className={`absolute top-4 right-4 z-40 min-w-[48px] min-h-[48px] w-11 h-11 sm:w-10 sm:h-10 flex items-center justify-center bg-black/60 border border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors transition-opacity duration-300 ${
            showControls ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
          </svg>
        </button>
      )}

      {/* Episode drawer handle — a VERTICAL RECTANGLE (24×56, ≈2.3:1) docked
          at the MIDDLE of the right edge, the only trigger there is
          (fullscreen-only; windowed mode has no drawer). Fades with the
          control HUD so it never sits on a clean frame.
          Item 2a: filled accent chip, black-on-accent with sharp corners —
          the same visual language as the SUB/DUB control's active side, so the
          fullscreen edge trigger reads as a real control rather than a stray
          glyph floating on the frame (a bare accent chevron looked like an
          overlay artifact). The TALL bar is the point: a strip welded to the
          frame edge says "there is a drawer behind this", where the old
          28×28 square read as a stray button. The chevron stays centred in
          the bar. Slight accent fade on hover for the affordance a solid
          chip needs (hover:text can't show on a fill). It slides in from
          the right (the side the drawer arrives from) via
          n54-chevron-in-right; the drawer's close right-chevron mirrors it. */}
      {isFullscreen && !drawerOpen && hasDrawer && (
        <button
          onClick={openDrawer}
          aria-label="Episodes"
          aria-expanded={false}
          title="Episodes"
          className={`group/handle absolute right-0 top-1/2 z-40 flex h-14 w-6 -translate-y-1/2 items-center justify-center rounded-none bg-[var(--accent)] text-black transition-colors duration-300 hover:bg-[var(--accent)]/80 ${
            showControls ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <ChevronLeftIcon className="n54-chevron-in-right h-5 w-5 transition-transform duration-200 group-hover/handle:-translate-x-0.5" />
        </button>
      )}

      {/* Next-episode countdown — Netflix-style "up next" card. Only ever
          armed by onEnded when auto-play next is on AND a next episode
          exists, so nothing appears otherwise. The scrim keeps the last frame
          visible underneath; z-[45] sits above the HUD (z-20/40) but under the
          episode drawer (z-50). */}
      {countdown !== null && nextEpisodeTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Up next"
          // Clicking off-card dismisses — never navigates — so the last frame
          // stays put and the viewer can keep the episode they're in.
          onClick={() => setCountdown(null)}
          className="absolute inset-0 z-[45] flex items-center justify-center bg-black/60 p-3"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[320px] rounded-none border border-[var(--accent)]/40 bg-[var(--panel)]/95 backdrop-blur-sm"
            // Both shadows inlined: `.accent-shadow-*` lives outside @layer in
            // globals.css, so as a class it would override Tailwind's
            // `shadow-[…]` utility (same specificity, unlayered wins) and the
            // drop shadow would silently vanish. One declaration, both effects.
            style={{
              boxShadow:
                "0 8px 40px rgba(0,0,0,0.7), 0 0 16px rgba(var(--accent-rgb), 0.4)",
            }}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--accent)]/20 px-3 py-2">
              <div className="font-mono text-[10px] uppercase leading-none tracking-[0.25em] text-[var(--accent)]/60">
                Up Next
              </div>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-none border border-[var(--accent)] bg-black/50 font-mono text-lg leading-none tabular-nums text-[var(--accent)] accent-shadow-sm">
                {Math.max(0, countdown)}
              </div>
            </div>

            <div className="px-3 pt-3 pb-2.5">
              <div className="label-micro text-[var(--accent)]/40">
                Episode {nextEpisodeTarget}
              </div>
              <div className="mt-1 truncate text-sm text-[var(--text-primary)]">
                {nextEpisodeTitle || `Episode ${nextEpisodeTarget}`}
              </div>
            </div>

            {/* Drain rule — steps down once a second, 1s linear between steps */}
            <div className="h-px w-full bg-[var(--accent)]/15">
              <div
                className="h-full bg-[var(--accent)] transition-[width] duration-1000 ease-linear"
                style={{ width: `${(Math.max(0, countdown) / 10) * 100}%` }}
              />
            </div>

            <div className="flex gap-2 px-3 py-3">
              <button
                onClick={() => setCountdown(null)}
                className="flex-1 rounded-none border border-[var(--accent)]/30 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]/70 transition-colors hover:border-[var(--accent)]/60 hover:bg-[var(--accent)]/10 hover:text-[var(--accent)]"
              >
                Cancel
              </button>
              <button
                onClick={() => { setCountdown(null); goToEpisode(nextEpisodeTarget); }}
                className="flex-1 rounded-none bg-[var(--accent)] px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-wider text-black transition-all hover:brightness-110 accent-shadow-sm"
              >
                Play Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Episode drawer — slides in from the right, over the video.
          Rendered inside the container so it is clipped to the player and
          still works in fullscreen. It stays mounted (closed = off-screen,
          `inert`, pointer-events-none) so its markup — the franchise dropdown
          first — ships in the initial HTML instead of only materialising on
          the first fullscreen tap. */}
      {hasDrawer && (
        <div
          aria-hidden={!drawerOpen}
          // `inert` keeps the closed drawer out of the tab order and out of
          // the accessibility tree; React 19 renders it as `inert=""`.
          inert={!drawerOpen}
          className={`absolute inset-0 z-50 ${drawerOpen ? "" : "pointer-events-none"}`}
        >
          {/* Backdrop — one layer per tap: with the franchise dropdown open,
              the first tap on the scrim drops the dropdown (this element's
              pointerdown also closed it via the shared outside-click closer),
              the next one closes the drawer. */}
          <div
            onPointerDown={() => {
              franchiseOnScrimRef.current = franchiseOpen;
            }}
            onClick={() => {
              if (franchiseOnScrimRef.current) {
                franchiseOnScrimRef.current = false;
                return;
              }
              closeDrawer();
            }}
            aria-hidden="true"
            className={`absolute inset-0 bg-black/70 transition-opacity duration-[250ms] ease-out ${
              drawerIn ? "opacity-100" : "opacity-0"
            }`}
          />
          {/* Panel — `overflow-hidden` is the hard edge: nothing inside it
              (the franchise dropdown included) can paint past the drawer. */}
          <div
            role="dialog"
            aria-modal={drawerOpen}
            aria-label="Episodes"
            // The edge shadow only exists while the drawer is on screen — a
            // closed (translated-out) panel would otherwise smear its 12px
            // spread across the right edge of the video at all times.
            className={`absolute right-0 top-0 flex h-full w-[320px] max-w-[85%] flex-col overflow-hidden border-l border-[var(--accent)]/30 bg-[var(--panel)] transition-transform duration-[250ms] ease-out ${
              drawerIn
                ? "translate-x-0 shadow-[-12px_0_32px_rgba(0,0,0,0.6)]"
                : "translate-x-full"
            }`}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--accent)]/20 px-4 py-3">
              <div className="min-w-0">
                <div className="font-mono text-[11px] uppercase leading-none tracking-[0.2em] text-[var(--accent)]">
                  Episodes
                </div>
                <div className="mt-1.5 truncate label-micro text-[var(--accent)]/40">
                  {animeTitle}
                </div>
              </div>
              {/* Item 2b: the boxed ✕ is gone — a bare right-chevron (the open
                  left-chevron reversed), same borderless glyph style as the
                  control row. It mirrors the open animation: slides in from the
                  LEFT (the drawer came from the right, so the close enters
                  opposite) via n54-chevron-in-left. onClick / aria-label /
                  focus unchanged. */}
              <button
                onClick={closeDrawer}
                aria-label="Close episodes"
                className="flex h-8 w-8 shrink-0 items-center justify-center text-[var(--accent)]/60 transition-colors hover:text-[var(--accent)]"
              >
                <ChevronRightIcon className="n54-chevron-in-left h-4 w-4" />
              </button>
            </div>

            {/* Franchise / season switcher — ONE control docked at the top of
                the drawer, above the episode list. The wrapper is the
                positioning context for the panel, so every offset resolves
                against it: `top-full` drops the list straight under the
                trigger (inside the drawer's padding), `max-h` + `overflow-y-auto`
                cap and scroll it, and the drawer's own `overflow-hidden`
                clips it as a second, hard boundary — it can never leave the
                drawer or the player box. */}
            {hasFranchise && (
              <div
                ref={franchiseWrapRef}
                className="relative shrink-0 border-b border-[var(--accent)]/20 px-3 py-2.5"
              >
                <button
                  type="button"
                  onClick={() => setFranchiseOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={franchiseOpen}
                  aria-label="Switch series"
                  title={currentFranchise?.detail ?? animeTitle}
                  className={`flex min-h-[44px] w-full items-center gap-2.5 border px-3 text-left transition-colors rounded-none ${
                    franchiseOpen
                      ? "border-[var(--accent)] bg-[var(--accent)]/10"
                      : "border-[var(--accent)]/30 bg-black/40 hover:border-[var(--accent)]/60 hover:bg-[var(--accent)]/10"
                  }`}
                >
                  <span className="shrink-0 label-micro text-[var(--accent)]/50">
                    Series
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--accent)]">
                    {currentFranchise?.title ?? animeTitle}
                  </span>
                  <ChevronDownIcon
                    className={`h-4 w-4 shrink-0 text-[var(--accent)]/60 transition-transform duration-200 ${
                      franchiseOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {franchiseOpen && (
                  <div
                    role="menu"
                    aria-label="Franchise"
                    className="absolute inset-x-0 top-full z-30 mt-1 max-h-[min(50vh,18rem)] overflow-y-auto overscroll-contain border border-[var(--accent)]/30 bg-[var(--panel)] shadow-xl"
                  >
                    {/* Same persisted order as the watch page's `// Franchise`
                        grid (presentational here: every row stays a plain
                        menu item). */}
                    {franchiseGroups.map((group) => (
                      <Fragment key={group.label ?? "all"}>
                        {group.label !== null && (
                          <div
                            role="presentation"
                            className="flex items-center gap-2 border-b border-[var(--accent)]/10 bg-black/30 px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-[var(--accent)]/55"
                          >
                            <span className="shrink-0">{group.label}</span>
                            <span aria-hidden="true" className="h-px flex-1 bg-[var(--accent)]/15" />
                            <span className="shrink-0 tabular-nums text-[var(--text-decorative)]">
                              {group.entries.length}
                            </span>
                          </div>
                        )}
                        {group.entries.map((entry) => {
                          const isCurrent = entry.current;
                          const qs = providerQuery
                            ? `?provider=${encodeURIComponent(providerQuery)}`
                            : "";
                          // Same href rules as the watch page's `// Franchise`
                          // grid: mainline seasons deep-link to episode 1, the
                          // rest fall through to their detail page.
                          const href = entry.mainLine
                            ? `/anime/${entry.id}/watch/1${qs}`
                            : `/anime/${entry.id}${qs}`;

                          return (
                            <button
                              key={entry.id}
                              type="button"
                              role="menuitem"
                              aria-current={isCurrent ? "page" : undefined}
                              title={entry.detail}
                              onClick={() => {
                                setFranchiseOpen(false);
                                if (isCurrent) return; // already here — just close
                                closeDrawer();
                                if (entry.mainLine) {
                                  // Watch-page switch: arm the overlay + handoff,
                                  // then push. Fullscreen lives on <html>, so it
                                  // carries across the remount untouched.
                                  beginSwitch({ kind: "series", series: entry.title, episode: 1 });
                                  router.push(href);
                                } else {
                                  // Detail page — there is no player to hand over
                                  // to, so drop out of fullscreen deliberately
                                  // rather than strand a fullscreened text page.
                                  exitFullscreen();
                                  router.push(href);
                                }
                              }}
                              className={`flex min-h-[44px] w-full items-center gap-2.5 border-l-2 px-3 py-2.5 text-left transition-colors rounded-none ${
                                isCurrent
                                  ? "border-[var(--accent)] bg-[var(--accent)]/15"
                                  : entry.tier === "main"
                                    ? "border-l-[var(--accent)]/45 bg-[var(--accent)]/5 hover:bg-[var(--accent)]/10"
                                    : "border-l-transparent hover:bg-[var(--accent)]/5"
                              }`}
                            >
                              {entry.season !== undefined && (
                                <span
                                  className={`shrink-0 border px-1.5 py-1 font-mono text-[11px] font-bold leading-none tabular-nums ${
                                    isCurrent
                                      ? "border-[var(--accent)]/50 bg-[var(--accent)]/15 text-[var(--accent)]"
                                      : "border-[var(--accent)]/30 text-[var(--accent)]/70"
                                  }`}
                                >
                                  {`S${entry.season}`}
                                </span>
                              )}
                              <span
                                className={`shrink-0 border px-1.5 py-1 font-mono text-[9px] uppercase leading-none tracking-wider ${
                                  isCurrent
                                    ? "border-[var(--accent)]/40 text-[var(--accent)]/85"
                                    : "border-[var(--accent)]/20 text-[var(--accent)]/55"
                                }`}
                              >
                                {entry.badge}
                              </span>
                              <span
                                className={`min-w-0 flex-1 truncate text-xs ${
                                  isCurrent
                                    ? "text-[var(--accent)]"
                                    : entry.tier === "main"
                                      ? "text-[var(--text-primary)]"
                                      : "text-[var(--text-secondary)]"
                                }`}
                              >
                                {entry.title}
                              </span>
                              {isCurrent && (
                                <span className="shrink-0 label-micro text-[var(--accent)]/70">
                                  Now
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </Fragment>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div ref={drawerListRef} className="flex-1 overflow-y-auto overscroll-contain py-1">
              {episodes?.map((ep) => {
                const isCurrent = ep.number === episodeNumber;
                // The row on screen is playing, so it is available by
                // definition — never render the CURRENT episode as dead, even
                // if the list's flag says otherwise.
                const isAvailable = isCurrent || ep.available !== false;
                if (!isAvailable) {
                  // Mirrors EpisodeList's unavailable branch (dim, inert, N/A)
                  // while keeping the drawer's own row geometry: a non-
                  // interactive div — no goToEpisode, nothing to click.
                  return (
                    <div
                      key={ep.number}
                      aria-disabled="true"
                      className="flex w-full items-center gap-3 border-l-2 border-[var(--text-decorative)]/30 px-4 py-3 text-left rounded-none opacity-50 cursor-not-allowed"
                    >
                      <span className="w-8 shrink-0 font-mono text-xs tabular-nums text-[var(--text-decorative)]">
                        {String(ep.number).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-decorative)]">
                        {ep.title || `Episode ${ep.number}`}
                      </span>
                      <AvailabilityChip kind="na" className="shrink-0" />
                    </div>
                  );
                }
                return (
                  <button
                    key={ep.number}
                    ref={isCurrent ? drawerCurrentRef : undefined}
                    onClick={() => {
                      closeDrawer();
                      if (!isCurrent) goToEpisode(ep.number);
                    }}
                    className={`flex w-full items-center gap-3 border-l-2 px-4 py-3 text-left transition-colors rounded-none ${
                      isCurrent
                        ? "border-[var(--accent)] bg-[var(--accent)]/15"
                        : "border-transparent hover:bg-[var(--accent)]/5"
                    }`}
                  >
                    <span
                      className={`w-8 shrink-0 font-mono text-xs tabular-nums ${
                        isCurrent ? "text-[var(--accent)]" : "text-[var(--accent)]/50"
                      }`}
                    >
                      {String(ep.number).padStart(2, "0")}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate text-xs ${
                        isCurrent ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"
                      }`}
                    >
                      {ep.title || `Episode ${ep.number}`}
                    </span>
                    {isCurrent && (
                      <span className="shrink-0 label-micro text-[var(--accent)]/70">
                        Now
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ⋯ "More" menu — ALWAYS inside the player box. The container is
          `relative overflow-hidden`, and both the dismiss layer and the panel
          below are its direct children, so every offset resolves against the
          player frame — nothing can render past its edge (see PlayerMoreMenu's
          `moreMenuAnchor` for the geometry of each shape):
          • BOTH breakpoints: a popup bottom-right on the 76px line — root list
            or drill-down — over a TRANSPARENT catcher that swallows clicks
            meant for the video, so dismissing the menu never also toggles
            playback. The catcher stops at 76px, leaving the whole control
            cluster live underneath (⋯ included, so it toggles shut). There is
            deliberately no dark scrim: the popup is a small floating card, not
            a takeover, and desktop has never dimmed the video behind it.
          z-40 on the dismiss layer sits above the HUD and stacked overlays
          (z-20/30), below the panel (z-50) — and below the up-next card
          (z-45), which stays actionable if it fires mid-menu. */}
      {showMore && (
        <>
          <div
            ref={moreDismissRef}
            onClick={closeMore}
            aria-hidden="true"
            className="absolute inset-x-0 top-0 bottom-[76px] z-40"
          />
          {moreMenu}
        </>
      )}
    </div>

    </div>
  );
}
