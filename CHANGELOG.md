# network54tv — Feature & Change Request Ledger

Every user request in the project's history, mapped to the commit that shipped
it (or marked **UNCOMMITTED** if still in the working tree). Use it for
tracking, future changes, and rollback: `git revert <hash>` to undo a request,
`git checkout <hash> -- <path>` to restore one file to a request's state.

**Policy (from 2026-10-16 onward):** every request gets its own commit —
`type(scope): description` — so the mapping stays 1:1. No amends, no bundling.
(`queue.lst` and `src/app/design/`, `src/components/design/` are local-only and
never committed; they do not appear here.)

History predating this ledger is organized by request date; a few early
commits bundle several small fixes — noted inline where applicable.

---

## 2026-10-16 — batch (rows 1–11, all shipped)

| # | Request | Files | Commit |
|---|---------|-------|--------|
| 1 | Pull-to-refresh suppression on the pull-to-search gesture (non-passive touchmove guard + `overscroll-behavior-y` on `html`) | `src/components/layout/Navbar.tsx`, `src/app/globals.css` | `11d693b` |
| 2 | Header: search-bar-style boxes around logo + browse globe; search field truly centered on ≥sm (absolute-center + width reserve) | `src/components/layout/Navbar.tsx` | `1c506f8` |
| 3 | AniList route hardening after the transient network outage: retry network-level fetch errors with backoff, serve stale L1 on exhaustion (the 500-banner fix) | `src/app/api/anilist/route.ts` | `70f3b32` |
| 4 | Header: logo/globe boxes on mobile too (frames at all breakpoints); dismiss/closing the mobile keyboard blurs the search input (visualViewport threshold + hysteresis, Enter/Escape blur, typing-guard release) | `src/components/layout/Navbar.tsx` | `a29af2e` |
| 5 | Header: mobile logo/globe boxes slightly smaller (44px → 40px, `h-10 w-10`) — **bundled with row 2** (`1c506f8`): the resize rewrites rows 2's box lines, so row 2's intermediate state never existed in the final tree | `src/components/layout/Navbar.tsx` | `1c506f8` |
| 6 | Streaming + episode fetching + anime-details consistency + slowness round (3 lanes): megaplay session cache, provider negative caching (animeunity 403 / anineko no-match), hardened `/api/anilist/fetch` (L1 cache + timeout + retries + stale), `strict=1` skips opposite-type re-walk, stream cache-key consolidation, deduped `resolveExpectedEpisodeCount`; metadata consistency — shared `anime-meta.ts` vocabulary (status/format labels, episode fraction), detail badges speak the card language (fraction, "Ep N airs in Xd", "Airs Oct 20", studios, duration), humanized enums, partial sub/dub tallies (`12/30 SUB`), SUB/DUB chips in watch episode selector, `startDate` in DETAIL_QUERY, airing-feed URLs bucketed to 15-min grid, franchise Suspense on detail + watch, watch revalidate 300; player waterfall — `strict=1` on all stream requests, dub probe sequential + early-abandon (≤2), `n54tv-audio:{id}` sessionStorage cache kills duplicate `?audio=1` | `src/lib/providers.ts`, `src/app/api/stream/route.ts`, `src/app/api/anilist/fetch/route.ts`, `src/app/api/episodes/route.ts`, `src/app/anime/[id]/page.tsx`, `src/app/anime/[id]/watch/[episode]/page.tsx`, `src/lib/anilist.ts`, `src/lib/anime-meta.ts` (new), `src/components/anime/{EpisodeListFetcher,Availability,AnimeCard}.tsx`, `src/components/watch/EpisodeSelector.tsx`, `src/components/player/Player.tsx` | `dfde2c5` |
| 7 | Remove the metadata badge line from the watch/player page (★ score, status, EP fraction, SUB/DUB chips under the h1) — player page stays title-only; the detail page owns the badge language — **no separate commit**: the badge line only ever existed inside this uncommitted round (net-zero in the final tree); the decision is recorded as the comment in `watch/[episode]/page.tsx`, whose title-only state ships in `dfde2c5` | `src/app/anime/[id]/watch/[episode]/page.tsx` | _(net-zero, see row 6)_ |
| 8 | This ledger | `CHANGELOG.md` | _(this commit)_ |
| 9 | "20sec blank clips" fix: KickAssAnime's broken servers (e.g. CatStream) resolve their player manifest to the site's own `intro.mp4` (10KB bumper) — bumper-source filter (`intro/outro/preview/trailer/bumper` paths) in `toStreamResult`; empty-after-filtering counts as provider failure so the walk falls through to a provider that has the episode | `src/lib/providers.ts` | `976b9d7` |
| 10 | Top-20 trending anime stream survey + ×-title fix: `normalize()` maps `×`/`✕`/`✖` to a **spaced** x (`HUNTER×HUNTER`/`SPY×FAMILY` now match providers' letter-x form), `titleQueryVariants` queries the x form first for × titles (provider search returns 0 hits for the glued form); survey result 20/20 after fixes | `src/lib/providers.ts` | `d747bfa` |
| 11 | Search too rigid ("requires the exact string"): typo/punctuation tolerance across the whole sparse-search retry — Damerau-Levenshtein (adjacent transposition = 1 edit, fixes `one peice`), single-token queries now get truncation variants (`apothicary` → Apothecary Diaries), glued-word probes re-query with a space inserted at a candidate split (`fatezero` → Fate/Zero, `onepunch man` → One-Punch Man) + adjacent-join gate rule, retry queries widen to 50/page, 9s wall-clock deadline on the retry phase (was 48s spins under rate limits) | `src/lib/anilist.ts` | `c0c4f45` |

Notes: each row above was committed as its own patch unit in the order
1 → 2+5 → 4 → 3 → 6 → 9 → 10 → 11 (Navbar rows 1/2+4/5 and the shared
`providers.ts`/`anilist.ts` rows were split hunk-by-hunk; every intermediate
commit typechecks). Row 8 (this file) lands last, so its own hash is the
hash of the commit you are reading.

---

## 2026-10

- `441143e` — feat(mobile,perf): sticky player on portrait phones (two-phase, viewport-bounded sections scroller), pull-to-search header (single 40px pull, auto-hide, chevron indicator, globe browse link, PTR guard), swipe-seek on video (scrub + mono timestamp), faster episodes (parallel provider probes with early-abandon, `/api/episodes` CDN cache, streamed detail episode list)
- `10ef330` — feat(player,watch): icon control toolbar (all menu options as priority-fitted icons), episodes dock, card fraction badges (`3/12 EP` while airing), settings persistence split (global `n54tv-settings` + per-anime `n54tv-prefs:{id}`, one-shot lossless migration)
- `cae3ecb` — feat(player): audio filters, megaplay-first streams, episode availability
- `aa707b4` — refactor(search): remove search-as-you-type; submit-only (Enter / magnifier)
- `dd37dc3` — fix(search): live min 3 chars, reuse landing on clear, abort orphaned upstream calls
- `a1a8427` — feat: UI consolidation primitives, typo-tolerant cached search, player polish + per-anime prefs
- `53f72b5` — feat: provider perf + availability consolidation, browse upcoming/live-search, player UX rounds

## 2026-09-28

- `68b8501` — fix(navbar): hide while the player is in fullscreen
- `c239fc9` — feat(watch): pager-only episode browser, no inner scroll
- `fd06828` — fix(episodes): plausibility gate against AniList count + fuzzy title match
- `97e0979` — feat(franchise): shared transitive resolver for detail row, watch strip, drawer
- `b9de4b7` — feat(search): landing feed + full browse filter suite
- `3a18216` — fix(player): fullscreen-preserving drawer, 3-dot menu, stall recovery restore
- `6b49d54` — fix(stream): referer-derived Origin, one-shot 403 retry, header-only timeout

## 2026-09-27 — queue batch (each queue item = its own commit)

- `deafd1c` — style(navbar): search button right of color selector (queue:navbar-order)
- `5c227c9` — style(player): site-consistent center glyph (queue:glyph)
- `e68f2f6` — feat(player): next-episode countdown overlay (queue:countdown)
- `5a156ff` — fix(search): home grouping off by default (queue:home-default)
- `238874c` — style(search): separate grouped sections from standalone tail (queue:sep)
- `6e006ea` — feat(search): reset controls for filters (queue:reset)
- `fc60eef` — style(navbar): move search button to top-right (queue:navbar-search-right)
- `d25c35d` — feat(watch): full franchise listing with significance badges (queue:franchise-all)
- `ca4af52` — refactor(player): priority-grouped controls, drop scroll chevrons (queue:controls-v2)
- `28071f0` — feat(player): edge-docked fullscreen episode drawer (queue:drawer)
- `6b832dd` — feat(anime): franchise row with small thumbnails on detail page (queue:franchise-detail)
- `0185c63` — fix(player): picker menus render above seekbar (queue:menu-pos)
- `47f4e65` — feat(player): responsive control bar with overflow scroll (queue:controls)
- `05ed851` — fix(synopsis): stop truncating description at 300 chars (queue:synopsis-data)
- `6e063f5` — refactor(watch): remove group-by-section toggle (queue:no-groupby)
- `2f99b88` — fix(synopsis): never clip description mid-word, robust read-more (queue:synopsis)
- `d95d18b` — feat(search): franchise season grouping, on by default (queue:seasons)
- `115be7e` — style(card): fix info block alignment and spacing (queue:card-align)
- `4e13a1d` — feat(watch): franchise season selector above episodes (queue:seasons-watch)
- `0023c05` — feat(player): move skip intro/outro to bottom-right (queue:skip-pos)
- `dcd5b77` — feat(navbar): logo-only brand mark + search button (queue:navbar)
- `d45a72b` — feat(search): group-by-season toggle in filters (queue#19b)
- `6d7377c` — feat(search): default sort matches home latest updates (queue#8)
- `ffbb0df` — feat(search): fuzzy title re-rank (queue#5)
- `7c6e0be` — feat(player): shift+,/. speed shortcuts ±0.25 (queue#17)
- `b0221b5` — feat(player): center play/pause glyph instead of HUD flash (queue#16)
- `e472086` — feat(watch): section grouping above episodes (queue#19a)
- `9e5717a` — feat(player): skip ±10s and prev/next episode controls (queue#15)
- `686b20d` — feat(watch): paged episode selector (queue#18)
- `c9abb5d` — feat(player): provider selector dropdown in controls (queue#14)
- `8daeacb` — feat(player): remove title overlay (queue#13)
- `e9aaaf2` — fix(episodes): verify sub/dub per episode via megaplay audio probe, honest counts + DUB/SUB chips (queue#10)
- `2458a62` — feat(chrome): new N54 favicon set, coherent icon metadata, navbar mark (queue#9)
- `cc5019f` — style(anime): tighten title to synopsis vertical rhythm (queue#12)
- `54ba13b` — feat(synopsis): open full description in scrollable modal (queue#11)
- `335f7c1` — feat(anime): rating + episode count meta row on cards; no cheap sub/dub source so dub omitted (queue#6)
- `e0457c7` — feat(layout): remove footer from site chrome (queue#7)
- `3983c26` — feat(navbar): remove search link from top-right of navbar (queue#4)
- `2db6dfb` — style(anime): remove top-right flare on card thumbnails (queue#3)

## 2026-09-26 → 2026-09-22

- `c016346` — fix: rebuild streaming pipeline — bounded player recovery + always-proxy media
- `6dfaa63` — feat: provider picker in player error overlay; drop header provider selector
- `aba7d08` — fix: restore working streams via KickAssAnime & fix m3u8 tag URIs

## 2026-09-11 — AniList server-IP blocks + streaming-proxy era

- `8d77a2f` — fix: revert CDN bypass — CORS blocks direct segment loads
- `f3391da` — perf: eliminate per-segment proxy hop (root cause of PC stuttering)
- `715b84b` — perf: reduce streaming latency on laptop
- `bb781c4` — fix: subtitle parsing + sliding subtitles with controls
- `0c932cd` — feat: auto-hiding fullscreen button + video filter presets
- `799d44d` — perf: reduce buffering with streaming proxy + leaner HLS config
- `f75f71d` — fix: streaming providers working again
- `1a31ac1` — fix: VERCEL_URL scheme + provider error logging
- `b852ad8` — fix: wire kaizoku-core AniList calls through proxy to bypass server-IP 403
- `b12f757` — refactor: remove fallback band-aids, clean AniList proxy
- `f53b218` — fix: AniList API — add Origin/Referer headers to bypass server IP block
- `b8066ae` — fix: fallback images + stable image proxy
- `aa2d08a` — fix: streaming provider chain — logging, error UI, proxy wiring
- `1938e5b` — fix: UI audit — search grid, player mobile UX, network resilience
- `4749ddd` — fix: AniList fallback — serve static data when API is down

## 2026-08-24 → 2026-08-16 — resilience, provider wiring, mobile UX

- `f48ef07` — fix: AniList outage resilience — serve stale cache, surface upstream errors
- `3007537` — fix: mobile UX — compact detail layout, inline search buttons, navbar touch targets
- `4f089e0` — fix: UI audit — touch targets, contrast, dropdown Escape, focus states, seek bar hover
- `5021e7a` — fix: improved error messaging when no streaming sources found
- `0a4985b` — fix: fetch episodes on mount + fix stale providerId in Player useCallbacks
- `64c6cce` — fix: watch page respects provider selection from navbar
- `ca2819b` — fix: episodes fetched client-side via /api/episodes, provider changes trigger instant re-fetch via custom event
- `9732928` — fix: provider dropdown updates URL param + router.refresh() on anime pages, no full reload
- `3110653` — fix: reload page after provider selection so all components pick up new source
- `57e8077` — feat: source provider dropdown in navbar (Auto/Anikoto/Anizone/AllManga/Anineko/MegaPlay/AnimeUnity), persisted in localStorage, flows through AnimeCard links

## 2026-08-10 — grid + fullscreen era

- `18e005a` — fix: widen recently aired window to 30 days for enough items to fill full rows
- `4caedb7` — fix: grid layout with full rows only — page size is multiple of all column counts (2,3,4,6)
- `7db6e00` — fix: CSS columns masonry layout for cards — fills rows completely, no wasted space
- `c2ffb6f` — fix: auto-fill grid to remove waste space + load more with 20-item pages
- `f5e2f10` — feat: grid fix, load more, loading animations, skip intro/outro mobile, network resilience
- `10a74d9` — fix: enter fullscreen button in controls bar, hidden when already fullscreen
- `a8ada13` — chore: remove old fullscreen button from controls bar
- `c49f241` — fix: exit fullscreen button top-right on all devices when fullscreen
- `d8f2d63` — fix: sync isFullscreen from fullscreenchange events instead of optimistic state
- `9ce2864` — fix: fullscreen API webkit prefixes for real mobile devices (iOS Safari)

## 2026-08-09 — subtitles & persistence day

- `7886e51` — fix: dedicated exit fullscreen button top-right on mobile, reverted bottom padding hack
- `6d5db80` — fix: increase controls bottom padding on mobile to avoid home indicator gesture zone
- `7469631` — fix: mobile settings panel stays open after selection, only closes via X button
- `9c6893b` — fix: enlarge fullscreen button hitbox on mobile (44px touch target)
- `1886ee7` — feat: subtitle size control (S/M/L) with persistence
- `9fc5225` — fix: mobile UI fixes — revert episode badge, fix settings menu, add close button
- `9fc5d64` — fix: mobile UI — episode numbers, player height, settings menu clipping
- `4a7686d` — fix: filter hentai/adult content from recently-aired section
- `3333e4b` — feat: OpenSubtitles pagination, filter search, and load more
- `6cf55f5` — fix: subtitle offset using ref to avoid rAF loop restart on every change
- `efb19b7` — feat: subtitle timing offset adjuster with localStorage persistence
- `1a255d0` — fix: add auto-loaded AI English subs to subtitle picker right after Off
- `00b2430` — feat: hide navbar on scroll during player mode
- `292bab5` — fix: auto-load AI English subs for dub even when provider subs exist
- `9236791` — feat: auto-load AI English subtitles for dubbed episodes
- `62e702b` — fix: reset OpenSubtitles state on episode change
- `e55e4aa` — fix: include AI-translated subtitles in OpenSubtitles results
- `7cbc2a5` — fix: filter empty OpenSubtitles + persist all user preferences
- `2872b85` — feat: persist autoPlayNext and autoSkipEnabled across reloads
- `fe2e00e` — feat: persist audio type (sub/dub) in playback progress
- `e72ab3f` — fix: OpenSubtitles downloads empty — API ignores VTT format, returns SRT
- `121b1ef` — fix: OpenSubtitles quality overhaul — validation, selected indicator, error feedback
- `0abd639` — fix: improve OpenSubtitles search quality and result display
- `391c6b7` — fix: OpenSubtitles subtitle selection — prevent auto-clobber + improve styling
- `d1ad3f7` — feat: persist playback progress in localStorage + AniSkip episodeLength fix
- `9315f8a` — fix: AniSkip episodeLength=0 + stop caching failures
- `f8b8fe4` — fix: OpenSubtitles blob URL proxy, AniSkip episodeLength, space hold-to-2x
- `bd8f54c` — fix: OpenSubtitles season_number + provider skip times override AniSkip
- `4f41014` — fix: episode numbering mismatch across providers
- `142b3d8` — fix: player controls, shortcuts, buffering, and quality switching

## 2026-08-08 → 2026-08-06 — player core, skip, dub/sub, favicons

- `f83488c` — fix: player buffering, shortcuts, and controls
- `358a06b` — perf: optimize player, subtitle engine, and stream loading
- `3ab5f75` — fix: codebase audit — security, stale closures, caches, dead code
- `134683b` — fix: dub not playing after switch — loadByType passed autoPlay:false to loadHls
- `501d6ad` — fix: dub episodes not loading — eliminate concurrent probe flood on mount
- `9ef2fed` — fix: faster dub/sub detection + seekbar click accuracy
- `8002176` — fix: move AniSkip out of stream loading path — was blocking every fetch
- `3dc31e9` — feat: real per-episode intro/outro skip via AniSkip API
- `610202b` — fix: skip intro/outro — time-window visibility instead of fixed timestamps
- `610928b` — fix: dub/sub toggle + server picker never showing, muted icon wrong
- `7411e18` — feat: auto-play next episode + skip intro/outro with auto-skip
- `e88eb68` — fix: correct blocky '4' shape in N54 favicon
- `cc83ce6` — fix: correct N54 favicon SVG paths and regenerate PNGs
- `ab4cd4a` — feat: add N54 logo favicon (SVG + PNG variants)
- `0abb1b7` — fix: progress bar thumb centering + source loading reliability

## 2026-08-02 — launch

- `f2c8643` — feat: tap toggles controls, remove center play overlay
- `1bb7a1d` — fix: suppress context menu on hold-to-2x, add episode list scroll overflow
- `e991836` — feat: mobile player controls with settings menu, hold-to-2x, and UX fixes
- `bdc199d` — Initial commit: Cyberpunk anime streaming site with Next.js 16
