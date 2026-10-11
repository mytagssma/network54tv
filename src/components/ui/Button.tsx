import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * The button primitive for the boxed/quiet action language (44px tall,
 * `rounded-none`, 1px border, `transition-colors`) that the player's error
 * overlay, the /design replica of it, the ⋯ menu's drill lists and the
 * episode pager all share.
 *
 * Every class string below is copied VERBATIM from the markup it replaces —
 * same utilities, same order — so swapping a literal `className` for a
 * `variant` is byte-for-byte a no-op in the rendered DOM.
 *
 * Two entry points on purpose:
 *   - `<Button variant=… />`  for real buttons (keeps every native prop).
 *   - `buttonClass(variant)`  for `<Link>` / `<div>` look-alikes (the
 *     "All Episodes" escape hatch is a link, not a button) and for callers
 *     that build their own element.
 */
export type ButtonVariant =
  /** Error overlay's primary action — "Retry". Accent 30% border. */
  | "accent"
  /** Error overlay's secondary action — "Try Dub" / "Try Sub". Quiet 10% border. */
  | "quiet"
  /** Error overlay's escape hatch — "All Episodes" (link-shaped: inline-flex). */
  | "quietLink"
  /** Error overlay's provider chip — mono 10px, 36px tall, `active` swaps the paint. */
  | "provider"
  /** ⋯ menu drill-down row — full-bleed, `active` swaps in the accent rail. */
  | "menuRow"
  /** Episode selector's `‹ 1/5 ›` pager — 44px mobile / 28px desktop hit. */
  | "pager";

/** The invariant shell shared by the 44px action variants. */
const ACTION_BASE =
  "text-xs px-5 py-2.5 border transition-colors rounded-none min-h-[44px]";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  accent: cn(ACTION_BASE, "border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/10"),
  quiet: cn(ACTION_BASE, "border-white/10 text-[var(--text-secondary)] hover:bg-white/5"),
  quietLink: cn(
    ACTION_BASE,
    "border-white/10 text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/40 inline-flex items-center",
  ),
  provider: "text-[10px] px-2.5 py-1.5 border font-mono uppercase tracking-wider transition-colors rounded-none min-h-[36px]",
  menuRow: "w-full rounded-none px-3 py-1.5 text-left text-xs transition-colors",
  pager:
    "h-11 w-11 sm:h-7 sm:w-7 grid place-items-center rounded-none border border-[var(--accent)]/25 text-base leading-none text-[var(--accent)]/70 transition-colors hover:border-[var(--accent)]/60 hover:text-[var(--accent)] disabled:opacity-30 disabled:pointer-events-none",
};

/** Paint for the two variants that have a selected state. */
const STATE_CLASS: Partial<Record<ButtonVariant, { on: string; off: string }>> = {
  provider: {
    on: "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/15",
    off: "border-white/10 text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/40",
  },
  menuRow: {
    on: "border-l-2 border-[var(--accent)] bg-[var(--accent)]/20 text-[var(--accent)]",
    off: "text-[var(--text-secondary)] hover:bg-[var(--accent)]/5 hover:text-[var(--accent)]",
  },
};

/**
 * The exact class string for a variant. `active` only matters for the
 * variants that carry a selected state (`provider`, `menuRow`); it is
 * ignored elsewhere so callers never have to think about it.
 */
export function buttonClass(variant: ButtonVariant, active = false): string {
  const state = STATE_CLASS[variant];
  return cn(VARIANT_CLASS[variant], state && (active ? state.on : state.off));
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Selected paint for `provider` / `menuRow`. Ignored by the others. */
  active?: boolean;
}

/** `<button>` wired to {@link buttonClass}. Native props pass straight through. */
export default function Button({
  variant = "quiet",
  active = false,
  className,
  ...props
}: ButtonProps) {
  // No `type` default: the markup this replaces is a bare <button>, and
  // React renders the attribute only when it is passed. Adding `type="button"`
  // would be a (harmless here, but real) DOM delta.
  return <button className={cn(buttonClass(variant, active), className)} {...props} />;
}
