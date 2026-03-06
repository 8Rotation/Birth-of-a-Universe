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

import { ECSKPhysics } from "./physics/ecsk-physics.js";
import { PhysicsBridge } from "./physics/physics-bridge.js";
import type { PendingParticle } from "./physics/shell.js";
import { SensorRenderer, type Hit } from "./rendering/renderer.js";
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
/** Maximum seconds into the future a particle can be born before discard. */
const MAX_FUTURE_SECONDS = 302;
/** FPS / HUD update interval in seconds. */
const FPS_SAMPLE_INTERVAL = 0.8;
/** EMA decay factor for arrival-rate smoothing. */
const RATE_SMOOTH_DECAY = 0.6;
/** EMA gain factor for arrival-rate smoothing (= 1 − decay). */
const RATE_SMOOTH_GAIN = 0.4;

// Hard ceiling: a true emergency stop to prevent
// multi-GB RAM/VRAM consumption if persistence and rate are
// both cranked to extreme values simultaneously.
// (Overridden at runtime by hardware detection.)
let EMERGENCY_HIT_CAP = 5_000_000;

// ── Info overlay ──────────────────────────────────────────────────────────

const info = document.getElementById("info")!;
function setInfo(text: string) {
  info.textContent = text;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  setInfo("Initializing ECSK Bounce Sensor...");

  // ── 0a. Detect screen characteristics ─────────────────────────────
  //   Must run before hardware detection so we can feed renderPixels
  //   into the capability score.
  const screenDetector = new ScreenDetector();
  const screenInfo = await screenDetector.init();
  console.log(`[main] ${screenInfo.summary}`);

  const renderPixels = screenInfo.renderWidth * screenInfo.renderHeight;

  // ── 0b. Detect hardware capabilities (includes screen penalty) ────
  const hwDetector = new HardwareDetector();
  const hwInfo = await hwDetector.detect(renderPixels);
  console.log(`[main] ${hwInfo.summary}`);

  // Budget already incorporates screen-resolution penalty
  const budget = hwInfo.budget;

  // Apply hardware-derived limits
  EMERGENCY_HIT_CAP = budget.emergencyHitCap;

  // ── 1. Initialize renderer ────────────────────────────────────────
  const renderer = new SensorRenderer({
    initialCapacity: budget.initialGpuCapacity,
    bloomStrength: 1.2,
    bloomRadius: 0.3,
    bloomThreshold: 0.05,
  });

  try {
    await renderer.init(screenInfo);
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
  let hits: Hit[] = [];
  let simTime = 0;
  let arrivalCounter = 0;
  let arrivalRateSmooth = 0;
  let lastBeta = physics.beta;
  let lastK = 1;  // track spatial curvature changes
  let frozenDisplayTime = 0;  // snapshot of "now" when freeze was engaged

  // Previous-frame slider snapshot — used to detect changes and clear
  // the pending-arrival heap so stale particles from old settings don't
  // keep draining for seconds after a slider move.  Only the heap is
  // cleared; the worker bridge is NOT flushed (no generation bump) so
  // new particles at the updated settings flow without interruption.
  let prevParticleRate      = NaN;  // NaN so first-frame compare is always false (no-op)
  let prevPerturbAmplitude  = NaN;
  let prevLMax              = NaN;
  let prevNS                = NaN;
  let prevTimeDilation      = NaN;
  let prevFieldEvolution    = NaN;
  let prevBeta              = NaN;
  let prevKCurvature        = NaN;
  let prevDoubleBounce      = false;
  let prevBetaPP             = 0;
  let prevSilkDamping        = NaN;

  // ── 4. Controls (auto-configured from hardware budget) ────────────
  const { params, hud, updateHUD, updateTimeDilationMax, readoutGui: _readoutGui } = createSensorControls(() => {
    // Clear: wipe visible hits but keep the worker running so new
    // particles arrive on the very next frame — no restart delay.
    hits = [];
    simTime = 0;
    arrivalCounter = 0;
    arrivalRateSmooth = 0;
    // Drain any already-queued batches so they don't appear after clear
    bridge.drain();
  }, budget);

  // Seed prev-snapshot so the first frame sees no change (NaN → real value)
  prevParticleRate      = params.particleRate;
  prevPerturbAmplitude  = params.perturbAmplitude;
  prevLMax              = params.lMax;
  prevNS                = params.nS;
  prevTimeDilation      = params.timeDilation;
  prevFieldEvolution    = params.fieldEvolution;
  prevBeta              = params.beta;
  prevKCurvature        = params.kCurvature;
  prevDoubleBounce      = params.doubleBounce;
  prevBetaPP             = params.betaPP;
  prevSilkDamping        = params.silkDamping;

  // Set initial TD slider max from current β and amplitude
  updateTimeDilationMax(
    physics.sensitivity(),
    params.beta,
    params.perturbAmplitude,
  );

  // ── 5. Physics worker (off-thread emission) ────────────────────
  // Random seed per session so the perturbation field differs on each
  // reload.  Using a time-based seed with bit mixing for decent entropy.
  const sessionSeed = (Date.now() ^ (Math.random() * 0xFFFFFFFF)) >>> 0;

  const bridge = new PhysicsBridge({
    beta: physics.beta,
    kCurvature: params.kCurvature,
    perturbAmplitude: params.perturbAmplitude,
    lMax: params.lMax,
    nS: params.nS,
    timeDilation: params.timeDilation,
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
  });

  // ── 6. Direct particle routing ───────────────────────────────────
  // Particles from the worker go straight into hits[] — no heap, no
  // arrival-time gating, no per-frame caps.  This makes slider changes
  // feel instant: the worker already syncs params on every tick(), so
  // the next batch reflects the new settings immediately.

  function ingestParticles(fresh: PendingParticle[], now: number): void {
    for (let i = 0; i < fresh.length; i++) {
      const p = fresh[i];
      hits.push({
        x: p.lx,
        y: p.ly,
        hue: p.hue,
        brightness: p.brightness,
        eps: p.eps,
        size: p.hitSize,
        tailAngle: p.tailAngle,
        // Use arrivalTime directly — do NOT clamp to now.
        // Particles with arrivalTime > now (not-yet-bounced regions) are
        // held at full brightness until their time comes, then fade normally.
        // Particles with arrivalTime < now (already-bounced regions) appear
        // partially faded proportional to how long ago they bounced.
        // This produces the correct physical wavefront: the bounce sweeps
        // across the S² sphere with one side approaching peak density
        // (bright) and the other receding from it (fading).
        // (Cubero & Popławski 2019 §26; Unger & Popławski 2019 eq. 3)
        born: p.arrivalTime,
      });
    }
    arrivalCounter += fresh.length;
  }

  // ── 7. Animation loop ─────────────────────────────────────────────
  let lastTimestamp = 0;
  let frameCount = 0;
  let fpsTime = 0;
  let fps = 0;
  let rateTime = 0;

  setInfo(""); // Clear loading message

  function animate(timestamp: number) {
    requestAnimationFrame(animate);

    const dt =
      lastTimestamp > 0
        ? Math.min((timestamp - lastTimestamp) / 1000, 0.1)
        : 0.016;
    lastTimestamp = timestamp;
    const now = timestamp / 1000;

    // ── Recreate physics engine if β or k changed ────────────────
    const currentK = Number(params.kCurvature);  // lil-gui dropdown returns string
    if (Math.abs(params.beta - lastBeta) > BETA_CHANGE_THRESHOLD || currentK !== lastK) {
      physics = new ECSKPhysics(params.beta, currentK);
      lastBeta = params.beta;
      lastK = currentK;
      // Keep TD slider max in sync with new β
      updateTimeDilationMax(
        physics.sensitivity(),
        params.beta,
        params.perturbAmplitude,
      );
    } else if (params.perturbAmplitude !== prevPerturbAmplitude) {
      // Amplitude changed without β changing — still affects TD ceiling
      updateTimeDilationMax(
        physics.sensitivity(),
        params.beta,
        params.perturbAmplitude,
      );
    }

    // ── Responsive setting changes ────────────────────────────────
    // When any slider moves, clear the pending-arrival heap so stale
    // particles from old settings don't keep draining for seconds.
    // The worker bridge is NOT flushed — it already receives updated
    // params on every tick(), so new particles at the new settings
    // arrive on the very next frame without interruption.
    //
    // If the effective target count dropped (rate × persistence), we
    // also trim the visible-hit array to the new target so the
    // on-screen count snaps down immediately instead of waiting for
    // the full persistence window to expire.
    {
      const settingsChanged =
        params.particleRate     !== prevParticleRate     ||
        params.beta             !== prevBeta             ||
        params.perturbAmplitude !== prevPerturbAmplitude ||
        params.lMax             !== prevLMax             ||
        params.nS               !== prevNS               ||
        params.timeDilation     !== prevTimeDilation     ||
        params.fieldEvolution   !== prevFieldEvolution   ||
        Number(params.kCurvature) !== prevKCurvature     ||
        params.doubleBounce     !== prevDoubleBounce     ||
        params.betaPP           !== prevBetaPP            ||
        params.silkDamping      !== prevSilkDamping;

      if (settingsChanged) {
        // Discard future-born hits — they were computed with old settings
        // (delay offsets baked at the previous β / timeDilation / amplitude).
        // Visible (past/present) hits are kept so the display doesn't flash.
        // Use `now` here — displayTime is set later in the frame.
        let wi = 0;
        for (let i = 0; i < hits.length; i++) {
          if (hits[i].born <= now) hits[wi++] = hits[i];
        }
        hits.length = wi;
        // Snap visible hits down to the new expected steady-state
        // count so the display responds instantly when rate drops.
        const newTarget = Math.ceil(params.particleRate * params.persistence);
        if (hits.length > newTarget) {
          // Keep the newest hits (end of array = most recently born)
          hits.splice(0, hits.length - newTarget);
        }
      }

      prevParticleRate      = params.particleRate;
      prevPerturbAmplitude  = params.perturbAmplitude;
      prevLMax              = params.lMax;
      prevNS                = params.nS;
      prevTimeDilation      = params.timeDilation;
      prevFieldEvolution    = params.fieldEvolution;
      prevBeta              = params.beta;
      prevKCurvature        = Number(params.kCurvature);
      prevDoubleBounce      = params.doubleBounce;
      prevBetaPP             = params.betaPP;
      prevSilkDamping        = params.silkDamping;
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

      // Request particles from worker (results arrive next frame)
      bridge.tick(dt, simTime, params.particleRate, {
        beta: params.beta,
        kCurvature: Number(params.kCurvature),
        perturbAmplitude: params.perturbAmplitude,
        lMax: params.lMax,
        nS: params.nS,
        timeDilation: params.timeDilation,
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

      // Ingest particles from previous worker tick(s) directly into hits
      const fresh = bridge.drain();
      if (fresh.length > 0) ingestParticles(fresh, now);
    }

    // ── Fade-expire hits in place (no allocation) —————————————
    // Particles go through three life stages:
    //   born > displayTime  — not yet arrived: invisible, waiting in queue
    //   0 ≤ age ≤ cutoff    — arrived and fading: rendered with decreasing α
    //   age > cutoff or
    //   fade < threshold    — fully faded: discarded
    //
    // Future arrivals (age < 0) are kept in the array but never passed
    // to the renderer.  We separate hits into two arrays:
    //   visible[]  — age ≥ 0, still bright enough to render
    //   pending[]  — born in future, will appear later
    // This keeps visible count = ~rate × persistence regardless of
    // how far into the future the arrival-time spread reaches.
    //
    // Use displayTime so that frozen particles don't age out.
    // Cutoff derived from the Weibull formula: solve exp(-(t/τ)^k) = threshold
    //   → t = τ × (-ln(threshold))^(1/k)
    // with a small safety margin (×1.2) to avoid popping.
    const fadeThreshold = FADE_THRESHOLD;
    const k = params.fadeSharpness;
    const cutoff = params.persistence * Math.pow(-Math.log(fadeThreshold), 1 / k) * CUTOFF_MARGIN;
    let writeIdx = 0;
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const age = displayTime - hit.born;
      if (age > cutoff) continue;        // expired — discard
      if (age < 0) {
        // Future arrival — keep in array but skip rendering.
        // Safety: discard if absurdly far in the future (> MAX_FUTURE_SECONDS s).
        if (age < -MAX_FUTURE_SECONDS) continue;
        hits[writeIdx++] = hit;
        continue;
      }
      // Born: check if still bright enough to render (Weibull, matches renderer)
      const fade = Math.exp(-Math.pow(age / params.persistence, k));
      if (fade < fadeThreshold) continue; // too dim — discard
      hits[writeIdx++] = hit;
    }
    hits.length = writeIdx;

    // Enforce emergency ceiling (prevents multi-GB RAM at extreme settings)
    if (hits.length > EMERGENCY_HIT_CAP) {
      hits.splice(0, hits.length - EMERGENCY_HIT_CAP);
    }

    // ── Update renderer (visible hits only — skip pending future arrivals)
    // Future particles (born > displayTime) are held in hits[] so they
    // appear when their time comes, but the renderer only receives hits
    // that have already arrived.  This keeps visible count ≈ rate × persistence.
    const visibleHits: Hit[] = [];
    for (let i = 0; i < hits.length; i++) {
      if (hits[i].born <= displayTime) visibleHits.push(hits[i]);
    }

    renderer.hitBaseSize = params.hitSize;
    renderer.brightnessMultiplier = params.brightness;
    renderer.roundParticles = params.roundParticles;
    renderer.useBloom = params.bloomEnabled;   // toggle
    renderer.bloomStrength = params.bloomStrength;
    renderer.bloomRadius = params.bloomRadius;
    renderer.bloomThreshold = params.bloomThreshold;
    renderer.fadeSharpness = params.fadeSharpness;
    renderer.lightnessFloor = params.lightnessFloor;
    renderer.lightnessRange = params.lightnessRange;
    renderer.saturationFloor = params.saturationFloor;
    renderer.saturationRange = params.saturationRange;
    renderer.ringOpacity = params.ringOpacity;
    renderer.ringColor = parseInt(params.ringColor.replace('#', ''), 16);
    renderer.softHdrExposure = params.softHdrExposure;
    renderer.particleSoftEdge = params.particleSoftEdge;
    renderer.updateHits(visibleHits, displayTime, params.persistence);
    renderer.render();

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
      hud.visible = String(visibleHits.length);
      hud.fps = String(fps);
      // Update screen info in HUD (may change if moved between monitors)
      const si = screenDetector.info;
      hud.screen = `${si.screenWidth}×${si.screenHeight}`;
      hud.hz = `${si.refreshRate}${si.vrrDetected ? " VRR" : ""}`;
      hud.hdr = si.hdrCapable
        ? (renderer.hdrMode === 'full'
            ? `FULL (~${si.peakBrightnessNits ?? '?'} nits)`
            : renderer.hdrMode === 'soft'
              ? `SOFT (~${si.peakBrightnessNits ?? '?'} nits)`
              : "Detected (SDR fallback)")
        : "No";
      hud.gamut = si.colorGamut.toUpperCase();
      // Hardware info
      hud.cpuCores = String(hwInfo.cpu.logicalCores);
      hud.cpuBench = hwInfo.cpu.benchmarkScore.toFixed(2) + "×";
      hud.gpu = hwInfo.gpu.device || hwInfo.gpu.vendor;
      hud.capability = `${(hwInfo.rawCapability * 100).toFixed(0)}% hw → ${(hwInfo.capability * 100).toFixed(0)}% eff`;
      hud.tier = `${hwInfo.tier.toUpperCase()} (${(hwInfo.capability * 100).toFixed(0)}%)`;
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
