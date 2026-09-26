"use client";

import { useState, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

interface ExpandableDescriptionProps {
  description: string;
  maxLines?: number;
}

export default function ExpandableDescription({ description, maxLines = 3 }: ExpandableDescriptionProps) {
  const [open, setOpen] = useState(false);
  const [isLong, setIsLong] = useState(false);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Check if description is long enough to need truncation
  useEffect(() => {
    // Create a temporary element to measure text height
    const temp = document.createElement("div");
    temp.style.cssText = `
      position: absolute;
      visibility: hidden;
      width: 100%;
      font-size: 1rem;
      line-height: 1.625;
      font-family: inherit;
      white-space: pre-wrap;
      word-wrap: break-word;
    `;
    temp.textContent = description;
    document.body.appendChild(temp);

    const lineHeight = parseFloat(getComputedStyle(temp).lineHeight);
    const height = temp.offsetHeight;
    const lines = height / lineHeight;

    setIsLong(lines > maxLines);
    document.body.removeChild(temp);
  }, [description, maxLines]);

  // Modal: lock body scroll, Escape to close, focus management
  useEffect(() => {
    if (!open) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    closeRef.current?.focus();

    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKeyDown);
      // Return focus to the trigger that opened the dialog
      triggerRef.current?.focus();
    };
  }, [open]);

  if (!isLong) {
    return (
      <p className="text-[#9a9aa0] leading-relaxed whitespace-pre-wrap">
        {description}
      </p>
    );
  }

  return (
    <>
      <div className="text-[#9a9aa0] leading-relaxed">
        <p className="line-clamp-3 whitespace-pre-wrap">{description}</p>
        <button
          ref={triggerRef}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="mt-2 inline-block py-1 text-xs font-mono text-[var(--accent)]/70 hover:text-[var(--accent)] uppercase tracking-wider transition-colors"
        >
          <span aria-hidden="true">[+] </span>Read More
        </button>
      </div>

      {open &&
        createPortal(
          // Backdrop = this element; click only closes when the press starts on it
          <div
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false);
            }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-fadeIn"
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-none border border-[var(--accent)]/40 bg-[var(--panel)] shadow-[0_0_48px_rgba(0,0,0,0.7)] animate-fadeIn"
            >
              {/* Header */}
              <div className="flex shrink-0 items-center justify-between border-b border-[var(--accent)]/20 px-5 py-3">
                <h3
                  id={titleId}
                  className="font-mono text-sm uppercase tracking-wider text-[var(--accent)]"
                >
                  // Synopsis
                </h3>
                <button
                  ref={closeRef}
                  onClick={() => setOpen(false)}
                  aria-label="Close synopsis"
                  className="ml-4 flex h-7 w-7 items-center justify-center rounded-none border border-[var(--accent)]/30 text-xs text-[var(--accent)]/70 transition-colors hover:border-[var(--accent)]/70 hover:text-[var(--accent)]"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </div>

              {/* Full description — its own scroll area */}
              <div className="max-h-[70vh] overflow-y-auto overscroll-contain px-5 py-4 text-[15px] leading-relaxed whitespace-pre-wrap text-[#9a9aa0]">
                {description}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
