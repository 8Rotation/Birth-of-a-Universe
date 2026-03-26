/**
 * shell.ts — Infalling comoving fluid elements.
 *
 * Provides the StreamEmitter for sampling the S² bounce hypersurface.
 *
 * ── StreamEmitter ─────────────────────────────────────────────────────────
 *   Models the collapsing fluid as a continuous Poisson stream.  Each call
 *   to emit() produces exactly one particle whose arrival time is
 *
 *     τ_arrive = now + derived_TD · sens · β · δ(θ,φ)
 *
 *   where derived_TD = arrivalSpread / (|sens| × β × amplitude) and
 *   δ is sampled from the current spherical-harmonic perturbation
 *   field.  Because no batching occurs the simulation is free of the
 *   discrete shell cadence; the only discretisation is the per-frame dt.
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

// ── Log-scale brightness reference ───────────────────────────────────────
// Anchored at eps = 10 000 (≡ a_min = 0.1).
const EPS_LOG_REF = Math.log(10001);
// ── Visual encoding defaults (now configurable via EmitterConfig) ─────────

const DEF_HUE_MIN = 25;
const DEF_HUE_RANGE = 245;
const DEF_BRIGHTNESS_FLOOR = 0.15;
const DEF_BRIGHTNESS_CEIL = 1.0;

// ── Arrival-time delay clamping ───────────────────────────────────────────

/** Multiplier on arrivalSpread for MAX_DELAY tail room (1.5× avoids hard clip). */
const SPREAD_TAIL_MULT = 1.5;
/** Minimum denominator for TD derivation — prevents division by zero
 *  when sensitivity, beta, or amplitude is near-zero. */
const TD_DENOM_FLOOR = 1e-6;

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
  /** Arrival-time spread in seconds — directly controls the temporal
   *  window over which the perturbation pattern is projected. */
  arrivalSpread: number;
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
  // Size variation (0=uniform, 1=full physics range)
  sizeVariation: number;
}

/** Build an EmitterConfig with defaults for any missing fields. */
export function defaultEmitterConfig(partial: Partial<EmitterConfig> = {}): EmitterConfig {
  return {
    perturbAmplitude: partial.perturbAmplitude ?? 0.12,
    lMax:             partial.lMax ?? 8,
    nS:               partial.nS ?? 0.965,
    arrivalSpread:    partial.arrivalSpread ?? 1.0,
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
    sizeVariation:    partial.sizeVariation ?? 0.5,
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
 *      and computes its arrivalTime = now + derived_TD·sens·δ·β.
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
   * When true, coefficient evolution is driven externally (by the bridge)
   * and `tick()` skips the local `evolveCoeffs` call.  The bridge
   * broadcasts the authoritative `c` values each tick via `applyCoeffs()`.
   */
  private _externalCoeffs = false;

  /**
   * Phase accumulator for double-bounce rate modulation.
   * Incremented by dt/visualPeriod each tick; wraps at 1.0.
   * Using an accumulator (rather than simTime % period) avoids
   * phase jumps when arrivalSpread changes the visual period.
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

  /**
   * Apply externally-evolved perturbation coefficients.
   *
   * When the bridge drives N workers the O-U evolution runs once on the
   * main thread.  The authoritative `c` values are packed into a
   * Float64Array and sent to each worker, which calls this method to
   * overwrite its local coefficients.  This ensures all workers share
   * the same spatial structure — only the random sampling positions
   * differ (each worker has a unique PRNG seed).
   *
   * Once called, the emitter skips its own `evolveCoeffs` call in
   * `tick()` since evolution is now external.
   */
  applyCoeffs(packed: Float64Array): void {
    this._externalCoeffs = true;
    const len = Math.min(packed.length, this.coeffs.length);
    for (let i = 0; i < len; i++) {
      this.coeffs[i].c = packed[i];
    }
  }

  /** Update mutable simulation parameters without reconstructing. */
  update(
    physics: ECSKPhysics,
    config: Partial<EmitterConfig>,
  ) {
    this.physics = physics;
    // Merge incoming config over current
    const c = this.cfg;
    if (config.arrivalSpread    !== undefined) c.arrivalSpread    = config.arrivalSpread;
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
    if (config.sizeVariation    !== undefined) c.sizeVariation    = config.sizeVariation;
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
    // Evolve the perturbation field (O-U random walk) before sampling.
    // When coefficients are centrally evolved by the bridge (multi-worker
    // mode), skip local evolution — the bridge has already called
    // applyCoeffs() with the authoritative values for this tick.
    if (!this._externalCoeffs) {
      evolveCoeffs(this.coeffs, dt, c.fieldEvolution, this.rng);
    }

    // ── Double-bounce rate modulation (Cubero & Popławski 2019 §26) ──
    // For k=+1 the closed universe oscillates: bounce → turnaround →
    // second bounce.  We modulate the emission rate with a two-peaked
    // cos² envelope so particles arrive in rhythmic pulses — one per
    // bounce epoch.
    //
    // The visual period is derived from arrivalSpread: higher spread
    // stretches the pulsation proportionally.  The period relates to
    // how much of the ECSK half-period maps into the user's chosen
    // spread window:
    //
    //   TD_internal = arrivalSpread / (|sens| × β × amplitude)
    //   P_vis = fullPeriod(β) × TD_internal / NORM
    //
    // This means the pulsation rate scales naturally with the spread
    // slider: small spread → fast pulsation, large spread → slow.
    //
    // Phase accumulates via dt so changes to period don't cause jumps.
    let effectiveRate = particleRate;
    let dbHueShift  = 0;
    let dbBriScale  = 1.0;
    const dbActive  = c.doubleBounce && this.physics.k === 1;

    if (dbActive) {
      const fp = this.physics.fullPeriod();
      // Derive internal TD from arrivalSpread for the period calc
      const dbDenom = Math.max(TD_DENOM_FLOOR, Math.abs(this.physics.sensitivity()) * this.physics.beta * c.perturbAmplitude);
      const dbTD = c.arrivalSpread / dbDenom;
      const visPeriod = Math.max(DB_VIS_PERIOD_FLOOR, fp * dbTD / DB_VIS_NORM);
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

    // Global acceleration bounds for stable per-particle size normalisation.
    // Precomputed from physics (β, amplitude) so every particle gets a
    // consistent size regardless of batch composition.
    const { minAcc: globalMinAcc, maxAcc: globalMaxAcc } =
      this.physics.bounceAccRange(c.perturbAmplitude);
    const globalAccR = globalMaxAcc - globalMinAcc || 1;

    const lxBuf = new Float32Array(count);
    const lyBuf = new Float32Array(count);
    const tBuf  = new Float32Array(count);
    const hueBuf = new Float32Array(count);
    const briBuf = new Float32Array(count);
    const epsBuf = new Float32Array(count);
    const accBuf = new Float32Array(count);
    const tailBuf = new Float32Array(count);

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

      // Arrival time — derive timeDilation from the user's arrivalSpread
      // so the perturbation pattern fills exactly that many seconds:
      //   TD = spread / (|sens| × β × amplitude)
      // MAX_DELAY = spread × 1.5 for tail room (no global ceiling).
      const denom = Math.max(TD_DENOM_FLOOR, Math.abs(sens) * this.physics.beta * c.perturbAmplitude);
      const td = c.arrivalSpread / denom;
      const rawDelay = sens * (betaEff - this.physics.beta) * td;
      const MAX_DELAY = c.arrivalSpread * SPREAD_TAIL_MULT;
      tBuf[i] = now + Math.max(-MAX_DELAY, Math.min(rawDelay, MAX_DELAY));

      accBuf[i] = props.acc;
      wBuf[i]   = props.wEff;

      epsBuf[i] = props.eps;
      briBuf[i] = Math.min(c.brightnessCeil, Math.max(c.brightnessFloor,
        Math.log(props.eps + 1) / EPS_LOG_REF,
      ));

      if (props.wEff < minW) minW = props.wEff;
      if (props.wEff > maxW) maxW = props.wEff;
    }

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
        // Size: lerp between uniform (1.0) and physics-driven based on sizeVariation.
        // normAcc is 0–1 from global bounds; at variation=0 all particles are size 1.0.
        hitSize:     1.0 - c.sizeVariation * 0.5
                     + ((accBuf[i] - globalMinAcc) / globalAccR) * c.sizeVariation,
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

        // Global production acceleration bounds (stable across batches)
        const { minAcc: ppGlobalMin, maxAcc: ppGlobalMax } =
          this.physics.productionAccRange(c.perturbAmplitude, c.betaPP);
        const ppGlobalR = ppGlobalMax - ppGlobalMin || 1;

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
          // TD is derived from arrivalSpread, same as the bounce path.
          const ppDenom = Math.max(TD_DENOM_FLOOR, Math.abs(sens) * this.physics.beta * c.perturbAmplitude);
          const ppTD = c.arrivalSpread / ppDenom;
          const rawDelay = sens
            * (betaEff - this.physics.beta) * ppTD;
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

          if (ppProps.wEff < ppMinW)  ppMinW  = ppProps.wEff;
          if (ppProps.wEff > ppMaxW)  ppMaxW  = ppProps.wEff;
        }

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
            hitSize:     (1.0 - c.sizeVariation * 0.5
                         + ((ppAccB[i] - ppGlobalMin) / ppGlobalR) * c.sizeVariation)
                         * c.ppSizeScale,
            tailAngle:   ppTailB[i],
          });
        }
      }
    }

    return result;
  }
}
