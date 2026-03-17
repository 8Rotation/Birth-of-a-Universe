/**
 * main.ts — Birth of a Universe: ECSK Bounce Sensor
 *
 * Visualizes the S² cross-section of the bounce hypersurface in
 * Poplawski's Einstein-Cartan torsion cosmology.
 *
 * Physics (verified against source papers):
 *   - (da̅/dτ̅)² = 1/a̅² − β/a̅⁴ − 1          (Friedmann + torsion)
 *   - Bounce at a̅²_min = [1 − √(1−4β)] / 2
 *   - Perturbation: δ(θ,φ) in spherical harmonics → β_eff = β(1+δ)
 *   - Color: w_eff(β_eff) — effective equation of state
 *
 * References (verified against all 29 source papers, 2025-03-04):
 *   Core: Poplawski 2010b, 2012, 2014, 2020, 2020b, 2021, 2025
 *   Spin-torsion: Hehl & Datta 1971; Hehl et al. 1976
 *   Bounce analysis: Unger & Poplawski 2019; Cubero & Poplawski 2019
 *   See EQUATION_CATALOG.md for full 29-paper bibliography
 */

import "./style.css";
import { ECSKPhysics } from "./physics/ecsk-physics.js";
import { PhysicsBridge, PARTICLE_STRIDE } from "./physics/physics-bridge.js";
import type { RawParticleBatch } from "./physics/physics-bridge.js";
import { SensorRenderer } from "./rendering/renderer.js";
import { createSensorControls } from "./ui/controls.js";
import { ScreenDetector } from "./ui/screen-info.js";
import { HardwareDetector } from "./ui/hardware-info.js";

console.log("[main] Birth of a Universe — ECSK Bounce Sensor");

// ── Configuration ─────────────────────────────────────────────────────────

/** Default spin parameter β on first launch. */
const DEFAULT_BETA = 0.10;
/** Threshold for detecting β slider changes (avoids float noise). */
const BETA_CHANGE_THRESHOLD = 0.0001;
/** Weibull fade threshold: particles dimmer than this are discarded. */
const FADE_THRESHOLD = 0.003;
/** Safety margin on Weibull cutoff to prevent pop-out. */
const CUTOFF_MARGIN = 1.2;

/**
 * Convert user-facing "fade duration" (seconds) to Weibull τ (scale parameter).
 * The slider value = total visible time before a particle reaches the
 * discard threshold.  We invert: τ = duration / ((-ln(threshold)) × margin)^(1/k).
 */
function fadeDurationToTau(duration: number, sharpness: number): number {
  return duration / (Math.pow(-Math.log(FADE_THRESHOLD) * CUTOFF_MARGIN, 1 / sharpness));
}
/** FPS / HUD update interval in seconds. */
const FPS_SAMPLE_INTERVAL = 0.8;
/** EMA decay factor for arrival-rate smoothing. */
const RATE_SMOOTH_DECAY = 0.6;
/** EMA gain factor for arrival-rate smoothing (= 1 − decay). */
const RATE_SMOOTH_GAIN = 0.4;
// VRAM budget cap: prevents multi-hundred-MB allocations if persistence
// and rate are both cranked to extreme values simultaneously.
// (Overridden at runtime by hardware detection.)
let VRAM_BUDGET_PARTICLES = 5_000_000;

// ── Info overlay ──────────────────────────────────────────────────────────

const infoEl = document.getElementById("info");
if (!infoEl) throw new Error('Missing #info element in document');
const info: HTMLElement = infoEl;
function setInfo(text: string) {
  info.textContent = text;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  setInfo("Initializing ECSK Bounce Sensor...");
  const t0 = performance.now();

  // ── 0a. Fire hardware benchmarks immediately (no await) ───────────
  //   CPU bench + GPU adapter query don't need renderPixels, so they
  //   run in parallel with the rAF-based screen measurement below.
  const hwDetector = new HardwareDetector();
  hwDetector.startBenchmarks();

  // ── 0b. Detect screen characteristics ─────────────────────────────
  const screenDetector = new ScreenDetector();
  const screenInfo = await screenDetector.init();
  console.log(`[main] Screen detection: ${(performance.now() - t0).toFixed(0)} ms — ${screenInfo.summary}`);

  const renderPixels = screenInfo.renderWidth * screenInfo.renderHeight;

  // ── 0c. Finalize hardware detection (applies screen penalty) ──────
  const t1 = performance.now();
  const hwInfo = await hwDetector.finalize(renderPixels);
  console.log(`[main] Hardware detection: ${(performance.now() - t1).toFixed(0)} ms — ${hwInfo.summary}`);

  // Budget already incorporates screen-resolution penalty
  const budget = hwInfo.budget;

  // Apply hardware-derived limits
  VRAM_BUDGET_PARTICLES = budget.emergencyHitCap;

  // ── 1. Initialize renderer ────────────────────────────────────────
  const t2 = performance.now();
  const renderer = new SensorRenderer({
    initialCapacity: budget.initialGpuCapacity,
    bloomStrength: 1.2,
    bloomRadius: 0.3,
    bloomThreshold: 0.05,
  });

  // Resolve 'auto' bloom quality based on hardware capability score
  renderer.bloomAutoResolvedQuality = hwInfo.capability >= 0.6 ? 'high' : 'low';

  try {
    await renderer.init(screenInfo);
    console.log(`[main] Renderer init: ${(performance.now() - t2).toFixed(0)} ms`);
  } catch (e) {
    setInfo(`WebGPU init failed: ${e}`);
    console.error(e);
    return;
  }

  // Apply detected screen settings to renderer
  renderer.applyScreenInfo(screenInfo);

  // Re-apply whenever the display changes (monitor switch, DPR change)
  screenDetector.onChange((info) => {
    renderer.applyScreenInfo(info);
    console.log(`[main] Screen change: ${info.summary}`);
  });

  // ── 2. Physics engine ─────────────────────────────────────────────
  let physics = new ECSKPhysics(DEFAULT_BETA, 1);

  // ── 3. State ──────────────────────────────────────────────────────
  const pendingBatches: RawParticleBatch[] = [];
  // simTime is initialised to wall-clock on the first frame so particle
  // born-times and displayTime (wall-clock) share the same time basis.
  // This eliminates the startup-offset bug where particles were born
  // seconds/minutes in the future relative to displayTime.
  let simTime = -1;  // sentinel: first frame will set from wall-clock
  let arrivalCounter = 0;
  let arrivalRateSmooth = 0;
  /** Watchdog throttle: multiplied into effectiveRate when frames lag.
   *  Decays back toward 1.0 over ~2 s.  Replaces the hard buffer trim
   *  that caused the cull→refill oscillation. */
  let throttleMultiplier = 1.0;
  let lastBeta = physics.beta;
  let lastK = 1;  // track spatial curvature changes
  let frozenDisplayTime = 0;  // snapshot of "now" when freeze was engaged

  // Previous-frame slider snapshot — used to detect changes.
  // Physics param changes discard future-born hits (baked with old settings).
  // Visual/flow param changes only affect going forward — no retroactive culling.
  let prevParticleRate      = NaN;  // NaN so first-frame compare is always false (no-op)
  let prevPerturbAmplitude  = NaN;
  let prevLMax              = NaN;
  let prevNS                = NaN;
  let prevArrivalSpread     = NaN;
  let prevFieldEvolution    = NaN;
  let prevBeta              = NaN;
  let prevKCurvature        = NaN;
  let prevDoubleBounce      = false;
  let prevBetaPP             = 0;
  let prevSilkDamping        = NaN;
  // Debounce timer for settings-change culling — prevents repeated wipes
  // during a slider drag gesture (200ms cooldown).
  let settingsChangeTimer   = 0;
  const SETTINGS_DEBOUNCE   = 0.2;  // seconds
  // Latching dirty flags — stay true until debounce fires.
  // Fixes the race condition where prevXxx updates every frame
  // but the debounce check fires later when physicsChanged is already false.
  let physicsDirty = false;
  let flowDirty = false;

  // ── 4. Controls (auto-configured from hardware budget) ────────────
  const tCtrl = performance.now();
  const { params, hud, updateHUD, setHDRMode, setForceHDRCallback, updateTargetFpsLabel } = createSensorControls(() => {
    // Full reset: terminate and recreate all workers (recovers from
    // crashes), wipe all particle state, and re-sync timing.
    // Equivalent to browser reload but keeps current settings.
    renderer.ringBuffer.clear();
    pendingBatches.length = 0;
    arrivalCounter = 0;
    arrivalRateSmooth = 0;
    frozenDisplayTime = 0;
    lastTimestamp = 0;  // next frame computes fresh dt
    // Reset rate tracking so the flux readout starts fresh instead of
    // staying near zero for seconds (EMA with stale denominator).
    rateTime = performance.now() / 1000;
    // Reset simTime so particle born-times re-sync with wall clock.
    simTime = -1;
    simTimePauseAccum = 0;  // clear pause offset on full reset
    // Unfreeze if frozen so the simulation resumes immediately
    params.frozen = false;
    // Clear dirty/debounce state to prevent stale culling after reset
    physicsDirty = false;
    flowDirty = false;
    settingsChangeTimer = 0;
    throttleMultiplier = 1.0;
    // Recreate physics engine from current settings
    const currentK = Number(params.kCurvature);
    physics = new ECSKPhysics(params.beta, currentK);
    lastBeta = params.beta;
    lastK = currentK;
    // Fresh seed for new session
    const resetSeed = (Date.now() ^ (Math.random() * 0xFFFFFFFF)) >>> 0;
    // Full worker restart: terminates old workers, creates fresh ones.
    // This recovers from worker crashes and fully resets emission state.
    bridge.restart({
      beta: params.beta,
      kCurvature: currentK,
      perturbAmplitude: params.perturbAmplitude,
      lMax: params.lMax,
      nS: params.nS,
      arrivalSpread: params.arrivalSpread,
      seed: resetSeed,
      fieldEvolution: params.fieldEvolution,
      doubleBounce: params.doubleBounce,
      betaPP: params.betaPP,
      silkDamping: params.silkDamping,
      hueMin: params.hueMin,
      hueRange: params.hueRange,
      brightnessFloor: params.brightnessFloor,
      brightnessCeil: params.brightnessCeil,
      dbSecondHueShift: params.dbSecondHueShift,
      dbSecondBriScale: params.dbSecondBriScale,
      ppHueShift: params.ppHueShift,
      ppBriBoost: params.ppBriBoost,
      ppSizeScale: params.ppSizeScale,
      ppBaseDelay: params.ppBaseDelay,
      ppScatterRange: params.ppScatterRange,
    });
    // Re-sync prev-snapshots so the first frame after reset sees no change
    prevParticleRate      = params.particleRate;
    prevPerturbAmplitude  = params.perturbAmplitude;
    prevLMax              = params.lMax;
    prevNS                = params.nS;
    prevArrivalSpread     = params.arrivalSpread;
    prevFieldEvolution    = params.fieldEvolution;
    prevBeta              = params.beta;
    prevKCurvature        = currentK;
    prevDoubleBounce      = params.doubleBounce;
    prevBetaPP             = params.betaPP;
    prevSilkDamping        = params.silkDamping;
    console.log("[main] Simulation reset (full worker restart)");
  }, budget, screenInfo.refreshRate, screenInfo.isMobile);

  // Seed prev-snapshot so the first frame sees no change (NaN → real value)
  prevParticleRate      = params.particleRate;
  prevPerturbAmplitude  = params.perturbAmplitude;
  prevLMax              = params.lMax;
  prevNS                = params.nS;
  prevArrivalSpread     = params.arrivalSpread;
  prevFieldEvolution    = params.fieldEvolution;
  prevBeta              = params.beta;
  prevKCurvature        = params.kCurvature;
  prevDoubleBounce      = params.doubleBounce;
  prevBetaPP             = params.betaPP;
  prevSilkDamping        = params.silkDamping;

  // Communicate detected HDR mode to controls so irrelevant sliders are hidden
  setHDRMode(renderer.hdrMode);

  // Wire the mobile Force HDR button to the renderer
  setForceHDRCallback((enabled) => {
    if (enabled) {
      renderer.forceSoftHDR();
    } else {
      renderer.disableSoftHDR();
    }
    setHDRMode(renderer.hdrMode);
  });

  function effectiveDisplaySyncHz(): number {
    const overrideHz = Number(params.displaySyncHz);
    return overrideHz > 0 ? overrideHz : (screenDetector.info.refreshRate || 60);
  }

  function effectivePresentationHz(): number {
    const syncHz = Math.max(1, effectiveDisplaySyncHz());
    const targetHz = Number(params.targetFps);
    return targetHz > 0 ? Math.max(1, Math.min(targetHz, syncHz)) : syncHz;
  }

  screenDetector.onChange((info) => {
    updateTargetFpsLabel(effectiveDisplaySyncHz());
  });

  console.log(`[main] Controls creation: ${(performance.now() - tCtrl).toFixed(0)} ms`);

  // ── 5. Physics worker (off-thread emission) ────────────────────
  // Random seed per session so the perturbation field differs on each
  // reload.  Using a time-based seed with bit mixing for decent entropy.
  const t3 = performance.now();
  const sessionSeed = (Date.now() ^ (Math.random() * 0xFFFFFFFF)) >>> 0;

  const bridge = new PhysicsBridge({
    beta: physics.beta,
    kCurvature: params.kCurvature,
    perturbAmplitude: params.perturbAmplitude,
    lMax: params.lMax,
    nS: params.nS,
    arrivalSpread: params.arrivalSpread,
    seed: sessionSeed,
    fieldEvolution: params.fieldEvolution,
    doubleBounce: params.doubleBounce,
    betaPP: params.betaPP,
    silkDamping: params.silkDamping,
    hueMin: params.hueMin,
    hueRange: params.hueRange,
    brightnessFloor: params.brightnessFloor,
    brightnessCeil: params.brightnessCeil,
    dbSecondHueShift: params.dbSecondHueShift,
    dbSecondBriScale: params.dbSecondBriScale,
    ppHueShift: params.ppHueShift,
    ppBriBoost: params.ppBriBoost,
    ppSizeScale: params.ppSizeScale,
    ppBaseDelay: params.ppBaseDelay,
    ppScatterRange: params.ppScatterRange,
  }, budget.recommendedWorkers);

  // ── 6. GPU pipeline ready ──────────────────────────────────────────
  console.log(`[main] Worker spawn: ${(performance.now() - t3).toFixed(0)} ms`);
  console.log(`[main] Total init: ${(performance.now() - t0).toFixed(0)} ms`);

  // ── 7. Visibility / focus management ─────────────────────────────
  // Two hard states plus an optional mobile-only soft throttle:
  //   1. Tab visible → full speed on desktop
  //   2. Tab hidden (switched tabs / minimized) → fully frozen, zero CPU cost;
  //      resumes exactly where user left off
  //   3. Mobile only: visible + window blurred → throttled (~10fps) so the
  //      simulation keeps evolving but uses minimal resources while backgrounded
  let tabHidden = document.hidden;
  const throttleWhenWindowBlurred = screenInfo.isMobile;
  let windowBlurred = !document.hasFocus();
  /** Wall-clock time (seconds) when the tab was hidden.  0 = not hidden. */
  let hiddenAtTime = 0;
  /** Accumulated simTime pause offset — added to `now` so simTime doesn't jump. */
  let simTimePauseAccum = 0;
  /** Background throttle interval (ms). ~10 fps when window blurred. */
  const BG_THROTTLE_INTERVAL = 100;

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      tabHidden = true;
      // Snapshot the current wall-clock time so we can compute pause duration
      hiddenAtTime = performance.now() / 1000;
      // Flush any in-flight worker batches — they'd arrive with stale timestamps
      bridge.flushPipeline();
      pendingBatches.length = 0;
    } else {
      if (tabHidden && hiddenAtTime > 0) {
        // Accumulate the pause duration so simTime doesn't jump forward
        const pauseDuration = performance.now() / 1000 - hiddenAtTime;
        simTimePauseAccum += pauseDuration;
        // Reset lastTimestamp so dt doesn't spike on the first visible frame
        lastTimestamp = 0;
      }
      tabHidden = false;
      hiddenAtTime = 0;
    }
  });

  if (throttleWhenWindowBlurred) {
    window.addEventListener("blur", () => { windowBlurred = true; });
    window.addEventListener("focus", () => { windowBlurred = false; });
  }

  // ── Animation loop ────────────────────────────────────────────────
  let lastTimestamp = 0;
  let frameCount = 0;
  let fpsTime = 0;
  let fps = 0;
  let rateTime = 0;

  // ── GPU / render timing accumulators ────────────────────────────
  let renderMsAccum = 0;   // total ms spent in renderer.render() this interval
  let renderFrameCount = 0; // frames rendered this interval
  let gpuLoadSmooth = 0;    // EMA-smoothed GPU load (0–1)

  setInfo(""); // Clear loading message

  function animate(timestamp: number) {
    requestAnimationFrame(animate);

    // ── Tab hidden: skip everything (zero CPU cost) ──────────────
    // Browsers already throttle rAF to ~1fps for hidden tabs, but we
    // skip all work so workers don't receive ticks either.
    if (tabHidden) return;

    // ── Background throttle: mobile only, ~10fps when window blurred ──
    // Desktop windows can remain fully visible on another monitor while
    // blurred, so focus loss is not a reliable proxy for occlusion there.
    if (throttleWhenWindowBlurred && windowBlurred && lastTimestamp > 0) {
      if (timestamp - lastTimestamp < BG_THROTTLE_INTERVAL) return;
    }

    // ── Frame throttling (target FPS) ──────────────────────────
    // When targetFps > 0, skip rAF callbacks that arrive too soon.
    // The 0.92 factor prevents systematic drift at fractional intervals
    // (e.g. 60 fps on 144 Hz — accept frames that land slightly early
    // rather than waiting an extra VSync and producing stuttery judder).
    const effectiveFrameCapHz = effectivePresentationHz();
    if (effectiveFrameCapHz > 0 && lastTimestamp > 0) {
      const minInterval = 1000 / effectiveFrameCapHz;
      if (timestamp - lastTimestamp < minInterval * 0.92) return;
    }

    const dt =
      lastTimestamp > 0
        ? Math.min((timestamp - lastTimestamp) / 1000, 0.1)
        : 0.016;
    // Raw inter-frame gap in ms (before capping dt) — used by watchdog below.
    const rawGapMs = lastTimestamp > 0 ? timestamp - lastTimestamp : 16;
    lastTimestamp = timestamp;
    const now = timestamp / 1000 - simTimePauseAccum;

    // ── Frame-time watchdog: soft throttle ────────────────────────
    // When a frame takes too long, reduce emission rate via a multiplier
    // instead of hard-trimming the buffer.  Existing particles fade out
    // naturally via Weibull; no pipeline flush so workers don't re-flood.
    // The multiplier decays back toward 1.0 over ~2 s.
    if (rawGapMs > 150 && renderer.ringBuffer.totalWritten > 10_000) {
      throttleMultiplier = Math.max(0.1, throttleMultiplier * 0.5);
      console.warn(`[main] Frame watchdog: ${rawGapMs.toFixed(0)}ms lag — throttle to ${(throttleMultiplier * 100).toFixed(0)}%`);
    } else if (throttleMultiplier < 1.0) {
      throttleMultiplier = Math.min(1.0, throttleMultiplier + dt * 0.5);
    }

    // Initialise simTime from wall-clock on the first frame so particle
    // born-times share the same time basis as displayTime.
    if (simTime < 0) simTime = now;

    // ── Recreate physics engine if β or k changed ────────────────
    const currentK = Number(params.kCurvature);  // lil-gui dropdown returns string
    if (Math.abs(params.beta - lastBeta) > BETA_CHANGE_THRESHOLD || currentK !== lastK) {
      physics = new ECSKPhysics(params.beta, currentK);
      lastBeta = params.beta;
      lastK = currentK;
      // Notify workers so they recreate their physics engine immediately
      // (prevents 1+ frames of stale-β particles).
      bridge.updatePhysics(physics.beta, currentK);
    }

    // ── Responsive setting changes ────────────────────────────────
    // Physics params (β, k, perturbAmplitude, lMax, nS, betaPP,
    // silkDamping) change the particle distribution — future-born hits
    // are discarded since they were computed with old settings.
    // Flow/visual params (particleRate, persistence, arrivalSpread,
    // fieldEvolution) only affect going forward — no retroactive culling.
    //
    // Latching dirty flags + 200ms debounce prevent repeated wipes
    // during a slider drag gesture while ensuring the cull actually
    // fires once the slider settles.
    {
      const physicsChanged =
        params.beta             !== prevBeta             ||
        params.perturbAmplitude !== prevPerturbAmplitude ||
        params.lMax             !== prevLMax             ||
        params.nS               !== prevNS               ||
        Number(params.kCurvature) !== prevKCurvature     ||
        params.doubleBounce     !== prevDoubleBounce     ||
        params.betaPP           !== prevBetaPP            ||
        params.silkDamping      !== prevSilkDamping;

      const flowChanged =
        params.particleRate     !== prevParticleRate     ||
        params.arrivalSpread    !== prevArrivalSpread    ||
        params.fieldEvolution   !== prevFieldEvolution;

      // Latch dirty flags — they stay true until the debounce fires.
      if (physicsChanged) physicsDirty = true;
      if (flowChanged) flowDirty = true;

      if (physicsChanged || flowChanged) {
        // Reset debounce timer — culling fires when slider settles
        settingsChangeTimer = SETTINGS_DEBOUNCE;
      }

      // Update prev-snapshot every frame (safe because dirty flags latch).
      prevParticleRate      = params.particleRate;
      prevPerturbAmplitude  = params.perturbAmplitude;
      prevLMax              = params.lMax;
      prevNS                = params.nS;
      prevArrivalSpread     = params.arrivalSpread;
      prevFieldEvolution    = params.fieldEvolution;
      prevBeta              = params.beta;
      prevKCurvature        = Number(params.kCurvature);
      prevDoubleBounce      = params.doubleBounce;
      prevBetaPP             = params.betaPP;
      prevSilkDamping        = params.silkDamping;

      // Decrement debounce; cull only when timer expires (slider settled)
      if (settingsChangeTimer > 0) {
        settingsChangeTimer -= dt;
        if (settingsChangeTimer <= 0) {
          settingsChangeTimer = 0;

          // Physics change → discard far-future hits (baked at old settings).
          // Keep particles arriving within 5s — they'll fade naturally via
          // Weibull, avoiding the near-total wipe at high arrivalSpread where
          // many particles are future-born.
          if (physicsDirty) {
            renderer.ringBuffer.invalidateFuture(now + 5);
            physicsDirty = false;
          }

          flowDirty = false;
        }
      }

      // (Soft cap moved to after fade-expire partition — see below)
    }

    // ── Freeze: snapshot display time so particles stop aging ────
    if (params.frozen) {
      // On first frozen frame, capture the current time
      if (frozenDisplayTime === 0) frozenDisplayTime = now;
    } else {
      frozenDisplayTime = 0;  // reset when unfrozen
    }
    const displayTime = params.frozen ? frozenDisplayTime : now;

    // ── Advance simulation (physics runs off-thread) ──────────────
    if (!params.frozen) {
      simTime += dt;

      // ── Compound-budget throttling ─────────────────────────────
      // Two proactive caps (VRAM, physics) prevent unbounded growth.
      // GPU handles rendering cheaply but unbounded VRAM growth is dangerous.
      let effectiveRate = params.particleRate;

      // Account for pair-production multiplier: workers emit
      // (1 + ppFraction) particles per requested base particle.
      const ppFraction = params.betaPP > 0
        ? Math.min(3.0, params.betaPP * 929)   // PP_FRACTION_CAP=3, BETA_CR=1/929
        : 0;
      const totalMultiplier = 1 + ppFraction;

      // (a) VRAM cap: cap total rate so totalRate × persistence ≤ vramBudgetParticles
      const maxByVRAM = VRAM_BUDGET_PARTICLES / (Math.max(params.persistence, 0.2) * totalMultiplier);
      if (effectiveRate > maxByVRAM) effectiveRate = maxByVRAM;

      // (b) Physics cost: cap total rate so totalRate × numCoeffs ≤ maxPhysicsCostPerSec
      const numCoeffs = params.lMax * params.lMax + 2 * params.lMax; // Σ(2l+1) for l=1..lMax
      if (numCoeffs > 0) {
        const maxByPhysics = budget.maxPhysicsCostPerSec / (numCoeffs * totalMultiplier);
        if (effectiveRate > maxByPhysics) effectiveRate = maxByPhysics;
      }

      // (c) Reactive back-pressure: reduce rate when ring buffer is near full
      if (renderer.ringBuffer.totalWritten > renderer.ringBuffer.capacity * 0.8) {
        const fillRatio = renderer.ringBuffer.totalWritten / renderer.ringBuffer.capacity;
        effectiveRate *= Math.exp(-0.5 * (fillRatio - 0.8));
      }

      // Apply watchdog throttle (decays back to 1.0 between lag spikes)
      effectiveRate *= throttleMultiplier;

      // Floor: never drop below 100/s (keep something visible)
      effectiveRate = Math.max(100, effectiveRate);

      // Request particles from worker (results arrive next frame)
      bridge.tick(dt, simTime, effectiveRate, {
        beta: params.beta,
        kCurvature: Number(params.kCurvature),
        perturbAmplitude: params.perturbAmplitude,
        lMax: params.lMax,
        nS: params.nS,
        arrivalSpread: params.arrivalSpread,
        fieldEvolution: params.fieldEvolution,
        doubleBounce: params.doubleBounce,
        betaPP: params.betaPP,
        silkDamping: params.silkDamping,
        hueMin: params.hueMin,
        hueRange: params.hueRange,
        brightnessFloor: params.brightnessFloor,
        brightnessCeil: params.brightnessCeil,
        dbSecondHueShift: params.dbSecondHueShift,
        dbSecondBriScale: params.dbSecondBriScale,
        ppHueShift: params.ppHueShift,
        ppBriBoost: params.ppBriBoost,
        ppSizeScale: params.ppSizeScale,
        ppBaseDelay: params.ppBaseDelay,
        ppScatterRange: params.ppScatterRange,
      });

      // Ingest particles from previous worker tick(s) — direct ring buffer writes.
      // No per-frame cap needed: ring buffer writes are just memcpy.
      const batches = bridge.drain();
      if (batches.length > 0) pendingBatches.push(...batches);
      const cutoff = params.persistence * CUTOFF_MARGIN;
      while (pendingBatches.length > 0) {
        const batch = pendingBatches.shift()!;
        renderer.ringBuffer.writeBatch(batch.data, batch.count, PARTICLE_STRIDE, displayTime, cutoff);
        arrivalCounter += batch.count;
      }
    }

    // ── Compute tau for GPU shader uniform ────────────────────────
    const tau = fadeDurationToTau(params.persistence, params.fadeSharpness);

    renderer.hitBaseSize = params.hitSize;
    renderer.brightnessMultiplier = params.brightness;
    renderer.roundParticles = params.roundParticles;
    renderer.useBloom = params.bloomEnabled || (params.ringEnabled && params.ringBloomEnabled);  // either bloom activates pipeline
    renderer.particleBloomEnabled = params.bloomEnabled;
    renderer.bloomStrength = params.bloomStrength;
    renderer.bloomRadius = params.bloomRadius;
    renderer.bloomThreshold = params.bloomThreshold;
    renderer.bloomQuality = params.bloomQuality;
    renderer.fadeSharpness = params.fadeSharpness;
    renderer.lightnessFloor = params.lightnessFloor;
    renderer.lightnessRange = params.lightnessRange;
    renderer.saturationFloor = params.saturationFloor;
    renderer.saturationRange = params.saturationRange;
    renderer.ringOpacity = params.ringEnabled ? params.ringOpacity : 0;
    renderer.ringColor = parseInt(params.ringColor.replace('#', ''), 16);
    renderer.ringWidthPx = params.ringWidthPx;
    renderer.ringBloomEnabled = params.ringEnabled && params.ringBloomEnabled;
    renderer.ringBloomStrength = params.ringBloomStrength;
    renderer.ringBloomRadius = params.ringBloomRadius;
    renderer.ringAutoColor = params.ringEnabled;

    // When auto-colour is active, feed the computed colour back into the
    // params object so the lil-gui colour picker (.listen()) stays in sync.
    if (params.ringEnabled) {
      const hex = '#' + renderer.effectiveRingColor.toString(16).padStart(6, '0');
      if (params.ringColor !== hex) params.ringColor = hex;
    }

    renderer.softHdrExposure = params.softHdrExposure;
    renderer.particleSoftEdge = params.particleSoftEdge;
    renderer.autoBrightness = params.autoBrightness;
    renderer.brightnessFloor = params.brightnessFloor;
    renderer.brightnessCeil = params.brightnessCeil;
    // Compute the maximum possible eps for auto-brightness ceiling.
    // With perturbation, the smallest β_eff (= β × (1 − amplitude)) yields
    // the highest energy density at bounce (eps ∝ 1/a_min⁴).
    const minBetaEff = physics.beta * Math.max(0.001, 1 - params.perturbAmplitude);
    const maxBetaEff = physics.beta * (1 + params.perturbAmplitude);
    renderer.maxEps = physics.bounceProps(minBetaEff).eps;
    renderer.minEps = physics.bounceProps(maxBetaEff).eps;
    renderer.backgroundColor = parseInt(params.backgroundColor.replace('#', ''), 16);
    renderer.zoom = params.zoom;
    renderer.updateUniforms(displayTime, tau);
    const renderStart = performance.now();
    renderer.render();
    renderMsAccum += performance.now() - renderStart;
    renderFrameCount++;

    // ── FPS + HUD ─────────────────────────────────────────────────
    frameCount++;
    fpsTime += dt;
    if (fpsTime >= FPS_SAMPLE_INTERVAL) {
      fps = Math.round(frameCount / fpsTime);
      frameCount = 0;
      fpsTime = 0;

      const elapsed = now - rateTime || 1;
      arrivalRateSmooth =
        arrivalRateSmooth * RATE_SMOOTH_DECAY + (arrivalCounter / elapsed) * RATE_SMOOTH_GAIN;
      arrivalCounter = 0;
      rateTime = now;

      const props = physics.bounceProps(physics.beta);
      hud.beta = params.beta.toFixed(3);
      hud.aMin = physics.aMin.toFixed(5);
      hud.wEff = props.wEff.toFixed(2);
      hud.torsionRatio = props.S.toFixed(4);
      hud.ppStrength = params.betaPP > 0
        ? (params.betaPP / ECSKPhysics.BETA_CR).toFixed(2)
        : "off";
      hud.flux = arrivalRateSmooth.toFixed(0);
      hud.visible = String(renderer.ringBuffer.totalWritten);
      hud.fps = String(fps);
      // Update screen info in HUD (may change if moved between monitors)
      const si = screenDetector.info;
      const effectiveSyncHz = effectiveDisplaySyncHz();
      hud.screen = `${si.screenWidth}×${si.screenHeight}`;
      hud.hz = `${effectiveSyncHz}${Number(params.displaySyncHz) > 0 ? " override" : ""}${si.vrrDetected ? " VRR" : ""}`;
      hud.hdr = renderer.hdrMode === 'full'
        ? `FULL (~${si.peakBrightnessNits ?? '?'} nits)`
        : renderer.hdrMode === 'soft'
          ? `SOFT${si.hdrCapable ? '' : ' (forced)'}`
          : si.hdrCapable ? "Detected (SDR fallback)" : "No";
      hud.gamut = si.colorGamut.toUpperCase();
      // Hardware info
      hud.cpuCores = String(hwInfo.cpu.logicalCores);
      hud.cpuBench = hwInfo.cpu.benchmarkScore.toFixed(2) + "×";
      hud.gpu = hwInfo.gpu.device || hwInfo.gpu.vendor;
      hud.capability = `${(hwInfo.capability * 100).toFixed(0)}%`;
      hud.tier = `${hwInfo.tier.toUpperCase()}`;
      hud.cpuUsage = `${bridge.workerCount} / ${hwInfo.cpu.logicalCores} threads`;
      // CPU load: measured worker utilization (fraction of available worker time)
      const measuredCpuLoad = bridge.updateCpuLoad(fpsTime + (fpsTime === 0 ? FPS_SAMPLE_INTERVAL : 0));
      const cpuPct = Math.round(measuredCpuLoad * 100);
      const cpuColor = measuredCpuLoad > 0.9 ? ' ⚠️ HIGH' : measuredCpuLoad > 0.7 ? ' • BUSY' : '';
      hud.cpuLoad = `${cpuPct}%${cpuColor}`;
      // GPU load: measured render time as fraction of frame budget
      if (renderFrameCount > 0) {
        const avgRenderMs = renderMsAccum / renderFrameCount;
        const frameBudgetMs = 1000 / effectivePresentationHz();
        const rawGpuLoad = avgRenderMs / frameBudgetMs;
        gpuLoadSmooth = gpuLoadSmooth * 0.6 + rawGpuLoad * 0.4;
      }
      renderMsAccum = 0;
      renderFrameCount = 0;
      const gpuPct = Math.round(gpuLoadSmooth * 100);
      const gpuColor = gpuLoadSmooth > 0.9 ? ' ⚠️ HIGH' : gpuLoadSmooth > 0.7 ? ' • BUSY' : '';
      hud.gpuLoad = `${gpuPct}%${gpuColor}`;
      hud.bufferFill = `${(renderer.ringBuffer.totalWritten / 1000).toFixed(0)}K / ${(renderer.ringBuffer.capacity / 1000).toFixed(0)}K`;
      updateHUD();
    }
  }

  requestAnimationFrame(animate);
}

// ── Boot ──────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Fatal:", err);
  const el = document.getElementById("info");
  if (el) el.textContent = `Error: ${err?.message ?? String(err)}`;
});
