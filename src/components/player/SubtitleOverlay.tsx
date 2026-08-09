"use client";

import { useEffect, useRef, useState, useMemo, Fragment } from "react";
import { proxyUrl } from "@/lib/utils";

interface SubtitleOverlayProps {
  subtitleUrl: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  headers?: Record<string, string>;
  offset?: number; // subtitle timing offset in seconds (positive = delayed, negative = earlier)
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

// ─── Binary search: find first cue whose end >= time ─────────────
function findActiveCues(cues: Cue[], time: number): string[] {
  let lo = 0,
    hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].end < time) lo = mid + 1;
    else hi = mid;
  }

  const result: string[] = [];
  for (let i = lo; i < cues.length && cues[i].start <= time; i++) {
    if (cues[i].end >= time) {
      result.push(cues[i].text);
    }
  }
  return result;
}

// ─── VTT cache (module-level, persists across mounts) ─────────────
const vttCache = new Map<string, Cue[]>();
const VTT_CACHE_MAX = 50;

function cacheVTT(url: string, cues: Cue[]) {
  vttCache.set(url, cues);
  if (vttCache.size > VTT_CACHE_MAX) {
    const first = vttCache.keys().next().value;
    if (first) vttCache.delete(first);
  }
}

// ─── Tag formatting (stable, outside component) ───────────────────
const TAG_MAP: Record<string, string> = {
  b: "font-bold",
  i: "italic",
  u: "underline",
  s: "line-through",
  "c.bold": "font-bold",
  "c.italic": "italic",
  "c.underline": "underline",
  "c.strike": "line-through",
};

const CLASS_STYLE_MAP: Record<string, string> = {
  bg_black: "bg-black/80",
  bg_white: "bg-white/80",
  bg_yellow: "bg-yellow-500/80",
  bg_cyan: "bg-cyan-500/80",
};

function renderFormattedText(text: string): React.ReactNode {
  let key = 0;

  function processSegment(segment: string): React.ReactNode {
    if (!segment) return null;

    segment = segment.replace(/<br\s*\/?>/gi, "\n");

    const result: React.ReactNode[] = [];
    let pos = 0;
    const tagRe = /<(\/)?([\w.]+)(?:\s[^>]*)?>/g;
    let match: RegExpExecArray | null;

    while ((match = tagRe.exec(segment)) !== null) {
      if (match.index > pos) {
        result.push(segment.slice(pos, match.index));
      }

      const isClosing = !!match[1];
      const tagName = match[2].toLowerCase();
      pos = match.index + match[0].length;

      if (isClosing) continue;

      const mappedClass = TAG_MAP[tagName] || CLASS_STYLE_MAP[tagName];
      const effectiveTag = tagName.split(".")[0];

      if (mappedClass) {
        const closeTag = `</${effectiveTag}>`;
        const closeIdx = segment.indexOf(closeTag, pos);
        if (closeIdx !== -1) {
          const inner = processSegment(segment.slice(pos, closeIdx));
          result.push(
            <span key={key++} className={mappedClass}>
              {inner}
            </span>
          );
          pos = closeIdx + closeTag.length;
          tagRe.lastIndex = pos;
        }
      } else {
        const closeTag = `</${effectiveTag}>`;
        const closeIdx = segment.indexOf(closeTag, pos);
        if (closeIdx !== -1) {
          const inner = processSegment(segment.slice(pos, closeIdx));
          if (typeof inner === "string") {
            result.push(inner);
          } else {
            result.push(<Fragment key={key++}>{inner}</Fragment>);
          }
          pos = closeIdx + closeTag.length;
          tagRe.lastIndex = pos;
        }
      }
    }

    if (pos < segment.length) {
      result.push(segment.slice(pos));
    }

    return result.length > 0 ? result : null;
  }

  return processSegment(text) || text;
}

// ─── VTT parser ───────────────────────────────────────────────────
function parseVTTTime(time: string): number {
  const parts = time.split(":");
  if (parts.length === 3) {
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return 0;
}

function parseVTT(vttContent: string): Cue[] {
  const cues: Cue[] = [];
  let text = vttContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const headerMatch = text.match(/^WEBVTT.*?\n\n/);
  if (headerMatch) {
    text = text.slice(headerMatch[0].length);
  } else if (text.startsWith("WEBVTT")) {
    const firstNewline = text.indexOf("\n");
    text = text.slice(firstNewline + 1);
  }

  const blocks = text.split(/\n\n+/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("NOTE") || trimmed.startsWith("COMMENT")) continue;

    const lines = trimmed.split("\n");
    const timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx === -1) continue;

    const timingMatch = lines[timingIdx].match(
      /(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/
    );
    if (!timingMatch) continue;

    const start = parseVTTTime(timingMatch[1]);
    const end = parseVTTTime(timingMatch[2]);
    const cueText = lines.slice(timingIdx + 1).filter((l) => !l.startsWith("NOTE")).join("\n").trim();

    if (cueText) {
      cues.push({ start, end, text: cueText });
    }
  }

  return cues;
}

// ─── Component ────────────────────────────────────────────────────

export default function SubtitleOverlay({
  subtitleUrl,
  videoRef,
  headers,
  offset = 0,
}: SubtitleOverlayProps) {
  const [cues, setCues] = useState<Cue[]>([]);
  const [activeText, setActiveText] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const offsetRef = useRef(offset);

  // Keep offsetRef in sync with prop
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  // Fetch and parse VTT (with module-level cache)
  useEffect(() => {
    if (!subtitleUrl) return;

    // Check VTT cache first
    const cached = vttCache.get(subtitleUrl);
    if (cached) {
      setCues(cached);
      setError(false);
      return;
    }

    setError(false);
    setCues([]);
    let cancelled = false;

    const fetchSubs = async () => {
      try {
        const url = subtitleUrl.startsWith("blob:") ? subtitleUrl : proxyUrl(subtitleUrl, headers);
        const res = await fetch(url, {
          headers: { Accept: "text/vtt, text/plain, */*" },
        });

        if (!res.ok || cancelled) {
          if (!cancelled) setError(true);
          return;
        }

        const text = await res.text();
        if (cancelled) return;

        const parsed = parseVTT(text);
        cacheVTT(subtitleUrl, parsed);
        setCues(parsed);
      } catch {
        if (!cancelled) setError(true);
      }
    };

    fetchSubs();
    return () => {
      cancelled = true;
    };
  }, [subtitleUrl, headers]);

  // rAF loop: read video.currentTime directly, update active text only when changed
  useEffect(() => {
    if (cues.length === 0) {
      setActiveText([]);
      return;
    }

    let rafId: number;
    let lastTime = -1;
    let lastText = "";

    const tick = () => {
      const video = videoRef.current;
      if (!video) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      const t = video.currentTime + offsetRef.current;
      // Only recompute when time actually changed (handles pause + seek)
      if (t !== lastTime) {
        lastTime = t;
        const active = findActiveCues(cues, t);
        const joined = active.length > 0 ? active.join("\n") : "";

        if (joined !== lastText) {
          lastText = joined;
          setActiveText(active);
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [cues, videoRef]);

  if (error || activeText.length === 0) return null;

  return (
    <div className="absolute bottom-16 left-0 right-0 pointer-events-none z-20 flex flex-col items-center gap-1 px-4">
      {activeText.map((text, i) => {
        const lines = text.split(/<br\s*\/?>/i).flatMap((l) => l.split("\n"));

        return (
          <div key={i} className="text-center">
            {lines.map((line, j) => (
              <span
                key={j}
                className="inline-block bg-black/80 text-white text-base md:text-lg font-medium leading-relaxed px-3 py-0.5 mb-0.5"
                style={{
                  textShadow:
                    "0 0 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,229,255,0.3)",
                  WebkitFontSmoothing: "antialiased",
                }}
              >
                {renderFormattedText(line)}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}