import type { Anime } from "@/types/anime";

const ANILIST_API = "https://graphql.anilist.co";

const TRENDING_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(sort: TRENDING_DESC, type: ANIME, isAdult: false) {
      id
      title { romaji english native }
      coverImage { large extraLarge color }
      bannerImage
      description
      averageScore
      episodes
      duration
      status
      season
      seasonYear
      format
      genres
      trending
      popularity
      studios { nodes { name } }
      nextAiringEpisode { airingAt episode }
    }
  }
}
`;

const SEARCH_QUERY = `
query ($search: String, $page: Int, $perPage: Int, $format: MediaFormat, $season: MediaSeason, $status: MediaStatus, $status_not: MediaStatus, $genre_in: [String], $genre_not_in: [String], $sort: [MediaSort], $startDate_greater: FuzzyDateInt) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(search: $search, type: ANIME, isAdult: false, format: $format, season: $season, status: $status, status_not: $status_not, genre_in: $genre_in, genre_not_in: $genre_not_in, sort: $sort, startDate_greater: $startDate_greater) {
      id
      title { romaji english native }
      coverImage { large extraLarge color }
      bannerImage
      description
      averageScore
      episodes
      duration
      status
      season
      seasonYear
      format
      genres
      trending
      popularity
      studios { nodes { name } }
    }
  }
}
`;

const DETAIL_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    title { romaji english native }
    coverImage { large extraLarge color }
    bannerImage
    description
    averageScore
    episodes
    duration
    status
    season
    seasonYear
    format
    genres
    trending
    popularity
    studios { nodes { name } }
    nextAiringEpisode { airingAt episode }
    relations {
      edges {
        node { id title { romaji english } coverImage { large } }
        relationType
      }
    }
  }
}
`;

const POPULAR_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(sort: POPULARITY_DESC, type: ANIME, isAdult: false) {
      id
      title { romaji english native }
      coverImage { large extraLarge color }
      bannerImage
      description
      averageScore
      episodes
      duration
      status
      season
      seasonYear
      format
      genres
      trending
      popularity
      studios { nodes { name } }
    }
  }
}
`;

const RECENTLY_AIRED_QUERY = `
query ($airingAt_greater: Int, $airingAt_lesser: Int, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    airingSchedules(
      airingAt_greater: $airingAt_greater
      airingAt_lesser: $airingAt_lesser
      sort: TIME_DESC
    ) {
      airingAt
      episode
      media {
        id
        isAdult
        title { romaji english native }
        coverImage { large extraLarge color }
        bannerImage
        description
        averageScore
        episodes
        duration
        status
        season
        seasonYear
        format
        genres
        trending
        popularity
        studios { nodes { name } }
      }
    }
  }
}
`;

const SEASONAL_QUERY = `
query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(season: $season, seasonYear: $seasonYear, type: ANIME, isAdult: false, sort: POPULARITY_DESC) {
      id
      title { romaji english native }
      coverImage { large extraLarge color }
      bannerImage
      description
      averageScore
      episodes
      duration
      status
      season
      seasonYear
      format
      genres
      trending
      popularity
      studios { nodes { name } }
    }
  }
}
`;

function anilistMediaToAnime(media: any): Anime {
  return {
    id: media.id,
    idMal: media.idMal || undefined,
    title: media.title?.english || media.title?.romaji || "Unknown",
    englishTitle: media.title?.english,
    nativeTitle: media.title?.native,
    coverImage: media.coverImage?.extraLarge || media.coverImage?.large || "",
    bannerImage: media.bannerImage,
    description: media.description
      ?.replace(/<[^>]*>/g, "")
      ?.substring(0, 300),
    score: media.averageScore,
    episodes: media.episodes,
    duration: media.duration,
    status: media.status,
    season: media.season,
    seasonYear: media.seasonYear,
    format: media.format,
    genres: media.genres || [],
    studios: media.studios?.nodes?.map((s: any) => s.name) || [],
    trending: media.trending || 0,
    color: media.coverImage?.color,
  };
}

async function fetchGraphQL(query: string, variables: Record<string, any>) {
  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
    next: { revalidate: 300 },
  });
  if (!res.ok) throw new Error(`AniList API error: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message);
  return json.data;
}

export async function getTrending(
  page = 1,
  perPage = 20
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const data = await fetchGraphQL(TRENDING_QUERY, { page, perPage });
  const pageData = data.Page;
  return {
    media: pageData.media.map(anilistMediaToAnime),
    hasNextPage: pageData.pageInfo.hasNextPage,
  };
}

// Map display labels → AniList API enum values
export const STATUS_API_MAP: Record<string, string> = {
  Finished: "FINISHED",
  Releasing: "RELEASING",
  Upcoming: "NOT_YET_RELEASED",
  Cancelled: "CANCELLED",
};

export const GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Fantasy",
  "Horror", "Mecha", "Music", "Mystery", "Psychological",
  "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural",
  "Thriller",
] as const;

export interface TagFilter {
  include: string[];
  exclude: string[];
  mode: "AND" | "OR";
}

export interface SearchFilters {
  format?: string;
  season?: string;
  seasonYear?: number;
  status?: string;
  status_not?: string;
  genres?: string[];
  tagFilter?: TagFilter;
  sort?: string;
  timeRange?: string;
}

export async function searchAnime(
  query: string,
  page = 1,
  perPage = 20,
  filters?: SearchFilters
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const variables: Record<string, any> = { page, perPage };
  if (query) variables.search = query;
  if (filters?.format) variables.format = filters.format.toUpperCase();
  if (filters?.season) variables.season = filters.season.toUpperCase();
  if (filters?.seasonYear) variables.seasonYear = filters.seasonYear;
  if (filters?.status) variables.status = STATUS_API_MAP[filters.status] || filters.status.toUpperCase();
  if (filters?.status_not) variables.status_not = filters.status_not.toUpperCase();
  if (filters?.genres?.length) variables.genre_in = filters.genres;
  if (filters?.tagFilter) {
    const { include, exclude, mode } = filters.tagFilter;
    if (include.length > 0) {
      variables.genre_in = include;
    }
    if (exclude.length > 0) {
      variables.genre_not_in = exclude;
    }
  }
  if (filters?.sort) variables.sort = [filters.sort];
  if (filters?.timeRange) {
    const now = new Date();
    let start = new Date(now);
    switch (filters.timeRange) {
      case 'week': start.setDate(now.getDate() - 7); break;
      case 'month': start.setMonth(now.getMonth() - 1); break;
      case '3months': start.setMonth(now.getMonth() - 3); break;
      case '6months': start.setMonth(now.getMonth() - 6); break;
      case 'year': start.setFullYear(now.getFullYear() - 1); break;
    }
    const y = start.getFullYear();
    const m = start.getMonth() + 1;
    const d = start.getDate();
    variables.startDate_greater = y * 10000 + m * 100 + d;
  }

  const data = await fetchGraphQL(SEARCH_QUERY, variables);
  const pageData = data.Page;
  let media = pageData.media.map(anilistMediaToAnime);

  // Client-side AND mode: filter to keep only media matching ALL included genres
  if (filters?.tagFilter?.mode === "AND" && filters.tagFilter.include.length > 1) {
    const required = new Set(filters.tagFilter.include);
    media = media.filter((m: Anime) => {
      const animeGenres = new Set(m.genres || []);
      return [...required].every((g) => animeGenres.has(g));
    });
  }

  return {
    media,
    hasNextPage: pageData.pageInfo.hasNextPage && media.length > 0,
  };
}

/**
 * Fetch anime with recently aired episodes (by airing schedule), deduplicated.
 * Uses a time window filter to get only episodes that aired within the past N days.
 */
export async function getRecentlyAired(
  daysWindow = 7,
  page = 1,
  perPage = 50
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - daysWindow * 24 * 60 * 60;

  const data = await fetchGraphQL(RECENTLY_AIRED_QUERY, {
    airingAt_greater: windowStart,
    airingAt_lesser: now,
    page,
    perPage,
  });

  const schedules = data.Page.airingSchedules || [];

  // Deduplicate by media ID — keep first (most recently aired) entry per anime
  const seen = new Set<number>();
  const unique: any[] = [];
  for (const s of schedules) {
    if (s?.media?.id && !seen.has(s.media.id) && !s.media.isAdult) {
      seen.add(s.media.id);
      unique.push(s.media);
    }
  }

  return {
    media: unique.map(anilistMediaToAnime),
    hasNextPage: data.Page.pageInfo.hasNextPage,
  };
}

export async function getAnimeById(id: number): Promise<Anime | null> {
  try {
    const data = await fetchGraphQL(DETAIL_QUERY, { id });
    if (!data.Media) return null;
    return anilistMediaToAnime(data.Media);
  } catch {
    return null;
  }
}

export async function getAnimeFull(id: number): Promise<any | null> {
  try {
    const data = await fetchGraphQL(DETAIL_QUERY, { id });
    return data.Media || null;
  } catch {
    return null;
  }
}

export async function getPopular(
  page = 1,
  perPage = 20
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const data = await fetchGraphQL(POPULAR_QUERY, { page, perPage });
  const pageData = data.Page;
  return {
    media: pageData.media.map(anilistMediaToAnime),
    hasNextPage: pageData.pageInfo.hasNextPage,
  };
}

export async function getSeasonal(
  season: string,
  year: number,
  page = 1,
  perPage = 20
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const data = await fetchGraphQL(SEASONAL_QUERY, {
    page,
    perPage,
    season: season.toUpperCase(),
    seasonYear: year,
});
  const pageData = data.Page;
  return {
    media: pageData.media.map(anilistMediaToAnime),
    hasNextPage: pageData.pageInfo.hasNextPage,
  };
}

// ─── Client-side API wrappers (for use in "use client" components) ───────

async function anilistFetch(query: string, variables: Record<string, any>) {
  const res = await fetch("/api/anilist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList API error: ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.data;
}

export async function getRecentlyAiredClient(
  daysWindow = 7,
  page = 1,
  perPage = 50
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - daysWindow * 24 * 60 * 60;

  const data = await anilistFetch(RECENTLY_AIRED_QUERY, {
    airingAt_greater: windowStart,
    airingAt_lesser: now,
    page,
    perPage,
  });

  const schedules = data.Page.airingSchedules || [];

  const seen = new Set<number>();
  const unique: any[] = [];
  for (const s of schedules) {
    if (s?.media?.id && !seen.has(s.media.id) && !s.media.isAdult) {
      seen.add(s.media.id);
      unique.push(s.media);
    }
  }

  return {
    media: unique.map(anilistMediaToAnime),
    hasNextPage: data.Page.pageInfo.hasNextPage,
  };
}

export async function searchAnimeClient(
  query: string,
  page = 1,
  perPage = 20,
  filters?: SearchFilters
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const variables: Record<string, any> = { page, perPage };
  if (query) variables.search = query;
  if (filters?.format) variables.format = filters.format.toUpperCase();
  if (filters?.season) variables.season = filters.season.toUpperCase();
  if (filters?.seasonYear) variables.seasonYear = filters.seasonYear;
  if (filters?.status) variables.status = filters.status.toUpperCase();
  if (filters?.status_not) variables.status_not = filters.status_not.toUpperCase();
  if (filters?.genres?.length) variables.genre_in = filters.genres;
  if (filters?.tagFilter?.include?.length) variables.genre_in = filters.tagFilter.include;
  if (filters?.tagFilter?.exclude?.length) variables.genre_not_in = filters.tagFilter.exclude;
  if (filters?.sort) variables.sort = [filters.sort];
  if (filters?.timeRange) {
    const now = new Date();
    let start = new Date(now);
    switch (filters.timeRange) {
      case "week": start.setDate(now.getDate() - 7); break;
      case "month": start.setMonth(now.getMonth() - 1); break;
      case "3months": start.setMonth(now.getMonth() - 3); break;
      case "6months": start.setMonth(now.getMonth() - 6); break;
      case "year": start.setFullYear(now.getFullYear() - 1); break;
    }
    const y = start.getFullYear();
    const m = start.getMonth() + 1;
    const d = start.getDate();
    variables.startDate_greater = y * 10000 + m * 100 + d;
  }

  const data = await anilistFetch(SEARCH_QUERY, variables);
  const pageData = data.Page;
  let media = pageData.media.map(anilistMediaToAnime);

  if (filters?.tagFilter?.mode === "AND" && filters.tagFilter.include.length > 1) {
    const required = new Set(filters.tagFilter.include);
    media = media.filter((m: Anime) => {
      const animeGenres = new Set(m.genres || []);
      return [...required].every((g) => animeGenres.has(g));
    });
  }

  return {
    media,
    hasNextPage: pageData.pageInfo.hasNextPage && media.length > 0,
  };
}

export async function getTrendingClient(
  page = 1,
  perPage = 20
): Promise<{ media: Anime[]; hasNextPage: boolean }> {
  const data = await anilistFetch(TRENDING_QUERY, { page, perPage });
  const pageData = data.Page;
  return {
    media: pageData.media.map(anilistMediaToAnime),
    hasNextPage: pageData.pageInfo.hasNextPage,
  };
}

export async function getAnimeByIdClient(id: number): Promise<Anime | null> {
  try {
    const data = await anilistFetch(DETAIL_QUERY, { id });
    if (!data.Media) return null;
    return anilistMediaToAnime(data.Media);
  } catch {
    return null;
  }
}
