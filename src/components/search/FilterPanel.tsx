"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ListIcon, ResetIcon } from "./icons";

interface FilterPanelProps {
  id: string;
  /** Open state — closed panels stay in the DOM, hidden. */
  open: boolean;
  /** Panel heading without the "//" prefix. */
  label?: string;
  children: ReactNode;
}

/**
 * Collapsible filter panel under the search row: a "// FILTERS" header bar
 * over a wrapping grid of controls. Always rendered so the field values stay
 * put between opens; `hidden` takes care of the closed state.
 */
export default function FilterPanel({ id, open, label = "Filters", children }: FilterPanelProps) {
  return (
    <div
      id={id}
      key={open ? "open" : "closed"}
      hidden={!open}
      className={cn(
        "rounded-none border border-[var(--accent)]/20 bg-[var(--panel)]",
        open && "animate-fadeIn"
      )}
    >
      <div className="border-b border-[var(--accent)]/10 bg-[var(--background)]/50 px-4 py-2.5">
        <span className="font-mono text-xs uppercase tracking-wider text-[var(--accent)]/70">
          {"// "}
          {label}
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-4 p-4">{children}</div>
    </div>
  );
}

/** Cluster results into franchises (seasons/prequels/spin-offs together). */
export function GroupingToggle({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex min-h-[44px] items-center gap-2 rounded-none border px-4 py-2 font-mono text-sm transition-colors",
        active
          ? "border-[var(--accent)] bg-[var(--accent)] text-black"
          : "border-[var(--accent)]/20 bg-[var(--background)] text-[var(--accent)] hover:bg-[var(--accent)]/10"
      )}
    >
      <ListIcon className="h-4 w-4" />
      Group by Franchise
    </button>
  );
}

/** Restore every filter in the panel to its default. */
export function ResetButton({
  onClick,
  children = "Reset Filters",
}: {
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-[44px] items-center gap-2 rounded-none border border-[var(--accent)]/20 bg-[var(--background)] px-4 py-2 font-mono text-sm text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10"
    >
      <ResetIcon className="h-4 w-4" />
      {children}
    </button>
  );
}
