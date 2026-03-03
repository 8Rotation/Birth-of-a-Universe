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
 * References:
 *   Poplawski 2010b, 2014, 2020, 2020b
 *   Hehl & Datta 1971; Hehl et al. 1976
 */

import { ECSKPhysics } from "./physics/ecsk-physics.js";
import { InfallingShell } from "./physics/shell.js";
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
  let shells: InfallingShell[] = [];
  let hits: Hit[] = [];
  let simTime = 0;
  let lastSpawnTime = 0;
  let shellCounter = 0;
  let arrivalCounter = 0;
  let arrivalRateSmooth = 0;
  let lastBeta = physics.beta;

  // ── 4. Controls ───────────────────────────────────────────────────
  const { params, hud, updateHUD } = createSensorControls(() => {
    // Reset
    shells = [];
    hits = [];
    simTime = 0;
    lastSpawnTime = 0;
    shellCounter = 0;
    arrivalCounter = 0;
    arrivalRateSmooth = 0;
  });

  // ── 5. Shell spawning ─────────────────────────────────────────────
  function spawnShell() {
    shellCounter++;
    shells.push(
      new InfallingShell(
        params.shellSize,
        physics,
        params.perturbAmplitude,
        params.lMax,
        params.timeDilation,
        shellCounter * 7919 + 13, // coprime seed
        simTime,
      ),
    );
  }

  // ── 6. Arrival processing ─────────────────────────────────────────
  function processArrivals(now: number): Hit[] {
    const newHits: Hit[] = [];
    for (let b = shells.length - 1; b >= 0; b--) {
      const shell = shells[b];
      while (
        shell.cursor < shell.size &&
        simTime >= shell.arrivalTime[shell.cursor]
      ) {
        const i = shell.cursor;
        newHits.push({
          x: shell.lx[i],
          y: shell.ly[i],
          hue: shell.hue[i],
          brightness: shell.brightness[i],
          size: shell.hitSize[i],
          tailAngle: shell.tailAngle[i],
          born: now,
        });
        shell.cursor++;
      }
      // Remove fully consumed shells
      if (shell.cursor >= shell.size) shells.splice(b, 1);
    }
    arrivalCounter += newHits.length;
    return newHits;
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

    // ── Advance simulation ────────────────────────────────────────
    if (!params.paused) {
      simTime += dt;

      // Spawn shells at configured rate
      const interval = 1 / Math.max(0.01, params.shellRate);
      if (now - lastSpawnTime > interval) {
        spawnShell();
        lastSpawnTime = now;
      }
    }

    // ── Process arrivals ──────────────────────────────────────────
    const newHits = !params.paused ? processArrivals(now) : [];

    // ── Add to visible hits, fade old ones ────────────────────────
    for (const h of newHits) hits.push(h);

    // Remove expired hits
    const cutoff = params.persistence * 2;
    const fadeThreshold = 0.003;
    const next: Hit[] = [];
    for (const hit of hits) {
      const age = now - hit.born;
      if (age > cutoff) continue;
      const fade = Math.exp((-age / params.persistence) * 3);
      if (fade < fadeThreshold) continue;
      next.push(hit);
    }
    hits = next;

    // Enforce budget
    if (hits.length > MAX_HITS) {
      hits = hits.slice(hits.length - MAX_HITS);
    }

    // ── Update renderer ───────────────────────────────────────────
    renderer.hitBaseSize = params.hitSize;
    renderer.brightnessMultiplier = params.brightness;
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
