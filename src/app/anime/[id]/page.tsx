import { getAnimeById } from "@/lib/anilist";
import { getEpisodes } from "@/lib/providers";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Episode } from "@/types/anime";
import ExpandableDescription from "@/components/ui/ExpandableDescription";

export const revalidate = 300;

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ provider?: string }>;
}

export default async function AnimeDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const animeId = parseInt(id, 10);
  if (isNaN(animeId)) notFound();

  const { provider } = await searchParams;

  const anime = await getAnimeById(animeId);
  if (!anime) notFound();

  const episodes = await getEpisodes(anime.title, animeId, provider);

  // null = unknown → assume subbed (most content is subbed); dub only when explicitly true
  const subCount = episodes.filter((ep) => ep.hasSub !== false).length;
  const dubCount = episodes.filter((ep) => ep.hasDub === true).length;

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-gray-100">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* ── Anime Info Section ── */}
        <div className="grid md:grid-cols-3 gap-8 mb-12">
          {/* Cover Image */}
          <div className="md:col-span-1">
            <div className="overflow-hidden border border-[var(--accent)]/10 rounded-none">
              <img
                src={anime.coverImage}
                alt={anime.title}
                className="w-full object-cover"
              />
            </div>
          </div>

          {/* Details */}
          <div className="md:col-span-2 space-y-5">
            {/* Title(s) */}
            <div>
              <h1 className="text-2xl font-bold text-white uppercase tracking-wider">{anime.title}</h1>
              {anime.englishTitle && anime.englishTitle !== anime.title && (
                <p className="text-lg text-[#9a9aa0] mt-1">
                  {anime.englishTitle}
                </p>
              )}
            </div>

            {/* Status & Info badges */}
            <div className="flex flex-wrap gap-2 text-sm">
              {anime.status && (
                <span className="bg-transparent border border-[var(--accent)]/30 text-[var(--accent)] px-3 py-1 font-mono uppercase tracking-wider text-xs rounded-none">
                  {anime.status.replace(/_/g, " ")}
                </span>
              )}
              {anime.format && (
                <span className="bg-transparent border border-[var(--accent)]/30 text-[var(--accent)] px-3 py-1 font-mono uppercase tracking-wider text-xs rounded-none">
                  {anime.format}
                </span>
              )}
              {anime.episodes != null && (
                <span className="bg-transparent border border-[var(--accent)]/30 text-[var(--accent)] px-3 py-1 font-mono uppercase tracking-wider text-xs rounded-none">
                  {anime.episodes} ep
                </span>
              )}
              {anime.season && anime.seasonYear && (
                <span className="bg-transparent border border-[var(--accent)]/30 text-[var(--accent)] px-3 py-1 font-mono uppercase tracking-wider text-xs rounded-none">
                  {anime.season} {anime.seasonYear}
                </span>
              )}
            </div>

            {/* Description */}
            <div>
              <h2 className="text-lg font-semibold mb-2 text-[var(--accent)] uppercase tracking-wider">
                // Synopsis
              </h2>
              {anime.description ? (
                <ExpandableDescription description={anime.description} maxLines={3} />
              ) : (
                <p className="text-[#6b6b70] italic">
                  No synopsis available.
                </p>
              )}
            </div>

            {/* Genres */}
            {anime.genres.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-2 text-[var(--accent)] uppercase tracking-wider">
                  // Genres
                </h2>
                <div className="flex flex-wrap gap-2">
                  {anime.genres.map((genre) => (
                    <span
                      key={genre}
                      className="bg-[var(--accent)]/10 text-[var(--accent)] text-sm px-3 py-1 border border-[var(--accent)]/20 rounded-none"
                    >
                      {genre}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Episode List Section ── */}
        <div>
          <div className="flex items-center gap-4 mb-5">
            <h2 className="text-xl font-bold text-[var(--accent)] uppercase tracking-wider">
              // Episodes
            </h2>
            {episodes.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="bg-transparent border border-[var(--accent)]/20 text-[var(--accent)]/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider rounded-none">
                  Sub {subCount}
                </span>
                <span className="bg-transparent border border-[var(--accent)]/20 text-[var(--accent)]/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider rounded-none">
                  Dub {dubCount}
                </span>
              </div>
            )}
          </div>

          {episodes.length > 0 ? (
            <div className="grid gap-2 sm:gap-3 max-h-[60vh] sm:max-h-none overflow-y-auto">
              {episodes.map((episode) => {
                const isAvailable = episode.available !== false;
                return isAvailable ? (
                  <Link
                    key={`${episode.id}-${episode.number}`}
                    href={`/anime/${animeId}/watch/${episode.number}`}
                    className="flex items-center gap-3 sm:gap-4 bg-[#131318] hover:bg-[#1a1a20] border-l-2 border-[var(--accent)]/30 hover:border-l-[var(--accent)] p-3 sm:p-4 transition-all group rounded-none"
                  >
                    <span className="bg-[var(--accent)]/10 text-[var(--accent)] font-mono text-sm w-8 text-right shrink-0 font-bold border border-[var(--accent)]/30 py-px">
                      {String(episode.number).padStart(2, "0")}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[#9a9aa0] truncate group-hover:text-white transition-colors">
                        {episode.title || `Episode ${episode.number}`}
                      </p>
                    </div>
                    <svg
                      className="w-5 h-5 text-[#6b6b70] group-hover:text-[var(--accent)] shrink-0 transition-colors"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </Link>
                ) : (
                  <div
                    key={`${episode.id}-${episode.number}`}
                    className="flex items-center gap-3 sm:gap-4 bg-[#131318] border-l-2 border-[#6b6b70]/30 p-3 sm:p-4 rounded-none opacity-50 cursor-not-allowed"
                  >
                    <span className="text-[#6b6b70] font-mono text-sm w-8 text-right shrink-0 font-bold">
                      {String(episode.number).padStart(2, "0")}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[#6b6b70] truncate">
                        {episode.title || `Episode ${episode.number}`}
                      </p>
                    </div>
                    <span className="text-[10px] font-mono text-[#6b6b70] uppercase tracking-wider shrink-0">
                      N/A
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[#6b6b70] italic">No episodes available.</p>
          )}
        </div>
      </div>
    </div>
  );
}
