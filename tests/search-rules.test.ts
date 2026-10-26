import { describe, expect, it } from "bun:test";
import {
  compoundWordSimilarity,
  passesCompoundGate,
  scoreCompoundTitle,
  type SearchableTitle,
} from "../src/lib/search/comparator";
import { isQwertyNeighbor, qwertyNeighborProbes, qwertyWeightedDistance } from "../src/lib/search/qwerty";
import { generateRomajiVariants, isRomajiEquivalent, toCanonicalRomaji } from "../src/lib/search/romaji";
import { cleanSymbols, extractSeasonNumber } from "../src/lib/search/tokens";
import { groupByFranchise } from "../src/lib/anilist";
import type { Anime } from "../src/types/anime";

// Mock media records for testing
const MEDIA_STEINS_GATE: SearchableTitle = {
  title: {
    romaji: "Steins;Gate",
    english: "Steins;Gate",
    native: "シュタインズ・ゲート",
  },
  synonyms: ["SteinsGate", "S;G"],
};

const MEDIA_STEINS_GATE_0: SearchableTitle = {
  title: {
    romaji: "Steins;Gate 0",
    english: "Steins;Gate 0",
  },
  synonyms: ["Steins;Gate Zero"],
};

const MEDIA_AOT_S1: SearchableTitle = {
  title: {
    romaji: "Shingeki no Kyojin",
    english: "Attack on Titan",
    native: "進撃の巨人",
  },
  synonyms: ["AoT", "SnK"],
};

const MEDIA_AOT_S2: SearchableTitle = {
  title: {
    romaji: "Shingeki no Kyojin Season 2",
    english: "Attack on Titan Season 2",
  },
  synonyms: ["Shingeki no Kyojin 2nd Season", "AoT 2"],
};

const MEDIA_FATE_ZERO: SearchableTitle = {
  title: {
    romaji: "Fate/Zero",
    english: "Fate/Zero",
  },
  synonyms: ["Fate Zero"],
};

const MEDIA_FATE_ZERO_S2: SearchableTitle = {
  title: {
    romaji: "Fate/Zero Season 2",
    english: "Fate/Zero Season 2",
  },
  synonyms: ["Fate/Zero 2nd Season", "Fate Zero Part 2"],
};

const MEDIA_SPY_FAMILY: SearchableTitle = {
  title: {
    romaji: "SPY×FAMILY",
    english: "SPY x FAMILY",
  },
  synonyms: ["Spy Family", "Spy x Family"],
};

const MEDIA_SLIME: SearchableTitle = {
  title: {
    romaji: "Tensei Shitara Slime Datta Ken",
    english: "That Time I Got Reincarnated as a Slime",
  },
  synonyms: ["Slime Isekai", "Tensura"],
};

const MEDIA_SLIME_S2: SearchableTitle = {
  title: {
    romaji: "Tensei Shitara Slime Datta Ken 2nd Season",
    english: "That Time I Got Reincarnated as a Slime Season 2",
  },
  synonyms: ["Tensura Season 2", "That Time I Got Reincarnated as a Slime Part 2"],
};

const MEDIA_KONOSUBA: SearchableTitle = {
  title: {
    romaji: "Kono Subarashii Sekai ni Shukufuku wo!",
    english: "KonoSuba: God's Blessing on this Wonderful World!",
  },
  synonyms: ["KonoSuba", "Give Blessings to This Wonderful World!"],
};

const MEDIA_KONOSUBA_2: SearchableTitle = {
  title: {
    romaji: "Kono Subarashii Sekai ni Shukufuku wo! 2",
    english: "KonoSuba: God's Blessing on this Wonderful World! 2",
  },
  synonyms: ["KonoSuba Season 2"],
};

const MEDIA_RUROUNI_KENSHIN: SearchableTitle = {
  title: {
    romaji: "Rurouni Kenshin: Meiji Kenkaku Romantan",
    english: "Rurouni Kenshin",
  },
  synonyms: ["Samurai X"],
};

const MEDIA_JUJUTSU_KAISEN: SearchableTitle = {
  title: {
    romaji: "Jujutsu Kaisen",
    english: "Jujutsu Kaisen",
  },
  synonyms: ["JJK"],
};

const MEDIA_JUJUTSU_KAISEN_S2: SearchableTitle = {
  title: {
    romaji: "Jujutsu Kaisen Season 2",
    english: "Jujutsu Kaisen Season 2",
  },
  synonyms: ["JJK Season 2"],
};

const MEDIA_ONE_PUNCH_MAN: SearchableTitle = {
  title: {
    romaji: "One Punch Man",
    english: "One Punch Man",
  },
  synonyms: ["OPM", "One-Punch Man"],
};

const MEDIA_ONE_PUNCH_MAN_S2: SearchableTitle = {
  title: {
    romaji: "One Punch Man 2",
    english: "One-Punch Man Season 2",
  },
  synonyms: ["OPM 2", "One-Punch Man 2"],
};

const MEDIA_ONE_PIECE: SearchableTitle = {
  title: {
    romaji: "ONE PIECE",
    english: "One Piece",
  },
  synonyms: ["OP"],
};

const MEDIA_NARUTO: SearchableTitle = {
  title: {
    romaji: "Naruto",
    english: "Naruto",
  },
  synonyms: [],
};

const MEDIA_BORUTO: SearchableTitle = {
  title: {
    romaji: "BORUTO: NARUTO NEXT GENERATIONS",
    english: "Boruto: Naruto Next Generations",
  },
  synonyms: [],
};

const MEDIA_OVERLORD: SearchableTitle = {
  title: {
    romaji: "Overlord",
    english: "Overlord",
  },
  synonyms: [],
};

const MEDIA_LORD_OF_MYSTERIES: SearchableTitle = {
  title: {
    romaji: "Guimi Zhi Zhu",
    english: "Lord of Mysteries",
  },
  synonyms: ["Lord of the Mysteries"],
};

const MEDIA_BERSERK: SearchableTitle = {
  title: {
    romaji: "Berserk",
    english: "Berserk",
  },
  synonyms: [],
};

const MEDIA_CLANNAD_AFTER_STORY: SearchableTitle = {
  title: {
    romaji: "Clannad: After Story",
    english: "Clannad: After Story",
  },
  synonyms: [],
};

const MEDIA_HUNTER_X_HUNTER: SearchableTitle = {
  title: {
    romaji: "HUNTER×HUNTER (2011)",
    english: "Hunter x Hunter (2011)",
  },
  synonyms: ["HxH (2011)", "Hunter Hunter"],
};

const MEDIA_K_ON: SearchableTitle = {
  title: {
    romaji: "K-ON!",
    english: "K-On!",
  },
  synonyms: ["Keion!"],
};

const MEDIA_D_GRAY_MAN: SearchableTitle = {
  title: {
    romaji: "D.Gray-man",
    english: "D.Gray-man",
  },
  synonyms: ["D. Gray-man", "D Gray Man"],
};

const MEDIA_EVANGELION_3: SearchableTitle = {
  title: {
    romaji: "Shin Evangelion Gekijouban :||",
    english: "Evangelion: 3.0+1.0 Thrice Upon a Time",
  },
  synonyms: ["Evangelion 3.0+1.0"],
};

const MEDIA_COWBOY_BEBOP: SearchableTitle = {
  title: {
    romaji: "Cowboy Bebop",
    english: "Cowboy Bebop",
  },
  synonyms: [],
};

describe("Search System Test Suite", () => {
  describe("1. Baseline & Exact Matches", () => {
    it("exact matches pass the gate and receive score 1.0", () => {
      expect(passesCompoundGate("Steins;Gate", MEDIA_STEINS_GATE)).toBe(true);
      expect(scoreCompoundTitle("Steins;Gate", MEDIA_STEINS_GATE)).toBe(1.0);

      expect(passesCompoundGate("Naruto", MEDIA_NARUTO)).toBe(true);
      expect(scoreCompoundTitle("Naruto", MEDIA_NARUTO)).toBe(1.0);

      expect(passesCompoundGate("One Piece", MEDIA_ONE_PIECE)).toBe(true);
      expect(scoreCompoundTitle("One Piece", MEDIA_ONE_PIECE)).toBe(1.0);
    });
  });

  describe("2. Symbol & Punctuation Cleanup", () => {
    it("handles semicolons, slashes, colons, and crossover marks smoothly", () => {
      // Semicolon replaced by space
      expect(passesCompoundGate("steins gate", MEDIA_STEINS_GATE)).toBe(true);

      // Slash replaced by space
      expect(passesCompoundGate("fate zero", MEDIA_FATE_ZERO)).toBe(true);

      // Crossover 'x' or '×'
      expect(passesCompoundGate("spy x family", MEDIA_SPY_FAMILY)).toBe(true);
      expect(passesCompoundGate("spy family", MEDIA_SPY_FAMILY)).toBe(true);
    });
  });

  describe("3. Japanese Romaji & Phonetics", () => {
    it("normalizes Kunrei-shiki to Hepburn", () => {
      expect(isRomajiEquivalent("singeki", "shingeki")).toBe(true);
      expect(isRomajiEquivalent("zyuzyutsu", "jujutsu")).toBe(true);
      expect(isRomajiEquivalent("sukufuku", "shukufuku")).toBe(true);

      expect(passesCompoundGate("singeki no kyojin", MEDIA_AOT_S1)).toBe(true);
      expect(passesCompoundGate("zyuzyutsu kaisen", MEDIA_JUJUTSU_KAISEN)).toBe(true);
    });

    it("normalizes Japanese long vowels and sokuon", () => {
      expect(isRomajiEquivalent("ruroni", "rurouni")).toBe(true);
      expect(passesCompoundGate("ruroni kenshin", MEDIA_RUROUNI_KENSHIN)).toBe(true);

      const variants = generateRomajiVariants("ruroni");
      expect(variants).toContain("rurouni");
    });
  });

  describe("4. QWERTY Proximity & Mechanical Typos", () => {
    it("calculates lower edit distance for physical QWERTY neighbors", () => {
      // 'm' and 'n' are physical neighbors -> weighted cost 0.5
      expect(isQwertyNeighbor("m", "n")).toBe(true);
      expect(qwertyWeightedDistance("steims", "steins")).toBe(0.5);

      // QWERTY neighbor probes generate 'steins' for 'steims'
      const probes = qwertyNeighborProbes("steims", 3);
      expect(probes).toContain("steins");
    });

    it("passes single-word typos with QWERTY proximity", () => {
      expect(compoundWordSimilarity("steims", "steins")).toBeGreaterThanOrEqual(0.85);
      expect(compoundWordSimilarity("narutp", "naruto")).toBeGreaterThanOrEqual(0.85);
      expect(compoundWordSimilarity("peice", "piece")).toBeGreaterThanOrEqual(0.75);
    });
  });

  describe("5. Sentence Titles & Particle Stripping", () => {
    it("matches light novel sentence titles with dropped stop words or particles", () => {
      // "reincarnated slime" matches "That Time I Got Reincarnated as a Slime"
      expect(passesCompoundGate("reincarnated slime", MEDIA_SLIME)).toBe(true);
      expect(passesCompoundGate("that time i got reincarnated as a slime", MEDIA_SLIME)).toBe(true);

      // Inverted word order
      expect(passesCompoundGate("slime reincarnated", MEDIA_SLIME)).toBe(true);

      // Dropped Japanese particles
      expect(passesCompoundGate("subarashii sekai shukufuku", MEDIA_KONOSUBA)).toBe(true);
    });
  });

  describe("6. Combinatorial Matrix: 2-Way Compound Combinations", () => {
    it("SYM + KBD: 'steins;gaet' (semicolon + transposition typo)", () => {
      expect(passesCompoundGate("steins;gaet", MEDIA_STEINS_GATE)).toBe(true);
    });

    it("SYM + ROM: 'ruroni: meiji' (colon + missing long vowel 'ou'->'o')", () => {
      expect(passesCompoundGate("ruroni: meiji", MEDIA_RUROUNI_KENSHIN)).toBe(true);
    });

    it("SYM + SEN: 'kono subarashii sekai: shukufuku!' (punctuation + dropped particles)", () => {
      expect(passesCompoundGate("kono subarashii sekai: shukufuku!", MEDIA_KONOSUBA)).toBe(true);
    });

    it("SYM + NUM: 'fate/zero: 2' (symbol + season numeral)", () => {
      expect(passesCompoundGate("fate/zero: 2", MEDIA_FATE_ZERO_S2)).toBe(true);
    });

    it("ROM + KBD: 'singeki kyojim' (Kunrei 'si' + QWERTY 'm'->'n')", () => {
      expect(passesCompoundGate("singeki kyojim", MEDIA_AOT_S1)).toBe(true);
    });

    it("ROM + SEN: 'subarasi sekai sukufuku' (Kunrei 'si'/'su' + dropped particles)", () => {
      expect(passesCompoundGate("subarasi sekai sukufuku", MEDIA_KONOSUBA)).toBe(true);
    });

    it("ROM + NUM: 'singeki no kyojin 2nd ssn' (Kunrei 'si' + season format)", () => {
      expect(passesCompoundGate("singeki no kyojin 2nd ssn", MEDIA_AOT_S2)).toBe(true);
    });

    it("KBD + SEN: 'reincarnaetd as a sllime' (transposition + duplicate letter + sentence)", () => {
      expect(passesCompoundGate("reincarnaetd as a sllime", MEDIA_SLIME)).toBe(true);
    });

    it("KBD + NUM: 'steims gate 0' (QWERTY typo + numeral)", () => {
      expect(passesCompoundGate("steims gate 0", MEDIA_STEINS_GATE_0)).toBe(true);
    });
  });

  describe("7. Combinatorial Matrix: 3-Way & 4-Way Combinations", () => {
    it("SYM + KBD + NUM: 'fate/zerp: 2' (slash + colon + QWERTY 'p'->'o' + numeral)", () => {
      expect(passesCompoundGate("fate/zerp: 2", MEDIA_FATE_ZERO_S2)).toBe(true);
    });

    it("SYM + KBD + SEN: 'that time i got reincarnaetd... slime!' (symbols + transposition + dropped stop words)", () => {
      expect(passesCompoundGate("that time i got reincarnaetd... slime!", MEDIA_SLIME)).toBe(true);
    });

    it("ROM + KBD + NUM: 'zyuzyutsu kaisem s2' (Kunrei 'zyu' + QWERTY 'm'->'n' + season)", () => {
      expect(passesCompoundGate("zyuzyutsu kaisem s2", MEDIA_JUJUTSU_KAISEN_S2)).toBe(true);
    });

    it("SYM + ROM + KBD + NUM: 'fate / zerp: part 2' (symbols + QWERTY typo + numeral)", () => {
      expect(passesCompoundGate("fate / zerp: part 2", MEDIA_FATE_ZERO_S2)).toBe(true);
    });
  });

  describe("8. The 5-Way Stacked Combination (ALL 5 Dimensions at Once)", () => {
    it("handles symbols + phonetics + keyboard typo + sentence particles + season format simultaneously", () => {
      // Query: "kono subarasi sekai ni sukufuku wo!: s2"
      // - SYM: ! and :
      // - ROM: subarasi, sukufuku
      // - KBD: missing double ii
      // - SEN: particles ni, wo
      // - NUM: s2
      expect(
        passesCompoundGate("kono subarasi sekai ni sukufuku wo!: s2", MEDIA_KONOSUBA_2)
      ).toBe(true);

      // Query: "that time i got reincarnaetd as a sllime: part 2"
      // - SYM: :
      // - KBD: reincarnaetd (transposition), sllime (double l)
      // - SEN: that time i got as a
      // - NUM: part 2
      expect(
        passesCompoundGate(
          "that time i got reincarnaetd as a sllime: part 2",
          MEDIA_SLIME_S2
        )
      ).toBe(true);
    });
  });

  describe("9. Distant & Unique Edge Cases", () => {
    it("glued run-on words (missing spaces): 'onepunchman'", () => {
      expect(passesCompoundGate("onepunchman", MEDIA_ONE_PUNCH_MAN)).toBe(true);
      expect(passesCompoundGate("onepunch man", MEDIA_ONE_PUNCH_MAN)).toBe(true);
    });

    it("cross-language code-switching with typo: 'attack on kyojim'", () => {
      expect(passesCompoundGate("attack on kyojim", MEDIA_AOT_S1)).toBe(true);
    });

    it("QWERTY diagonal neighbor: 'berzerk' (z is diagonal to s) matches Berserk", () => {
      expect(isQwertyNeighbor("z", "s")).toBe(true);
      expect(passesCompoundGate("berzerk", MEDIA_BERSERK)).toBe(true);
    });

    it("omitted crossover symbol: 'hunter hunter' matches HUNTER×HUNTER", () => {
      expect(passesCompoundGate("hunter hunter", MEDIA_HUNTER_X_HUNTER)).toBe(true);
    });

    it("hyphenated franchise: 'k-on' and 'k on' match K-ON!", () => {
      expect(passesCompoundGate("k-on", MEDIA_K_ON)).toBe(true);
      expect(passesCompoundGate("k on", MEDIA_K_ON)).toBe(true);
    });

    it("dotted franchise: 'd.gray-man' and 'd gray man' match D.Gray-man", () => {
      expect(passesCompoundGate("d.gray-man", MEDIA_D_GRAY_MAN)).toBe(true);
      expect(passesCompoundGate("d gray man", MEDIA_D_GRAY_MAN)).toBe(true);
    });

    it("decimal title: 'evangelion 3.0+1.0' and 'evangelion 3 0 1 0'", () => {
      expect(passesCompoundGate("evangelion 3.0+1.0", MEDIA_EVANGELION_3)).toBe(true);
      expect(passesCompoundGate("evangelion 3 0 1 0", MEDIA_EVANGELION_3)).toBe(true);
    });

    it("multiple simultaneous typos across multi-word: 'calnand aftr stroy' matches Clannad: After Story", () => {
      expect(passesCompoundGate("calnand aftr stroy", MEDIA_CLANNAD_AFTER_STORY)).toBe(true);
    });

    it("accidental backspace / dropped letter in middle: 'cowboy bepop'", () => {
      expect(passesCompoundGate("cowboy bepop", MEDIA_COWBOY_BEBOP)).toBe(true);
    });
  });

  describe("10. False-Positive Protection (Anti-Poisoning)", () => {
    it("'lord of the mystries' MUST accept Lord of the Mysteries and REJECT Overlord", () => {
      expect(passesCompoundGate("lord of the mystries", MEDIA_LORD_OF_MYSTERIES)).toBe(true);
      expect(passesCompoundGate("lord of the mystries", MEDIA_OVERLORD)).toBe(false);
    });

    it("'naruto' MUST rank Naruto higher than Boruto (no false-positive promotion)", () => {
      expect(passesCompoundGate("naruto", MEDIA_NARUTO)).toBe(true);
      expect(scoreCompoundTitle("naruto", MEDIA_NARUTO)).toBe(1.0);
      expect(scoreCompoundTitle("naruto", MEDIA_NARUTO)).toBeGreaterThan(
        scoreCompoundTitle("naruto", MEDIA_BORUTO)
      );
      expect(passesCompoundGate("naruto", MEDIA_ONE_PIECE)).toBe(false);
    });

    it("'one piece' MUST NOT accept One Punch Man", () => {
      expect(passesCompoundGate("one piece", MEDIA_ONE_PIECE)).toBe(true);
      expect(passesCompoundGate("one piece", MEDIA_ONE_PUNCH_MAN)).toBe(false);
    });

    it("random keyboard mashing is rejected outright", () => {
      expect(passesCompoundGate("asdfghjkl", MEDIA_AOT_S1)).toBe(false);
      expect(passesCompoundGate("!@#$%^&*", MEDIA_STEINS_GATE)).toBe(false);
    });
  });

  describe("11. Dropped-Letter Typo Probes & Standalone Season Numbers", () => {
    it("generates 'punch' probe from omission typos 'puch' and 'punh', and 'one' from 'oen'", () => {
      expect(qwertyNeighborProbes("puch")).toContain("punch");
      expect(qwertyNeighborProbes("punh")).toContain("punch");
      expect(qwertyNeighborProbes("oen")).toContain("one");
    });

    it("accepts short-word transpositions through compound gate: 'oen punch man'", () => {
      expect(passesCompoundGate("oen punch man", MEDIA_ONE_PUNCH_MAN)).toBe(true);
      expect(passesCompoundGate("oen punch 2", MEDIA_ONE_PUNCH_MAN_S2)).toBe(true);
    });

    it("extracts trailing standalone digit as season number", () => {
      expect(extractSeasonNumber("one punch 2")).toEqual({ cleaned: "one punch", season: "2" });
      expect(extractSeasonNumber("one punh 2")).toEqual({ cleaned: "one punh", season: "2" });
      expect(extractSeasonNumber("mob psycho 100 2")).toEqual({ cleaned: "mob psycho 100", season: "2" });
      expect(extractSeasonNumber("fate zero 2")).toEqual({ cleaned: "fate zero", season: "2" });
    });

    it("evaluates season 2 as higher score than season 1 when '2' is queried", () => {
      const s1Score = scoreCompoundTitle("one punch 2", MEDIA_ONE_PUNCH_MAN);
      const s2Score = scoreCompoundTitle("one punch 2", MEDIA_ONE_PUNCH_MAN_S2);
      expect(s2Score).toBeGreaterThan(s1Score);
      expect(s2Score).toBe(1.0);

      const typoS1Score = scoreCompoundTitle("one punh 2", MEDIA_ONE_PUNCH_MAN);
      const typoS2Score = scoreCompoundTitle("one punh 2", MEDIA_ONE_PUNCH_MAN_S2);
      expect(typoS2Score).toBeGreaterThan(typoS1Score);
      expect(typoS2Score).toBe(1.0);
    });
  });

  describe("12. Franchise Group Ordering with Search Query", () => {
    const mockAnimeS1: Anime = {
      id: 21087,
      title: "One-Punch Man",
      coverImage: "",
      genres: [],
      studios: [],
      trending: 0,
      format: "TV",
      startDate: 20151005,
      relations: [{ id: 97668, relationType: "SEQUEL" }],
    };
    const mockAnimeS2: Anime = {
      id: 97668,
      title: "One-Punch Man Season 2",
      coverImage: "",
      genres: [],
      studios: [],
      trending: 0,
      format: "TV",
      startDate: 20190410,
      relations: [{ id: 21087, relationType: "PREQUEL" }],
    };

    it("orders Season 1 first when query is general 'one punch'", () => {
      const groups = groupByFranchise([mockAnimeS2, mockAnimeS1], { query: "one punch" });
      expect(groups.length).toBe(1);
      expect(groups[0].items[0].id).toBe(21087); // Season 1 first
      expect(groups[0].items[1].id).toBe(97668); // Season 2 second
    });

    it("orders Season 2 first when query specifically asks for 'one punch 2'", () => {
      const groups = groupByFranchise([mockAnimeS1, mockAnimeS2], { query: "one punch 2" });
      expect(groups.length).toBe(1);
      expect(groups[0].items[0].id).toBe(97668); // Season 2 leads!
      expect(groups[0].items[1].id).toBe(21087); // Season 1 follows
    });

    it("orders Season 2 first when query has typo 'one punh 2'", () => {
      const groups = groupByFranchise([mockAnimeS1, mockAnimeS2], { query: "one punh 2" });
      expect(groups.length).toBe(1);
      expect(groups[0].items[0].id).toBe(97668); // Season 2 leads!
      expect(groups[0].items[1].id).toBe(21087); // Season 1 follows
    });
  });
});
