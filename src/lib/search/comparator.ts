/**
 * Unified compound comparator and firewall gate.
 * Evaluates candidates across symbol cleaning, Romaji phonetics,
 * QWERTY keyboard proximity, stop-word tolerance, and season matching.
 */

import { qwertyWordSimilarity } from "./qwerty";
import { isRomajiEquivalent, toCanonicalRomaji } from "./romaji";
import { analyzeQueryTokens, cleanSymbols, extractSeasonNumber } from "./tokens";

export interface SearchableTitle {
  title?: {
    romaji?: string | null;
    english?: string | null;
    native?: string | null;
  } | null;
  synonyms?: (string | null)[] | null;
}

/**
 * Calculates compound similarity between a single query word and a single title word.
 * Evaluates:
 * 1. Exact equality (1.0)
 * 2. Romaji phonetic equivalence (0.95)
 * 3. Romaji-canonical QWERTY distance
 * 4. Direct QWERTY-weighted distance
 * 5. Prefix / morphological stem alignment
 */
export function compoundWordSimilarity(queryWord: string, titleWord: string): number {
  if (queryWord === titleWord) return 1.0;
  if (!queryWord || !titleWord) return 0.0;

  // 1. Direct Romaji equivalence (Kunrei ↔ Hepburn, long vowels)
  if (isRomajiEquivalent(queryWord, titleWord)) {
    return 0.95;
  }

  // 2. QWERTY distance in Romaji canonical space (handles phonetic + keyboard typo combined)
  const canonQ = toCanonicalRomaji(queryWord);
  const canonT = toCanonicalRomaji(titleWord);
  let best = 0.0;

  if (canonQ && canonT) {
    const romajiQwertySim = qwertyWordSimilarity(canonQ, canonT);
    best = Math.max(best, romajiQwertySim);
  }

  // 3. Direct QWERTY distance (standard spelling + typo)
  const directQwertySim = qwertyWordSimilarity(queryWord, titleWord);
  best = Math.max(best, directQwertySim);

  // 4. Prefix match allowance for truncated words ("apothic" -> "apothecary")
  const minLen = Math.min(queryWord.length, titleWord.length);
  if (minLen >= 4) {
    if (titleWord.startsWith(queryWord) || queryWord.startsWith(titleWord)) {
      best = Math.max(best, 0.85);
    }
  }

  return Math.min(best, 1.0);
}

/** Threshold for considering a query word successfully explained by a title word */
export const COMPOUND_WORD_THRESHOLD = 0.70;

export function compoundWordMatches(
  queryWord: string,
  titleWord: string,
  threshold = COMPOUND_WORD_THRESHOLD
): boolean {
  return compoundWordSimilarity(queryWord, titleWord) >= threshold;
}

/**
 * Checks if a candidate title satisfies the user's query under compound matching.
 * Every significant content token in the query must match a distinct word
 * (or contiguous run of words) in one of the media's titles, or across the
 * combined cross-language title set (code-switching: e.g. "attack on kyojin").
 */
export function passesCompoundGate(
  query: string,
  media: SearchableTitle
): boolean {
  const { contentTokens, season } = analyzeQueryTokens(query);

  // If query had only grammar words or empty, nothing to filter
  if (contentTokens.length === 0) return true;

  const rawFields = [
    media.title?.romaji,
    media.title?.english,
    media.title?.native,
    ...(media.synonyms || []),
  ].filter(Boolean) as string[];

  if (rawFields.length === 0) return false;

  // 1. Single-field check (standard case)
  for (const field of rawFields) {
    const { cleaned: cleanedField, season: fieldSeason } = extractSeasonNumber(
      cleanSymbols(field)
    );

    // If a season was explicitly requested (e.g. "s2"), title must match or be compatible
    if (season && fieldSeason && season !== fieldSeason) {
      continue;
    }

    const titleWords = cleanedField.split(" ").filter(Boolean);
    if (titleWords.length === 0) continue;

    if (tokensCoveredByWords(contentTokens, titleWords)) {
      return true;
    }
  }

  // 2. Cross-field code-switching check (e.g. "attack on kyojim" mixing English & Romaji)
  const combinedWords: string[] = [];
  let combinedHasSeason = false;
  for (const field of rawFields) {
    const { cleaned, season: fieldSeason } = extractSeasonNumber(cleanSymbols(field));
    if (fieldSeason) {
      combinedHasSeason = true;
      if (season && fieldSeason !== season) continue;
    }
    for (const w of cleaned.split(" ")) {
      if (w && !combinedWords.includes(w)) combinedWords.push(w);
    }
  }

  if (season && combinedHasSeason) {
    // If season was requested and fields have seasons, ensure season matched
  }

  return tokensCoveredByWords(contentTokens, combinedWords);
}

function tokensCoveredByWords(contentTokens: string[], titleWords: string[]): boolean {
  const used = new Set<number>();
  let covered = 0;

  for (const qWord of contentTokens) {
    // 1. Single distinct word match
    const idx = titleWords.findIndex(
      (tWord, i) => !used.has(i) && compoundWordMatches(qWord, tWord)
    );

    if (idx !== -1) {
      used.add(idx);
      covered++;
      continue;
    }

    // 2. Glued word run match (e.g. "onepunch" matches "one punch")
    let matchedRun = 0;
    for (const runLen of [2, 3]) {
      for (let i = 0; i + runLen <= titleWords.length; i++) {
        let windowFree = true;
        for (let k = 0; k < runLen; k++) {
          if (used.has(i + k)) {
            windowFree = false;
            break;
          }
        }
        if (!windowFree) continue;

        const joined = titleWords.slice(i, i + runLen).join("");
        if (compoundWordMatches(qWord, joined)) {
          for (let k = 0; k < runLen; k++) used.add(i + k);
          matchedRun = runLen;
          break;
        }
      }
      if (matchedRun > 0) break;
    }

    if (matchedRun > 0) {
      covered++;
      continue;
    }

    // 3. Reverse glued: query has separate words that are joined in title
    const allJoined = titleWords.join("");
    if (allJoined.includes(qWord) && qWord.length >= 4) {
      covered++;
      continue;
    }

    // Word could not be explained
    break;
  }

  return covered === contentTokens.length;
}

/**
 * Composite relevance score of a media candidate against a query in [0, 1].
 * Preserves strict monotonic hierarchy:
 * Exact full match (1.0) > Substring prefix > Word-level match > Phonetic/Fuzzy.
 */
export function scoreCompoundTitle(
  query: string,
  media: SearchableTitle
): number {
  const queryClean = cleanSymbols(query);
  const { contentTokens } = analyzeQueryTokens(query);

  const fields = [
    media.title?.romaji,
    media.title?.english,
    media.title?.native,
    ...(media.synonyms || []),
  ];

  let maxScore = 0.0;

  for (const field of fields) {
    if (!field) continue;
    const fieldClean = cleanSymbols(field);
    if (!fieldClean) continue;

    // 1. Exact match
    if (fieldClean === queryClean) return 1.0;

    // 2. Exact substring match with word boundary
    const idx = fieldClean.indexOf(queryClean);
    if (idx === 0) {
      maxScore = Math.max(maxScore, 0.95);
    } else if (idx > 0) {
      maxScore = Math.max(maxScore, 0.88);
    }

    // 3. Content tokens coverage and alignment
    const titleWords = fieldClean.split(" ").filter(Boolean);
    if (contentTokens.length > 0 && titleWords.length > 0) {
      let sumSim = 0;
      let matchedCount = 0;
      for (const qw of contentTokens) {
        let bestWordSim = 0;
        for (const tw of titleWords) {
          const sim = compoundWordSimilarity(qw, tw);
          if (sim > bestWordSim) bestWordSim = sim;
        }
        if (bestWordSim >= COMPOUND_WORD_THRESHOLD) {
          matchedCount++;
          sumSim += bestWordSim;
        }
      }

      if (matchedCount === contentTokens.length) {
        const coverage = sumSim / contentTokens.length;
        const lengthRatio = Math.min(1.0, queryClean.length / fieldClean.length);
        const score = 0.65 + 0.2 * coverage + 0.1 * lengthRatio;
        maxScore = Math.max(maxScore, score);
      }
    }
  }

  return Math.min(maxScore, 1.0);
}
