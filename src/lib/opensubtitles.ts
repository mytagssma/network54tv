/**
 * Server-side OpenSubtitles.com REST API client (v1).
 *
 * Env vars required:
 *   OPENSUBTITLES_API_KEY   — API consumer key (from opensubtitles.com/en/consumers)
 *   OPENSUBTITLES_USERNAME  — Free account username
 *   OPENSUBTITLES_PASSWORD  — Free account password
 *
 * Search works with just Api-Key. Download requires Bearer token (login).
 */

const BASE = "https://api.opensubtitles.com/api/v1";
const UA = "Network54TV v0.1";

// ─── Types ───────────────────────────────────────────────────────────────

export interface OSSearchResult {
  file_id: number;
  language: string;
  download_count: number;
  hearing_impaired: boolean;
  ai_translated: boolean;
  release: string;
  file_name: string;
  subtitle_id: string;
}

interface TokenCache {
  token: string;
  baseUrl: string;
  expiresAt: number; // ms timestamp
}

let tokenCache: TokenCache | null = null;

// ─── Auth ────────────────────────────────────────────────────────────────

async function ensureToken(): Promise<TokenCache> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache;

  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;

  if (!apiKey || !username || !password) {
    throw new Error(
      "OpenSubtitles not configured — set OPENSUBTITLES_API_KEY, OPENSUBTITLES_USERNAME, OPENSUBTITLES_PASSWORD"
    );
  }

  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: {
      "Api-Key": apiKey,
      "Content-Type": "application/json",
      "User-Agent": UA,
      Accept: "application/json",
    },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenSubtitles login failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  // base_url is just the hostname (e.g. "api.opensubtitles.com");
  // keep the /api/v1 prefix from BASE
  const raw = data.base_url ?? "api.opensubtitles.com";
  const host = raw.startsWith("http") ? new URL(raw).host : raw;
  const baseUrl = `https://${host}/api/v1`;
  // Tokens are valid for 24 h; we refresh after 20 h
  tokenCache = {
    token: data.token,
    baseUrl,
    expiresAt: Date.now() + 20 * 60 * 60 * 1000,
  };
  return tokenCache;
}

// ─── Search ──────────────────────────────────────────────────────────────

export async function searchSubtitles(params: {
  query?: string;
  imdb_id?: number;
  parent_imdb_id?: number;
  season_number?: number;
  episode_number?: number;
  languages?: string;
}): Promise<OSSearchResult[]> {
  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) throw new Error("OPENSUBTITLES_API_KEY not set");

  const sp = new URLSearchParams();
  if (params.query) sp.set("query", params.query);
  if (params.imdb_id) sp.set("imdb_id", String(params.imdb_id));
  if (params.parent_imdb_id) sp.set("parent_imdb_id", String(params.parent_imdb_id));
  if (params.season_number) sp.set("season_number", String(params.season_number));
  if (params.episode_number) sp.set("episode_number", String(params.episode_number));
  if (params.languages) sp.set("languages", params.languages);

  // Sort params alphabetically per API requirement
  sp.sort();

  const res = await fetch(`${BASE}/subtitles?${sp}`, {
    headers: {
      "Api-Key": apiKey,
      "User-Agent": UA,
      Accept: "application/json",
    },
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenSubtitles search failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const results = ((data.data ?? []) as any[]).flatMap((item: any) => {
    const files = item.attributes?.files ?? [];
    return files.map((f: any) => ({
      file_id: f.file_id,
      language: item.attributes.language,
      download_count: item.attributes.download_count ?? 0,
      hearing_impaired: item.attributes.hearing_impaired ?? false,
      ai_translated: item.attributes.ai_translated ?? false,
      release: item.attributes.release ?? "",
      file_name: f.file_name ?? "",
      subtitle_id: item.attributes.subtitle_id ?? "",
    }));
  });

  // Filter out AI-translated (usually low quality) and sort by popularity
  return results
    .filter((r) => !r.ai_translated)
    .sort((a, b) => b.download_count - a.download_count);
}

// ─── Download ────────────────────────────────────────────────────────────

export async function downloadSubtitle(
  fileId: number,
  subFormat: "srt" | "vtt" = "vtt"
): Promise<{ content: string; fileName: string }> {
  const { token, baseUrl } = await ensureToken();
  const apiKey = process.env.OPENSUBTITLES_API_KEY!;

  // 1. Get signed download link
  const dlRes = await fetch(`${baseUrl}/download`, {
    method: "POST",
    headers: {
      "Api-Key": apiKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({ file_id: fileId, sub_format: subFormat }),
  });

  if (!dlRes.ok) {
    const body = await dlRes.text().catch(() => "");
    throw new Error(`OpenSubtitles download failed (${dlRes.status}): ${body}`);
  }

  const dlData = await dlRes.json();
  const link: string = dlData.link;
  const fileName: string = dlData.file_name ?? `subtitle.${subFormat}`;

  if (!link) throw new Error("OpenSubtitles download response missing link");

  // 2. Fetch the actual subtitle file
  const fileRes = await fetch(link, {
    headers: { "User-Agent": UA },
  });

  if (!fileRes.ok) {
    throw new Error(`Subtitle file fetch failed (${fileRes.status})`);
  }

  const content = await fileRes.text();

  // Validate VTT has actual cues (not empty/broken)
  const hasCues = /\d{2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(content);
  if (subFormat === "vtt" && !hasCues) {
    throw new Error("Downloaded subtitle file has no timing cues");
  }
  if (subFormat === "srt" && !/\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(content)) {
    throw new Error("Downloaded subtitle file has no timing cues");
  }

  return { content, fileName };
}
