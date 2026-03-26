/**
 * ecsk-physics.ts — Einstein-Cartan-Sciama-Kibble bounce physics.
 *
 * Implements the dimensionless Friedmann equation for a closed FLRW
 * interior with spin-torsion corrections.
 *
 * Governing equations (dimensionless form, spatial curvature k):
 *   (da̅/dτ̅)² = 1/a̅² − β/a̅⁴ − k                        (D1)
 *   d²a̅/dτ̅² = −1/a̅³ + 2β/a̅⁵                           (D2)
 *   k=+1: a̅_min² = [1 − √(1 − 4β)] / 2                  (D3)
 *   k= 0: a̅_min² = β                                     (D3′)
 *   k=−1: a̅_min² = [−1 + √(1 + 4β)] / 2                 (D3″)
 *   w_eff = (a̅² − 3β) / (3(a̅² − β))                     (EOS)
 *
 * Curvature k ∈ {−1, 0, +1}:
 *   k=+1 (closed) — bounce + turnaround/recollapse
 *   k= 0 (flat)   — bounce, then indefinite expansion
 *   k=−1 (open)   — bounce, then indefinite expansion
 *   (Cubero & Popławski 2019; Unger & Popławski 2019 eq. 2, 7)
 *
 * Verified against all 29 source papers (full review 2025-03-04):
 *
 *   Core ECSK bounce equations (D1–D3):
 *     Poplawski 2010b — Phys. Lett. B 694, 181 (eq. 10, 16, 21, 24)
 *     Poplawski 2012 — Phys. Rev. D 85, 107502 (eq. 5–7)
 *     Poplawski 2014 — CQG 31, 065005 (eq. 9–11, 20–22, 25)
 *     Unger & Poplawski 2019 — Astrophys. J. 870, 78 (eq. 1–10)
 *     Cubero & Poplawski 2019 — CQG 37, 025011 (dimensionless Friedmann)
 *     Poplawski 2020 — arXiv:2007.11556 (eq. 1, 10, 32)
 *     Poplawski 2020b — arXiv:2008.02136 (eq. 27–29)
 *     Poplawski 2021 — Phys. Rev. D 105, 024046 (eq. 3, 7)
 *
 *   Spin-torsion coupling & foundational ECSK theory:
 *     Hehl & Datta 1971 — J. Math. Phys. 12, 1334 (eq. 4.8, 7.1)
 *     Hehl et al. 1976 — Rev. Mod. Phys. 48, 393 (eq. 3.21–22, 5.13–18)
 *     Brechet et al. 2007 — CQG 24, 6329 (eq. 25, 62, 71)
 *     Hashemi et al. 2021 — arXiv:1407.4103 (eq. 9, 11a–b, 15)
 *
 *   Independent confirmation from alternative frameworks:
 *     Tukhashvili 2024 — arXiv:2309.08654 (NJL bounce, R_max ≈ 0.004 M_Pl²)
 *     Sadatian & Hosseini 2025 — Nucl. Phys. B 1014 (F(T) bounce, eq. 16–20)
 *     Lucat & Prokopec 2015 — arXiv:1512.06074 (generalized ξ-coupling)
 *     Alam et al. 2025 — arXiv:2509.03508 (f(R) ECSK, anisotropic bounce)
 *
 *   Observational/phenomenological constraints (no conflicts):
 *     Poplawski 2025 — CQG 42, 065017 (McVittie-ECSK, BH mass invariance)
 *     Elizalde et al. 2023 — arXiv:2204.00090 (GW speed = c in ECSK)
 *     Kirsch et al. 2023 — arXiv:2303.01165 (CCGG torsion dark energy)
 *     Shah et al. 2025 — arXiv:2511.15773 (DW ECSK, s₀ < 10⁻¹¹ yr⁻¹ at CMB)
 *     Kranas et al. 2019 — EPJC 79, 341 (BBN constrains |λ| < 0.02)
 *     Garcia de Andrade 2018 — EPJC 78, 530 (EC dynamo, B_seed ~ 10⁻¹⁰ G)
 *
 *   Foundational references:
 *     Alexander et al. 2014 — Phys. Rev. D 89, 065017 (gravi-weak EC origin)
 *     Böhmer & Bronowski 2006 — arXiv:gr-qc/0612078 (FLRW + spin averaging)
 *     Gourgoulhon 2007, Wald 1984, MTW 1973, Parker & Toms 2009
 *
 * EOS convention:
 *   This code uses the spin-fluid form: ε̃ = ε − αn², p̃ = p − αn²
 *   (Poplawski 2010b, 2014, 2020, Unger & Poplawski 2019).
 *   The Dirac-spinor treatment gives p̃ = p + αn² instead
 *   (Poplawski 2012, Cubero & Poplawski 2019). Both yield the same D1;
 *   the EOS differs but is used only for visual encoding, not dynamics.
 *   See EQUATION_CATALOG.md §11, §14, §26 for detailed cross-checks.
 *
 * Coupling constant: α = κ(ℏc)²/32, where κ = 8πG/c⁴
 * Spin parameter: β = αn₀²/ε₀  (torsion-to-radiation energy ratio)
 * Valid range: 0 < β < 1/4  (finite bounce requires 4β < 1)
 */

// ── Physics constants ──────────────────────────────────────────────────────

/** Minimum allowed β (global spin parameter). */
const BETA_MIN = 0.005;
/** Maximum allowed β (must be < 1/4 for finite bounce). */
const BETA_MAX = 0.2499;
/**
 * Minimum allowed β_eff in bounceProps().
 * Intentionally lower than BETA_MIN: the global β is clamped at 0.005,
 * but locally perturbed β_eff = β(1+δ) can dip below that when δ < 0.
 * 0.002 ensures the bounce-point algebra stays well-conditioned without
 * rejecting mildly negative perturbations.
 */
const BETA_EFF_MIN = 0.002;
/** Number of Simpson's-rule intervals for half-period integration. */
const HALF_PERIOD_INTERVALS = 1000;
/** Small offset to keep integration boundaries away from singularities. */
const INTEGRATION_EPS = 1e-9;
/** Finite-difference step for sensitivity (dT_half/dβ). */
const SENSITIVITY_DB = 1e-5;

export class ECSKPhysics {
  /** Minimum allowed global β (for external reference). */
  static readonly BETA_MIN = BETA_MIN;
  /** Maximum allowed global β (for external reference). */
  static readonly BETA_MAX = BETA_MAX;

  readonly beta: number;
  readonly k: number;     // spatial curvature: -1, 0, or +1
  readonly aMin: number;  // bounce scale factor (D3/D3′/D3″)
  readonly aMax: number;  // turnaround scale factor (finite only for k=+1)

  private _sensitivity: number | null = null;

  constructor(beta: number, k: number = 1) {
    this.beta = Math.max(BETA_MIN, Math.min(beta, BETA_MAX));
    this.k = Math.round(Math.max(-1, Math.min(k, 1)));  // clamp to {-1, 0, +1}

    // Bounce turning points from (da̅/dτ̅)² = 1/a̅² − β/a̅⁴ − k = 0
    // Multiply by a⁴:  a² − β − k·a⁴ = 0
    if (this.k === 1) {
      // k=+1 (closed): k·a⁴ − a² + β = 0  →  a² = (1 ± √(1−4β))/2
      const disc = Math.sqrt(Math.max(0, 1 - 4 * this.beta));
      this.aMin = Math.sqrt((1 - disc) / 2);
      this.aMax = Math.sqrt((1 + disc) / 2);
    } else if (this.k === 0) {
      // k=0 (flat): a² = β
      this.aMin = Math.sqrt(this.beta);
      this.aMax = Infinity;  // no turnaround — expands forever
    } else {
      // k=−1 (open): a⁴ + a² − β = 0  →  a² = (−1 + √(1+4β))/2
      const disc = Math.sqrt(1 + 4 * this.beta);
      this.aMin = Math.sqrt(Math.max(0, (-1 + disc) / 2));
      this.aMax = Infinity;  // no turnaround — expands forever
    }
  }

  /**
   * Bounce properties for a given effective beta.
   *
   * Each comoving fluid element can have a locally perturbed β_eff,
   * giving different bounce properties across the hypersurface.
   *
   * The bounce scale factor a_min depends on spatial curvature k:
   *   k=+1: a² = (1 − √(1−4β))/2       (D3)
   *   k= 0: a² = β                      (D3′)
   *   k=−1: a² = (−1 + √(1+4β))/2      (D3″)
   * w_eff, eps, acc, S, n are k-independent in formula but change
   * through a — the matter sector doesn't see curvature directly.
   * (Cubero & Popławski 2019; Unger & Popławski 2019 eq. 2, 7)
   */
  bounceProps(betaEff: number) {
    const be = Math.max(BETA_EFF_MIN, Math.min(betaEff, BETA_MAX));
    let a2: number;
    if (this.k === 1) {
      // k=+1 (closed): a⁴ − a² + β = 0  →  a² = (1 − √(1−4β))/2
      const disc = Math.sqrt(Math.max(0, 1 - 4 * be));
      a2 = (1 - disc) / 2;
    } else if (this.k === 0) {
      // k=0 (flat): a² = β
      a2 = be;
    } else {
      // k=−1 (open): a⁴ + a² − β = 0  →  a² = (−1 + √(1+4β))/2
      const disc = Math.sqrt(1 + 4 * be);
      a2 = Math.max(1e-12, (-1 + disc) / 2);
    }
    const a = Math.sqrt(a2);

    // w_eff = (a² − 3β) / (3(a² − β)).
    // The denominator vanishes when a² = β_eff, which is always the
    // case for k=0 at bounce (a² ≡ β_eff).  At that point ε̃ = 0
    // (torsion exactly cancels radiation energy) while p̃ = −2β/(3a⁶)
    // remains finite, so w → −∞.  For visual encoding we use the
    // physical limit w = −1 (cosmological-constant behaviour:
    // repulsive torsion dominates — Popławski 2010b eq. 24).
    const wDenom = 3 * (a2 - be);
    const wEff = Math.abs(wDenom) > 1e-12 ? (a2 - 3 * be) / wDenom : -1;

    return {
      a,
      betaEff: be,
      // Energy density at bounce: ε/ε₀ = 1/a̅⁴
      eps: 1 / (a2 * a2),
      // Effective equation of state — see derivation above.
      wEff,
      // Bounce kick: ä = −1/a³ + 2β/a⁵ (from D2)
      acc: -1 / (a2 * a) + (2 * be) / (a2 * a2 * a),
      // Torsion ratio: S = αn²/ε = β/a² (→ 1 in small-β limit; = 1−a² at bounce)
      S: be / a2,
      // Number density proxy: n ∝ 1/a³
      n: 1 / (a2 * a),
    };
  }

  /**
   * Critical particle production rate (standard model).
   * β_cr = (√6/32) × h_{n1} h_{nf}³ (ℏc)³ / h_star³ ≈ 1/929
   * (Popławski 2014 eq. 50–51)
   */
  static readonly BETA_CR = 1 / 929;

  /**
   * Properties at the post-bounce production epoch.
   *
   * After the bounce, gravitational particle production creates new
   * fermions at rate  ṅ_f + 3Hn_f = β_pp H⁴  (Popławski 2014 eq. 40–46;
   * 2020 eq. 33; 2021 eq. 8).  The production rate peaks shortly after
   * the bounce when the Hubble parameter H is near-maximal in the
   * expanding phase.  We evaluate at a ≈ a_min × √2, which is near
   * the H² maximum.
   *
   * Returns the same property set as bounceProps() plus production-
   * specific fields (gamma, ppStrength).
   *
   * @param betaEff  Locally perturbed spin parameter.
   * @param betaPP   Particle production rate coefficient.
   */
  productionProps(betaEff: number, betaPP: number) {
    const bounce = this.bounceProps(betaEff);
    const be = bounce.betaEff;

    // Production epoch: scale factor ≈ a_min × √2 (near H² peak)
    const aPost = bounce.a * Math.SQRT2;
    const a2 = aPost * aPost;
    const a4 = a2 * a2;

    // Hubble squared: H² = (ȧ/a)² = 1/a⁴ − β/a⁶ − k/a²
    // (from D1 divided by a²)
    const H2 = Math.max(0, 1 / a4 - be / (a4 * a2) - this.k / a2);
    const H4 = H2 * H2;

    // Production rate: Γ = β_pp × H⁴  (Popławski 2020 eq. 33)
    const gamma = betaPP * H4;

    // Strength relative to critical rate: β_pp / β_cr
    // Supercritical (> 1) → production sustains inflation
    const ppStrength = betaPP / ECSKPhysics.BETA_CR;

    return {
      a: aPost,
      betaEff: be,
      // Energy density at production epoch: ε ∝ 1/a⁴
      eps: 1 / a4,
      // w_eff at production-epoch scale factor
      wEff: (a2 - 3 * be) / (3 * (a2 - be)),
      // Acceleration at production epoch (from D2)
      acc: -1 / (a2 * aPost) + (2 * be) / (a4 * aPost),
      // Torsion ratio at production epoch
      S: be / a2,
      // Number density proxy
      n: 1 / (a2 * aPost),
      // Production rate Γ = β_pp × H⁴
      gamma,
      // Supercritical ratio β_pp / β_cr
      ppStrength,
    };
  }

  /**
   * Half-period: proper time from bounce to turnaround (k=+1)
   * or from bounce to a reference scale (k ≤ 0).
   *
   * T_half = ∫_{a_min}^{a_upper} da / √f(a)
   * where f(a) = 1/a² − β/a⁴ − k
   *
   * For k=+1: a_upper = a_max (turnaround).
   * For k=0, k=−1: a_upper = 3·a_min (no turnaround; captures
   *   bounce-region dynamics for sensitivity computation).
   *
   * Computed via Simpson's rule (N=1000 intervals).
   * (Cubero & Popławski 2019 dimensionless Friedmann equation)
   */
  halfPeriod(beta?: number): number {
    const b = beta ?? this.beta;
    const kv = this.k;
    let lo: number, hi: number;

    if (kv === 1) {
      const disc = Math.sqrt(Math.max(1e-12, 1 - 4 * b));
      lo = Math.sqrt((1 - disc) / 2) + INTEGRATION_EPS;
      hi = Math.sqrt((1 + disc) / 2) - INTEGRATION_EPS;
    } else if (kv === 0) {
      lo = Math.sqrt(b) + INTEGRATION_EPS;
      hi = 3 * lo;
    } else {
      // k = -1
      const disc = Math.sqrt(1 + 4 * b);
      lo = Math.sqrt(Math.max(1e-12, (-1 + disc) / 2)) + INTEGRATION_EPS;
      hi = 3 * lo;
    }

    const N = HALF_PERIOD_INTERVALS;
    const h = (hi - lo) / N;
    let sum = 0;

    for (let i = 0; i <= N; i++) {
      const a = lo + i * h;
      const f = 1 / (a * a) - b / (a * a * a * a) - kv;
      const v = f > 0 ? 1 / Math.sqrt(f) : 0;
      sum += (i === 0 || i === N ? 1 : i % 2 === 0 ? 2 : 4) * v;
    }

    return (sum * h) / 3;
  }

  /**
   * Full oscillation period for k=+1 (closed universe):
   * bounce → turnaround → second bounce in dimensionless time.
   * Returns Infinity for k ≤ 0 (no turnaround).
   *
   * For the double-bounce visualization: the closed universe oscillates
   * between a_min and a_max with period 2·T_half.  Both the first and
   * second bounce are physical bounce epochs (a = a_min) separated by
   * one full period.
   * (Cubero & Popławski 2019 — EQUATION_CATALOG.md §26)
   */
  fullPeriod(): number {
    if (this.k !== 1) return Infinity;
    return 2 * this.halfPeriod();
  }

  /**
   * Global acceleration range for bounce particles across the full
   * perturbation amplitude.  Returns [minAcc, maxAcc] for
   *   β_eff ∈ [β(1−amplitude), β(1+amplitude)]
   * so per-particle sizing can normalise against stable bounds
   * instead of per-batch min/max.
   */
  bounceAccRange(amplitude: number): { minAcc: number; maxAcc: number } {
    const lo = this.bounceProps(this.beta * (1 - amplitude)).acc;
    const hi = this.bounceProps(this.beta * (1 + amplitude)).acc;
    // acc is monotonic in β_eff; smaller β → larger acc (harder kick)
    const minAcc = Math.min(lo, hi);
    const maxAcc = Math.max(lo, hi);
    return { minAcc, maxAcc };
  }

  /**
   * Global acceleration range for production particles.
   */
  productionAccRange(amplitude: number, betaPP: number): { minAcc: number; maxAcc: number } {
    const lo = this.productionProps(this.beta * (1 - amplitude), betaPP).acc;
    const hi = this.productionProps(this.beta * (1 + amplitude), betaPP).acc;
    const minAcc = Math.min(lo, hi);
    const maxAcc = Math.max(lo, hi);
    return { minAcc, maxAcc };
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
    this._sensitivity =
      (this.halfPeriod(this.beta + SENSITIVITY_DB) -
        this.halfPeriod(this.beta - SENSITIVITY_DB)) /
      (2 * SENSITIVITY_DB);
    return this._sensitivity;
  }
}
