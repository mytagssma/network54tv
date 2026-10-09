"use client";

import { useEffect, useRef } from "react";

/**
 * "Clear the whole search" channel between the global header field and the
 * browse page.
 *
 * The ✕ lives in the header (Navbar) but the filters/chips/grouping it also
 * has to reset are browse client-state — neither side owns both. So the
 * header just broadcasts, and browse (the only listener, mounted only while
 * on /browse) runs its existing Clear handler: reset filters + push
 * /browse, which empties the header field through the URL. Outside /browse
 * there is simply no listener: the ✕ clears the field locally and stays put.
 */
export const CLEAR_SEARCH_EVENT = "n54tv:clear-search";

/** Fire the header ✕ behaviour. No-op when browse isn't mounted. */
export function dispatchClearSearch() {
  window.dispatchEvent(new Event(CLEAR_SEARCH_EVENT));
}

/**
 * Run `handler` whenever the header ✕ fires. The handler is kept in a ref
 * so the listener subscribes once and never sees a stale closure (browse's
 * Clear closes over live filter state).
 */
export function useClearSearch(handler: () => void) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const onClear = () => ref.current();
    window.addEventListener(CLEAR_SEARCH_EVENT, onClear);
    return () => window.removeEventListener(CLEAR_SEARCH_EVENT, onClear);
  }, []);
}
