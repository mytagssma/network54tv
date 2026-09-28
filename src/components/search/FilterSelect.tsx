"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";
import type { FilterOption } from "./constants";

interface FilterSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  /**
   * Label for the empty (none-selected) option, always listed first so a
   * fresh panel never looks pre-selected. Pass "" to omit it.
   */
  noneLabel?: string;
  className?: string;
}

/** Stacked label + select — the filter panel's control shape. */
export default function FilterSelect({
  label,
  value,
  onChange,
  options,
  noneLabel = "Any",
  className,
}: FilterSelectProps) {
  const id = useId();
  const entries = noneLabel ? [{ value: "", label: noneLabel }, ...options] : options;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label
        htmlFor={id}
        className="font-mono text-xs uppercase tracking-wider text-[var(--accent)]/70"
      >
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[44px] rounded-none border border-[var(--accent)]/20 bg-[var(--background)] px-3 py-2 text-sm text-[var(--accent)] transition-colors focus:border-[var(--accent)] focus:outline-none"
      >
        {entries.map((option) => (
          <option key={option.value || "none"} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
