"use client";

import { useState, useEffect } from "react";

const ACCENT_COLORS = [
  { name: "Yellow", value: "#e8ff00" },
  { name: "Red", value: "#ff3333" },
  { name: "Green", value: "#00ff88" },
  { name: "Cyan", value: "#00ddff" },
  { name: "Purple", value: "#bb66ff" },
  { name: "Orange", value: "#ff8800" },
] as const;

const STORAGE_KEY = "n54tv-accent";

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

export default function AccentColorSelector() {
  const [activeColor, setActiveColor] = useState<string>(ACCENT_COLORS[0].value);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && ACCENT_COLORS.some((c) => c.value === stored)) {
      setActiveColor(stored);
      applyAccent(stored);
    }
  }, []);

  function applyAccent(hex: string) {
    const root = document.documentElement;
    root.style.setProperty("--accent", hex);
    // Also update any inline rgba references via CSS custom properties
    root.style.setProperty("--accent-rgb", hexToRgb(hex));
  }

  function handleSelect(hex: string) {
    setActiveColor(hex);
    localStorage.setItem(STORAGE_KEY, hex);
    applyAccent(hex);
  }

  if (!mounted) return null;

  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Accent color">
      {ACCENT_COLORS.map((color) => (
        <button
          key={color.value}
          onClick={() => handleSelect(color.value)}
          className={`accent-swatch ${activeColor === color.value ? "active" : ""}`}
          style={{ backgroundColor: color.value }}
          role="radio"
          aria-checked={activeColor === color.value}
          aria-label={color.name}
          title={color.name}
        />
      ))}
    </div>
  );
}
