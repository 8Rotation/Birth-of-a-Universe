/**
 * shell.ts — Infalling shell of comoving fluid elements.
 *
 * Each shell represents a batch of particles that are crossing the
 * bounce hypersurface. On construction, the shell:
 *
 *   1. Samples N uniform points on S² (the 2-sphere)
 *   2. Projects them via Lambert equal-area to a 2D disk
 *   3. Evaluates the spherical harmonic perturbation field δ(θ,φ)
 *   4. Computes per-particle bounce properties from β_eff = β(1+δ)
 *   5. Determines arrival times (when each element "lights up")
 *   6. Sorts by arrival time for efficient cursor-based processing
 *
 * The arrival time encodes when each fluid element reaches its local
 * bounce, creating the structured patterns (dipole, quadrupole, etc.)
 * that make the visualization physically meaningful.
 *
 * Visual encoding:
 *   - Hue: w_eff (effective equation of state, amber→violet)
 *   - Brightness: ε at bounce (energy density, 1/a_min⁴)
 *   - Size: ä at bounce (bounce kick acceleration)
 *   - Tail direction: random (no preferred motion on S²)
 */

import { ECSKPhysics } from "./ecsk-physics.js";
import {
  generatePerturbCoeffs,
  evaluatePerturbation,
  splitmix32,
} from "./perturbation.js";

/**
 * Reorder a Float32Array by an index permutation.
 */
function reorderF32(arr: Float32Array, idx: Uint32Array): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < idx.length; i++) out[i] = arr[idx[i]];
  return out;
}

export class InfallingShell {
  readonly size: number;

  // Per-particle arrays (sorted by arrival time after construction)
  lx: Float32Array;
  ly: Float32Array;
  arrivalTime: Float32Array;
  hue: Float32Array;
  brightness: Float32Array;
  hitSize: Float32Array;
  tailAngle: Float32Array;

  /** Cursor into sorted arrival times — advanced by main loop. */
  cursor = 0;

  constructor(
    size: number,
    physics: ECSKPhysics,
    perturbAmplitude: number,
    lMax: number,
    timeDilation: number,
    batchSeed: number,
    birthTime: number,
  ) {
    this.size = size;
    const rng = splitmix32(batchSeed);

    // Generate perturbation coefficients for this shell
    const coeffs = generatePerturbCoeffs(lMax, perturbAmplitude, rng);
    const sens = physics.sensitivity();

    // Allocate per-particle arrays
    this.lx = new Float32Array(size);
    this.ly = new Float32Array(size);
    this.arrivalTime = new Float32Array(size);
    this.hue = new Float32Array(size);
    this.brightness = new Float32Array(size);
    this.hitSize = new Float32Array(size);
    this.tailAngle = new Float32Array(size);

    // Temporary arrays for normalization
    let minEps = Infinity,
      maxEps = 0;
    let minAcc = Infinity,
      maxAcc = 0;
    let minW = 0,
      maxW = -Infinity;
    const epsArr = new Float32Array(size);
    const accArr = new Float32Array(size);
    const wArr = new Float32Array(size);

    for (let i = 0; i < size; i++) {
      // ── Sample uniform point on S² ────────────────────────────────
      const theta = Math.acos(1 - 2 * rng()); // colatitude [0, π]
      const phi = 2 * Math.PI * rng(); // azimuth [0, 2π]
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      // ── Lambert equal-area projection (S² → disk radius 2) ────────
      // r = 2 sin(θ/2), x = r cos(φ), y = r sin(φ)
      // Preserves density statistics (equal area ↔ uniform distribution)
      this.lx[i] = 2 * Math.sin(theta / 2) * Math.cos(phi);
      this.ly[i] = 2 * Math.sin(theta / 2) * Math.sin(phi);
      this.tailAngle[i] = rng() * 6.2832;

      // ── Perturbation: δ(θ,φ) → β_eff = β(1+δ) ────────────────────
      const delta = evaluatePerturbation(coeffs, cosT, sinT, phi);
      const betaEff = physics.beta * (1 + delta);

      // ── Bounce properties for this fluid element ───────────────────
      const props = physics.bounceProps(betaEff);
      epsArr[i] = props.eps;
      accArr[i] = props.acc;
      wArr[i] = props.wEff;

      if (props.eps < minEps) minEps = props.eps;
      if (props.eps > maxEps) maxEps = props.eps;
      if (props.acc < minAcc) minAcc = props.acc;
      if (props.acc > maxAcc) maxAcc = props.acc;
      if (props.wEff < minW) minW = props.wEff;
      if (props.wEff > maxW) maxW = props.wEff;

      // ── Arrival time: birth + bounce time offset ───────────────────
      // sens = dT/dβ, so δτ ≈ sens × δβ = sens × β × δ
      // timeDilation stretches the offset for visual clarity
      this.arrivalTime[i] =
        birthTime + sens * (betaEff - physics.beta) * timeDilation;
    }

    // ── Shift so earliest arrival is shortly after birth ─────────────
    let minArr = this.arrivalTime[0];
    for (let i = 1; i < size; i++) {
      if (this.arrivalTime[i] < minArr) minArr = this.arrivalTime[i];
    }
    const shift = birthTime + 0.15 - minArr;
    for (let i = 0; i < size; i++) this.arrivalTime[i] += shift;

    // ── Normalize visual properties to 0-1 range ─────────────────────
    const epsR = maxEps - minEps || 1;
    const accR = maxAcc - minAcc || 1;
    const wR = minW - maxW || 1;

    for (let i = 0; i < size; i++) {
      // Hue: w_eff maps from amber (25°) → violet (270°)
      // Higher w_eff (mild torsion) → amber
      // Lower w_eff (deep repulsive) → violet
      this.hue[i] = 25 + ((wArr[i] - maxW) / wR) * 245;

      // Brightness: energy density at bounce (higher = brighter)
      this.brightness[i] = 0.3 + 0.7 * (epsArr[i] - minEps) / epsR;

      // Hit size: bounce kick acceleration (larger kick = bigger)
      this.hitSize[i] = 0.5 + (accArr[i] - minAcc) / accR;
    }

    // ── Sort by arrival time for O(1) cursor-based processing ────────
    const idx = new Uint32Array(size);
    for (let i = 0; i < size; i++) idx[i] = i;
    idx.sort((a, b) => this.arrivalTime[a] - this.arrivalTime[b]);

    this.lx = reorderF32(this.lx, idx);
    this.ly = reorderF32(this.ly, idx);
    this.arrivalTime = reorderF32(this.arrivalTime, idx);
    this.hue = reorderF32(this.hue, idx);
    this.brightness = reorderF32(this.brightness, idx);
    this.hitSize = reorderF32(this.hitSize, idx);
    this.tailAngle = reorderF32(this.tailAngle, idx);
  }
}
