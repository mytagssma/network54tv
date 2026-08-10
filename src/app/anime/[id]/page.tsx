import { getAnimeById } from "@/lib/anilist";
import { getEpisodes } from "@/lib/providers";
import { notFound } from "next/navigation";
import ExpandableDescription from "@/components/ui/ExpandableDescription";
import EpisodeList from "@/components/anime/EpisodeList";

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
            <EpisodeList episodes={episodes} animeId={animeId} />
          ) : (
            <p className="text-[#6b6b70] italic">No episodes available.</p>
          )}
        </div>
      </div>
    </div>
  );
}
