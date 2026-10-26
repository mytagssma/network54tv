export const ACCENT_COLORS = [
  { name: "Yellow", value: "#e8ff00" },
  { name: "Red", value: "#ff3333" },
  { name: "Green", value: "#00ff88" },
  { name: "Cyan", value: "#00ddff" },
  { name: "Purple", value: "#bb66ff" },
  { name: "Orange", value: "#ff8800" },
] as const;

export const DEFAULT_ACCENT = "#e8ff00";

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Sanitizes an accent value to ensure it matches hex color format
 * and is one of the valid ACCENT_COLORS values. Never reflects raw input.
 */
export function sanitizeAccent(raw: string | undefined | null): string {
  if (!raw || typeof raw !== "string") {
    return DEFAULT_ACCENT;
  }
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // ignore decode error
  }
  if (!HEX_COLOR_REGEX.test(decoded)) {
    return DEFAULT_ACCENT;
  }
  const matched = ACCENT_COLORS.find(
    (c) => c.value.toLowerCase() === decoded.toLowerCase()
  );
  if (!matched) {
    return DEFAULT_ACCENT;
  }
  return matched.value;
}

/**
 * Returns the complete standalone SVG string (32x32 badge) with letterforms filled with accent.
 */
export function n54IconSvg(accent: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="N54">
  <title>N54 // n54tv</title>
  <!-- accent letterforms: uniform 3u strokes, 8u cells, y6..y26 -->
  <g fill="${accent}">
    <!-- N: cells x2..x10 -->
    <rect x="2" y="6" width="3" height="20" />
    <polygon points="2,6 5,6 10,26 7,26" />
    <rect x="7" y="6" width="3" height="20" />
    <!-- 5: cells x12..x20 -->
    <rect x="12" y="6" width="8" height="3" />
    <rect x="12" y="6" width="3" height="11" />
    <rect x="12" y="14" width="8" height="3" />
    <rect x="17" y="14" width="3" height="12" />
    <rect x="12" y="23" width="8" height="3" />
    <!-- 4: cells x22..x30 -->
    <rect x="22" y="6" width="3" height="11" />
    <rect x="22" y="14" width="8" height="3" />
    <rect x="27" y="6" width="3" height="20" />
  </g>
</svg>`;
}

/**
 * Updates the browser's favicon live by setting the <link rel="icon"> element's href
 * to a data:image/svg+xml URI. Creates the element if absent.
 */
export function applyFaviconAccent(hex: string): void {
  if (typeof document === "undefined") return;
  const svg = n54IconSvg(hex);
  const dataUri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]');
  if (links.length > 0) {
    links.forEach((link) => {
      link.type = "image/svg+xml";
      link.href = dataUri;
    });
  } else {
    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = dataUri;
    document.head.appendChild(link);
  }
}
