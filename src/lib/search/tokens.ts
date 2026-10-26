/**
 * Tokenization, symbol handling, grammar particle filtering, and season extraction.
 */

export const ENGLISH_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "at", "to",
  "for", "with", "by", "from", "as", "is", "it", "that", "this",
  "into", "not", "are", "be",
]);

export const JAPANESE_PARTICLES = new Set([
  "no", "wa", "ga", "wo", "ni", "de", "to", "he", "kara", "made", "mo", "ka",
]);

// Crossover and separator symbols common in anime titles
const SYMBOL_REPLACEMENTS: [RegExp, string][] = [
  // Crossover symbols: "spy x family", "hunter x hunter", "spy×family"
  [/\b[xX×*]\b/g, " "],
  [/×/g, " "],

  // Semicolons, colons, slashes, dashes, tildes, underscores, pipes
  [/[:;/\\_~|\-–—+]/g, " "],

  // Quotes, exclamation marks, question marks, brackets
  [/[!?'"`()[\]{}«»「」『』]/g, " "],

  // Ellipses and dots (unless between digits like "3.0")
  [/(?<!\d)\.|\.(?!\d)/g, " "],
];

// Roman numerals mapping
const ROMAN_NUMERALS: Record<string, string> = {
  i: "1",
  ii: "2",
  iii: "3",
  iv: "4",
  v: "5",
  vi: "6",
  vii: "7",
  viii: "8",
  ix: "9",
  x: "10",
};

// Season patterns
const SEASON_PATTERNS: [RegExp, string][] = [
  [/\b(?:season|ssn|s)\s*([0-9]+)\b/i, "$1"],
  [/\b([0-9]+)(?:st|nd|rd|th)\s+(?:season|ssn)\b/i, "$1"],
  [/\bpart\s*([0-9]+)\b/i, "$1"],
  [/\bsecond\s+(?:season|ssn|part)\b/i, "2"],
  [/\bthird\s+(?:season|ssn|part)\b/i, "3"],
  [/\bfourth\s+(?:season|ssn|part)\b/i, "4"],
];

/**
 * Normalizes symbols and delimiters into spaces while preserving alpha-numerics.
 */
export function cleanSymbols(text: string): string {
  let s = text.toLowerCase();
  for (const [pattern, replacement] of SYMBOL_REPLACEMENTS) {
    s = s.replace(pattern, replacement);
  }
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Extracts a season / part number if explicitly specified in the query.
 * e.g. "s2" -> "2", "season 2" -> "2", "2nd season" -> "2", "part 2" -> "2"
 */
export function extractSeasonNumber(text: string): { cleaned: string; season?: string } {
  let cleaned = text;
  let season: string | undefined;

  for (const [pattern, repl] of SEASON_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match) {
      season = match[1] || repl;
      cleaned = cleaned.replace(pattern, " ");
      break;
    }
  }

  // Also check Roman numerals at word boundaries if not already matched
  if (!season) {
    const words = cleaned.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const num = ROMAN_NUMERALS[words[i]];
      if (num && words.length > 1) {
        season = num;
        words.splice(i, 1);
        cleaned = words.join(" ");
        break;
      }
    }
  }

  return { cleaned: cleaned.replace(/\s+/g, " ").trim(), season };
}

export interface QueryTokenBreakdown {
  raw: string;
  cleaned: string;
  contentTokens: string[];
  grammarTokens: string[];
  season?: string;
}

/**
 * Full pre-processing of a user query:
 * 1. Clean symbols and delimiters
 * 2. Extract season/part numerals
 * 3. Separate content tokens from stop words & particles
 */
export function analyzeQueryTokens(query: string): QueryTokenBreakdown {
  const { cleaned, season } = extractSeasonNumber(cleanSymbols(query));
  const rawWords = cleaned.split(" ").filter(Boolean);

  const contentTokens: string[] = [];
  const grammarTokens: string[] = [];

  for (const word of rawWords) {
    if (ENGLISH_STOPWORDS.has(word) || JAPANESE_PARTICLES.has(word)) {
      grammarTokens.push(word);
    } else if (word.length >= 2) {
      contentTokens.push(word);
    }
  }

  return {
    raw: query,
    cleaned,
    contentTokens,
    grammarTokens,
    season,
  };
}
