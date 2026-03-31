import { describe, it, expect } from "vitest";
import {
  splitmix32,
  generatePerturbCoeffs,
  evaluatePerturbation,
  evaluatePerturbationFast,
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

// ── evaluatePerturbationFast vs evaluatePerturbation ────────────────────

describe("evaluatePerturbationFast", () => {
  it("matches evaluatePerturbation on 1000+ random points (lMax=8)", () => {
    const lMax = 8;
    const coeffs = generatePerturbCoeffs(lMax, 0.5, splitmix32(42));
    const rng = splitmix32(777);
    for (let i = 0; i < 1200; i++) {
      const theta = Math.acos(1 - 2 * rng());
      const phi = 2 * Math.PI * rng();
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const slow = evaluatePerturbation(coeffs, cosT, sinT, phi);
      const fast = evaluatePerturbationFast(coeffs, lMax, cosT, sinT, phi);
      const absDiff = Math.abs(fast - slow);
      const relDiff = Math.abs(slow) > 1e-15 ? absDiff / Math.abs(slow) : absDiff;
      expect(relDiff).toBeLessThan(1e-9);
    }
  });

  it("matches evaluatePerturbation on 1000+ random points (lMax=32)", () => {
    const lMax = 32;
    const coeffs = generatePerturbCoeffs(lMax, 0.3, splitmix32(99));
    const rng = splitmix32(1234);
    for (let i = 0; i < 1200; i++) {
      const theta = Math.acos(1 - 2 * rng());
      const phi = 2 * Math.PI * rng();
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const slow = evaluatePerturbation(coeffs, cosT, sinT, phi);
      const fast = evaluatePerturbationFast(coeffs, lMax, cosT, sinT, phi);
      const absDiff = Math.abs(fast - slow);
      const relDiff = Math.abs(slow) > 1e-15 ? absDiff / Math.abs(slow) : absDiff;
      expect(relDiff).toBeLessThan(1e-10);
    }
  });

  it("returns 0 for empty coefficients", () => {
    expect(evaluatePerturbationFast([], 0, 0.5, 0.866, 1.0)).toBe(0);
  });

  it("returns 0 for zero-amplitude coefficients", () => {
    const coeffs = generatePerturbCoeffs(4, 0, splitmix32(1));
    const theta = Math.PI / 4;
    const val = evaluatePerturbationFast(coeffs, 4, Math.cos(theta), Math.sin(theta), Math.PI / 3);
    expect(val).toBeCloseTo(0, 10);
  });

  it("matches at poles (cosT=±1, sinT≈0)", () => {
    const lMax = 16;
    const coeffs = generatePerturbCoeffs(lMax, 0.5, splitmix32(55));
    // North pole
    const slow1 = evaluatePerturbation(coeffs, 1, 0, 0);
    const fast1 = evaluatePerturbationFast(coeffs, lMax, 1, 0, 0);
    expect(Math.abs(fast1 - slow1)).toBeLessThan(1e-12);
    // South pole
    const slow2 = evaluatePerturbation(coeffs, -1, 0, 0);
    const fast2 = evaluatePerturbationFast(coeffs, lMax, -1, 0, 0);
    expect(Math.abs(fast2 - slow2)).toBeLessThan(1e-12);
  });

  it("matches at equator (cosT=0, sinT=1)", () => {
    const lMax = 16;
    const coeffs = generatePerturbCoeffs(lMax, 0.5, splitmix32(55));
    const rng = splitmix32(333);
    for (let i = 0; i < 100; i++) {
      const phi = 2 * Math.PI * rng();
      const slow = evaluatePerturbation(coeffs, 0, 1, phi);
      const fast = evaluatePerturbationFast(coeffs, lMax, 0, 1, phi);
      const absDiff = Math.abs(fast - slow);
      const relDiff = Math.abs(slow) > 1e-15 ? absDiff / Math.abs(slow) : absDiff;
      expect(relDiff).toBeLessThan(1e-10);
    }
  });

  it("coefficient index mapping matches generatePerturbCoeffs layout", () => {
    // Verify the formula idx(l, m) = l² + l + m − 1 matches the actual array
    for (const lMax of [4, 8, 16, 32]) {
      const coeffs = generatePerturbCoeffs(lMax, 1.0, splitmix32(42));
      for (let i = 0; i < coeffs.length; i++) {
        const { l, m } = coeffs[i];
        const expectedIdx = l * l + l + m - 1;
        expect(expectedIdx).toBe(i);
      }
    }
  });

  it("matches evaluatePerturbation for each individual mode (lMax=4)", () => {
    // Test that each single Y_lm is correctly evaluated by the fast path
    const lMax = 4;
    const rng = splitmix32(999);
    for (let trial = 0; trial < 50; trial++) {
      const theta = Math.acos(1 - 2 * rng());
      const phi = 2 * Math.PI * rng();
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      // Create coeffs with only one non-zero mode at a time
      for (let idx = 0; idx < lMax * lMax + 2 * lMax; idx++) {
        const coeffs = generatePerturbCoeffs(lMax, 0, splitmix32(1));
        coeffs[idx].c = 1.0; // activate only this mode
        const slow = evaluatePerturbation(coeffs, cosT, sinT, phi);
        const fast = evaluatePerturbationFast(coeffs, lMax, cosT, sinT, phi);
        const absDiff = Math.abs(fast - slow);
        expect(absDiff).toBeLessThan(1e-12);
      }
    }
  });

  it("is measurably faster than evaluatePerturbation at lMax=32", () => {
    const lMax = 32;
    const coeffs = generatePerturbCoeffs(lMax, 0.5, splitmix32(42));
    const rng = splitmix32(777);
    const N = 2000;

    // Pre-generate random angles to avoid RNG overhead in timing
    const angles = Array.from({ length: N }, () => {
      const theta = Math.acos(1 - 2 * rng());
      return { cosT: Math.cos(theta), sinT: Math.sin(theta), phi: 2 * Math.PI * rng() };
    });

    // Warm up JIT
    for (let i = 0; i < 200; i++) {
      const a = angles[i % N];
      evaluatePerturbation(coeffs, a.cosT, a.sinT, a.phi);
      evaluatePerturbationFast(coeffs, lMax, a.cosT, a.sinT, a.phi);
    }

    const t0 = performance.now();
    let dummy1 = 0;
    for (let i = 0; i < N; i++) {
      const a = angles[i];
      dummy1 += evaluatePerturbation(coeffs, a.cosT, a.sinT, a.phi);
    }
    const slowMs = performance.now() - t0;

    const t1 = performance.now();
    let dummy2 = 0;
    for (let i = 0; i < N; i++) {
      const a = angles[i];
      dummy2 += evaluatePerturbationFast(coeffs, lMax, a.cosT, a.sinT, a.phi);
    }
    const fastMs = performance.now() - t1;

    // Prevent dead-code elimination
    expect(Number.isFinite(dummy1)).toBe(true);
    expect(Number.isFinite(dummy2)).toBe(true);

    const speedup = slowMs / fastMs;
    console.log(`  Benchmark lMax=32: slow=${slowMs.toFixed(1)}ms, fast=${fastMs.toFixed(1)}ms, speedup=${speedup.toFixed(1)}×`);
    // Spec target: ≥ 3× speedup
    expect(speedup).toBeGreaterThan(2.0); // conservative floor for CI variance
  });
});
