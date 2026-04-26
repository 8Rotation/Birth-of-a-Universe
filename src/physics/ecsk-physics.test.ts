import { describe, it, expect } from "vitest";
import { ECSKPhysics } from "./ecsk-physics";

// ── Constructor & turning points ────────────────────────────────────────

describe("ECSKPhysics constructor", () => {
  it("computes aMin and aMax for k=+1 (closed)", () => {
    const p = new ECSKPhysics(0.10, 1);
    // a²_min = (1 − √(1−4β))/2 = (1−√0.6)/2
    const disc = Math.sqrt(1 - 4 * 0.10);
    const expectedAMin = Math.sqrt((1 - disc) / 2);
    const expectedAMax = Math.sqrt((1 + disc) / 2);
    expect(p.aMin).toBeCloseTo(expectedAMin, 10);
    expect(p.aMax).toBeCloseTo(expectedAMax, 10);
    expect(p.aMin).toBeLessThan(p.aMax);
  });

  it("computes aMin for k=0 (flat)", () => {
    const p = new ECSKPhysics(0.10, 0);
    expect(p.aMin).toBeCloseTo(Math.sqrt(0.10), 10);
    expect(p.aMax).toBe(Infinity);
  });

  it("computes aMin for k=−1 (open)", () => {
    const p = new ECSKPhysics(0.10, -1);
    const disc = Math.sqrt(1 + 4 * 0.10);
    const expected = Math.sqrt((-1 + disc) / 2);
    expect(p.aMin).toBeCloseTo(expected, 10);
    expect(p.aMax).toBe(Infinity);
  });

  it("clamps beta to valid range", () => {
    const tooLow = new ECSKPhysics(0.001);
    expect(tooLow.beta).toBe(0.005);
    const tooHigh = new ECSKPhysics(0.30);
    expect(tooHigh.beta).toBe(0.2499);
  });

  it("clamps k to {−1, 0, +1}", () => {
    expect(new ECSKPhysics(0.10, 5).k).toBe(1);
    expect(new ECSKPhysics(0.10, -3).k).toBe(-1);
    expect(new ECSKPhysics(0.10, 0.4).k).toBe(0);
  });
});

// ── bounceProps ─────────────────────────────────────────────────────────

describe("bounceProps", () => {
  const physics = new ECSKPhysics(0.10, 1);

  it("returns finite values for default beta", () => {
    const bp = physics.bounceProps(0.10);
    expect(bp.a).toBeGreaterThan(0);
    expect(bp.a).toBeCloseTo(physics.aMin, 5);
    expect(Number.isFinite(bp.wEff)).toBe(true);
    expect(Number.isFinite(bp.eps)).toBe(true);
    expect(Number.isFinite(bp.acc)).toBe(true);
    expect(Number.isFinite(bp.S)).toBe(true);
    expect(Number.isFinite(bp.n)).toBe(true);
  });

  it("acceleration is positive at bounce (repulsive torsion wins)", () => {
    const bp = physics.bounceProps(0.10);
    expect(bp.acc).toBeGreaterThan(0);
  });

  it("torsion ratio S approaches 1 for small beta", () => {
    // As β→0: a²_min→β, S = β/a² → 1
    const smallBeta = new ECSKPhysics(0.005, 1);
    const bp = smallBeta.bounceProps(0.005);
    expect(bp.S).toBeCloseTo(1, 1);
  });

  it("w_eff is finite (can be phantom w < −1 near bounce)", () => {
    const bp = physics.bounceProps(0.10);
    expect(Number.isFinite(bp.wEff)).toBe(true);
    // For spin-fluid convention at bounce, w_eff ≈ (a²−3β)/(3(a²−β))
    // which diverges as a²→β (phantom regime), so w_eff can be << −1
    expect(bp.wEff).toBeLessThan(0); // should be negative at bounce
  });

  it("produces different results for different betaEff", () => {
    const low = physics.bounceProps(0.05);
    const high = physics.bounceProps(0.20);
    expect(low.a).not.toBeCloseTo(high.a, 3);
    expect(low.wEff).not.toBeCloseTo(high.wEff, 3);
  });

  it("clamps betaEff below minimum", () => {
    const bp = physics.bounceProps(0.0001);
    expect(bp.betaEff).toBe(0.002);
  });

  it("w_eff is finite for k=0 (no division-by-zero)", () => {
    const flat = new ECSKPhysics(0.10, 0);
    const bp = flat.bounceProps(0.10);
    expect(Number.isFinite(bp.wEff)).toBe(true);
    expect(bp.wEff).toBe(-1); // cosmological-constant limit
    // Perturbed β_eff should also be finite
    const bp2 = flat.bounceProps(0.05);
    expect(Number.isFinite(bp2.wEff)).toBe(true);
    expect(bp2.wEff).toBe(-1);
  });

  it("w_eff is finite for k=-1", () => {
    const open = new ECSKPhysics(0.10, -1);
    const bp = open.bounceProps(0.10);
    expect(Number.isFinite(bp.wEff)).toBe(true);
  });
});

// ── productionProps ─────────────────────────────────────────────────────

describe("productionProps", () => {
  const physics = new ECSKPhysics(0.10, 1);

  it("scale factor is aMin * sqrt(2)", () => {
    const pp = physics.productionProps(0.10, 1.0);
    expect(pp.a).toBeCloseTo(physics.aMin * Math.SQRT2, 8);
  });

  it("ppStrength = betaPP / BETA_CR", () => {
    const betaPP = 0.005;
    const pp = physics.productionProps(0.10, betaPP);
    expect(pp.ppStrength).toBeCloseTo(betaPP / ECSKPhysics.BETA_CR, 8);
  });

  it("gamma increases with betaPP", () => {
    const pp1 = physics.productionProps(0.10, 0.001);
    const pp2 = physics.productionProps(0.10, 0.01);
    expect(pp2.gamma).toBeGreaterThan(pp1.gamma);
  });
});

// ── halfPeriod & fullPeriod ─────────────────────────────────────────────

describe("halfPeriod", () => {
  it("is finite and positive for k=+1", () => {
    const p = new ECSKPhysics(0.10, 1);
    const T = p.halfPeriod();
    expect(T).toBeGreaterThan(0);
    expect(Number.isFinite(T)).toBe(true);
  });

  it("fullPeriod = 2 × halfPeriod for k=+1", () => {
    const p = new ECSKPhysics(0.10, 1);
    expect(p.fullPeriod()).toBeCloseTo(2 * p.halfPeriod(), 10);
  });

  it("fullPeriod is Infinity for k=0", () => {
    const p = new ECSKPhysics(0.10, 0);
    expect(p.fullPeriod()).toBe(Infinity);
  });

  it("halfPeriod decreases with larger beta (torsion narrows the throat)", () => {
    const p1 = new ECSKPhysics(0.05, 1);
    const p2 = new ECSKPhysics(0.20, 1);
    expect(p2.halfPeriod()).toBeLessThan(p1.halfPeriod());
  });
});

// ── sensitivity ─────────────────────────────────────────────────────────

describe("sensitivity", () => {
  it("is finite and nonzero for k=+1", () => {
    const p = new ECSKPhysics(0.10, 1);
    const s = p.sensitivity();
    expect(Number.isFinite(s)).toBe(true);
    expect(s).not.toBe(0);
  });

  it("is cached (same value on second call)", () => {
    const p = new ECSKPhysics(0.10, 1);
    const s1 = p.sensitivity();
    const s2 = p.sensitivity();
    expect(s1).toBe(s2);
    expect(s1).toBeLessThan(0);
  });

  it("has negative dT/dβ for a closed bounce across beta perturbations", () => {
    const beta = 0.10;
    const closed = new ECSKPhysics(beta, 1);

    for (const delta of [1e-4, 1e-3, 5e-3]) {
      const dTDb = (closed.halfPeriod(beta + delta) - closed.halfPeriod(beta - delta)) / (2 * delta);
      expect(dTDb).toBeLessThan(0);
    }
  });
});
