import Link from "next/link";

interface AnimeCardAnime {
  id: number;
  title: string;
  image: string;
  genres?: string[];
  rating?: number;
}

interface AnimeCardProps {
  anime: AnimeCardAnime;
  href?: string;
}

export default function AnimeCard({ anime, href }: AnimeCardProps) {
  const linkHref = href ?? `/anime/${anime.id}`;

  return (
    <Link
      href={linkHref}
      className="block bg-[var(--panel)] border border-[var(--accent)]/10 overflow-hidden
                 transition-all duration-200 hover:border-[var(--accent)]/50 hover:-translate-y-0.5
                 rounded-none accent-card-hover"
    >
      {/* Cover image */}
      <div className="aspect-[3/4] relative overflow-hidden bg-[var(--background)] rounded-none">
        <img
          src={anime.image}
          alt={anime.title}
          className="w-full h-full object-cover"
          loading="lazy"
        />
        {/* Diagonal accent line */}
        <div className="absolute top-0 right-0 w-12 h-12 bg-gradient-to-bl from-[var(--accent)]/20 to-transparent pointer-events-none" />
      </div>

      {/* Info */}
      <div className="p-3 space-y-1.5">
        <h3 className="text-sm font-bold text-white line-clamp-2 leading-tight uppercase tracking-wider">
          {anime.title}
        </h3>

        {anime.genres && anime.genres.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {anime.genres.slice(0, 3).map((genre) => (
              <span
                key={genre}
                className="text-[10px] px-1.5 py-0.5 bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20 rounded-none"
              >
                {genre}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
