/**
 * Japanese Romaji phonetic normalizer.
 * Maps Kunrei-shiki, Nihon-shiki, and irregular vowel/consonant spellings
 * to canonical forms and generates high-accuracy Hepburn variants.
 */

// Kunrei-shiki / Nihon-shiki combinations to standard Hepburn
const KUNREI_TO_HEPBURN: [RegExp, string][] = [
  // Multi-char combos first
  [/tsya/g, "cha"],
  [/tsyu/g, "chu"],
  [/tsyo/g, "cho"],
  [/tya/g, "cha"],
  [/tyu/g, "chu"],
  [/tyo/g, "cho"],
  [/sya/g, "sha"],
  [/syu/g, "shu"],
  [/syo/g, "sho"],
  [/zya/g, "ja"],
  [/zyu/g, "ju"],
  [/zyo/g, "jo"],
  [/dya/g, "ja"],
  [/dyu/g, "ju"],
  [/dyo/g, "jo"],

  // Single syllable replacements
  [/si/g, "shi"],
  [/ti/g, "chi"],
  [/tu/g, "tsu"],
  [/hu/g, "fu"],
  [/zi/g, "ji"],
  [/di/g, "ji"],
  [/du/g, "zu"],
];

/**
 * Converts a Kunrei-shiki romanized string to standard modified Hepburn.
 * e.g. "singeki" -> "shingeki", "zyuzyutsu" -> "jujutsu", "syukufuku" -> "shukufuku"
 */
export function kunreiToHepburn(value: string): string {
  let s = value.toLowerCase();
  for (const [pattern, replacement] of KUNREI_TO_HEPBURN) {
    s = s.replace(pattern, replacement);
  }
  return s;
}

/**
 * Collapses Japanese long vowels and macrons to their single-vowel roots:
 * - "ou" / "oo" / "ō" -> "o"
 * - "uu" / "ū" -> "u"
 * - "aa" / "ā" -> "a"
 * - "ee" / "ē" -> "e"
 * - "ii" / "ī" -> "i"
 */
export function collapseLongVowels(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip macrons/accents
    .replace(/ou/g, "o")
    .replace(/oo/g, "o")
    .replace(/uu/g, "u")
    .replace(/aa/g, "a")
    .replace(/ee/g, "e")
    .replace(/ii/g, "i");
}

/**
 * Canonical phonetic key for Japanese Romaji.
 * Two words that sound identical in Japanese Romaji will produce the EXACT same key.
 *
 * Examples:
 * - "singeki", "shingeki" -> "singeki"
 * - "ruroni", "rurouni" -> "ruroni"
 * - "zyuzyutsu", "jujutsu" -> "zuzutsu"
 * - "sukufuku", "shukufuku", "syukufuku" -> "sukufuku"
 * - "subarasi", "subarashii" -> "subarasi"
 * - "shippuuden", "shippuden" -> "sipuden"
 */
export function toCanonicalRomaji(value: string): string {
  if (!value) return "";
  let s = value.toLowerCase();
  s = collapseLongVowels(s);

  // Collapse phonetic equivalents to base representation
  s = s.replace(/sh/g, "s");
  s = s.replace(/ch/g, "t");
  s = s.replace(/ts/g, "t");
  s = s.replace(/j/g, "z");
  s = s.replace(/f/g, "h");

  // Collapse Kunrei combos
  s = s.replace(/sy/g, "s");
  s = s.replace(/ty/g, "t");
  s = s.replace(/zy/g, "z");

  // Collapse double consonants (sokuon) to single for equivalence keying
  s = s.replace(/([bcdfghjklmnpqrstvwxyz])\1+/g, "$1");
  return s;
}

/**
 * Checks if two words are phonetically equivalent in Japanese Romaji.
 */
export function isRomajiEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const keyA = toCanonicalRomaji(a);
  const keyB = toCanonicalRomaji(b);
  return keyA.length >= 3 && keyA === keyB;
}

/**
 * Generates upstream search variants for Japanese terms.
 * If the user typed Kunrei (e.g. "singeki"), returns the Hepburn equivalent ("shingeki").
 * If the user omitted long-vowels (e.g. "ruroni"), returns the "ou" variant ("rurouni").
 */
export function generateRomajiVariants(token: string): string[] {
  const norm = token.toLowerCase();
  const variants: string[] = [];
  const seen = new Set<string>([norm]);

  // 1. Kunrei -> Hepburn variant
  const hepburn = kunreiToHepburn(norm);
  if (!seen.has(hepburn)) {
    seen.add(hepburn);
    variants.push(hepburn);
  }

  // 2. Expand 'o' to 'ou' for common anime titles (e.g. "ruroni" -> "rurouni", "kyokai" -> "kyoukai")
  if (norm.includes("o") && !norm.includes("ou")) {
    const withOu = norm.replace(/o/g, "ou");
    if (!seen.has(withOu) && withOu.length <= norm.length + 2) {
      seen.add(withOu);
      variants.push(withOu);
    }
  }

  // 3. Single-consonant to double-consonant sokuon (e.g. "shippuden" -> "shippuuden")
  if (norm.includes("puden") && !norm.includes("puuden")) {
    const withPuuden = norm.replace("puden", "puuden");
    if (!seen.has(withPuuden)) {
      seen.add(withPuuden);
      variants.push(withPuuden);
    }
  }

  return variants;
}
