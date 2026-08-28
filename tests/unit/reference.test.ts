import { describe, expect, it } from "vitest";

import { generateReference } from "@/services/reference";

describe("generateReference", () => {
  it("matches the EVC-XXXXXX format", () => {
    expect(generateReference()).toMatch(/^EVC-[0-9A-HJKMNP-TV-Z]{6}$/);
  });

  /* The alphabet exists to survive being read aloud and re-typed; if an
     ambiguous glyph creeps back in, that guarantee is silently gone. */
  it("never emits the transcription-ambiguous glyphs I, L, O or U", () => {
    const sample = Array.from({ length: 2000 }, () => generateReference()).join("");
    expect(sample).not.toMatch(/[ILOU]/);
  });

  it("does not repeat across a large sample", () => {
    const seen = new Set(Array.from({ length: 5000 }, () => generateReference()));
    // 32^6 ≈ 1.07e9, so 5000 draws colliding would mean the RNG is broken.
    expect(seen.size).toBe(5000);
  });
});
