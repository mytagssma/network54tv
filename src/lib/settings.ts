/**
 * Global (device / behaviour) viewer settings — one bucket for the whole
 * browser profile: `n54tv-settings`. Everything here applies to every show;
 * per-show things (sub/dub, the provider override, and the per-show subtitle
 * OVERRIDES) stay in the per-anime bucket handled by `Player.tsx`.
 *
 * Client-only: every function touches localStorage, so nothing may run at
 * module scope or during render — call these from effects / event handlers
 * (the same SSR discipline as the rest of the player).
 */

export interface GlobalSettings {
  v: 1;
  /** `qualityLabel` name: "auto" | "1080p" | "720p" | … */
  quality?: string;
  autoPlayNext?: boolean;
  autoSkip?: boolean;
  /** FILTER_PRESETS id (validated by the Player before it is adopted). */
  videoFilter?: string;
  /** AUDIO_FILTER_PRESETS id (validated by the Player before it is adopted). */
  audioFilter?: string;
  /** Subtitle visibility default; a show may override it per-anime. */
  subtitles?: boolean;
  /** Remembered track LANG label, never a URL — URLs differ per stream. */
  subtitleLang?: string;
  subtitleOffset?: number;
  subtitleSize?: "small" | "medium" | "large";
  speed?: number;
  volume?: number;
  muted?: boolean;
  ts?: number;
}

export const SETTINGS_KEY = "n54tv-settings";
const SETTINGS_VERSION = 1 as const;

export function readSettings(): GlobalSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const data: unknown = JSON.parse(raw);
    // Corrupt / non-object payloads (a stray string, an array) fall back to
    // defaults rather than poisoning every setter below.
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    // Foreign or future payload — a newer schema this build doesn't know —
    // is treated as absent rather than misread field-by-field.
    if ((data as { v?: unknown }).v !== SETTINGS_VERSION) return null;
    return data as GlobalSettings;
  } catch {
    return null; // private mode, quota, malformed JSON
  }
}

/** Merge-shaped write (same contract as `writePrefsByKey`): only the patched
 *  fields change; `undefined` values are dropped by JSON.stringify, so a
 *  partial patch can never clear a stored field. */
export function writeSettings(patch: Partial<GlobalSettings>): void {
  try {
    const current = readSettings() || { v: SETTINGS_VERSION };
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ...current, ...patch, v: SETTINGS_VERSION, ts: Date.now() })
    );
  } catch {
    // A storage failure must never break playback — the session just
    // behaves as if nothing were remembered.
  }
}

/**
 * The per-anime keys that are PURELY global now: migration copies each one
 * out of a per-anime bucket (seed once / fill-if-absent) and then STRIPS it
 * from that bucket. The subtitle fields are deliberately NOT here — a show's
 * subtitle values stay put as its override layer over the global defaults.
 */
export const GLOBAL_ONLY_PREF_KEYS = [
  "quality",
  "autoPlayNext",
  "autoSkip",
  "videoFilter",
  "audioFilter",
] as const;

/** The per-anime bucket as migration sees it (legacy payload, pre-strip). */
export interface LegacyAnimePrefs extends Partial<GlobalSettings> {
  audioType?: "sub" | "dub";
  providerId?: string;
}

/** The per-episode progress blob's device fields — the legacy home of
 *  speed/volume/mute before the global store existed. */
export interface LegacyProgressBlob {
  volume?: number;
  muted?: boolean;
  speed?: number;
}

/**
 * One-shot migration — the Player calls it once per episode, at hydration:
 * if the global bucket doesn't exist yet, SEED it from the current show's
 * per-anime prefs (merged with defaults) plus the current episode's progress
 * blob (device fields only — they were the freshest write before this
 * refactor). If the global bucket already exists, only FILL the fields it
 * never got from this show's legacy per-anime copy. Either way, then STRIP
 * the pure-global fields from this show's per-anime bucket. Subtitle fields
 * are folded into the seed but never stripped — they keep working as the
 * per-show override layer.
 */
export function migrateIntoGlobal(input: {
  animeKey: string;
  prefs: LegacyAnimePrefs | null;
  legacy: LegacyProgressBlob | null;
}): void {
  const cur = readSettings();
  const prefs: LegacyAnimePrefs = input.prefs ?? {};
  if (!cur) {
    // SEED — defaults first, then this show's legacy prefs, then the
    // progress blob's device fields (the freshest legacy write wins).
    const seed: GlobalSettings = {
      v: SETTINGS_VERSION,
      quality: typeof prefs.quality === "string" ? prefs.quality : "auto",
      autoPlayNext: typeof prefs.autoPlayNext === "boolean" ? prefs.autoPlayNext : false,
      autoSkip: typeof prefs.autoSkip === "boolean" ? prefs.autoSkip : false,
      videoFilter: typeof prefs.videoFilter === "string" ? prefs.videoFilter : "off",
      audioFilter: typeof prefs.audioFilter === "string" ? prefs.audioFilter : "off",
      subtitles: typeof prefs.subtitles === "boolean" ? prefs.subtitles : true,
      subtitleOffset: typeof prefs.subtitleOffset === "number" ? prefs.subtitleOffset : 0,
      subtitleSize:
        prefs.subtitleSize === "small" || prefs.subtitleSize === "large"
          ? prefs.subtitleSize
          : "medium",
      speed: input.legacy?.speed ?? 1,
      volume: input.legacy?.volume ?? 1,
      muted: input.legacy?.muted ?? false,
    };
    if (typeof prefs.subtitleLang === "string") seed.subtitleLang = prefs.subtitleLang;
    writeSettings(seed);
  } else {
    // FILL — the global bucket exists (another show migrated first, or the
    // viewer has been using the new layout). Copy over any pure-global field
    // it never received from THIS show's legacy per-anime copy, so a
    // pre-refactor choice on a later-visited show still lands. Subtitle keys
    // are not filled: promoting one show's override would make it every
    // show's default.
    const fill: Partial<GlobalSettings> = {};
    if (cur.quality === undefined && typeof prefs.quality === "string") fill.quality = prefs.quality;
    if (cur.autoPlayNext === undefined && typeof prefs.autoPlayNext === "boolean") {
      fill.autoPlayNext = prefs.autoPlayNext;
    }
    if (cur.autoSkip === undefined && typeof prefs.autoSkip === "boolean") fill.autoSkip = prefs.autoSkip;
    if (cur.videoFilter === undefined && typeof prefs.videoFilter === "string") {
      fill.videoFilter = prefs.videoFilter;
    }
    if (cur.audioFilter === undefined && typeof prefs.audioFilter === "string") {
      fill.audioFilter = prefs.audioFilter;
    }
    if (Object.keys(fill).length > 0) writeSettings(fill);
  }

  // ALWAYS strip the pure-global fields from this show's per-anime bucket
  // (the seed path already read them out of it; the fill path may have
  // copied them). The merge-shaped `writePrefsByKey` can't delete keys, so
  // prune the raw payload here.
  try {
    const raw = localStorage.getItem(input.animeKey);
    if (raw) {
      const data: unknown = JSON.parse(raw);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const obj = data as Record<string, unknown>;
        let changed = false;
        for (const k of GLOBAL_ONLY_PREF_KEYS) {
          if (k in obj) {
            delete obj[k];
            changed = true;
          }
        }
        if (changed) {
          localStorage.setItem(input.animeKey, JSON.stringify({ ...obj, ts: Date.now() }));
        }
      }
    }
  } catch {
    // Best-effort, like every other storage touch here.
  }
}
