# Functional Rebuild — Plan

## Goal
Strip all styling/animations, rebuild purely functional:
1. Search page → 2. Anime detail + episodes → 3. Player with auto-server, quality, subtitles (provider + OpenSubtitles fallback)

## Architecture
- **AniList GraphQL** — anime metadata (search, info, genres, images)
- **kaizoku-core (anikoto/anizone/etc)** — streaming sources (auto server selection)
- **OpenSubtitles.com API** — subtitle fallback when provider has none for DUB
- **HLS.js + /api/proxy** — video playback with CDN headers
- **SRT → VTT conversion** — convert OpenSubtitles SRT to VTT for the player

## Implementation Phases

### Phase 1: Scaffold Cleanup
- Strip globals.css to bare minimum (only resets, no cyberpunk)
- Remove all UI component files (GlitchText, GridBackground, Badge, etc.)
- Strip anime components of styling (AnimeCard, EpisodeList, etc.)
- Simplify layout (Navbar, Footer) to bare links

### Phase 2: Search Page (/)
- Search input + results grid from AniList
- Navigate to /anime/[id]

### Phase 3: Anime Detail Page (/anime/[id])
- Info section (image, title, description, genres)
- Episode list with click to watch

### Phase 4: Player (/anime/[id]/watch/[episode])
- Auto-best server selection (try servers, pick first with sources)
- Quality selector (1080p > 720p > auto)
- Subtitle selector (combine provider subs + OpenSubtitles)
- Subtitle extraction: if subs only exist for SUB, use them on DUB too
- Basic controls: play/pause, progress, volume, fullscreen

### Phase 5: OpenSubtitles Integration
- `/api/opensubtitles` — server-side search + download
- UI in player to show available OpenSubtitles tracks
- SRT→VTT conversion

## Files to keep (working infrastructure)
- `src/lib/anilist.ts` — AniList API queries
- `src/lib/providers.ts` — kaizoku-core multi-provider chain
- `src/app/api/stream/route.ts` — streaming API endpoint
- `src/app/api/proxy/route.ts` — CDN header proxy
- `src/types/anime.ts` — TypeScript types
- `src/types/dom.d.ts` — SpeechRecognition types (for STT)

## Files to rewrite
- `src/app/page.tsx` — search page
- `src/app/anime/[id]/page.tsx` — anime detail + episodes
- `src/app/anime/[id]/watch/[episode]/page.tsx` — player page
- `src/components/player/CyberpunkPlayer.tsx` → simple player
- `src/components/player/SubtitleOverlay.tsx` — subtitle display (keep)

## Files to delete
- `src/components/ui/` — all (GlitchText, GridBackground, Badge, Button, SearchInput, LoadingSpinner)
- `src/components/layout/` — simplify Navbar, Footer
- `src/components/anime/HeroBanner.tsx`, `TrendingRow.tsx`
- `src/hooks/useLiveCaptions.ts` — too complex for now, can add back later
- `src/components/player/LiveCaptionsOverlay.tsx` — too complex for now

## Phase Reviews (Oracle)
- After Phase 2 (search working)
- After Phase 4 (player working)
- After Phase 5 (subtitles complete)
