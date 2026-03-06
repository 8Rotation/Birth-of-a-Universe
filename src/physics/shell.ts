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
  DEFAULT_SILK_DAMPING,
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
// ── Visual encoding defaults (now configurable via EmitterConfig) ─────────

const DEF_HUE_MIN = 25;
const DEF_HUE_RANGE = 245;
const DEF_BRIGHTNESS_FLOOR = 0.15;
const DEF_BRIGHTNESS_CEIL = 1.0;
/** Base offset for hit-size normalisation (0–1 range). */
const HIT_SIZE_BASE = 0.5;

// ── Arrival-time delay clamping ───────────────────────────────────────────

/** Minimum MAX_DELAY (seconds) — prevents structure crush at low TD. */
const MAX_DELAY_FLOOR = 8.0;
/** Maximum MAX_DELAY (seconds) — cap to prevent divergence near β → 1/4. */
const MAX_DELAY_CEIL = 300.0;
/** Multiplier on naturalSpread for MAX_DELAY scaling. */
const NATURAL_SPREAD_MULT = 1.5;

// ── Double-bounce visual modulation (Cubero & Popławski 2019 §26) ───────

/**
 * Normalisation constant for double-bounce visual period.
 * Calibrated so default parameters (β=0.10, TD=120) give ~2.5 s period.
 * NORM = fullPeriod(0.10) × 120 / 2.5 ≈ 645
 */
const DB_VIS_NORM = 645;
/** Minimum visual period (seconds) to prevent imperceptible flicker. */
const DB_VIS_PERIOD_FLOOR = 0.3;
/** Floor for the cos² rate-modulation envelope (avoids total silence). */
const DB_MOD_FLOOR = 0.05;
/** Mean of max(0, cos²(2x)) over one period — used to normalise rate. */
const DB_MOD_MEAN = 0.375;
// Double-bounce defaults (now configurable via EmitterConfig)
const DEF_DB_SECOND_HUE_SHIFT = 15;
const DEF_DB_SECOND_BRI_SCALE = 0.82;

// ── Particle production visual encoding (Popławski 2014; 2021) ────────

/** Maximum ppStrength fraction (caps production-particle count). */
const PP_FRACTION_CAP = 3.0;
/** Maximum brightness for production particles (higher than bounce). */
const PP_BRIGHTNESS_CEIL = 1.5;
/** Scatter bias: shifts mean scatter slightly earlier (negative = earlier). */
const PP_SCATTER_BIAS = -0.6;

// Production defaults (now configurable via EmitterConfig)
const DEF_PP_HUE_SHIFT = 60;
const DEF_PP_BRI_BOOST = 1.3;
const DEF_PP_SIZE_SCALE = 0.7;
const DEF_PP_BASE_DELAY = 1.5;
const DEF_PP_SCATTER_RANGE = 1.0;
// ── Emitter configuration ───────────────────────────────────────────────

/** All tunable parameters passed from the UI to the StreamEmitter. */
export interface EmitterConfig {
  // Core physics
  perturbAmplitude: number;
  lMax: number;
  nS: number;
  timeDilation: number;
  fieldEvolution: number;
  doubleBounce: boolean;
  betaPP: number;
  // Silk damping
  silkDamping: number;
  // Colour encoding
  hueMin: number;
  hueRange: number;
  brightnessFloor: number;
  brightnessCeil: number;
  // Double-bounce visual tuning
  dbSecondHueShift: number;
  dbSecondBriScale: number;
  // Production visual tuning
  ppHueShift: number;
  ppBriBoost: number;
  ppSizeScale: number;
  ppBaseDelay: number;
  ppScatterRange: number;
}

/** Build an EmitterConfig with defaults for any missing fields. */
export function defaultEmitterConfig(partial: Partial<EmitterConfig> = {}): EmitterConfig {
  return {
    perturbAmplitude: partial.perturbAmplitude ?? 0.12,
    lMax:             partial.lMax ?? 8,
    nS:               partial.nS ?? 0.965,
    timeDilation:     partial.timeDilation ?? 120,
    fieldEvolution:   partial.fieldEvolution ?? 0.1,
    doubleBounce:     partial.doubleBounce ?? false,
    betaPP:           partial.betaPP ?? 0,
    silkDamping:      partial.silkDamping ?? DEFAULT_SILK_DAMPING,
    hueMin:           partial.hueMin ?? DEF_HUE_MIN,
    hueRange:         partial.hueRange ?? DEF_HUE_RANGE,
    brightnessFloor:  partial.brightnessFloor ?? DEF_BRIGHTNESS_FLOOR,
    brightnessCeil:   partial.brightnessCeil ?? DEF_BRIGHTNESS_CEIL,
    dbSecondHueShift: partial.dbSecondHueShift ?? DEF_DB_SECOND_HUE_SHIFT,
    dbSecondBriScale: partial.dbSecondBriScale ?? DEF_DB_SECOND_BRI_SCALE,
    ppHueShift:       partial.ppHueShift ?? DEF_PP_HUE_SHIFT,
    ppBriBoost:       partial.ppBriBoost ?? DEF_PP_BRI_BOOST,
    ppSizeScale:      partial.ppSizeScale ?? DEF_PP_SIZE_SCALE,
    ppBaseDelay:      partial.ppBaseDelay ?? DEF_PP_BASE_DELAY,
    ppScatterRange:   partial.ppScatterRange ?? DEF_PP_SCATTER_RANGE,
  };
}

/** A single particle ready to be added to the hit buffer. */
export interface PendingParticle {
  lx: number;
  ly: number;
  arrivalTime: number;
  hue: number;
  brightness: number;
  /** Raw energy density at bounce: eps = 1/a_min⁴ (for HDR nits mapping). */
  eps: number;
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
  private cfg: EmitterConfig;

  private rng: () => number;
  private coeffs: ReturnType<typeof generatePerturbCoeffs>;
  private accumulator = 0;
  private seed: number;
  private _lastLMax: number;
  private _lastAmplitude: number;
  private _lastNS: number;
  private _lastSilkDamping: number;

  /**
   * Phase accumulator for double-bounce rate modulation.
   * Incremented by dt/visualPeriod each tick; wraps at 1.0.
   * Using an accumulator (rather than simTime % period) avoids
   * phase jumps when timeDilation or β change the visual period.
   */
  private _dbPhase = 0;

  constructor(
    physics: ECSKPhysics,
    config: Partial<EmitterConfig>,
    seed: number,
  ) {
    this.physics = physics;
    this.cfg = defaultEmitterConfig(config);
    this.seed = seed;
    this._lastLMax = this.cfg.lMax;
    this._lastAmplitude = this.cfg.perturbAmplitude;
    this._lastNS = this.cfg.nS;
    this._lastSilkDamping = this.cfg.silkDamping;
    this.rng = splitmix32(seed);
    this.coeffs = generatePerturbCoeffs(
      this.cfg.lMax, this.cfg.perturbAmplitude, this.rng,
      this.cfg.nS, this.cfg.silkDamping,
    );
  }

  /** Update mutable simulation parameters without reconstructing. */
  update(
    physics: ECSKPhysics,
    config: Partial<EmitterConfig>,
  ) {
    this.physics = physics;
    // Merge incoming config over current
    const c = this.cfg;
    if (config.timeDilation     !== undefined) c.timeDilation     = config.timeDilation;
    if (config.fieldEvolution   !== undefined) c.fieldEvolution   = config.fieldEvolution;
    if (config.doubleBounce     !== undefined) c.doubleBounce     = config.doubleBounce;
    if (config.betaPP           !== undefined) c.betaPP           = config.betaPP;
    if (config.hueMin           !== undefined) c.hueMin           = config.hueMin;
    if (config.hueRange         !== undefined) c.hueRange         = config.hueRange;
    if (config.brightnessFloor  !== undefined) c.brightnessFloor  = config.brightnessFloor;
    if (config.brightnessCeil   !== undefined) c.brightnessCeil   = config.brightnessCeil;
    if (config.dbSecondHueShift !== undefined) c.dbSecondHueShift = config.dbSecondHueShift;
    if (config.dbSecondBriScale !== undefined) c.dbSecondBriScale = config.dbSecondBriScale;
    if (config.ppHueShift       !== undefined) c.ppHueShift       = config.ppHueShift;
    if (config.ppBriBoost       !== undefined) c.ppBriBoost       = config.ppBriBoost;
    if (config.ppSizeScale      !== undefined) c.ppSizeScale      = config.ppSizeScale;
    if (config.ppBaseDelay      !== undefined) c.ppBaseDelay      = config.ppBaseDelay;
    if (config.ppScatterRange   !== undefined) c.ppScatterRange   = config.ppScatterRange;
    if (config.silkDamping      !== undefined) c.silkDamping      = config.silkDamping;

    const lMax = config.lMax ?? c.lMax;
    const nS   = config.nS   ?? c.nS;
    const perturbAmplitude = config.perturbAmplitude ?? c.perturbAmplitude;

    // Regenerate perturbation field if turbulence order, spectral index, or silk damping changed
    if (lMax !== this._lastLMax || nS !== this._lastNS || c.silkDamping !== this._lastSilkDamping) {
      c.lMax = lMax;
      c.nS = nS;
      c.perturbAmplitude = perturbAmplitude;
      this._lastLMax = lMax;
      this._lastNS = nS;
      this._lastAmplitude = perturbAmplitude;
      this._lastSilkDamping = c.silkDamping;
      this.rng = splitmix32(this.seed ^ (lMax * 6271));
      this.coeffs = generatePerturbCoeffs(
        lMax, perturbAmplitude, this.rng, nS, c.silkDamping,
      );
    } else if (perturbAmplitude !== this._lastAmplitude) {
      // Amplitude changed: rescale O-U sigma targets so the stationary
      // distribution tracks the new amplitude; existing coefficients drift
      // toward the new scale naturally.
      c.perturbAmplitude = perturbAmplitude;
      this._lastAmplitude = perturbAmplitude;
      rescaleCoeffSigmas(this.coeffs, c.lMax, perturbAmplitude, nS, c.silkDamping);
    } else {
      c.lMax = lMax;
      c.nS = nS;
      c.perturbAmplitude = perturbAmplitude;
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
    const c = this.cfg;
    // Evolve the perturbation field (O-U random walk) before sampling
    evolveCoeffs(this.coeffs, dt, c.fieldEvolution, this.rng);

    // ── Double-bounce rate modulation (Cubero & Popławski 2019 §26) ──
    // For k=+1 the closed universe oscillates: bounce → turnaround →
    // second bounce.  We modulate the emission rate with a two-peaked
    // cos² envelope so particles arrive in rhythmic pulses — one per
    // bounce epoch.  The visual period is pegged directly to β and
    // timeDilation:
    //
    //   P_vis = fullPeriod(β) × timeDilation / NORM
    //
    // NORM is calibrated so the default parameters (β=0.10, TD=120)
    // produce a ~2.5 s visual period.  Both factors respond naturally:
    //   - Lowering β toward 0.005: fullPeriod grows → slower pulsation
    //   - Raising β toward 0.249: fullPeriod shrinks → rapid pulsation
    //   - Increasing timeDilation: proportionally slower pulsation
    //   - Decreasing timeDilation: proportionally faster pulsation
    //
    // No ceiling clamp — if the user pushes TD to 8000 the pulse slows
    // to ~50 s, which is physically correct (they stretched time 67×).
    // Only a 0.3 s floor prevents imperceptible flicker at extreme lows.
    //
    // Phase accumulates via dt so changes to period don't cause jumps.
    let effectiveRate = particleRate;
    let dbHueShift  = 0;
    let dbBriScale  = 1.0;
    const dbActive  = c.doubleBounce && this.physics.k === 1;

    if (dbActive) {
      const fp = this.physics.fullPeriod();
      // NORM: fullPeriod(0.10) × 120 / 2.5 ≈ 645
      const visPeriod = Math.max(DB_VIS_PERIOD_FLOOR, fp * c.timeDilation / DB_VIS_NORM);
      this._dbPhase += dt / visPeriod;
      this._dbPhase %= 1.0;

      // cos²(2πφ·2) — two symmetrical peaks per period (first & second bounce)
      const cosVal = Math.cos(2 * Math.PI * 2 * this._dbPhase);
      const mod = Math.max(DB_MOD_FLOOR, cosVal > 0 ? cosVal * cosVal : 0);
      // Mean of max(0,cos²(2x)) over one period ≈ 0.375 → normalise to
      // preserve the user-set average rate.
      effectiveRate = particleRate * mod / DB_MOD_MEAN;

      // Second-bounce visual shift (phase 0.25–0.75):
      // slightly warmer hue (+15°) and dimmer brightness (×0.82)
      // to distinguish re-collapse epoch from the primary bounce.
      const isSecondBounce = this._dbPhase > 0.25 && this._dbPhase < 0.75;
      dbHueShift = isSecondBounce ? c.dbSecondHueShift : 0;
      dbBriScale = isSecondBounce ? c.dbSecondBriScale : 1.0;
    }

    this.accumulator += dt * effectiveRate;
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
    const epsBuf = new Float32Array(count);
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
      //
      // MAX_DELAY scales with the natural physics spread:
      //   natural ≈ |sens| × β × perturbAmplitude × timeDilation
      // Clamped to [8, 300] so it's never too tight (small TD) or
      // absurdly large (β → 1/4 divergence).  This ensures the
      // perturbation structure isn't crushed at high timeDilation.
      const rawDelay = sens * (betaEff - this.physics.beta) * c.timeDilation;
      const naturalSpread = Math.abs(sens) * this.physics.beta * c.perturbAmplitude * c.timeDilation;
      const MAX_DELAY = Math.min(Math.max(MAX_DELAY_FLOOR, naturalSpread * NATURAL_SPREAD_MULT), MAX_DELAY_CEIL);
      tBuf[i] = now + Math.max(-MAX_DELAY, Math.min(rawDelay, MAX_DELAY));

      accBuf[i] = props.acc;
      wBuf[i]   = props.wEff;

      epsBuf[i] = props.eps;
      briBuf[i] = Math.min(c.brightnessCeil, Math.max(c.brightnessFloor,
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
      // Apply double-bounce visual shift: second-bounce epoch has warmer
      // hue and slightly dimmer brightness (Cubero & Popławski 2019 §26).
      const hueMax = c.hueMin + c.hueRange;
      hueBuf[i] = Math.min(hueMax, c.hueMin + ((wBuf[i] - maxW) / wR) * c.hueRange + dbHueShift);
      const bri = briBuf[i] * dbBriScale;
      result.push({
        lx:          lxBuf[i],
        ly:          lyBuf[i],
        arrivalTime: tBuf[i],
        hue:         hueBuf[i],
        brightness:  bri,
        eps:         epsBuf[i] * dbBriScale,
        hitSize:     HIT_SIZE_BASE + (accBuf[i] - minAcc) / accR,
        tailAngle:   tailBuf[i],
      });
    }

    // ── Particle production (Popławski 2014 eq. 40–46; 2021 eq. 8) ────
    // Post-bounce fermion creation at rate ṅ_f + 3Hn_f = β_pp H⁴.
    // β_cr ≈ 1/929 is the critical rate above which production sustains
    // indefinite expansion (inflation).  Visually: a second surge of
    // particles with higher-energy colors arriving after the bounce wave.
    //
    // Production fraction = β_pp / β_cr  (capped at 3.0):
    //   0  → no production particles (feature off)
    //   1  → equal production and bounce particles (critical threshold)
    //   >1 → production-dominated (inflationary regime)
    //
    // Delay: production particles arrive after the bounce wave with an
    // offset proportional to the bounce wave's naturalSpread.  Temporal
    // scatter widens from subcritical (tight burst) to supercritical
    // (sustained creation, representing inflation onset).
    //
    // Visual encoding:
    //   Hue:        +PP_HUE_SHIFT toward violet (higher creation T)
    //   Brightness: ×PP_BRI_BOOST (hot creation epoch)
    //   Size:       ×PP_SIZE_SCALE (individual fermion creation)
    if (c.betaPP > 0) {
      const ppStrength = c.betaPP / ECSKPhysics.BETA_CR;
      const ppFraction = Math.min(PP_FRACTION_CAP, ppStrength);
      const ppCount = Math.max(0, Math.floor(count * ppFraction));

      if (ppCount > 0) {
        // Wider MAX_DELAY for production (arrives later than bounce)
        const ppMaxDelay = c.ppBaseDelay + c.ppScatterRange + 2.0;

        // Per-particle buffers
        const ppLxB   = new Float32Array(ppCount);
        const ppLyB   = new Float32Array(ppCount);
        const ppTB    = new Float32Array(ppCount);
        const ppAccB  = new Float32Array(ppCount);
        const ppWB    = new Float32Array(ppCount);
        const ppEpsB  = new Float32Array(ppCount);
        const ppBriB  = new Float32Array(ppCount);
        const ppTailB = new Float32Array(ppCount);

        let ppMinAcc = Infinity, ppMaxAcc = 0;
        let ppMinW = 0, ppMaxW = -Infinity;

        for (let i = 0; i < ppCount; i++) {
          const theta = Math.acos(1 - 2 * this.rng());
          const phi   = 2 * Math.PI * this.rng();
          const cosT  = Math.cos(theta);
          const sinT  = Math.sin(theta);

          ppLxB[i]   = 2 * Math.sin(theta / 2) * Math.cos(phi);
          ppLyB[i]   = 2 * Math.sin(theta / 2) * Math.sin(phi);
          ppTailB[i] = this.rng() * 6.2832;

          const delta   = evaluatePerturbation(this.coeffs, cosT, sinT, phi);
          const betaEff = this.physics.beta * (1 + delta);
          const ppProps = this.physics.productionProps(betaEff, c.betaPP);

          // Arrival = bounce perturbation delay + fixed production offset
          // + small scatter.  The perturbation delay (rawDelay) preserves
          // the spatial wavefront structure; the fixed offset separates
          // the production wave visually from the bounce wave.
          const rawDelay = sens
            * (betaEff - this.physics.beta) * c.timeDilation;
          const scatter  = c.ppScatterRange * (this.rng() * 2 + PP_SCATTER_BIAS);
          const totalDelay = rawDelay + c.ppBaseDelay + scatter;
          ppTB[i] = now
            + Math.max(-ppMaxDelay, Math.min(totalDelay, ppMaxDelay));

          ppAccB[i] = ppProps.acc;
          ppWB[i]   = ppProps.wEff;
          ppEpsB[i] = ppProps.eps;
          ppBriB[i] = Math.min(PP_BRIGHTNESS_CEIL, Math.max(c.brightnessFloor,
            Math.log(ppProps.eps + 1) / EPS_LOG_REF,
          ) * c.ppBriBoost);

          if (ppProps.acc < ppMinAcc) ppMinAcc = ppProps.acc;
          if (ppProps.acc > ppMaxAcc) ppMaxAcc = ppProps.acc;
          if (ppProps.wEff < ppMinW)  ppMinW  = ppProps.wEff;
          if (ppProps.wEff > ppMaxW)  ppMaxW  = ppProps.wEff;
        }

        const ppAccR = ppMaxAcc - ppMinAcc || 1;
        const ppWR   = ppMinW  - ppMaxW    || 1;

        const ppHueMax = c.hueMin + c.hueRange;
        for (let i = 0; i < ppCount; i++) {
          const baseHue = c.hueMin + ((ppWB[i] - ppMaxW) / ppWR) * c.hueRange;
          result.push({
            lx:          ppLxB[i],
            ly:          ppLyB[i],
            arrivalTime: ppTB[i],
            hue:         Math.min(ppHueMax, baseHue + c.ppHueShift + dbHueShift),
            brightness:  ppBriB[i] * dbBriScale,
            eps:         ppEpsB[i] * dbBriScale,
            hitSize:     (HIT_SIZE_BASE + (ppAccB[i] - ppMinAcc) / ppAccR) * c.ppSizeScale,
            tailAngle:   ppTailB[i],
          });
        }
      }
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

    for (let i = 0; i < size; i++) {
      // Hue: w_eff maps from amber (25°) → violet (270°)
      // Higher w_eff (mild torsion) → amber
      // Lower w_eff (deep repulsive) → violet
      this.hue[i] = DEF_HUE_MIN + ((wArr[i] - maxW) / wR) * DEF_HUE_RANGE;

      // Brightness: absolute log-scale energy density at bounce.
      // Clamp to [BRIGHTNESS_FLOOR, BRIGHTNESS_CEIL] so no hit disappears entirely.
      this.brightness[i] = Math.min(DEF_BRIGHTNESS_CEIL, Math.max(DEF_BRIGHTNESS_FLOOR,
        Math.log(epsArr[i] + 1) / EPS_LOG_REF,
      ));

      // Hit size: bounce kick acceleration (larger kick = bigger)
      this.hitSize[i] = HIT_SIZE_BASE + (accArr[i] - minAcc) / accR;
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
