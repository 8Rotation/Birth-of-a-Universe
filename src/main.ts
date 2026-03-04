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
import { MinHeap } from "./physics/min-heap.js";
import type { PendingParticle } from "./physics/shell.js";
import { SensorRenderer, type Hit } from "./rendering/renderer.js";
import { createSensorControls } from "./ui/controls.js";

console.log("[main] Birth of a Universe — ECSK Bounce Sensor");

// ── Configuration ─────────────────────────────────────────────────────────

const MAX_HITS = 150_000;

// ── Info overlay ──────────────────────────────────────────────────────────

const info = document.getElementById("info")!;
function setInfo(text: string) {
  info.textContent = text;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  setInfo("Initializing ECSK Bounce Sensor...");

  // ── 1. Initialize renderer ────────────────────────────────────────
  const renderer = new SensorRenderer({
    maxHits: MAX_HITS,
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

  // ── 2. Physics engine ─────────────────────────────────────────────
  let physics = new ECSKPhysics(0.10);

  // ── 3. State ──────────────────────────────────────────────────────
  let hits: Hit[] = [];  const pendingHeap = new MinHeap<PendingParticle>(p => p.arrivalTime);  let simTime = 0;
  let arrivalCounter = 0;
  let arrivalRateSmooth = 0;
  let lastBeta = physics.beta;

  // ── 4. Controls ───────────────────────────────────────────────────
  const { params, hud, updateHUD } = createSensorControls(() => {
    // Reset
    pendingHeap.clear();
    hits = [];
    simTime = 0;
    arrivalCounter = 0;
    arrivalRateSmooth = 0;
    bridge.reset({
      beta: physics.beta,
      perturbAmplitude: params.perturbAmplitude,
      lMax: params.lMax,
      timeDilation: params.timeDilation,
      seed: Date.now(),
      fieldEvolution: params.fieldEvolution,
    });
  });

  // ── 5. Physics worker (off-thread emission) ────────────────────
  const bridge = new PhysicsBridge({
    beta: physics.beta,
    perturbAmplitude: params.perturbAmplitude,
    lMax: params.lMax,
    timeDilation: params.timeDilation,
    seed: 42,
    fieldEvolution: params.fieldEvolution,
  });

  // ── 6. Arrival processing (heap-backed, O(log N) per extract) ──
  function processArrivals(now: number): void {
    let count = 0;
    while (pendingHeap.length > 0 && pendingHeap.peek()!.arrivalTime <= now) {
      const p = pendingHeap.pop()!;
      hits.push({
        x: p.lx,
        y: p.ly,
        hue: p.hue,
        brightness: p.brightness,
        size: p.hitSize,
        tailAngle: p.tailAngle,
        born: now,
      });
      count++;
    }
    arrivalCounter += count;
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
      // Notify worker; discard stale pending/hits baked at the old β.
      bridge.updateBeta(params.beta);
      pendingHeap.clear();
      hits = [];
    }

    // ── Advance simulation (physics runs off-thread) ──────────────
    if (!params.paused) {
      simTime += dt;

      // Request particles from worker (results arrive next frame)
      bridge.tick(dt, simTime, params.particleRate, {
        perturbAmplitude: params.perturbAmplitude,
        lMax: params.lMax,
        timeDilation: params.timeDilation,
        fieldEvolution: params.fieldEvolution,
      });

      // Insert particles from previous worker tick(s) into heap
      const fresh = bridge.drain();
      for (let i = 0; i < fresh.length; i++) {
        pendingHeap.push(fresh[i]);
      }

      // Guard against unbounded growth if timeDilation is very large
      if (pendingHeap.length > MAX_HITS * 2) {
        pendingHeap.clear();
      }
    }

    // ── Process arrivals ──────────────────────────────────────────
    if (!params.paused) processArrivals(now);

    // ── Fade-expire hits in place (no allocation) ─────────────────
    const cutoff = params.persistence * 2;
    const fadeThreshold = 0.003;
    let writeIdx = 0;
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const age = now - hit.born;
      if (age > cutoff) continue;
      const fade = Math.exp((-age / params.persistence) * 3);
      if (fade < fadeThreshold) continue;
      hits[writeIdx++] = hit;
    }
    hits.length = writeIdx;

    // Enforce budget
    if (hits.length > MAX_HITS) {
      hits = hits.slice(hits.length - MAX_HITS);
    }

    // ── Update renderer ───────────────────────────────────────────
    renderer.hitBaseSize = params.hitSize;
    renderer.brightnessMultiplier = params.brightness;
    renderer.useBloom = params.bloomEnabled;   // toggle
    renderer.bloomStrength = params.bloomStrength;
    renderer.bloomRadius = params.bloomRadius;
    renderer.updateHits(hits, now, params.persistence);
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
