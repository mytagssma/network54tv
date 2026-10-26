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
        best = Math.min(best, prev2[j - 2] + 1.0);
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
 * Generate high-probability QWERTY neighbor probes for a single word.
 * Cycles through positions from right to left, taking the highest-probability
 * neighbor at each position, to ensure internal typos (like 'm' in 'steims')
 * are tested rather than exhausting the budget on the last letter.
 */
export function qwertyNeighborProbes(word: string, maxProbes = 3): string[] {
  const probes: string[] = [];
  const seen = new Set<string>([word]);
  const len = word.length;
  if (len === 0) return probes;

  // Round-robin over positions from right to left
  let neighborIdx = 0;
  while (probes.length < maxProbes && neighborIdx < 4) {
    let generatedThisPass = false;
    for (let i = len - 1; i >= 0 && probes.length < maxProbes; i--) {
      const ch = word.charAt(i).toLowerCase();
      const neighbors = QWERTY_NEIGHBORS[ch] || [];
      if (neighborIdx < neighbors.length) {
        const neighbor = neighbors[neighborIdx];
        const probe = word.slice(0, i) + neighbor + word.slice(i + 1);
        if (!seen.has(probe)) {
          seen.add(probe);
          probes.push(probe);
          generatedThisPass = true;
        }
      }
    }
    if (!generatedThisPass) break;
    neighborIdx++;
  }

  return probes;
}
