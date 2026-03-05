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
    await renderer.init();
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
  let physics = new ECSKPhysics(0.10);

  // ── 3. State ──────────────────────────────────────────────────────
  let hits: Hit[] = [];
  let simTime = 0;
  let arrivalCounter = 0;
  let arrivalRateSmooth = 0;
  let lastBeta = physics.beta;
  let frozenDisplayTime = 0;  // snapshot of "now" when freeze was engaged

  // Previous-frame slider snapshot — used to detect changes and clear
  // the pending-arrival heap so stale particles from old settings don't
  // keep draining for seconds after a slider move.  Only the heap is
  // cleared; the worker bridge is NOT flushed (no generation bump) so
  // new particles at the updated settings flow without interruption.
  let prevParticleRate      = NaN;  // NaN so first-frame compare is always false (no-op)
  let prevPerturbAmplitude  = NaN;
  let prevLMax              = NaN;
  let prevTimeDilation      = NaN;
  let prevFieldEvolution    = NaN;
  let prevBeta              = NaN;

  // ── 4. Controls (auto-configured from hardware budget) ────────────
  const { params, hud, updateHUD } = createSensorControls(() => {
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
  prevTimeDilation      = params.timeDilation;
  prevFieldEvolution    = params.fieldEvolution;
  prevBeta              = params.beta;

  // ── 5. Physics worker (off-thread emission) ────────────────────
  const bridge = new PhysicsBridge({
    beta: physics.beta,
    perturbAmplitude: params.perturbAmplitude,
    lMax: params.lMax,
    timeDilation: params.timeDilation,
    seed: 42,
    fieldEvolution: params.fieldEvolution,
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
        size: p.hitSize,
        tailAngle: p.tailAngle,
        // Clamp born to <= now so fade math never produces negative age
        // (which would make particles flash brighter than intended).
        born: Math.min(p.arrivalTime, now),
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

    // ── Recreate physics engine if β changed ──────────────────────
    if (Math.abs(params.beta - lastBeta) > 0.0001) {
      physics = new ECSKPhysics(params.beta);
      lastBeta = params.beta;
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
        params.timeDilation     !== prevTimeDilation     ||
        params.fieldEvolution   !== prevFieldEvolution;

      if (settingsChanged) {
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
      prevTimeDilation      = params.timeDilation;
      prevFieldEvolution    = params.fieldEvolution;
      prevBeta              = params.beta;
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
        perturbAmplitude: params.perturbAmplitude,
        lMax: params.lMax,
        timeDilation: params.timeDilation,
        fieldEvolution: params.fieldEvolution,
      });

      // Ingest particles from previous worker tick(s) directly into hits
      const fresh = bridge.drain();
      if (fresh.length > 0) ingestParticles(fresh, now);
    }

    // ── Fade-expire hits in place (no allocation) ─────────────────
    // Use displayTime so that frozen particles don't age out
    const cutoff = params.persistence * 2;
    const fadeThreshold = 0.003;
    let writeIdx = 0;
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const age = displayTime - hit.born;
      if (age > cutoff) continue;
      const fade = Math.exp((-age / params.persistence) * 3);
      if (fade < fadeThreshold) continue;
      hits[writeIdx++] = hit;
    }
    hits.length = writeIdx;

    // Enforce emergency ceiling (prevents multi-GB RAM at extreme settings)
    if (hits.length > EMERGENCY_HIT_CAP) {
      hits.splice(0, hits.length - EMERGENCY_HIT_CAP);
    }

    // ── Update renderer ───────────────────────────────────────────
    renderer.hitBaseSize = params.hitSize;
    renderer.brightnessMultiplier = params.brightness;
    renderer.roundParticles = params.roundParticles;
    renderer.useBloom = params.bloomEnabled;   // toggle
    renderer.bloomStrength = params.bloomStrength;
    renderer.bloomRadius = params.bloomRadius;
    renderer.updateHits(hits, displayTime, params.persistence);
    renderer.render();

    // ── FPS + HUD ─────────────────────────────────────────────────
    frameCount++;
    fpsTime += dt;
    if (fpsTime >= 0.8) {
      fps = Math.round(frameCount / fpsTime);
      frameCount = 0;
      fpsTime = 0;

      const elapsed = now - rateTime || 1;
      arrivalRateSmooth =
        arrivalRateSmooth * 0.6 + (arrivalCounter / elapsed) * 0.4;
      arrivalCounter = 0;
      rateTime = now;

      const props = physics.bounceProps(physics.beta);
      hud.beta = params.beta.toFixed(3);
      hud.aMin = physics.aMin.toFixed(5);
      hud.wEff = props.wEff.toFixed(2);
      hud.torsionRatio = props.S.toFixed(4);
      hud.flux = arrivalRateSmooth.toFixed(0);
      hud.visible = String(hits.length);
      hud.fps = String(fps);
      // Update screen info in HUD (may change if moved between monitors)
      const si = screenDetector.info;
      hud.screen = `${si.screenWidth}×${si.screenHeight}`;
      hud.hz = `${si.refreshRate}${si.vrrDetected ? " VRR" : ""}`;
      hud.hdr = si.hdrCapable
        ? (si.peakBrightnessNits ? `Yes (~${si.peakBrightnessNits} nits)` : "Yes")
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
