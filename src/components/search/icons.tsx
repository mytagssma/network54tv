import type { SVGProps } from "react";

/** Thin stroke icons used by the shared search controls. */
type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...props }: IconProps) {
  return (
    <svg
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
    </Base>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
      />
    </Base>
  );
}

export function ResetIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </Base>
  );
}

/* The glyphs that used to be defined here (and the dropdown chevron, whose
   path Player.tsx also carried inline) are single-sourced in the shared
   library — re-exported so every existing `from "./icons"` keeps working. */
export { ChevronDownIcon, SearchIcon, XIcon } from "@/components/ui/icons";
