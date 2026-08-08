"use client";

import { useEffect, useRef, useState, Fragment } from "react";
import { proxyUrl } from "@/lib/utils";

interface SubtitleOverlayProps {
  subtitleUrl: string;
  currentTime: number;
  headers?: Record<string, string>;
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

export default function SubtitleOverlay({
  subtitleUrl,
  currentTime,
  headers,
}: SubtitleOverlayProps) {
  const [cues, setCues] = useState<Cue[]>([]);
  const [activeText, setActiveText] = useState<string[]>([]);
  const [error, setError] = useState(false);

  // Fetch and parse VTT subtitle file
  useEffect(() => {
    if (!subtitleUrl) return;

    setError(false);
    setCues([]);
    let cancelled = false;

    const fetchSubs = async () => {
      try {
        // Use proxy to avoid CORS / missing Referer issues
        const url = proxyUrl(subtitleUrl, headers);
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
        setCues(parsed);
      } catch {
        if (!cancelled) setError(true);
      }
    };

    fetchSubs();
    return () => { cancelled = true; };
  }, [subtitleUrl, headers]);

  // Update active subtitle text based on current time
  useEffect(() => {
    if (cues.length === 0) {
      setActiveText([]);
      return;
    }

    const active = cues
      .filter((cue) => currentTime >= cue.start && currentTime <= cue.end)
      .map((cue) => cue.text);

    setActiveText(active);
  }, [cues, currentTime]);

  if (error || activeText.length === 0) return null;

  // Render a line of subtitle text with formatting tags parsed into React elements
  function renderFormattedText(text: string): React.ReactNode {
    // Map of tag names (or tag.class) → Tailwind class
    const tagMap: Record<string, string> = {
      b: "font-bold",
      i: "italic",
      u: "underline",
      s: "line-through",
      "c.bold": "font-bold",
      "c.italic": "italic",
      "c.underline": "underline",
      "c.strike": "line-through",
    };

    // Map for class-only patterns like bg_... → background color classes
    const classStyleMap: Record<string, string> = {
      bg_black: "bg-black/80",
      bg_white: "bg-white/80",
      bg_yellow: "bg-yellow-500/80",
      bg_cyan: "bg-cyan-500/80",
    };

    let key = 0;

    // Simple inline parser: walk through text and build React elements
    function processSegment(segment: string): React.ReactNode {
      if (!segment) return null;

      // Replace <br> with newlines
      segment = segment.replace(/<br\s*\/?>/gi, "\n");

      const result: React.ReactNode[] = [];
      let pos = 0;
      // Match tags like <b>, </b>, <c.bold>, </c>, <v Bob>, <ruby>, <rt>, etc.
      const tagRe = /<(\/)?([\w.]+)(?:\s[^>]*)?>/g;
      let match: RegExpExecArray | null;

      while ((match = tagRe.exec(segment)) !== null) {
        // Text before this tag
        if (match.index > pos) {
          result.push(segment.slice(pos, match.index));
        }

        const isClosing = !!match[1];
        let tagName = match[2].toLowerCase();
        pos = match.index + match[0].length;

        if (isClosing) {
          // Closing tag — skip, handled by opening
          continue;
        }

        // Determine effective tag and class
        const mappedClass = tagMap[tagName] || classStyleMap[tagName];
        const effectiveTag = tagName.split(".")[0]; // "c" from "c.bold", "b" from "b"

        if (mappedClass) {
          // Known tag — find matching close and wrap
          const closeTag = `</${effectiveTag}>`;
          const closeIdx = segment.indexOf(closeTag, pos);
          if (closeIdx !== -1) {
            const innerContent = segment.slice(pos, closeIdx);
            const inner = processSegment(innerContent);
            result.push(
              <span key={key++} className={mappedClass}>
                {inner}
              </span>
            );
            pos = closeIdx + closeTag.length;
            tagRe.lastIndex = pos;
          }
        } else {
          // Unknown tag — skip opening tag, keep inner content until close
          const closeTag = `</${effectiveTag}>`;
          const closeIdx = segment.indexOf(closeTag, pos);
          if (closeIdx !== -1) {
            const innerContent = segment.slice(pos, closeIdx);
            const inner = processSegment(innerContent);
            // Flatten text nodes to avoid nested <span> without class
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

      // Remaining text
      if (pos < segment.length) {
        result.push(segment.slice(pos));
      }

      return result.length > 0 ? result : null;
    }

    return processSegment(text) || text;
  }

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

/**
 * Parse WebVTT content into cue objects.
 * Handles standard VTT format with optional header.
 */
function parseVTT(vttContent: string): Cue[] {
  const cues: Cue[] = [];

  // Remove BOM and normalize line endings
  let text = vttContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove WEBVTT header and metadata
  const headerMatch = text.match(/^WEBVTT.*?\n\n/);
  if (headerMatch) {
    text = text.slice(headerMatch[0].length);
  } else if (text.startsWith("WEBVTT")) {
    const firstNewline = text.indexOf("\n");
    text = text.slice(firstNewline + 1);
  }

  // Split into cue blocks (separated by blank lines)
  const blocks = text.split(/\n\n+/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Skip notes and comments
    if (trimmed.startsWith("NOTE") || trimmed.startsWith("COMMENT")) continue;

    // Try to find timing line (-->)
    const lines = trimmed.split("\n");
    const timingIdx = lines.findIndex((l) => l.includes("-->"));

    if (timingIdx === -1) continue;

    const timingLine = lines[timingIdx];

    // Parse timing: 00:00:01.000 --> 00:00:04.000
    const timingMatch = timingLine.match(
      /(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/
    );

    if (!timingMatch) continue;

    const start = parseVTTTime(timingMatch[1]);
    const end = parseVTTTime(timingMatch[2]);

    // Text is everything after the timing line
    const cueText = lines.slice(timingIdx + 1).filter((l) => !l.startsWith("NOTE")).join("\n").trim();

    if (cueText) {
      cues.push({ start, end, text: cueText });
    }
  }

  return cues;
}

function parseVTTTime(time: string): number {
  const parts = time.split(":");
  if (parts.length === 3) {
    return (
      parseInt(parts[0]) * 3600 +
      parseInt(parts[1]) * 60 +
      parseFloat(parts[2])
    );
  } else if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return 0;
}
