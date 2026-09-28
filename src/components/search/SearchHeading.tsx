import { cn } from "@/lib/utils";

interface SearchHeadingProps {
  /** Plain title shown when no query is active, e.g. "Browse Anime". */
  title: string;
  /** Active query — renders "// SEARCH: <query>" when non-empty. */
  query?: string;
  className?: string;
}

/**
 * Page heading for search-driven routes. Uppercase is applied by CSS so the
 * rendered text reads `// SEARCH: STONE` / `// BROWSE ANIME`.
 */
export default function SearchHeading({ title, query, className }: SearchHeadingProps) {
  const active = query?.trim();
  return (
    <h1
      className={cn(
        "text-2xl font-bold uppercase tracking-wider text-[var(--accent)] mb-4",
        className
      )}
    >
      {active ? `// Search: ${active}` : `// ${title}`}
    </h1>
  );
}
