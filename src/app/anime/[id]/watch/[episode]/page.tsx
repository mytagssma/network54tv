import { getAnimeById, getAnimeFull } from "@/lib/anilist";
import { getAudioFlags, getEpisodes } from "@/lib/providers";
import { notFound } from "next/navigation";
import Player from "@/components/player/Player";
import EpisodeBrowser from "@/components/watch/EpisodeBrowser";
import { EmptyState } from "@/components/anime/Availability";
import FranchiseStrip from "@/components/watch/FranchiseStrip";
import { buildFranchiseEntries } from "@/components/watch/franchiseEntries";
import { getFranchiseItems } from "@/lib/franchise";
import Link from "next/link";
import {
  ChevronLeftSolidIcon,
  ChevronRightSolidIcon,
  MenuIcon,
} from "@/components/ui/icons";

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

  // Navigation runs over the SAME `available` the lists below render — one
  // definition, applied by `applyAvailability` in providers.ts.
  //
  // Decision: prev/next TRUNCATES the run (it steps over a dimmed row) while
  // the episode list KEEPS that row visible with an `N/A` reason label. They
  // are two views of one field, and both are deliberate: hiding the row would
  // make the numbering look broken, while routing through it would let the
  // countdown and the next button hand the viewer a row the list itself marks
  // dead — a dead end with no way back. The gap is therefore visible where you
  // scan (the list) and invisible where you navigate (the buttons).
  const availableEpisodes = episodes.filter((ep) => ep.available !== false);
  const currentEpIndex = availableEpisodes.findIndex(
    (ep) => ep.number === episodeNumber
  );
  const prevEp = currentEpIndex > 0 ? availableEpisodes[currentEpIndex - 1] : null;
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

      <h1 className="text-xl font-bold text-[var(--accent)] mb-4 uppercase tracking-wider">
        {anime.title}{" "}
        <span className="text-[var(--accent)]/50 font-mono text-base">
          &mdash; Episode {episodeNumber}
        </span>
      </h1>

      {/* Player — bleeds the container's 16px padding on both sides
          (`-mx-4`) so the frame runs edge-to-edge with the page column */}
      <div className="-mx-4">
      <Player
        animeTitle={anime.title}
        episodeNumber={episodeNumber}
        anilistId={animeId}
        malId={anime.idMal}
        nextEpisodeNumber={nextEp?.number}
        providerId={episodeProviderId}
        providerQuery={provider}
        episodes={availableEpisodes.map((ep) => ({ number: ep.number, title: ep.title }))}
        // Same entries as the `// Franchise` grid below — the fullscreen
        // drawer's series dropdown is fed from this one list.
        franchise={franchise}
        // This episode's own dub flag (true / false / null = provider didn't
        // say). The player gates the DUB button on it instead of guessing.
        episodeHasDub={currentEp?.hasDub ?? null}
      />
      </div>

      {/* Episode navigation — ONE aligned row: prev + the episode-list
          action sit left, next sits right. All three share the same quiet
          text+chevron treatment and a 44px touch height (the ⋯ sheet's row
          language), so "All Episodes" no longer floats center as a bare
          link between two boxed buttons at mobile. */}
      <div className="mt-4 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center">
          {prevEp && (
            <Link
              href={`/anime/${animeId}/watch/${prevEp.number}${providerQs}`}
              className="group flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-none px-2 text-xs uppercase tracking-wider text-[var(--accent)]/50 transition-colors hover:text-[var(--accent)]"
            >
              <ChevronLeftSolidIcon className="h-4 w-4 shrink-0" />
              <span className="hidden whitespace-nowrap sm:inline">
                EP {String(prevEp.number).padStart(2, "0")}
              </span>
              <span className="whitespace-nowrap sm:hidden">Prev</span>
            </Link>
          )}
          <Link
            href={`/anime/${animeId}${providerQs}`}
            className="group flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-none px-2 text-xs uppercase tracking-wider text-[var(--accent)]/50 transition-colors hover:text-[var(--accent)]"
          >
            <MenuIcon className="h-4 w-4 shrink-0" />
            <span className="whitespace-nowrap">All Episodes</span>
          </Link>
        </div>
        {nextEp && (
          <Link
            href={`/anime/${animeId}/watch/${nextEp.number}${providerQs}`}
            className="group flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-none px-2 text-xs uppercase tracking-wider text-[var(--accent)]/50 transition-colors hover:text-[var(--accent)]"
          >
            <span className="hidden whitespace-nowrap sm:inline">
              EP {String(nextEp.number).padStart(2, "0")}
            </span>
            <span className="whitespace-nowrap sm:hidden">Next</span>
            <ChevronRightSolidIcon className="h-4 w-4 shrink-0" />
          </Link>
        )}
      </div>

      {/* Franchise / season switcher (hidden when there are no relations) */}
      <FranchiseStrip entries={franchise} provider={provider} />

      {/* Paged episode selector — the full run, natural height.
          Zero episodes is a real provider answer, not a loading gap, so it
          says so instead of rendering nothing under the player. */}
      {episodes.length > 0 ? (
        <div className="mt-8">
          <EpisodeBrowser
            episodes={episodes}
            animeId={animeId}
            provider={provider}
            currentEpisode={episodeNumber}
          />
        </div>
      ) : (
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
