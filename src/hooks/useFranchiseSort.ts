"use client";

/**
 * `useFranchiseSort` — the persisted franchise sort mode (`default` /
 * `time`), shared by the watch page's `// Franchise` strip and the
 * player drawer's series dropdown so both lists can never disagree.
 *
 * A stored mode that isn't a current one (a retired `"type"`, hand-edited
 * storage) reads back as `default` — see `isFranchiseSortMode`.
 *
 * Backed by an external store (`useSyncExternalStore`) instead of per-instance
 * state because TWO components on the same watch page read it: the module-level
 * snapshot is written to `localStorage` and pushed through a listener set, so a
 * tap in the strip re-renders an open drawer too (a plain `storage` event only
 * ever fires in *other* documents, never in the one that wrote the key — it is
 * wired up here for the multi-tab case).
 *
 * Hydration: the server snapshot is the default mode, so the prerendered HTML
 * always matches the first client render; the stored mode is adopted right
 * after hydration (no mismatch warning, at most a frame at default order).
 */

import { useCallback, useSyncExternalStore } from "react";
import {
  isFranchiseSortMode,
  type FranchiseSortMode,
} from "@/components/watch/franchiseEntries";

const STORAGE_KEY = "n54tv-franchise-sort";
const DEFAULT_MODE: FranchiseSortMode = "default";

/** Last mode read for this document; `null` until the store is first touched. */
let mode: FranchiseSortMode | null = null;
const listeners = new Set<() => void>();

function readStore(): FranchiseSortMode {
  if (mode === null) {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private mode / disabled storage — the default is still a good answer.
    }
    mode = isFranchiseSortMode(stored) ? stored : DEFAULT_MODE;
  }
  return mode;
}

function subscribe(onStoreChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    // `key === null` means the whole store was cleared.
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    mode = null; // force a re-read of whatever is in there now
    onStoreChange();
  };
  listeners.add(onStoreChange);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): FranchiseSortMode {
  return readStore();
}

function getServerSnapshot(): FranchiseSortMode {
  return DEFAULT_MODE;
}

/**
 * `[mode, setMode]` — `mode` is the persisted choice (default until
 * hydration), `setMode` persists it and notifies every subscriber in this
 * document immediately.
 */
export function useFranchiseSort(): [FranchiseSortMode, (mode: FranchiseSortMode) => void] {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setSort = useCallback((next: FranchiseSortMode) => {
    if (!isFranchiseSortMode(next)) return;
    mode = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable — the choice still applies for this session.
    }
    listeners.forEach((listener) => listener());
  }, []);

  return [current, setSort];
}
