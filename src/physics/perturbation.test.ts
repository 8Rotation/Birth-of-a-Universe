import { describe, it, expect } from "vitest";
import {
  splitmix32,
  generatePerturbCoeffs,
  evaluatePerturbation,
  rescaleCoeffSigmas,
  evolveCoeffs,
  DEFAULT_SILK_DAMPING,
} from "./perturbation";

// ── splitmix32 PRNG ─────────────────────────────────────────────────────

describe("splitmix32", () => {
  it("produces deterministic sequence from same seed", () => {
    const rng1 = splitmix32(42);
    const rng2 = splitmix32(42);
    for (let i = 0; i < 100; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it("produces values in [0, 1)", () => {
    const rng = splitmix32(123);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("produces different sequences for different seeds", () => {
    const rng1 = splitmix32(1);
    const rng2 = splitmix32(2);
    let allSame = true;
    for (let i = 0; i < 10; i++) {
      if (rng1() !== rng2()) allSame = false;
    }
    expect(allSame).toBe(false);
  });
});

// ── Perturbation coefficients ───────────────────────────────────────────

describe("generatePerturbCoeffs", () => {
  it("returns correct number of coefficients for lMax", () => {
    const lMax = 5;
    const rng = splitmix32(42);
    const coeffs = generatePerturbCoeffs(lMax, 1.0, rng, 1.0, DEFAULT_SILK_DAMPING);
    // Total coefficients = sum_{l=1}^{lMax} (2l+1)
    const expected = Array.from({ length: lMax }, (_, i) => 2 * (i + 1) + 1).reduce(
      (a, b) => a + b,
      0,
    );
    expect(coeffs.length).toBe(expected);
  });

  it("returns deterministic output for same seed", () => {
    const c1 = generatePerturbCoeffs(4, 1.0, splitmix32(99), 1.0, DEFAULT_SILK_DAMPING);
    const c2 = generatePerturbCoeffs(4, 1.0, splitmix32(99), 1.0, DEFAULT_SILK_DAMPING);
    expect(c1).toEqual(c2);
  });

  it("each coefficient has l, m, c, sigma fields", () => {
    const coeffs = generatePerturbCoeffs(2, 0.5, splitmix32(7));
    for (const mode of coeffs) {
      expect(typeof mode.l).toBe("number");
      expect(typeof mode.m).toBe("number");
      expect(typeof mode.c).toBe("number");
      expect(typeof mode.sigma).toBe("number");
    }
  });
});

// ── evaluatePerturbation ────────────────────────────────────────────────

describe("evaluatePerturbation", () => {
  it("returns 0 for zero coefficients", () => {
    const coeffs = generatePerturbCoeffs(3, 0, splitmix32(1));
    // All c values should be 0 when amplitude is 0
    // cosT = cos(pi/4), sinT = sin(pi/4)
    const theta = Math.PI / 4;
    const val = evaluatePerturbation(coeffs, Math.cos(theta), Math.sin(theta), Math.PI / 3);
    expect(val).toBeCloseTo(0, 10);
  });

  it("returns finite value for random coefficients", () => {
    const coeffs = generatePerturbCoeffs(4, 0.5, splitmix32(42), 1.0, DEFAULT_SILK_DAMPING);
    const theta = 1.0;
    const val = evaluatePerturbation(coeffs, Math.cos(theta), Math.sin(theta), 2.0);
    expect(Number.isFinite(val)).toBe(true);
  });

  it("is smooth: nearby points give similar values", () => {
    const coeffs = generatePerturbCoeffs(3, 0.3, splitmix32(7), 1.0, DEFAULT_SILK_DAMPING);
    const t1 = 1.0;
    const t2 = 1.001;
    const v1 = evaluatePerturbation(coeffs, Math.cos(t1), Math.sin(t1), 1.0);
    const v2 = evaluatePerturbation(coeffs, Math.cos(t2), Math.sin(t2), 1.001);
    expect(Math.abs(v1 - v2)).toBeLessThan(0.01);
  });
});

// ── rescaleCoeffSigmas ──────────────────────────────────────────────────

describe("rescaleCoeffSigmas", () => {
  it("updates sigma values to new amplitude", () => {
    const coeffs = generatePerturbCoeffs(3, 1.0, splitmix32(42));
    const origSigmas = coeffs.map((m) => m.sigma);
    rescaleCoeffSigmas(coeffs, 3, 2.0); // double amplitude
    // Sigmas should be ~doubled
    for (let i = 0; i < coeffs.length; i++) {
      expect(coeffs[i].sigma).toBeCloseTo(origSigmas[i] * 2, 8);
    }
  });
});

// ── evolveCoeffs ────────────────────────────────────────────────────────

describe("evolveCoeffs", () => {
  it("does not mutate when theta=0 (frozen field)", () => {
    const coeffs = generatePerturbCoeffs(3, 1.0, splitmix32(42));
    const origC = coeffs.map((m) => m.c);
    evolveCoeffs(coeffs, 0.016, 0, splitmix32(99));
    for (let i = 0; i < coeffs.length; i++) {
      expect(coeffs[i].c).toBe(origC[i]);
    }
  });

  it("mutates coefficients when theta > 0", () => {
    const coeffs = generatePerturbCoeffs(3, 1.0, splitmix32(42));
    const origC = coeffs.map((m) => m.c);
    evolveCoeffs(coeffs, 0.016, 0.5, splitmix32(99));
    let anyChanged = false;
    for (let i = 0; i < coeffs.length; i++) {
      if (coeffs[i].c !== origC[i]) anyChanged = true;
    }
    expect(anyChanged).toBe(true);
  });
});
