import { getAnimeById } from "@/lib/anilist";
import { getEpisodes } from "@/lib/providers";
import { notFound } from "next/navigation";
import Player from "@/components/player/Player";
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

  const episodes = await getEpisodes(anime.title, animeId, provider);

  // Find current episode's providerId for consistent stream fetching
  const currentEp = episodes.find((ep) => ep.number === episodeNumber);
  const episodeProviderId = currentEp?.providerId;

  // Filter available episodes for navigation
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
      <div className="flex items-center gap-2 text-xs text-[#6b6b70] mb-4">
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

      {/* Player */}
      <Player animeTitle={anime.title} episodeNumber={episodeNumber} anilistId={animeId} malId={anime.idMal} nextEpisodeNumber={nextEp?.number} providerId={episodeProviderId} />

      {/* Episode navigation */}
      <div className="flex items-center justify-between mt-4">
        <div>
          {prevEp && (
            <Link
              href={`/anime/${animeId}/watch/${prevEp.number}${providerQs}`}
              className="group flex items-center gap-2 text-sm text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors border border-[var(--accent)]/20 hover:border-[var(--accent)]/50 px-4 py-2 rounded-none"
            >
              <svg
                className="w-4 h-4"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
              </svg>
              <span className="hidden sm:inline">
                EP {String(prevEp.number).padStart(2, "0")}
              </span>
              <span className="sm:hidden">Prev</span>
            </Link>
          )}
        </div>

        <div>
          <Link
              href={`/anime/${animeId}${providerQs}`}
            className="text-xs text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors uppercase tracking-wider"
          >
            All Episodes
          </Link>
        </div>

        <div>
          {nextEp && (
            <Link
              href={`/anime/${animeId}/watch/${nextEp.number}${providerQs}`}
              className="group flex items-center gap-2 text-sm text-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors border border-[var(--accent)]/20 hover:border-[var(--accent)]/50 px-4 py-2 rounded-none"
            >
              <span className="hidden sm:inline">
                EP {String(nextEp.number).padStart(2, "0")}
              </span>
              <span className="sm:hidden">Next</span>
              <svg
                className="w-4 h-4"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
              </svg>
            </Link>
          )}
        </div>
      </div>

      {/* Episode grid */}
      {episodes.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-[var(--accent)] uppercase tracking-wider mb-3">
            Episodes
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
            {episodes.map((ep) => {
              const isAvailable = ep.available !== false;
              const isCurrent = ep.number === episodeNumber;
              if (isAvailable) {
                return (
                  <Link
                    key={ep.number}
                    href={`/anime/${animeId}/watch/${ep.number}${providerQs}`}
                    className={`text-center py-3 text-xs sm:py-2 font-mono border transition-all duration-200 rounded-none min-h-[44px] flex items-center justify-center ${
                      isCurrent
                        ? "bg-[var(--accent)] border-[var(--accent)] text-black font-bold"
                        : "border-[var(--accent)]/10 text-[var(--accent)]/50 hover:border-[var(--accent)]/50 hover:text-[var(--accent)]"
                    }`}
                  >
                    {String(ep.number).padStart(2, "0")}
                  </Link>
                );
              }
              return (
                <div
                  key={ep.number}
                  className="text-center py-3 text-xs sm:py-2 font-mono border border-[#6b6b70]/10 text-[#6b6b70] rounded-none opacity-50 cursor-not-allowed min-h-[44px] flex items-center justify-center"
                >
                  {String(ep.number).padStart(2, "0")}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
