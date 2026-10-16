import { Suspense } from "react";
import { getAnimeById, getAnimeFull } from "@/lib/anilist";
import { notFound } from "next/navigation";
import ExpandableDescription from "@/components/ui/ExpandableDescription";
import EpisodeListFetcher from "@/components/anime/EpisodeListFetcher";
import FranchiseRow from "@/components/anime/FranchiseRow";
import { getFranchiseItems } from "@/lib/franchise";
import { getAudioFlags, getEpisodes } from "@/lib/providers";
import { LoadingNote } from "@/components/anime/Availability";
import {
  formatAirsDate,
  formatAirsDelta,
  formatLabel,
  resolveEpisodeFraction,
  statusLabel,
} from "@/lib/anime-meta";

export const revalidate = 300;

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ provider?: string }>;
}

/**
 * The episode list, server-fetched and streamed. It consumes `getEpisodes`
 * DIRECTLY — same process as `/api/episodes`, so the in-process availability
 * cache is shared (a page hit and an API hit are one cache) and the client
 * roundtrip is gone entirely: before, the page painted with an empty SSR
 * payload and the browser stared at "Fetching episodes…" for the hydration
 * gap PLUS the full cold provider walk. The audio=1 probe stays a CLIENT
 * second pass inside EpisodeListFetcher: it costs a megaplay round trip
 * (~1–3s) and must not delay the rows, exactly as before.
 */
async function EpisodeSection({ animeTitle, animeId }: { animeTitle: string; animeId: number }) {
  // Data first, JSX outside the try/catch (react-hooks/error-boundaries).
  let data: {
    episodes: Awaited<ReturnType<typeof getAudioFlags>>["episodes"];
    audio: Awaited<ReturnType<typeof getAudioFlags>>["audio"] | null;
    listStatus: Awaited<ReturnType<typeof getEpisodes>>["listStatus"] | null;
  } | null = null;
  try {
    // The same two calls /api/episodes makes, minus the `?audio=1` probe.
    // `getEpisodes` resolves the AniList expected-count itself when omitted
    // (fetch-cached) so the plausibility gate behaves identically.
    const { episodes, listStatus } = await getEpisodes(animeTitle, animeId);
    const { episodes: withFlags, audio } = await getAudioFlags(episodes, animeId, false);
    data = { episodes: withFlags, audio, listStatus };
  } catch {
    // Mirrors the route's error path: an empty answer keeps the same
    // empty-state language instead of failing the whole page.
    data = { episodes: [], audio: null, listStatus: null };
  }
  return (
    <EpisodeListFetcher
      animeTitle={animeTitle}
      animeId={animeId}
      episodes={data.episodes}
      audio={data.audio}
      listStatus={data.listStatus}
    />
  );
}

/** Suspense fallback: the same `// EPISODES` header + "Fetching episodes…"
 *  line the client used to show, so the streamed swap is visually seamless. */
function EpisodeListSkeleton() {
  return (
    <div>
      <div className="flex items-center gap-4 mb-5">
        <h2 className="text-xl font-bold text-[var(--accent)] uppercase tracking-wider">
          {"// Episodes"}
        </h2>
      </div>
      <LoadingNote state="rows" />
    </div>
  );
}

/**
 * The relation walk, streamed behind its own Suspense boundary so it can no
 * longer block first paint: the shell above (title, badges, synopsis, genres)
 * and the episode list (which streams independently) render without waiting
 * for it.
 *
 * getAnimeById maps DETAIL_QUERY down to `Anime` (relations dropped), so pull
 * the raw media too for the franchise row — same query, so Next's fetch cache
 * (revalidate: 300) serves it from the request getAnimeById just made. The
 * resolver then walks the relation graph transitively (bounded BFS over batch
 * `id_in` fetches, each cached for 300s) so seasons that are only linked
 * through *other* entries show up here too. The fallback is `null` because
 * FranchiseRow itself renders nothing when no entry qualifies — a standalone
 * title shows the same page either way, so there is no layout shift.
 */
async function FranchiseSection({ animeId }: { animeId: number }) {
  const fullMedia = await getAnimeFull(animeId);
  const franchiseItems = await getFranchiseItems(animeId, fullMedia);
  return <FranchiseRow items={franchiseItems} currentId={animeId} />;
}

export default async function AnimeDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const animeId = parseInt(id, 10);
  if (isNaN(animeId)) notFound();

  const anime = await getAnimeById(animeId);
  if (!anime) notFound();

  // AniList scores are 0–100 → render as e.g. 8.5. Same gate and shape as
  // AnimeCard.tsx (ratingLabel): a number > 0 only, so an unresolved/absent
  // score renders no element at all rather than a stray ★.
  const ratingLabel =
    typeof anime.score === "number" && Number.isFinite(anime.score) && anime.score > 0
      ? (anime.score / 10).toFixed(1)
      : null;

  // Same fraction the card badge renders (`3/12 EP` while airing, plain
  // `12 EP` once the run is done) — one episode-count truth across surfaces.
  // Null = AniList doesn't know the total → no episode badge at all.
  const fraction = resolveEpisodeFraction(anime);
  // Quiet schedule line: "Ep 4 airs in 2d" while airing, "Airs Oct 20" for a
  // not-yet-released title with a known premiere.
  const nextAiring = anime.status === "RELEASING" ? anime.nextAiringEpisode : undefined;
  const airsDelta =
    typeof nextAiring?.episode === "number" && nextAiring.airingAt != null
      ? formatAirsDelta(nextAiring.airingAt)
      : null;
  const airsDate = anime.status === "NOT_YET_RELEASED" ? formatAirsDate(anime.startDate) : null;

  return (
    <div className="min-h-screen bg-[var(--background)] text-white">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* ── Anime Info Section ── */}
        {/* Mobile: compact poster beside title, synopsis full-width below.
            Desktop (md+): poster left, one flow column right — title → badges →
            synopsis stack contiguously (no separate grid row = no dead gap). */}
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

          {/* Details — `contents` on mobile (children are grid items, synopsis
              spans full width); a single block column from md up */}
          <div className="contents md:col-span-2 md:col-start-2 md:block md:min-w-0 md:space-y-5">
            {/* Title(s) + status badges */}
            <div className="min-w-0 space-y-3">
              {/* Title(s) */}
              <div>
                <h1 className="text-2xl font-bold text-white uppercase tracking-wider">{anime.title}</h1>
                {anime.englishTitle && anime.englishTitle !== anime.title && (
                  <p className="text-lg text-[var(--text-secondary)] mt-1">
                    {anime.englishTitle}
                  </p>
                )}
              </div>

              {/* Status & Info badges */}
              <div className="flex flex-wrap gap-2 text-sm">
                {ratingLabel && (
                  <span className="inline-flex items-baseline gap-1 bg-transparent border border-[var(--accent)]/30 text-[var(--accent)] px-3 py-1 font-mono uppercase tracking-wider text-xs rounded-none">
                    <span aria-hidden="true">★</span>
                    <span className="tabular-nums">{ratingLabel}</span>
                  </span>
                )}
                {anime.status && (
                  <span className="bg-transparent border border-[var(--accent)]/30 text-[var(--accent)] px-3 py-1 font-mono uppercase tracking-wider text-xs rounded-none">
                    {statusLabel(anime.status)}
                  </span>
                )}
                {anime.format && (
                  <span className="bg-transparent border border-[var(--accent)]/30 text-[var(--accent)] px-3 py-1 font-mono uppercase tracking-wider text-xs rounded-none">
                    {formatLabel(anime.format)}
                  </span>
                )}
                {/* One episode-count truth: the SAME fraction the card badge
                    renders — `3/12 EP` while airing, `12 EP` once released —
                    instead of a bare total next to a card that knows better. */}
                {fraction && (
                  <span className="bg-transparent border border-[var(--accent)]/30 text-[var(--accent)] px-3 py-1 font-mono uppercase tracking-wider text-xs rounded-none">
                    {fraction.label}
                  </span>
                )}
                {/* Quiet schedule/premiere line — same badge box, same ladder. */}
                {airsDelta && nextAiring?.episode != null && (
                  <span className="bg-transparent border border-[var(--accent)]/30 text-[var(--accent)] px-3 py-1 font-mono uppercase tracking-wider text-xs rounded-none">
                    Ep {nextAiring.episode} airs {airsDelta}
                  </span>
                )}
                {airsDate && (
                  <span className="bg-transparent border border-[var(--accent)]/30 text-[var(--accent)] px-3 py-1 font-mono uppercase tracking-wider text-xs rounded-none">
                    {airsDate}
                  </span>
                )}
                {anime.season && anime.seasonYear && (
                  <span className="bg-transparent border border-[var(--accent)]/30 text-[var(--accent)] px-3 py-1 font-mono uppercase tracking-wider text-xs rounded-none">
                    {anime.season} {anime.seasonYear}
                  </span>
                )}
                {/* Selected in DETAIL_QUERY and mapped since forever, but never
                    rendered — now the studio line + runtime complete the badge
                    block, in the exact same box. */}
                {anime.studios.length > 0 && (
                  <span className="bg-transparent border border-[var(--accent)]/30 text-[var(--accent)] px-3 py-1 font-mono uppercase tracking-wider text-xs rounded-none">
                    {anime.studios.slice(0, 2).join(", ")}
                  </span>
                )}
                {typeof anime.duration === "number" && anime.duration > 0 && (
                  <span className="bg-transparent border border-[var(--accent)]/30 text-[var(--accent)] px-3 py-1 font-mono uppercase tracking-wider text-xs rounded-none">
                    {anime.duration} min
                  </span>
                )}
              </div>
            </div>

            {/* Synopsis + Genres — full width on mobile, same column as title on desktop */}
            <div className="col-span-2 min-w-0 space-y-5">
              {/* Description */}
              <div>
                <h2 className="text-lg font-semibold mb-2 text-[var(--accent)] uppercase tracking-wider">
                  // Synopsis
                </h2>
                {anime.description ? (
                  <ExpandableDescription description={anime.description} maxLines={3} />
                ) : (
                  <p className="text-[var(--text-decorative)] italic">
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
        </div>

        {/* ── Same franchise — compact row of related entries (hidden when none).
            Streamed behind its own boundary so the relation walk can't hold
            the first paint hostage while the episodes stream in. ── */}
        <Suspense fallback={null}>
          <FranchiseSection animeId={animeId} />
        </Suspense>

        {/* ── Episode List — server-fetched, streamed behind a Suspense
            boundary: the shell above paints immediately and this section
            swaps in when the provider walk resolves. ── */}
        <Suspense fallback={<EpisodeListSkeleton />}>
          <EpisodeSection animeTitle={anime.title} animeId={animeId} />
        </Suspense>
      </div>
    </div>
  );
}
