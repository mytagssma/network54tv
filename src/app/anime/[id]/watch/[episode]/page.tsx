import { getAnimeById, getAnimeFull } from "@/lib/anilist";
import { getAudioFlags, getEpisodes } from "@/lib/providers";
import { notFound } from "next/navigation";
import WatchDock from "@/components/watch/WatchDock";
import { EmptyState } from "@/components/anime/Availability";
import FranchiseStrip from "@/components/watch/FranchiseStrip";
import { buildFranchiseEntries } from "@/components/watch/franchiseEntries";
import { getFranchiseItems } from "@/lib/franchise";
import Link from "next/link";

export const revalidate = 0;

interface Props {
  params: Promise<{ id: string; episode: string }>;
  searchParams: Promise<{ provider?: string }>;
}

export default async function WatchPage({ params, searchParams }: Props) {
  const { id, episode } = await params;
  const { provider } = await searchParams;
  const animeId = parseInt(id, 10);
  const episodeNumber = parseInt(episode, 10);
  if (isNaN(animeId) || isNaN(episodeNumber)) notFound();

  const anime = await getAnimeById(animeId);
  if (!anime) notFound();

  // getAnimeById maps DETAIL_QUERY down to `Anime` (no relations), so pull the
  // raw media too for the franchise strip — same query, so Next's fetch cache
  // (revalidate: 300) serves it from the request getAnimeById just made. The
  // shared resolver then expands the relation graph transitively (batched
  // `id_in` fetches, each cached for 300s) so this strip lists exactly the
  // same entries, with the same season numbers, as the detail page's row.
  const [fullMedia, episodeList] = await Promise.all([
    getAnimeFull(animeId),
    getEpisodes(anime.title, animeId, provider),
  ]);
  const rawEpisodes = episodeList.episodes;
  // Why the list below can be empty — `ok` / `none` / `suspect`. It only
  // changes the reason line under `// NO EPISODE DATA`, never the heading.
  const { listStatus } = episodeList;
  // Fold in any sub/dub flags an earlier audio probe already learned — pure
  // cache lookup, zero I/O, so it costs nothing here. `episodeHasDub` below is
  // the ONE dub truth the player consumes; it does not re-derive it.
  const { episodes } = await getAudioFlags(rawEpisodes, animeId, false);
  const franchise = buildFranchiseEntries(
    await getFranchiseItems(animeId, fullMedia),
    animeId
  );

  // Find current episode's providerId for consistent stream fetching
  const currentEp = episodes.find((ep) => ep.number === episodeNumber);
  const episodeProviderId = currentEp?.providerId;

  // Navigation runs over the SAME `available` the episode list renders — one
  // definition, applied by `applyAvailability` in providers.ts.
  //
  // Decision: the player's next-episode handoff TRUNCATES the run (it steps
  // over a dimmed row) while the episode list KEEPS that row visible with an
  // `N/A` reason label. They are two views of one field, and both are
  // deliberate: hiding the row would make the numbering look broken, while
  // routing through it would hand the viewer a row the list itself marks
  // dead — a dead end with no way back. The gap is therefore visible where
  // you scan (the list) and invisible where you navigate (auto-next). (The
  // old episode-nav bar under the player is gone — the player's transport
  // covers prev/next — so only the NEXT handoff is computed here.)
  const availableEpisodes = episodes.filter((ep) => ep.available !== false);
  const currentEpIndex = availableEpisodes.findIndex(
    (ep) => ep.number === episodeNumber
  );
  const nextEp =
    currentEpIndex < availableEpisodes.length - 1
      ? availableEpisodes[currentEpIndex + 1]
      : null;
  const providerQs = provider ? `?provider=${provider}` : "";

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-[var(--text-decorative)] mb-4">
        <Link
          href="/"
          className="text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors"
        >
          Home
        </Link>
        <span className="text-[var(--accent)]">/</span>
        <Link
          href={`/anime/${animeId}${providerQs}`}
          className="text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors truncate max-w-[200px]"
        >
          {anime.title}
        </Link>
        <span className="text-[var(--accent)]">/</span>
        <span className="text-[var(--accent)]/50">
          EP {String(episodeNumber).padStart(2, "0")}
        </span>
      </div>

      {/* Player + episode panel — WatchDock owns the dock toggle and the
          title band: the h1 renders above the player in both modes, and the
          docked panel header joins it on the right (lg+, preference
          persisted in localStorage) while the panel docks beside the
          player. FranchiseStrip passes through as children so it stays
          server-rendered here, full width, below the docked row. */}
      <WatchDock
        title={
          <h1 className="text-xl font-bold text-[var(--accent)] mb-4 uppercase tracking-wider">
            {anime.title}{" "}
            <span className="text-[var(--accent)]/50 font-mono text-base">
              &mdash; Episode {episodeNumber}
            </span>
          </h1>
        }
        animeTitle={anime.title}
        episodeNumber={episodeNumber}
        anilistId={animeId}
        malId={anime.idMal}
        nextEpisodeNumber={nextEp?.number}
        providerId={episodeProviderId}
        providerQuery={provider}
        episodes={episodes}
        // FULL run WITH availability — the drawer marks `available: false`
        // rows N/A + inert (EpisodeList's treatment) instead of dropping
        // them: a hidden row breaks the numbering, a marked one explains it.
        // The player's next-episode handoff still walks the filtered
        // `availableEpisodes`, so navigation steps over dead rows while the
        // drawer shows them.
        drawerEpisodes={episodes.map((ep) => ({
          number: ep.number,
          title: ep.title,
          available: ep.available,
          hasSub: ep.hasSub,
          hasDub: ep.hasDub,
        }))}
        // Same entries as the `// Franchise` grid below — the fullscreen
        // drawer's series dropdown is fed from this one list.
        franchise={franchise}
        // This episode's own dub flag (true / false / null = provider didn't
        // say). The player gates the DUB button on it instead of guessing.
        episodeHasDub={currentEp?.hasDub ?? null}
      >
        {/* Franchise / season switcher (hidden when there are no relations) */}
        <FranchiseStrip entries={franchise} provider={provider} />
      </WatchDock>

      {/* Zero episodes is a real provider answer, not a loading gap, so it
          says so instead of rendering nothing under the player. (The
          non-empty case renders inside WatchDock, which owns the panel's
          docked-rail vs below-the-band positions.) */}
      {episodes.length === 0 && (
        <div className="mt-8">
          <EmptyState
            code="NO_EPISODE_DATA"
            detail={listStatus === "suspect" ? "suspect" : undefined}
          />
        </div>
      )}
    </div>
  );
}
