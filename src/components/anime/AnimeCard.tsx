"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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
  loading?: boolean;
}

export default function AnimeCard({ anime, href, loading }: AnimeCardProps) {
  const [provider, setProvider] = useState("");

  useEffect(() => {
    setProvider(localStorage.getItem("n54tv-provider") || "");
  }, []);

  const baseHref = href ?? `/anime/${anime.id}`;
  const linkHref = provider ? `${baseHref}?provider=${provider}` : baseHref;

  return (
    <Link
      href={linkHref}
      className="block bg-[var(--panel)] border border-[var(--accent)]/10 overflow-hidden
                 transition-all duration-200 hover:border-[var(--accent)]/50 hover:-translate-y-0.5
                 rounded-none accent-card-hover"
    >
      {/* Cover image */}
      <div className="aspect-[3/4] relative overflow-hidden bg-[var(--background)] rounded-none">
        {loading ? (
          <>
            {/* Diagonal 4-part pulse loading overlay */}
            <div className="absolute inset-0 z-10 pointer-events-none">
              {/* Top triangle */}
              <div
                className="diagonal-pulse-section absolute inset-0"
                style={{ clipPath: "polygon(0 0, 100% 0, 50% 50%)" }}
              />
              {/* Right triangle */}
              <div
                className="diagonal-pulse-section absolute inset-0"
                style={{ clipPath: "polygon(100% 0, 100% 100%, 50% 50%)" }}
              />
              {/* Bottom triangle */}
              <div
                className="diagonal-pulse-section absolute inset-0"
                style={{ clipPath: "polygon(0 100%, 100% 100%, 50% 50%)" }}
              />
              {/* Left triangle */}
              <div
                className="diagonal-pulse-section absolute inset-0"
                style={{ clipPath: "polygon(0 0, 0 100%, 50% 50%)" }}
              />
            </div>
            {/* Dimmed placeholder behind the pulse */}
            <div className="absolute inset-0 bg-[var(--panel)]" />
          </>
        ) : (
          <img
            src={anime.image}
            alt={anime.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        )}
        {/* Diagonal accent line */}
        <div className="absolute top-0 right-0 w-12 h-12 bg-gradient-to-bl from-[var(--accent)]/20 to-transparent pointer-events-none" />
      </div>

      {/* Info */}
      <div className="p-3 space-y-1.5">
        <h3 className="text-sm font-bold text-white line-clamp-2 leading-tight uppercase tracking-wider">
          {loading ? "\u00A0" : anime.title}
        </h3>

        {!loading && anime.genres && anime.genres.length > 0 && (
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
        {loading && (
          <div className="flex gap-1">
            <div className="h-2.5 w-12 bg-[var(--accent)]/10 rounded-none animate-pulse" />
            <div className="h-2.5 w-8 bg-[var(--accent)]/10 rounded-none animate-pulse" />
          </div>
        )}
      </div>
    </Link>
  );
}
