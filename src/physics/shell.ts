/**
 * shell.ts — Infalling comoving fluid elements.
 *
 * Provides two abstractions for sampling the S² bounce hypersurface:
 *
 * ── StreamEmitter (preferred) ─────────────────────────────────────────────
 *   Models the collapsing fluid as a continuous Poisson stream.  Each call
 *   to emit() produces exactly one particle whose arrival time is
 *
 *     τ_arrive = now + sens · β · δ(θ,φ) · timeDilation
 *
 *   where δ is sampled from the current spherical-harmonic perturbation
 *   field.  Because no batching occurs the simulation is free of the
 *   discrete shell cadence; the only discretisation is the per-frame dt.
 *
 * ── InfallingShell (legacy, kept for reference) ───────────────────────────
 *   Batch approach: constructs N particles at once, sorts by arrival time,
 *   and drains them via a cursor.  Retained in case a batch interface is
 *   ever needed again.
 *
 * Visual encoding (shared by both):
 *   - Hue: w_eff (effective equation of state, amber→violet)
 *       Spin-fluid convention: w = (ā² − 3β)/(3(ā² − β))
 *       Always < −1/3 at bounce → acceleration (violet = deep repulsive)
 *       Approaches 1/3 (radiation) at low density (amber)
 *   - Brightness: ε at bounce (energy density, 1/a_min⁴)
 *   - Size: ä at bounce (bounce kick acceleration)
 *   - Tail direction: random (no preferred motion on S²)
 */

import { ECSKPhysics } from "./ecsk-physics.js";
import {
  generatePerturbCoeffs,
  evaluatePerturbation,
  evolveCoeffs,
  rescaleCoeffSigmas,
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

// ── Log-scale brightness reference (shared with InfallingShell) ──────────
// Anchored at eps = 10 000 (≡ a_min = 0.1).
const EPS_LOG_REF = Math.log(10001);

/** A single particle ready to be added to the hit buffer. */
export interface PendingParticle {
  lx: number;
  ly: number;
  arrivalTime: number;
  hue: number;
  brightness: number;
  hitSize: number;
  tailAngle: number;
}

/**
 * StreamEmitter — continuous Poisson stream of infalling fluid elements.
 *
 * Instead of spawning N particles at once, the emitter is ticked each
 * frame with a fractional accumulator.  Each tick it:
 *
 *   1. Adds dt × particleRate to an accumulator.
 *   2. For each whole count in the accumulator, samples one particle on S²
 *      and computes its arrivalTime = now + sens·β·δ·timeDilation.
 *   3. Returns the batch of pending particles; the arrival times are
 *      already in the future so they dribble into the hit buffer over the
 *      next few seconds just like the old batch cursor did — but without
 *      the coarse shell cadence.
 *
 * The perturbation field is regenerated whenever lMax changes so the
 * angular structure remains coherent within a session.
 */
export class StreamEmitter {
  private physics: ECSKPhysics;
  private perturbAmplitude: number;
  private lMax: number;
  private timeDilation: number;
  private fieldEvolution: number; // O-U mean-reversion rate (1/s)

  private rng: () => number;
  private coeffs: ReturnType<typeof generatePerturbCoeffs>;
  private accumulator = 0;
  private seed: number;
  private _lastLMax: number;
  private _lastAmplitude: number;

  constructor(
    physics: ECSKPhysics,
    perturbAmplitude: number,
    lMax: number,
    timeDilation: number,
    seed: number,
    fieldEvolution = 0.1,
  ) {
    this.physics = physics;
    this.perturbAmplitude = perturbAmplitude;
    this.lMax = lMax;
    this.timeDilation = timeDilation;
    this.fieldEvolution = fieldEvolution;
    this.seed = seed;
    this._lastLMax = lMax;
    this._lastAmplitude = perturbAmplitude;
    this.rng = splitmix32(seed);
    this.coeffs = generatePerturbCoeffs(lMax, perturbAmplitude, this.rng);
  }

  /** Update mutable simulation parameters without reconstructing. */
  update(
    physics: ECSKPhysics,
    perturbAmplitude: number,
    lMax: number,
    timeDilation: number,
    fieldEvolution: number,
  ) {
    this.physics = physics;
    this.timeDilation = timeDilation;
    this.fieldEvolution = fieldEvolution;

    // Regenerate perturbation field only if turbulence order changed
    if (lMax !== this._lastLMax) {
      this.lMax = lMax;
      this._lastLMax = lMax;
      this._lastAmplitude = perturbAmplitude;
      this.perturbAmplitude = perturbAmplitude;
      this.rng = splitmix32(this.seed ^ (lMax * 6271));
      this.coeffs = generatePerturbCoeffs(lMax, perturbAmplitude, this.rng);
    } else if (perturbAmplitude !== this._lastAmplitude) {
      // Amplitude changed: rescale O-U sigma targets so the stationary
      // distribution tracks the new amplitude; existing coefficients drift
      // toward the new scale naturally.
      this.perturbAmplitude = perturbAmplitude;
      this._lastAmplitude = perturbAmplitude;
      rescaleCoeffSigmas(this.coeffs, this.lMax, perturbAmplitude);
    }
  }

  /**
   * Tick the emitter for one frame.
   *
   * @param dt          Frame duration in seconds.
   * @param now         Current wall-clock simulation time (seconds).
   * @param particleRate Target particles per second.
   * @returns Array of particles whose arrivalTime is in the future.
   */
  tick(dt: number, now: number, particleRate: number): PendingParticle[] {
    // Evolve the perturbation field (O-U random walk) before sampling
    evolveCoeffs(this.coeffs, dt, this.fieldEvolution, this.rng);

    this.accumulator += dt * particleRate;
    const count = Math.floor(this.accumulator);
    this.accumulator -= count;

    if (count === 0) return [];

    const sens = this.physics.sensitivity();
    const result: PendingParticle[] = [];

    // Per-particle min/max for hit-size normalisation within this batch.
    // We accumulate raw acc values first, then normalise.
    const lxBuf = new Float32Array(count);
    const lyBuf = new Float32Array(count);
    const tBuf  = new Float32Array(count);
    const hueBuf = new Float32Array(count);
    const briBuf = new Float32Array(count);
    const accBuf = new Float32Array(count);
    const tailBuf = new Float32Array(count);

    let minAcc = Infinity, maxAcc = 0;
    let minW = 0, maxW = -Infinity;
    const wBuf = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const theta = Math.acos(1 - 2 * this.rng());
      const phi   = 2 * Math.PI * this.rng();
      const cosT  = Math.cos(theta);
      const sinT  = Math.sin(theta);

      lxBuf[i] = 2 * Math.sin(theta / 2) * Math.cos(phi);
      lyBuf[i] = 2 * Math.sin(theta / 2) * Math.sin(phi);
      tailBuf[i] = this.rng() * 6.2832;

      const delta   = evaluatePerturbation(this.coeffs, cosT, sinT, phi);
      const betaEff = this.physics.beta * (1 + delta);
      const props   = this.physics.bounceProps(betaEff);

      // Arrival time relative to now — clamped to prevent pathological
      // delays when sensitivity diverges near β → 1/4.
      const rawDelay = sens * (betaEff - this.physics.beta) * this.timeDilation;
      const MAX_DELAY = 8.0;
      tBuf[i] = now + Math.max(-MAX_DELAY, Math.min(rawDelay, MAX_DELAY));

      accBuf[i] = props.acc;
      wBuf[i]   = props.wEff;

      briBuf[i] = Math.min(1.0, Math.max(0.15,
        Math.log(props.eps + 1) / EPS_LOG_REF,
      ));

      if (props.acc < minAcc) minAcc = props.acc;
      if (props.acc > maxAcc) maxAcc = props.acc;
      if (props.wEff < minW) minW = props.wEff;
      if (props.wEff > maxW) maxW = props.wEff;
    }

    const accR = maxAcc - minAcc || 1;
    const wR   = minW - maxW   || 1;

    for (let i = 0; i < count; i++) {
      hueBuf[i] = 25 + ((wBuf[i] - maxW) / wR) * 245;
      result.push({
        lx:          lxBuf[i],
        ly:          lyBuf[i],
        arrivalTime: tBuf[i],
        hue:         hueBuf[i],
        brightness:  briBuf[i],
        hitSize:     0.5 + (accBuf[i] - minAcc) / accR,
        tailAngle:   tailBuf[i],
      });
    }

    return result;
  }
}

/**
 * InfallingShell — legacy batch approach (kept for reference).
 *
 * Constructs N particles at once, sorts by arrival time, and drains
 * them via a cursor. No longer used by the main loop (replaced by
 * StreamEmitter) but retained in case a batch interface is needed.
 */
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
    const accR = maxAcc - minAcc || 1;
    const wR = minW - maxW || 1;

    // Fixed global log-scale reference anchored at eps = 10 000
    // (≡ a_min = 0.1, a mid-range physical energy density).
    // This is independent of the current β so that:
    //   • strong-torsion shells (large β, gentle bounce, low eps) appear dim
    //   • weak-torsion shells (small β, hard crunch, high eps) appear bright
    //
    // log(eps + 1) / log(10001) maps approx:
    //   β = 0.20 → eps ≈ 13  → brightness ≈ 0.29
    //   β = 0.10 → eps ≈ 79  → brightness ≈ 0.48
    //   β = 0.05 → eps ≈ 254 → brightness ≈ 0.60
    //   β ≪ 0.01 → eps → ∞   → brightness → 1.0 (clamped)
    const EPS_LOG_REF = Math.log(10001); // log(1 / 0.1⁴ + 1)

    for (let i = 0; i < size; i++) {
      // Hue: w_eff maps from amber (25°) → violet (270°)
      // Higher w_eff (mild torsion) → amber
      // Lower w_eff (deep repulsive) → violet
      this.hue[i] = 25 + ((wArr[i] - maxW) / wR) * 245;

      // Brightness: absolute log-scale energy density at bounce.
      // Clamp to [0.15, 1.0] so no hit disappears entirely.
      this.brightness[i] = Math.min(1.0, Math.max(0.15,
        Math.log(epsArr[i] + 1) / EPS_LOG_REF,
      ));

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
