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
 *   {type:'init',   beta, perturbAmplitude, lMax, timeDilation, seed, fieldEvolution}
 *   {type:'tick',   dt, simTime, particleRate, perturbAmplitude, lMax, timeDilation, fieldEvolution}
 *   {type:'updateBeta', beta}
 *   {type:'reset',  beta, perturbAmplitude, lMax, timeDilation, seed, fieldEvolution}
 *
 * Worker → Main:
 *   {type:'particles', count, data: Float32Array | null}
 *
 * Packed particle layout (7 × Float32 per particle, stride 7):
 *   [0] lx   [1] ly   [2] arrivalTime   [3] hue
 *   [4] brightness   [5] hitSize   [6] tailAngle
 */

import { ECSKPhysics } from "./ecsk-physics.js";
import { StreamEmitter } from "./shell.js";

const STRIDE = 7;

/* eslint-disable @typescript-eslint/no-explicit-any */
const _self = self as any;

let physics: ECSKPhysics;
let emitter: StreamEmitter;

_self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case "init": {
      physics = new ECSKPhysics(msg.beta);
      emitter = new StreamEmitter(
        physics,
        msg.perturbAmplitude,
        msg.lMax,
        msg.timeDilation,
        msg.seed,
        msg.fieldEvolution,
      );
      break;
    }

    case "updateBeta": {
      physics = new ECSKPhysics(msg.beta);
      break;
    }

    case "reset": {
      physics = new ECSKPhysics(msg.beta);
      emitter = new StreamEmitter(
        physics,
        msg.perturbAmplitude,
        msg.lMax,
        msg.timeDilation,
        msg.seed,
        msg.fieldEvolution,
      );
      break;
    }

    case "tick": {
      // Sync emitter with latest slider values
      emitter.update(
        physics,
        msg.perturbAmplitude,
        msg.lMax,
        msg.timeDilation,
        msg.fieldEvolution,
      );

      const particles = emitter.tick(msg.dt, msg.simTime, msg.particleRate);
      const count = particles.length;

      if (count === 0) {
        _self.postMessage({ type: "particles", count: 0, data: null });
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
        buf[off + 5] = p.hitSize;
        buf[off + 6] = p.tailAngle;
      }

      // Transfer the ArrayBuffer (zero-copy handoff to main thread)
      _self.postMessage(
        { type: "particles", count, data: buf },
        [buf.buffer],
      );
      break;
    }
  }
};
