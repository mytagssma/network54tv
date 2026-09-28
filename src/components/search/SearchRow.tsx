"use client";

import { useEffect, useRef, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, SearchIcon, SlidersIcon, XIcon } from "./icons";

/** State for the Filters toggle in the search row. */
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
  /** GET form target — set for URL-driven search, omit for a controlled form. */
  action?: string;
  /** Initial text for the GET form; re-synced when the URL query changes. */
  initialValue?: string;
  /** Controlled text (client-side search). */
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  loading?: boolean;
  /** Renders the Clear button when provided. */
  onClear?: () => void;
  /** Renders the Filters toggle when provided. */
  filters?: FiltersToggle;
  /** Filter panel, rendered inside the form below the row. */
  children?: ReactNode;
}

/**
 * The canonical search row: magnifier input, Search button, optional Clear
 * and Filters buttons — stacked on mobile, inline from `sm` up. The filter
 * panel is passed in as children so both routes share the same row.
 */
export default function SearchRow({
  action,
  initialValue = "",
  value,
  onChange,
  onSubmit,
  loading = false,
  onClear,
  filters,
  children,
}: SearchRowProps) {
  const isGetForm = Boolean(action);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the uncontrolled GET field aligned with the URL (back/forward, links).
  useEffect(() => {
    if (isGetForm && inputRef.current) inputRef.current.value = initialValue;
  }, [isGetForm, initialValue]);

  const filled = Boolean(filters && (filters.open || filters.active));

  return (
    <form
      action={isGetForm ? action : undefined}
      method={isGetForm ? "GET" : undefined}
      onSubmit={onSubmit}
      className="flex flex-col gap-3"
    >
      {/* Search row — stacked on mobile, inline on desktop */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative w-full flex-1 sm:w-auto">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-decorative)]" />
          <input
            ref={isGetForm ? inputRef : undefined}
            type="text"
            name={isGetForm ? "q" : undefined}
            defaultValue={isGetForm ? initialValue : undefined}
            value={isGetForm ? undefined : (value ?? "")}
            onChange={
              isGetForm
                ? undefined
                : (e: ChangeEvent<HTMLInputElement>) => onChange?.(e.target.value)
            }
            placeholder="Search anime..."
            aria-label="Search anime"
            className="min-h-[44px] w-full rounded-none border border-[var(--accent)]/30 bg-[var(--panel)] py-2.5 pl-10 pr-4 font-mono text-sm text-white transition-all placeholder:text-[var(--text-decorative)] focus:border-[var(--accent)] focus:accent-shadow-sm focus:outline-none"
          />
        </div>

        {/* Buttons — side by side on mobile, inline on desktop */}
        <div className="flex w-full gap-2 sm:w-auto">
          <button
            type="submit"
            disabled={loading}
            className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-none bg-[var(--accent)] px-6 py-2.5 font-bold uppercase tracking-wider text-sm text-black accent-shadow-md transition-all hover:brightness-110 disabled:opacity-50 sm:flex-none"
          >
            <SearchIcon className="h-4 w-4" />
            {loading ? "Searching..." : "Search"}
          </button>

          {onClear && (
            <button
              type="button"
              onClick={onClear}
              className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-none border border-[var(--accent)]/30 bg-transparent px-4 py-2.5 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10 sm:flex-none"
            >
              <XIcon className="h-4 w-4" />
              Clear
            </button>
          )}

          {filters && (
            <button
              type="button"
              onClick={filters.onToggle}
              aria-expanded={filters.open}
              aria-controls={filters.panelId}
              className={cn(
                "flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-none border px-4 py-2.5 text-sm font-medium transition-colors sm:flex-none",
                filled
                  ? "border-[var(--accent)] bg-[var(--accent)] text-black"
                  : "border-[var(--accent)]/30 bg-transparent text-[var(--accent)] hover:bg-[var(--accent)]/10"
              )}
            >
              <SlidersIcon className="h-4 w-4" />
              Filters
              {filters.active && <span className="text-[10px]">(active)</span>}
              <ChevronDownIcon
                className={cn("h-3 w-3 transition-transform", filters.open && "rotate-180")}
              />
            </button>
          )}
        </div>
      </div>

      {children}
    </form>
  );
}
