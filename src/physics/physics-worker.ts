/**
 * physics-worker.ts — Off-thread particle emission.
 *
 * Runs StreamEmitter + ECSKPhysics in a Web Worker so the main
 * thread is free for rendering and UI.  Communicates via transferable
 * Float32Arrays for zero-copy particle delivery.
 *
 * Message protocol
 * ────────────────
 * Main → Worker:
 *   {type:'init',   beta, kCurvature, perturbAmplitude, lMax, nS, arrivalSpread, seed, fieldEvolution, doubleBounce, betaPP, coeffs?: Float64Array}
 *   {type:'tick',   dt, simTime, particleRate, beta, kCurvature, perturbAmplitude, lMax, nS, arrivalSpread, fieldEvolution, doubleBounce, betaPP, coeffs?: Float64Array}
 *   {type:'updateBeta', beta, kCurvature}
 *   {type:'reset',  beta, kCurvature, perturbAmplitude, lMax, nS, arrivalSpread, seed, fieldEvolution, doubleBounce, betaPP, coeffs?: Float64Array}
 *
 * Worker → Main:
 *   {type:'particles', count, data: Float32Array | null}
 *
 * Packed particle layout (8 × Float32 per particle, stride 8):
 *   [0] lx   [1] ly   [2] arrivalTime   [3] hue
 *   [4] brightness   [5] eps   [6] hitSize   [7] tailAngle
 */

import { ECSKPhysics } from "./ecsk-physics.js";
import { StreamEmitter } from "./shell.js";
import type { EmitterConfig } from "./shell.js";

const STRIDE = 8;

/**
 * Hard ceiling on particles produced per tick.
 * At high particle rates the accumulator can demand millions of particles
 * per frame; generating them all would choke the worker and backlog the
 * message queue.  50 000 is enough to saturate the 150 000 hit budget in
 * a few seconds while remaining interactive.
 */
const MAX_PARTICLES_PER_TICK = 50_000;

// Worker global scope — typed to expose onmessage/postMessage without full `any`.
// DedicatedWorkerGlobalScope is in lib.webworker.d.ts (not included alongside DOM),
// so we use a narrow interface instead.
interface WorkerSelf {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const _self: WorkerSelf = self as unknown as WorkerSelf;

let physics: ECSKPhysics;
let emitter: StreamEmitter;
let generation = 0;
let currentK = 1;  // spatial curvature, default closed

/** Extract an EmitterConfig (with defaults via Partial) from a worker message. */
function configFromMsg(msg: any): Partial<EmitterConfig> {
  return {
    perturbAmplitude: msg.perturbAmplitude,
    lMax: msg.lMax,
    nS: msg.nS,
    arrivalSpread: msg.arrivalSpread,
    fieldEvolution: msg.fieldEvolution,
    doubleBounce: msg.doubleBounce ?? false,
    betaPP: msg.betaPP ?? 0,
    silkDamping: msg.silkDamping,
    hueMin: msg.hueMin,
    hueRange: msg.hueRange,
    brightnessFloor: msg.brightnessFloor,
    brightnessCeil: msg.brightnessCeil,
    dbSecondHueShift: msg.dbSecondHueShift,
    dbSecondBriScale: msg.dbSecondBriScale,
    ppHueShift: msg.ppHueShift,
    ppBriBoost: msg.ppBriBoost,
    ppSizeScale: msg.ppSizeScale,
    ppBaseDelay: msg.ppBaseDelay,
    ppScatterRange: msg.ppScatterRange,
  };
}

_self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case "init": {
      generation = msg.generation ?? 0;
      currentK = msg.kCurvature ?? 1;
      physics = new ECSKPhysics(msg.beta, currentK);
      emitter = new StreamEmitter(physics, configFromMsg(msg), msg.seed);
      // If the bridge sends centrally-evolved coefficients, apply them
      if (msg.coeffs) emitter.applyCoeffs(msg.coeffs as Float64Array);
      break;
    }

    case "updateBeta": {
      generation = msg.generation ?? generation;
      currentK = msg.kCurvature ?? currentK;
      physics = new ECSKPhysics(msg.beta, currentK);
      break;
    }

    case "reset": {
      generation = msg.generation ?? generation;
      currentK = msg.kCurvature ?? 1;
      physics = new ECSKPhysics(msg.beta, currentK);
      emitter = new StreamEmitter(physics, configFromMsg(msg), msg.seed);
      // If the bridge sends centrally-evolved coefficients, apply them
      if (msg.coeffs) emitter.applyCoeffs(msg.coeffs as Float64Array);
      break;
    }

    case "tick": {
      // Drop stale ticks that were queued before a reset/updateBeta
      if (msg.generation !== undefined && msg.generation < generation) break;

      // Adopt the latest generation so responses carry the current tag.
      // Without this, flushPipeline() bumps the bridge generation but the
      // worker keeps stamping responses with the old value — the bridge
      // then silently discards every response as "stale".
      if (msg.generation !== undefined) generation = msg.generation;

      const tickStart = performance.now();

      // Continuously track β and k from tick params so slider drags
      // propagate without a disruptive generation bump.
      const tickK = msg.kCurvature ?? currentK;
      if (msg.beta !== undefined && (Math.abs(msg.beta - physics.beta) > 1e-6 || tickK !== currentK)) {
        currentK = tickK;
        physics = new ECSKPhysics(msg.beta, currentK);
      }

      // Sync emitter with latest slider values
      emitter.update(physics, configFromMsg(msg));

      // Apply centrally-evolved coefficients (multi-worker coherence).
      // When the bridge sends coeffs, the emitter skips its own O-U
      // evolution and uses these authoritative values instead.
      if (msg.coeffs) emitter.applyCoeffs(msg.coeffs as Float64Array);

      // Cap particle rate so the worker never chokes on a single tick
      const cappedRate = Math.min(msg.particleRate, MAX_PARTICLES_PER_TICK / Math.max(msg.dt, 1e-4));
      const particles = emitter.tick(msg.dt, msg.simTime, cappedRate);
      const count = particles.length;

      const tickElapsedMs = performance.now() - tickStart;

      if (count === 0) {
        _self.postMessage({ type: "particles", count: 0, data: null, generation, tickMs: tickElapsedMs });
        break;
      }

      // Pack into Float32Array for zero-copy transfer
      const buf = new Float32Array(count * STRIDE);
      for (let i = 0; i < count; i++) {
        const p = particles[i];
        const off = i * STRIDE;
        buf[off]     = p.lx;
        buf[off + 1] = p.ly;
        buf[off + 2] = p.arrivalTime;
        buf[off + 3] = p.hue;
        buf[off + 4] = p.brightness;
        buf[off + 5] = p.eps;
        buf[off + 6] = p.hitSize;
        buf[off + 7] = p.tailAngle;
      }

      // Transfer the ArrayBuffer (zero-copy handoff to main thread)
      _self.postMessage(
        { type: "particles", count, data: buf, generation, tickMs: tickElapsedMs },
        [buf.buffer],
      );
      break;
    }
  }
};
