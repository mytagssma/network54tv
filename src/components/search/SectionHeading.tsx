import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "solid" | "soft" | "dim";

interface SectionHeadingProps {
  title: string;
  /** Extra text after the title, e.g. "S1–S3 · Prequel · 4 titles". */
  detail?: string;
  icon?: ReactNode;
  size?: "lg" | "sm";
  tone?: Tone;
  /** Heading level — section titles default to h2, sub-groups to h3. */
  as?: "h2" | "h3";
  className?: string;
}

/**
 * "// SECTION" heading with the accent tick — used for results, trending,
 * popular and franchise group titles so every route reads the same way.
 */
export default function SectionHeading({
  title,
  detail,
  icon,
  size = "lg",
  tone = "solid",
  as,
  className,
}: SectionHeadingProps) {
  const Tag: ElementType = as ?? (size === "lg" ? "h2" : "h3");

  const bar = cn(
    "w-1 shrink-0",
    size === "lg" ? "h-5" : "h-4",
    tone === "dim"
      ? "bg-[var(--accent)]/40"
      : tone === "soft" || size === "sm"
      ? "bg-[var(--accent)]/60"
      : "bg-[var(--accent)]"
  );

  const text = cn(
    "uppercase tracking-wider font-mono font-black",
    size === "lg" ? "text-lg" : "text-sm",
    tone === "dim"
      ? "text-[var(--accent)]/50"
      : tone === "soft"
      ? "text-[var(--accent)]/70"
      : size === "sm"
      ? "text-[var(--accent)]/80"
      : "text-[var(--accent)]"
  );

  return (
    <div className={cn("flex items-center gap-3 mb-4", className)}>
      <div className={bar} />
      {icon}
      <Tag className={text}>{"// "}{title}</Tag>
      {detail && (
        <span
          className={cn(
            "font-mono text-[11px] text-[var(--text-decorative)]",
            tone === "dim" && "text-[var(--text-decorative)]/70"
          )}
        >
          {detail}
        </span>
      )}
    </div>
  );
}
