"use client";

import { groupByFranchise } from "@/lib/anilist";
import type { Anime } from "@/types/anime";
import AnimeCard from "@/components/anime/AnimeCard";
import SectionHeading from "./SectionHeading";

interface GroupedResultsProps {
  items: Anime[];
  /** Cluster results into franchise sections. */
  groupFranchise: boolean;
  /** Keep the fetched order inside each group (an explicit sort is active). */
  preserveOrder: boolean;
  navigatingId: number | null;
  onNavigate: (id: number) => void;
}

const GRID =
  "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3";

/**
 * Search results grid, shared by both routes: flat by default, split into
 * franchise sections (with a flat tail for lone results) when grouping is on.
 */
export default function GroupedResults({
  items,
  groupFranchise,
  preserveOrder,
  navigatingId,
  onNavigate,
}: GroupedResultsProps) {
  const renderCard = (anime: Anime) => (
    <AnimeCard
      key={anime.id}
      anime={{
        id: anime.id,
        title: anime.title,
        image: anime.coverImage,
        genres: anime.genres,
        rating: anime.score,
        episodes: anime.episodes,
      }}
      loading={anime.id === navigatingId}
      onClick={() => onNavigate(anime.id)}
    />
  );

  const groupedResults = groupFranchise
    ? groupByFranchise(items, { preserveOrder })
    : [];
  const franchiseGroups = groupedResults.filter((group) => group.items.length > 1);
  const standaloneItems = groupedResults
    .filter((group) => group.items.length === 1)
    .map((group) => group.items[0]);

  if (!groupFranchise || franchiseGroups.length === 0) {
    return <div className={GRID}>{items.map(renderCard)}</div>;
  }

  return (
    <>
      {franchiseGroups.map((group) => (
        <section key={group.items[0].id} className="mb-8 last:mb-0">
          <SectionHeading
            as="h3"
            size="sm"
            title={group.label}
            detail={`${group.detail ? `${group.detail} · ` : ""}${
              group.items.length
            } title${group.items.length === 1 ? "" : "s"}`}
          />
          <div className={GRID}>{group.items.map(renderCard)}</div>
        </section>
      ))}
      {standaloneItems.length > 0 && (
        <div className="mt-8">
          {/* Dimmer divider: separates franchise sections from the flat tail */}
          <SectionHeading
            as="h3"
            size="sm"
            tone="dim"
            title="More Titles"
            detail={`${standaloneItems.length} standalone title${
              standaloneItems.length === 1 ? "" : "s"
            }`}
          />
          <div className={GRID}>{standaloneItems.map(renderCard)}</div>
        </div>
      )}
    </>
  );
}
