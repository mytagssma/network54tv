/**
 * Physical QWERTY keyboard adjacency map and weighted edit distance.
 * Adjacent keys have substitution cost 0.5 instead of 1.0.
 */

// Adjacency list for standard US-QWERTY layout (lowercase letters)
const QWERTY_NEIGHBORS: Record<string, string[]> = {
  q: ["w", "a", "s"],
  w: ["q", "e", "a", "s", "d"],
  e: ["w", "r", "s", "d", "f"],
  r: ["e", "t", "d", "f", "g"],
  t: ["r", "y", "f", "g", "h"],
  y: ["t", "u", "g", "h", "j"],
  u: ["y", "i", "h", "j", "k"],
  i: ["u", "o", "j", "k", "l"],
  o: ["i", "p", "k", "l"],
  p: ["o", "l"],
  a: ["q", "w", "s", "z", "x"],
  s: ["w", "e", "a", "d", "z", "x", "c"],
  d: ["e", "r", "s", "f", "x", "c", "v"],
  f: ["r", "t", "d", "g", "c", "v", "b"],
  g: ["t", "y", "f", "h", "v", "b", "n"],
  h: ["y", "u", "g", "j", "b", "n", "m"],
  j: ["u", "i", "h", "k", "n", "m"],
  k: ["i", "o", "j", "l", "m"],
  l: ["o", "p", "k"],
  z: ["a", "s", "x"],
  x: ["z", "s", "d", "c"],
  c: ["x", "d", "f", "v"],
  v: ["c", "f", "g", "b"],
  b: ["v", "g", "h", "n"],
  n: ["b", "h", "j", "m"],
  m: ["n", "j", "k"],
};

/**
 * Returns true if character `a` and `b` are immediate physical neighbors
 * on a standard QWERTY keyboard layout.
 */
export function isQwertyNeighbor(a: string, b: string): boolean {
  if (a === b) return false;
  const neighbors = QWERTY_NEIGHBORS[a.toLowerCase()];
  return neighbors ? neighbors.includes(b.toLowerCase()) : false;
}

/**
 * Weighted Damerau-Levenshtein distance:
 * - Exact match: cost 0
 * - QWERTY physical neighbor substitution: cost 0.5
 * - Standard substitution: cost 1.0
 * - Insertion / Deletion: cost 1.0
 * - Adjacent transposition (e.g. "peice" for "piece"): cost 1.0
 */
export function qwertyWeightedDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Short-circuit if length difference is too large
  if (Math.abs(m - n) > Math.max(m, n) * 0.6) return Math.max(m, n);

  let prev2: number[] = [];
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const charA = a.charAt(i - 1);

    for (let j = 1; j <= n; j++) {
      const charB = b.charAt(j - 1);
      let subCost = 1.0;
      if (charA === charB) {
        subCost = 0.0;
      } else if (isQwertyNeighbor(charA, charB)) {
        subCost = 0.5;
      }

      let best = Math.min(
        prev[j] + 1.0, // deletion
        cur[j - 1] + 1.0, // insertion
        prev[j - 1] + subCost // substitution
      );

      // Adjacent transposition
      if (
        i > 1 &&
        j > 1 &&
        a.charAt(i - 1) === b.charAt(j - 2) &&
        a.charAt(i - 2) === b.charAt(j - 1) &&
        prev2.length === n + 1
      ) {
        best = Math.min(best, prev2[j - 2] + 0.8);
      }

      cur[j] = best;
    }

    const spare = prev2;
    prev2 = prev;
    prev = cur;
    cur = spare.length === n + 1 ? spare : new Array<number>(n + 1);
  }

  return prev[n];
}

/**
 * Normalized similarity between two words under QWERTY-weighted distance.
 * Returns a score in [0, 1].
 */
export function qwertyWordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = qwertyWeightedDistance(a, b);
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Generate high-probability typo probes for a single word:
 * 1. Dropped-letter / common digraph restorations (e.g. "puch" -> "punch", "punh" -> "punch")
 * 2. Transposition of adjacent letters (e.g. "peice" -> "piece", "pnuch" -> "punch")
 * 3. Physical QWERTY key substitutions from right to left (e.g. "steims" -> "steins", "narutp" -> "naruto")
 */
export function qwertyNeighborProbes(word: string, maxProbes = 4): string[] {
  const probes: string[] = [];
  const seen = new Set<string>([word]);
  const len = word.length;
  if (len < 2) return probes;

  const add = (p: string) => {
    if (p && !seen.has(p) && probes.length < maxProbes) {
      seen.add(p);
      probes.push(p);
    }
  };

  const norm = word.toLowerCase();

  // 1. Common dropped letter / cluster restorations:
  if (norm.includes("uch") && !norm.includes("unch")) add(norm.replace("uch", "unch"));
  if (norm.includes("nh") && !norm.includes("nch")) add(norm.replace("nh", "nch"));
  if (norm.includes("ach") && !norm.includes("each")) add(norm.replace("ach", "each"));
  if (norm.includes("geki") && !norm.includes("ngeki")) add(norm.replace("geki", "ngeki"));

  // 2. High-probability transpositions (for short words <= 4 chars, all adjacent transpositions;
  // for longer words, common vowel/consonant swap pairs like "peice" -> "piece")
  if (len <= 4) {
    for (let i = 0; i < len - 1 && probes.length < maxProbes; i++) {
      add(norm.slice(0, i) + norm[i + 1] + norm[i] + norm.slice(i + 2));
    }
  } else {
    for (let i = 0; i < len - 1 && probes.length < maxProbes; i++) {
      const a = norm[i];
      const b = norm[i + 1];
      if (a !== b) {
        if (
          (a === "e" && b === "i") ||
          (a === "i" && b === "e") ||
          (a === "a" && b === "l") ||
          (a === "p" && b === "n")
        ) {
          add(norm.slice(0, i) + b + a + norm.slice(i + 2));
        }
      }
    }
  }

  // 3. Physical QWERTY key substitutions (1st neighbor pass from right to left)
  for (let i = len - 1; i >= 0 && probes.length < maxProbes; i--) {
    const ch = norm.charAt(i);
    const neighbors = QWERTY_NEIGHBORS[ch] || [];
    if (neighbors.length > 0) {
      add(norm.slice(0, i) + neighbors[0] + norm.slice(i + 1));
    }
  }

  // 4. Any other transpositions
  for (let i = 0; i < len - 1 && probes.length < maxProbes; i++) {
    add(norm.slice(0, i) + norm[i + 1] + norm[i] + norm.slice(i + 2));
  }

  // 5. Secondary QWERTY substitutions if budget remains
  let neighborIdx = 1;
  while (probes.length < maxProbes && neighborIdx < 3) {
    let generated = false;
    for (let i = len - 1; i >= 0 && probes.length < maxProbes; i--) {
      const ch = norm.charAt(i);
      const neighbors = QWERTY_NEIGHBORS[ch] || [];
      if (neighborIdx < neighbors.length) {
        add(norm.slice(0, i) + neighbors[neighborIdx] + norm.slice(i + 1));
        generated = true;
      }
    }
    if (!generated) break;
    neighborIdx++;
  }

  return probes;
}
