"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, SlidersIcon } from "./icons";

/** State for the Filters toggle. */
export interface FiltersToggle {
  /** Panel is open. */
  open: boolean;
  /** Some filter is set (drives the "(active)" note and filled style). */
  active: boolean;
  onToggle: () => void;
  /** id of the panel this button controls. */
  panelId: string;
}

interface SearchRowProps {
  /** Page heading sitting left of the Filters toggle (a SearchHeading). */
  heading?: ReactNode;
  /** Filters toggle — always rendered, so the panel stays reachable
      whether a query is active or the landing view is showing. */
  filters: FiltersToggle;
  /** Filter panel, rendered below the heading row. */
  children?: ReactNode;
}

/**
 * Browse's search block: heading + Filters toggle on ONE row, panel below.
 *
 * The query field and the Clear ✕ live in the header search (Navbar), so
 * the separate button row under the heading is gone — this component now
 * only positions the Filters toggle against the heading: right-aligned on
 * "// SEARCH: …" and on the landing heading alike. Search is submit-only
 * (Enter / magnifier routes to /browse?q=…); typing alone never navigates.
 */
export default function SearchRow({
  heading,
  filters,
  children,
}: SearchRowProps) {
  const filled = filters.open || filters.active;

  return (
    <div className="flex flex-col gap-3">
      {/* One line at 360px: heading flexes and truncates, button keeps its
          natural width (`shrink-0`, never wraps). `[&>h1]:mb-0` drops
          SearchHeading's built-in mb-4 — inside this row it would offset the
          heading from the button's centre (higher specificity beats .mb-4
          regardless of stylesheet order). */}
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <div className="min-w-0 flex-1 [&>h1]:mb-0">{heading}</div>

        <button
          type="button"
          onClick={filters.onToggle}
          aria-expanded={filters.open}
          aria-controls={filters.panelId}
          className={cn(
            "flex min-h-[44px] shrink-0 items-center justify-center gap-1.5 rounded-none border px-3 py-2.5 text-sm font-medium transition-colors sm:px-4",
            filled
              ? "border-[var(--accent)] bg-[var(--accent)] text-black"
              : "border-[var(--accent)]/30 bg-transparent text-[var(--accent)] hover:bg-[var(--accent)]/10"
          )}
        >
          <SlidersIcon className="h-4 w-4" />
          {/* Below sm the button drops the label and chevron and shows the
              sliders glyph alone (a ~44×44 target); the sr-only spans keep
              its accessible name — "Filters (active)" — exactly as the
              labeled version reads on wider screens. */}
          <span className="hidden sm:inline">Filters</span>
          {filters.active && <span className="hidden text-[10px] sm:inline">(active)</span>}
          <span className="sr-only sm:hidden">Filters{filters.active ? " (active)" : ""}</span>
          <ChevronDownIcon
            className={cn(
              "hidden h-3 w-3 transition-transform sm:inline-block",
              filters.open && "rotate-180"
            )}
          />
        </button>
      </div>

      {children}
    </div>
  );
}
