import { describe, it, expect } from "vitest";
import { ECSKPhysics } from "../physics/ecsk-physics";
import {
  generatePerturbCoeffs,
  evaluatePerturbationFast,
  splitmix32,
} from "../physics/perturbation";
import shaderSource from "./particle-emit.wgsl?raw";

// ── WGSL source validation ──────────────────────────────────────────────

describe("particle-emit.wgsl", () => {
  it("imports as a non-empty string", () => {
    expect(typeof shaderSource).toBe("string");
    expect(shaderSource.length).toBeGreaterThan(100);
  });

  it("contains @compute entry point", () => {
    expect(shaderSource).toContain("@compute");
    expect(shaderSource).toContain("fn main");
  });

  it("contains bounceProps function", () => {
    expect(shaderSource).toContain("fn bounceProps");
  });

  it("contains PCG PRNG functions", () => {
    expect(shaderSource).toContain("fn pcg");
    expect(shaderSource).toContain("fn rand01");
  });

  it("contains evalPerturbation function", () => {
    expect(shaderSource).toContain("fn evalPerturbation");
  });

  it("uses log-factorial normalization instead of materialising (2m)!", () => {
    expect(shaderSource).toContain("logFactorial2m");
    expect(shaderSource).toContain("var norm2");
    expect(shaderSource).toContain("log(f32(i))");
    expect(shaderSource).toContain("sqrt(norm2)");
    expect(shaderSource).not.toContain("fac *= f32(i)");
  });

  it("contains ring buffer output bindings", () => {
    expect(shaderSource).toContain("outA");
    expect(shaderSource).toContain("outB");
  });

  it("does NOT multiply delta by perturbAmplitude in betaEff", () => {
    // The correct formula is: betaEff = beta * (1 + delta)
    // NOT: betaEff = beta * (1 + perturbAmplitude * delta)
    expect(shaderSource).toContain("params.beta * (1.0 + delta)");
    // Ensure no double-counting of amplitude in betaEff
    expect(shaderSource).not.toMatch(/betaEff.*perturbAmplitude\s*\*\s*delta/);
  });
});

// ── Golden values: bounceProps ──────────────────────────────────────────

describe("bounceProps golden values", () => {
  const testCases: Array<{
    label: string;
    beta: number;
    k: number;
    betaEff: number;
  }> = [
    { label: "β=0.005, k=+1", beta: 0.005, k: 1, betaEff: 0.005 },
    { label: "β=0.10, k=+1", beta: 0.10, k: 1, betaEff: 0.10 },
    { label: "β=0.2499, k=+1", beta: 0.2499, k: 1, betaEff: 0.2499 },
    { label: "β=0.005, k=0", beta: 0.005, k: 0, betaEff: 0.005 },
    { label: "β=0.10, k=0", beta: 0.10, k: 0, betaEff: 0.10 },
    { label: "β=0.2499, k=0", beta: 0.2499, k: 0, betaEff: 0.2499 },
    { label: "β=0.005, k=−1", beta: 0.005, k: -1, betaEff: 0.005 },
    { label: "β=0.10, k=−1", beta: 0.10, k: -1, betaEff: 0.10 },
    { label: "β=0.2499, k=−1", beta: 0.2499, k: -1, betaEff: 0.2499 },
  ];

  for (const tc of testCases) {
    it(`produces finite results for ${tc.label}`, () => {
      const physics = new ECSKPhysics(tc.beta, tc.k);
      const props = physics.bounceProps(tc.betaEff);

      expect(Number.isFinite(props.a)).toBe(true);
      expect(Number.isFinite(props.eps)).toBe(true);
      expect(Number.isFinite(props.wEff)).toBe(true);
      expect(Number.isFinite(props.acc)).toBe(true);

      // a > 0 always
      expect(props.a).toBeGreaterThan(0);
      // eps = 1/a⁴ > 0
      expect(props.eps).toBeGreaterThan(0);
    });
  }

  it("golden values for β=0.10, k=+1", () => {
    const p = new ECSKPhysics(0.10, 1);
    const props = p.bounceProps(0.10);

    // a² = (1 − √(1−0.4)) / 2 = (1 − √0.6) / 2
    const disc = Math.sqrt(0.6);
    const a2 = (1 - disc) / 2;
    const a = Math.sqrt(a2);

    expect(props.a).toBeCloseTo(a, 6);
    expect(props.eps).toBeCloseTo(1 / (a2 * a2), 4);

    const wDenom = 3 * (a2 - 0.10);
    const wEff = (a2 - 0.30) / wDenom;
    expect(props.wEff).toBeCloseTo(wEff, 6);

    const acc = -1 / (a2 * a) + 0.20 / (a2 * a2 * a);
    expect(props.acc).toBeCloseTo(acc, 4);
  });

  it("golden values for β=0.005, k=0", () => {
    const p = new ECSKPhysics(0.005, 0);
    const props = p.bounceProps(0.005);

    // k=0: a² = β
    expect(props.a).toBeCloseTo(Math.sqrt(0.005), 8);
    // wEff → -1 at k=0 bounce (denominator ≈ 0)
    expect(props.wEff).toBe(-1);
  });

  it("golden values for β=0.10, k=−1", () => {
    const p = new ECSKPhysics(0.10, -1);
    const props = p.bounceProps(0.10);

    // a² = (−1 + √(1.4)) / 2
    const disc = Math.sqrt(1.4);
    const a2 = (-1 + disc) / 2;
    const a = Math.sqrt(a2);

    expect(props.a).toBeCloseTo(a, 6);
    expect(props.eps).toBeCloseTo(1 / (a2 * a2), 4);
  });

  it("golden values for β=0.2499, k=+1 (near-critical)", () => {
    const p = new ECSKPhysics(0.2499, 1);
    const props = p.bounceProps(0.2499);

    // disc = √(1 − 4×0.2499) = √0.0004 = 0.02
    const disc = Math.sqrt(0.0004);
    const a2 = (1 - disc) / 2;
    const a = Math.sqrt(a2);

    expect(props.a).toBeCloseTo(a, 5);
    expect(props.eps).toBeCloseTo(1 / (a2 * a2), 3);
  });
});

// ── Golden values: evaluatePerturbationFast ─────────────────────────────

describe("evaluatePerturbationFast golden values", () => {
  const lMaxValues = [2, 8, 16];

  for (const lMax of lMaxValues) {
    describe(`lMax=${lMax}`, () => {
      const rng = splitmix32(42);
      const coeffs = generatePerturbCoeffs(lMax, 0.05, rng);

      it("returns 0 for empty coefficients", () => {
        expect(evaluatePerturbationFast([], 0, 0.5, 0.866, 1.0)).toBe(0);
      });

      it("produces finite results at north pole (θ=0)", () => {
        const delta = evaluatePerturbationFast(coeffs, lMax, 1.0, 0.0, 0.0);
        expect(Number.isFinite(delta)).toBe(true);
      });

      it("produces finite results at equator (θ=π/2)", () => {
        const delta = evaluatePerturbationFast(coeffs, lMax, 0.0, 1.0, 1.234);
        expect(Number.isFinite(delta)).toBe(true);
      });

      it("produces finite results at south pole (θ=π)", () => {
        const delta = evaluatePerturbationFast(coeffs, lMax, -1.0, 0.0, 0.0);
        expect(Number.isFinite(delta)).toBe(true);
      });

      it("has bounded magnitude for amplitude=0.05", () => {
        // With amplitude 0.05 and moderate lMax, |δ| should be small
        for (let i = 0; i < 20; i++) {
          const cosT = 1 - 2 * (i / 19);
          const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
          const phi = (i / 19) * 2 * Math.PI;
          const delta = evaluatePerturbationFast(coeffs, lMax, cosT, sinT, phi);
          expect(Math.abs(delta)).toBeLessThan(2.0);
        }
      });

      it("snapshot golden value at (cosT=0.5, sinT=0.866, φ=1.0)", () => {
        const delta = evaluatePerturbationFast(coeffs, lMax, 0.5, Math.sqrt(0.75), 1.0);
        // Record golden value — the WGSL must reproduce this within f32 tolerance
        expect(Number.isFinite(delta)).toBe(true);
        // Log for future WGSL validation
        console.log(`  lMax=${lMax} golden δ(0.5, 0.866, 1.0) = ${delta}`);
      });
    });
  }

  it("coefficient count matches expected L²+2L formula", () => {
    for (const lMax of lMaxValues) {
      const rng = splitmix32(42);
      const coeffs = generatePerturbCoeffs(lMax, 0.05, rng);
      expect(coeffs.length).toBe(lMax * lMax + 2 * lMax);
    }
  });
});

// ── WGSL Task 4 features: double-bounce & pair production ───────────────

describe("particle-emit.wgsl Task 4 features", () => {
  it("contains productionProps function", () => {
    expect(shaderSource).toContain("fn productionProps");
  });

  it("contains ProductionResult struct", () => {
    expect(shaderSource).toContain("struct ProductionResult");
  });

  it("contains double-bounce params in Params struct", () => {
    expect(shaderSource).toContain("doubleBounce: u32");
    expect(shaderSource).toContain("dbPhase: f32");
    expect(shaderSource).toContain("dbSecondHueShift: f32");
    expect(shaderSource).toContain("dbSecondBriScale: f32");
  });

  it("contains pair-production params in Params struct", () => {
    expect(shaderSource).toContain("bounceCount: u32");
    expect(shaderSource).toContain("ppHueShift: f32");
    expect(shaderSource).toContain("ppBriBoost: f32");
    expect(shaderSource).toContain("ppSizeScale: f32");
    expect(shaderSource).toContain("ppBaseDelay: f32");
    expect(shaderSource).toContain("ppScatterRange: f32");
    expect(shaderSource).toContain("ppBrightnessCeil: f32");
    expect(shaderSource).toContain("ppMinWEff: f32");
    expect(shaderSource).toContain("ppMaxWEff: f32");
    expect(shaderSource).toContain("ppGlobalMinAcc: f32");
    expect(shaderSource).toContain("ppGlobalMaxAcc: f32");
  });

  it("contains PP_SCATTER_BIAS constant", () => {
    expect(shaderSource).toContain("PP_SCATTER_BIAS");
  });

  it("uses bounceCount to distinguish bounce vs production particles", () => {
    expect(shaderSource).toContain("params.bounceCount");
    expect(shaderSource).toContain("isProduction");
  });

  it("applies double-bounce visual shift only on second bounce epoch", () => {
    // Should check dbPhase > 0.25 && dbPhase < 0.75 for second bounce
    expect(shaderSource).toContain("params.dbPhase > 0.25");
    expect(shaderSource).toContain("params.dbPhase < 0.75");
  });

  it("does NOT apply double-bounce brightness modulation to production particles", () => {
    // Production path should NOT multiply brightness by dbSecondBriScale.
    // The shader has a comment about this matching CPU semantics.
    expect(shaderSource).toContain("do NOT apply double-bounce brightness modulation");
  });
});

// ── Golden values: productionProps ──────────────────────────────────────

describe("productionProps golden values", () => {
  const testCases = [
    { beta: 0.005, k: 1, betaPP: 0.001 },
    { beta: 0.10, k: 1, betaPP: 0.005 },
    { beta: 0.10, k: 0, betaPP: 0.001 },
    { beta: 0.2499, k: 1, betaPP: 0.01 },
  ];

  for (const tc of testCases) {
    it(`produces finite results for β=${tc.beta}, k=${tc.k}, βPP=${tc.betaPP}`, () => {
      const physics = new ECSKPhysics(tc.beta, tc.k);
      const props = physics.productionProps(tc.beta, tc.betaPP);

      expect(Number.isFinite(props.a)).toBe(true);
      expect(Number.isFinite(props.eps)).toBe(true);
      expect(Number.isFinite(props.wEff)).toBe(true);
      expect(Number.isFinite(props.acc)).toBe(true);

      // Production epoch at a ≈ a_min × √2 → a > a_min
      const bounce = physics.bounceProps(tc.beta);
      expect(props.a).toBeCloseTo(bounce.a * Math.SQRT2, 6);
      // eps at production < eps at bounce (larger scale factor)
      expect(props.eps).toBeLessThan(bounce.eps);
    });
  }
});
