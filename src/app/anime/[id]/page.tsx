import { getAnimeById } from "@/lib/anilist";
import { notFound } from "next/navigation";
import ExpandableDescription from "@/components/ui/ExpandableDescription";
import EpisodeListFetcher from "@/components/anime/EpisodeListFetcher";

export const revalidate = 300;

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ provider?: string }>;
}

export default async function AnimeDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const animeId = parseInt(id, 10);
  if (isNaN(animeId)) notFound();

  const anime = await getAnimeById(animeId);
  if (!anime) notFound();

  return (
    <div className="min-h-screen bg-[var(--background)] text-white">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* ── Anime Info Section ── */}
        {/* Mobile: compact poster beside title, synopsis full-width below.
            Desktop (md+): unchanged 3-col grid — poster left, details right. */}
        <div className="grid grid-cols-[7.5rem_1fr] md:grid-cols-3 gap-x-4 gap-y-5 md:gap-8 items-start mb-12">
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

          {/* Title(s) + status badges */}
          <div className="min-w-0 space-y-5 md:col-span-2">
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
          </div>

          {/* Synopsis + Genres — full width on mobile, right column on desktop */}
          <div className="col-span-2 md:col-span-2 md:col-start-2 space-y-5">
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

        {/* ── Episode List (client-fetched, responds to provider changes) ── */}
        <EpisodeListFetcher animeTitle={anime.title} animeId={animeId} initialEpisodes={[]} />
      </div>
    </div>
  );
}
