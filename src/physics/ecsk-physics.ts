/**
 * ecsk-physics.ts — Einstein-Cartan-Sciama-Kibble bounce physics.
 *
 * Implements the dimensionless Friedmann equation for a closed FLRW
 * interior with spin-torsion corrections.
 *
 * Governing equations (dimensionless form):
 *   (da̅/dτ̅)² = 1/a̅² − β/a̅⁴ − 1                      (D1)
 *   d²a̅/dτ̅² = −1/a̅³ + 2β/a̅⁵                           (D2)
 *   a̅_min² = [1 − √(1 − 4β)] / 2                        (D3)
 *   w_eff = (a̅² − 3β) / (3(a̅² − β))                     (EOS)
 *
 * Verified against source papers:
 *   Poplawski 2010b — Phys. Lett. B 694, 181 (eq. 10, 16, 21, 24)
 *   Poplawski 2014 — CQG 31, 065005 (eq. 10, 20, 25)
 *   Poplawski 2020b — arXiv:2008.02136 (eq. 27, 28)
 *   Hehl & Datta 1971, Hehl et al. 1976 — spin-torsion coupling
 *
 * Coupling constant: α = κ(ℏc)²/32, where κ = 8πG/c⁴
 * Spin parameter: β = αn₀²/ε₀  (torsion-to-radiation energy ratio)
 * Valid range: 0 < β < 1/4  (finite bounce requires 4β < 1)
 */

export class ECSKPhysics {
  readonly beta: number;
  readonly aMin: number;  // bounce scale factor (D3)
  readonly aMax: number;  // turnaround scale factor

  private _sensitivity: number | null = null;

  constructor(beta: number) {
    this.beta = Math.max(0.005, Math.min(beta, 0.2499));
    const disc = Math.sqrt(1 - 4 * this.beta);
    this.aMin = Math.sqrt((1 - disc) / 2);
    this.aMax = Math.sqrt((1 + disc) / 2);
  }

  /**
   * Bounce properties for a given effective beta.
   *
   * Each comoving fluid element can have a locally perturbed β_eff,
   * giving different bounce properties across the hypersurface.
   */
  bounceProps(betaEff: number) {
    const be = Math.max(0.002, Math.min(betaEff, 0.2499));
    const disc = Math.sqrt(Math.max(0, 1 - 4 * be));
    const a2 = (1 - disc) / 2;
    const a = Math.sqrt(a2);

    return {
      a,
      betaEff: be,
      // Energy density at bounce: ε/ε₀ = 1/a̅⁴
      eps: 1 / (a2 * a2),
      // Effective equation of state: w_eff = p̃/ε̃
      // Derived from ε̃ = 1/a⁴ − β/a⁶ and p̃ = 1/(3a⁴) − β/a⁶
      wEff: (a2 - 3 * be) / (3 * (a2 - be)),
      // Bounce kick: ä = −1/a³ + 2β/a⁵ (from D2)
      acc: -1 / (a2 * a) + (2 * be) / (a2 * a2 * a),
      // Torsion ratio: S = αn²/ε = β/a² → 1 at bounce
      S: be / a2,
      // Number density proxy: n ∝ 1/a³
      n: 1 / (a2 * a),
    };
  }

  /**
   * Half-period: proper time from bounce to turnaround.
   *
   * T_half = ∫_{a_min}^{a_max} da / √f(a)
   * where f(a) = 1/a² − β/a⁴ − 1
   *
   * Computed via Simpson's rule (N=1000 intervals).
   */
  halfPeriod(beta?: number): number {
    const b = beta ?? this.beta;
    const disc = Math.sqrt(Math.max(1e-12, 1 - 4 * b));
    const lo = Math.sqrt((1 - disc) / 2) + 1e-9;
    const hi = Math.sqrt((1 + disc) / 2) - 1e-9;
    const N = 1000;
    const h = (hi - lo) / N;
    let sum = 0;

    for (let i = 0; i <= N; i++) {
      const a = lo + i * h;
      const f = 1 / (a * a) - b / (a * a * a * a) - 1;
      const v = f > 0 ? 1 / Math.sqrt(f) : 0;
      sum += (i === 0 || i === N ? 1 : i % 2 === 0 ? 2 : 4) * v;
    }

    return (sum * h) / 3;
  }

  /**
   * Sensitivity: dT_half / dβ, by central finite difference.
   *
   * Determines how perturbations in β shift the bounce time:
   *   δτ_bounce ≈ (dT/dβ) · δβ
   *
   * Cached after first computation.
   */
  sensitivity(): number {
    if (this._sensitivity !== null) return this._sensitivity;
    const db = 1e-5;
    this._sensitivity =
      (this.halfPeriod(this.beta + db) -
        this.halfPeriod(this.beta - db)) /
      (2 * db);
    return this._sensitivity;
  }
}
