// AniList API response types
export interface AniListTitle {
  romaji?: string;
  english?: string;
  native?: string;
}

export interface AniListCoverImage {
  large: string;
  medium: string;
  extraLarge: string;
  color?: string;
}

export interface AniListStudio {
  name: string;
}

export interface AniListStudioConnection {
  nodes: AniListStudio[];
}

export interface AniListRelation {
  id: number;
  title: AniListTitle;
  relationType: string;
}

export interface AniListMedia {
  id: number;
  idMal?: number;
  title: AniListTitle;
  coverImage: AniListCoverImage;
  bannerImage?: string;
  description?: string;
  averageScore?: number;
  meanScore?: number;
  episodes?: number;
  duration?: number;
  status?: string;
  season?: string;
  seasonYear?: number;
  format?: string;
  genres: string[];
  tags: { name: string }[];
  studios?: AniListStudioConnection;
  trending: number;
  popularity?: number;
  relations?: {
    edges: { node: AniListRelation; relationType: string }[];
  };
  nextAiringEpisode?: {
    airingAt: number;
    episode: number;
  };
  seasonInt?: number;
  synonyms?: string[];
  isAdult?: boolean;
}

export interface AniListPage {
  Page: {
    pageInfo: {
      total: number;
      currentPage: number;
      lastPage: number;
      hasNextPage: boolean;
    };
    media: AniListMedia[];
  };
}

export interface AniListMediaResponse {
  Media: AniListMedia;
}

// Anify API types
export interface AnifyEpisode {
  id: string;
  number: number;
  title?: string;
  image?: string;
  description?: string;
  isFiller?: boolean;
}

export interface AnifyProviderEpisode {
  providerId: string;
  episodes: AnifyEpisode[];
}

export interface AnifyEpisodesResponse {
  episodes: AnifyProviderEpisode[];
}

export interface AnifySource {
  url: string;
  quality: string;
  isM3U8: boolean;
}

export interface AnifySubtitle {
  url: string;
  lang: string;
}

export interface AnifySourcesResponse {
  sources: AnifySource[];
  subtitles: AnifySubtitle[];
  headers?: Record<string, string>;
  intro?: { start: number; end: number };
}

// App-level types
export interface Anime {
  id: number;
  idMal?: number;
  title: string;
  englishTitle?: string;
  nativeTitle?: string;
  coverImage: string;
  bannerImage?: string;
  description?: string;
  score?: number;
  episodes?: number;
  duration?: number;
  status?: string;
  season?: string;
  seasonYear?: number;
  format?: string;
  genres: string[];
  studios: string[];
  trending: number;
  color?: string;
}

export interface Episode {
  id: string;
  number: number;
  title?: string;
  image?: string;
  providerId: string;
  hasDub?: boolean | null;
  hasSub?: boolean | null;
  airDate?: string;
  available?: boolean;
}

export interface StreamSource {
  url: string;
  quality: string;
  isM3U8: boolean;
}

export interface Subtitle {
  url: string;
  lang: string;
}
