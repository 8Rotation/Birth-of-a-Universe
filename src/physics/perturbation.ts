/**
 * perturbation.ts — Spherical harmonic perturbation field.
 *
 * Generates a perturbation δ(θ,φ) = Σ c_lm Y_lm(θ,φ) with a
 * nearly scale-invariant (Harrison-Zeldovich) spectrum and Silk-type
 * exponential damping at high multipoles.
 *
 * The perturbation models local variations in the spin parameter β
 * across the bounce hypersurface, creating structure in when each
 * fluid element reaches its bounce. This is a physically motivated
 * extrapolation — Poplawski's papers treat the homogeneous case,
 * while we apply the separate-universe approximation to introduce
 * perturbations.
 *
 * The separate-universe approach is supported by the algebraic nature
 * of torsion in ECSK theory (Hehl et al. 1976 eq. 3.22; Brechet et al.
 * 2007 eq. 21): torsion does not propagate, so each fluid element's
 * bounce depends only on its local β_eff. Elizalde et al. 2023 confirm
 * that GW propagate on torsionless geodesics at c, further validating
 * that torsion effects are strictly local.
 *
 * Perturbation spectrum for δ on the primordial bounce S²:
 *   Sadatian & Hosseini 2025 derive a Bessel-type mode equation
 *   with spectral index n_s ≈ 0.965 from ξ ≈ 0.4 (their eq. 37),
 *   consistent with the Planck 2018 value used here.
 *
 * Spectral index: n_s = 0.965 default (Planck 2018), exposed as UI slider
 * Silk damping: exp(−(l/l_silk)²) with l_silk = 0.6 × l_max
 */

// ── Seeded PRNG (splitmix32) ──────────────────────────────────────────────

/**
 * Splitmix32: fast, deterministic PRNG with good statistical properties.
 * Used for reproducible random generation of perturbation coefficients.
 */
export function splitmix32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x9e3779b9) | 0;
    let t = seed ^ (seed >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

// ── Real spherical harmonics Y_l^m(θ, φ) ─────────────────────────────────

/**
 * Evaluate a real spherical harmonic Y_l^m at (θ, φ).
 *
 * Uses associated Legendre polynomial recurrence:
 *   P_m^m = (−1)^m (2m−1)!! sinθ^m
 *   P_{m+1}^m = cosθ(2m+1) P_m^m
 *   P_l^m = [(2l−1)cosθ P_{l-1}^m − (l+m−1) P_{l-2}^m] / (l−m)
 *
 * Normalization: N_l^m = √[(2l+1)/(4π) · (l−|m|)!/(l+|m|)!]
 *
 * Real form:
 *   m > 0: N · P_l^m · √2 · cos(mφ)
 *   m < 0: N · P_l^|m| · √2 · sin(|m|φ)
 *   m = 0: N · P_l^0
 */
function ylmReal(
  l: number,
  m: number,
  cosTheta: number,
  sinTheta: number,
  phi: number,
): number {
  const am = Math.abs(m);

  // P_m^m via starting recurrence
  let pmm = 1;
  for (let i = 1; i <= am; i++) pmm *= -(2 * i - 1) * sinTheta;

  let plm: number;
  if (l === am) {
    plm = pmm;
  } else {
    const pmm1 = cosTheta * (2 * am + 1) * pmm;
    if (l === am + 1) {
      plm = pmm1;
    } else {
      plm = 0;
      let a = pmm,
        b = pmm1;
      for (let ll = am + 2; ll <= l; ll++) {
        plm =
          ((2 * ll - 1) * cosTheta * b - (ll + am - 1) * a) / (ll - am);
        a = b;
        b = plm;
      }
    }
  }

  // Normalization factor
  let norm = (2 * l + 1) / (4 * Math.PI);
  let fac = 1;
  for (let i = l - am + 1; i <= l + am; i++) fac *= i;
  norm = Math.sqrt(norm / fac);

  if (m > 0) return norm * plm * Math.sqrt(2) * Math.cos(m * phi);
  if (m < 0) return norm * plm * Math.sqrt(2) * Math.sin(am * phi);
  return norm * plm;
}

// ── Perturbation spectrum ─────────────────────────────────────────────────

/** Default Silk damping ratio (l_silk = ratio × l_max). */
export const DEFAULT_SILK_DAMPING = 0.6;

export interface PerturbMode {
  l: number;
  m: number;
  c: number;     // current coefficient
  sigma: number; // O-U diffusion scale = amplitude × √C_l (per-mode target std dev)
}

/**
 * Generate perturbation coefficients with nearly scale-invariant spectrum.
 *
 * Power spectrum: C_l ∝ l^(n_s − 1) × exp(−(l/l_silk)²)
 *   - n_s: spectral index (default 0.965, Planck 2018; Sadatian & Hosseini 2025 eq. 37)
 *   - l_silk = 0.6 × lMax (Silk damping scale)
 *
 * Each (l, m) mode gets a random coefficient ~ modeAmp × uniform(−1, 1).
 */
export function generatePerturbCoeffs(
  lMax: number,
  amplitude: number,
  rng: () => number,
  ns = 0.965,
  silkDamping = DEFAULT_SILK_DAMPING,
): PerturbMode[] {
  if (!Number.isFinite(lMax) || lMax <= 0) {
    throw new RangeError("lMax must be greater than 0");
  }
  if (!Number.isFinite(amplitude) || amplitude < 0) {
    throw new RangeError("amplitude must be greater than or equal to 0");
  }

  const lSilk = Math.max(2, lMax * silkDamping);
  const coeffs: PerturbMode[] = [];

  for (let l = 1; l <= lMax; l++) {
    const Cl =
      Math.pow(l, ns - 1) * Math.exp(-(l * l) / (lSilk * lSilk));
    const modeAmp = amplitude * Math.sqrt(Cl);

    for (let m = -l; m <= l; m++) {
      coeffs.push({ l, m, c: (rng() * 2 - 1) * modeAmp, sigma: modeAmp });
    }
  }

  return coeffs;
}

const gaussianSpareByRng = new WeakMap<() => number, number>();

function gaussianFromRng(rng: () => number): number {
  const spare = gaussianSpareByRng.get(rng);
  if (spare !== undefined) {
    gaussianSpareByRng.delete(rng);
    return spare;
  }

  const u1 = Math.max(1e-10, rng());
  const u2 = rng();
  const radius = Math.sqrt(-2 * Math.log(u1));
  const angle = 2 * Math.PI * u2;
  gaussianSpareByRng.set(rng, radius * Math.sin(angle));
  return radius * Math.cos(angle);
}

/**
 * Ornstein-Uhlenbeck evolution of perturbation coefficients.
 *
 * Each coefficient performs a mean-reverting random walk:
 *
 *   dc = −θ · c · dt + σ_OU · √dt · ξ
 *
 * where σ_OU = mode.sigma · √(2θ) ensures the stationary variance
 * equals mode.sigma² (matching the original generatePerturbCoeffs scale).
 *
 * @param coeffs  Coefficient array (mutated in place).
 * @param dt      Frame duration in seconds.
 * @param theta   Mean-reversion rate (1/s).  θ = 0.1 → ~10 s correlation
 *                time; θ = 1.0 → ~1 s; θ = 0 → frozen.
 * @param rng     Uniform [0,1) PRNG (Box-Muller pairs consumed internally).
 */
export function evolveCoeffs(
  coeffs: PerturbMode[],
  dt: number,
  theta: number,
  rng: () => number,
): void {
  if (theta <= 0) return;
  const sqrtDt = Math.sqrt(dt);
  const sigmaScale = Math.sqrt(2 * theta);
  for (const mode of coeffs) {
    const gauss = gaussianFromRng(rng);
    mode.c += -theta * mode.c * dt + mode.sigma * sigmaScale * sqrtDt * gauss;
  }
}

/**
 * Rescale the sigma targets of an existing coefficient array.
 *
 * Called when perturbAmplitude changes at runtime so the O-U stationary
 * distribution tracks the new amplitude without regenerating coefficients.
 */
export function rescaleCoeffSigmas(
  coeffs: PerturbMode[],
  lMax: number,
  amplitude: number,
  ns = 0.965,
  silkDamping = DEFAULT_SILK_DAMPING,
): void {
  const lSilk = Math.max(2, lMax * silkDamping);
  for (const mode of coeffs) {
    const Cl =
      Math.pow(mode.l, ns - 1) * Math.exp(-(mode.l * mode.l) / (lSilk * lSilk));
    mode.sigma = amplitude * Math.sqrt(Cl);
  }
}

/**
 * Evaluate the perturbation field δ(θ, φ) at a single point.
 *
 * δ = Σ c_lm × Y_lm(θ, φ)
 *
 * Returns a dimensionless perturbation value (typically |δ| ≪ 1).
 */
// Reference implementation — used by tests; do not inline into hot path.
export function evaluatePerturbation(
  coeffs: PerturbMode[],
  cosT: number,
  sinT: number,
  phi: number,
): number {
  let delta = 0;
  for (const { l, m, c } of coeffs) {
    delta += c * ylmReal(l, m, cosT, sinT, phi);
  }
  return delta;
}

/**
 * Fast single-pass evaluation of the perturbation field δ(θ, φ).
 *
 * Mathematically identical to `evaluatePerturbation` but walks the
 * Associated Legendre recurrence once across all (m, l) pairs instead
 * of recomputing P_l^m from scratch for every mode. This eliminates
 * all redundant work and is 5-10× faster for lMax ≥ 16.
 *
 * Coefficient indexing: coeffs[l² + l + m − 1] holds mode (l, m),
 * matching the layout produced by `generatePerturbCoeffs` which
 * iterates l = 1..lMax, m = −l..+l.
 *
 * cos(mφ) and sin(mφ) are computed via angle-addition recurrence
 * (zero per-call allocations).
 *
 * @param coeffs  Coefficient array from generatePerturbCoeffs.
 * @param lMax    Maximum multipole degree (must match coeffs).
 * @param cosT    cos(θ).
 * @param sinT    sin(θ).
 * @param phi     Azimuthal angle φ.
 */
export function evaluatePerturbationFast(
  coeffs: PerturbMode[],
  lMax: number,
  cosT: number,
  sinT: number,
  phi: number,
): number {
  if (lMax < 1 || coeffs.length === 0) return 0;

  let delta = 0;
  const SQRT2 = Math.SQRT2;
  const LOG_4PI = Math.log(4 * Math.PI);

  // cos(φ) and sin(φ) for angle-addition recurrence
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // Sectoral Legendre value P_m^m (built incrementally)
  let pmm = 1.0; // P_0^0 = 1

  // Angle-addition state: cos(m·φ), sin(m·φ)
  let cosMPhi = 1.0; // cos(0) = 1
  let sinMPhi = 0.0; // sin(0) = 0

  for (let m = 0; m <= lMax; m++) {
    // ── Advance sectoral & trig values for m > 0 ──
    if (m > 0) {
      // P_m^m = -(2m-1) · sinT · P_{m-1}^{m-1}
      pmm *= -(2 * m - 1) * sinT;

      // cos(mφ) = cos((m-1)φ)·cos(φ) − sin((m-1)φ)·sin(φ)
      // sin(mφ) = sin((m-1)φ)·cos(φ) + cos((m-1)φ)·sin(φ)
      const c = cosMPhi * cosPhi - sinMPhi * sinPhi;
      const s = sinMPhi * cosPhi + cosMPhi * sinPhi;
      cosMPhi = c;
      sinMPhi = s;
    }

    // Initial squared normalization at l = m:
    // N_m^m^2 = (2m+1) / (4π * (2m)!). Use log((2m)!) so the
    // CPU path remains a stable oracle for the f32 WGSL mirror at high m.
    let logFactorial2m = 0;
    for (let i = 1; i <= 2 * m; i++) logFactorial2m += Math.log(i);
    let norm2 = Math.exp(Math.log(2 * m + 1) - LOG_4PI - logFactorial2m);

    // ── Upward recurrence in l for fixed m ──
    let plm_prev = 0;     // P_{m-1}^m = 0 (doesn't exist)
    let plm_curr = pmm;   // P_m^m

    for (let l = m; l <= lMax; l++) {
      // Advance Legendre and fac for l > m
      if (l > m) {
        // P_l^m = [(2l−1)·cosT·P_{l−1}^m − (l+m−1)·P_{l−2}^m] / (l−m)
        const plm_next =
          ((2 * l - 1) * cosT * plm_curr - (l + m - 1) * plm_prev) /
          (l - m);
        plm_prev = plm_curr;
        plm_curr = plm_next;

        // N_l^m^2 / N_{l-1}^m^2 = ((2l+1)/(2l-1)) * ((l-m)/(l+m))
        norm2 *= ((2 * l + 1) / (2 * l - 1)) * ((l - m) / (l + m));
      }

      // No l = 0 modes in the coefficient array
      if (l < 1) continue;

      // N_l^m = sqrt(norm2)
      const norm = Math.sqrt(norm2);

      if (m === 0) {
        // Y_l^0 = N · P_l^0
        const idx = l * l + l - 1;
        delta += coeffs[idx].c * norm * plm_curr;
      } else {
        // Both +m and −m share the same P_l^m and norm
        const nPlm = norm * plm_curr * SQRT2;
        // Y_l^{+m} = N · P_l^m · √2 · cos(mφ)
        const idxPos = l * l + l + m - 1;
        delta += coeffs[idxPos].c * nPlm * cosMPhi;
        // Y_l^{−m} = N · P_l^m · √2 · sin(mφ)
        const idxNeg = l * l + l - m - 1;
        delta += coeffs[idxNeg].c * nPlm * sinMPhi;
      }
    }
  }

  return delta;
}
