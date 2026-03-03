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
 * Spectral index: n_s = 0.965 (Planck 2018)
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

export interface PerturbMode {
  l: number;
  m: number;
  c: number; // coefficient
}

/**
 * Generate perturbation coefficients with nearly scale-invariant spectrum.
 *
 * Power spectrum: C_l ∝ l^(n_s − 1) × exp(−(l/l_silk)²)
 *   - n_s = 0.965 (Planck 2018 scalar spectral index)
 *   - l_silk = 0.6 × lMax (Silk damping scale)
 *
 * Each (l, m) mode gets a random coefficient ~ modeAmp × uniform(−1, 1).
 */
export function generatePerturbCoeffs(
  lMax: number,
  amplitude: number,
  rng: () => number,
): PerturbMode[] {
  const ns = 0.965;
  const lSilk = Math.max(2, lMax * 0.6);
  const coeffs: PerturbMode[] = [];

  for (let l = 1; l <= lMax; l++) {
    const Cl =
      Math.pow(l, ns - 1) * Math.exp(-(l * l) / (lSilk * lSilk));
    const modeAmp = amplitude * Math.sqrt(Cl);

    for (let m = -l; m <= l; m++) {
      coeffs.push({ l, m, c: (rng() * 2 - 1) * modeAmp });
    }
  }

  return coeffs;
}

/**
 * Evaluate the perturbation field δ(θ, φ) at a single point.
 *
 * δ = Σ c_lm × Y_lm(θ, φ)
 *
 * Returns a dimensionless perturbation value (typically |δ| ≪ 1).
 */
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
