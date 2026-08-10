import { searchAnime, getTrending, getPopular } from "@/lib/anilist";
import type { Anime } from "@/types/anime";
import AnimeCard from "@/components/anime/AnimeCard";

export const revalidate = 300;

interface BrowsePageProps {
  searchParams: Promise<{ q?: string; page?: string }>;
}

export default async function BrowsePage({ searchParams }: BrowsePageProps) {
  const params = await searchParams;
  const query = params.q || "";
  const page = parseInt(params.page || "1", 10);

  let results;
  let title = "Browse Anime";

  if (query) {
    try {
      const data = await searchAnime(query, page);
      const toCard = (a: Anime) => ({ id: a.id, title: a.title, image: a.coverImage, genres: a.genres, rating: a.score });
      results = data.media.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {data.media.map((a) => <AnimeCard key={a.id} anime={toCard(a)} />)}
        </div>
      ) : (
        <div className="text-center py-20 border border-dashed border-[var(--accent)]/20 rounded-none">
          <p className="text-[var(--accent)]/50 font-mono text-sm tracking-wider">No results for &ldquo;{query}&rdquo;</p>
        </div>
      );
      title = `Search: ${query}`;
    } catch {
      results = <div className="text-center py-20"><p className="text-red-400/50 font-mono text-sm">Search failed.</p></div>;
    }
  } else {
    const toCard = (a: Anime) => ({ id: a.id, title: a.title, image: a.coverImage, genres: a.genres, rating: a.score });
    try {
      const [trendingData, popularData] = await Promise.all([
        getTrending(1, 12), getPopular(1, 12),
      ]);
      results = (
        <div>
          <div className="mb-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="h-5 w-1 bg-[var(--accent)]" />
              <svg className="w-4 h-4 text-[var(--accent)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 16.121A3 3 0 1012.015 11L11 14H9c0 .768.293 1.536.879 2.121z" />
              </svg>
              <h2 className="text-lg font-black text-[var(--accent)] uppercase tracking-wider font-mono">Trending Now</h2>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {trendingData.media.map((a) => <AnimeCard key={a.id} anime={toCard(a)} />)}
            </div>
          </div>
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="h-5 w-1 bg-[var(--accent)]/60" />
              <svg className="w-4 h-4 text-[var(--accent)]/70" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
              <h2 className="text-lg font-black text-[var(--accent)]/70 uppercase tracking-wider font-mono">Most Popular</h2>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {popularData.media.map((a) => <AnimeCard key={a.id} anime={toCard(a)} />)}
            </div>
          </div>
        </div>
      );
    } catch {
      results = <div className="text-center py-20"><p className="text-red-400/50 font-mono text-sm">Failed to load.</p></div>;
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-[var(--accent)] mb-6 uppercase tracking-wider">
          // {title}
        </h1>
        <SearchBar initialQuery={query} />
      </div>
      {results}
    </div>
  );
}

function SearchBar({ initialQuery }: { initialQuery: string }) {
  return (
    <div className="max-w-xl">
      <form action="/browse" method="GET" className="relative group">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-decorative)]"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input type="text" name="q" defaultValue={initialQuery} placeholder="Search anime..."
          className="w-full bg-[var(--panel)] border border-[var(--accent)]/30 text-white pl-10 pr-12 py-3 outline-none transition-all duration-300 focus:border-[var(--accent)] focus:accent-shadow-sm placeholder:text-[var(--text-decorative)] font-mono text-sm rounded-none" />
        <button type="submit" className="absolute right-1 top-1/2 -translate-y-1/2 px-3 py-2 text-[var(--accent)] hover:brightness-125 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </button>
      </form>
    </div>
  );
}
