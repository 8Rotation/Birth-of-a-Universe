/**
 * physics-bridge.ts — Main-thread interface to the physics Web Worker.
 *
 * Creates the worker, sends tick / update messages, and accumulates
 * particle batches for the main animation loop to drain each frame.
 *
 * Particles produced by worker tick N arrive on the main thread one
 * frame later (~16 ms latency at 60 fps) — imperceptible for this
 * visualization, and it frees the main thread for rendering + UI.
 */

import type { PendingParticle } from "./shell.js";

const STRIDE = 7;

export interface PhysicsBridgeConfig {
  beta: number;
  perturbAmplitude: number;
  lMax: number;
  timeDilation: number;
  seed: number;
  fieldEvolution: number;
}

export class PhysicsBridge {
  private worker: Worker;
  private batches: PendingParticle[][] = [];
  private generation = 0;

  constructor(config: PhysicsBridgeConfig) {
    this.worker = new Worker(
      new URL("./physics-worker.ts", import.meta.url),
      { type: "module" },
    );

    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "particles" && msg.count > 0 && msg.data) {
        // Discard batches from a stale generation (pre-reset/pre-updateBeta)
        if (msg.generation !== undefined && msg.generation < this.generation) return;
        this.batches.push(this._unpack(msg.data, msg.count));
      }
    };

    this.worker.postMessage({ type: "init", ...config, generation: this.generation });
  }

  /** Send a tick to the worker — produces particles asynchronously. */
  tick(
    dt: number,
    simTime: number,
    particleRate: number,
    params: {
      perturbAmplitude: number;
      lMax: number;
      timeDilation: number;
      fieldEvolution: number;
    },
  ): void {
    this.worker.postMessage({
      type: "tick",
      dt,
      simTime,
      particleRate,
      generation: this.generation,
      ...params,
    });
  }

  /** Notify the worker that β has changed (recreates physics engine). */
  updateBeta(beta: number): void {
    this.generation++;
    this.worker.postMessage({ type: "updateBeta", beta, generation: this.generation });
    // Discard any queued particles baked at the old β
    this.batches.length = 0;
  }

  /** Reset the worker's emitter (e.g., on user "Clear"). */
  reset(config: PhysicsBridgeConfig): void {
    this.generation++;
    this.worker.postMessage({ type: "reset", ...config, generation: this.generation });
    this.batches.length = 0;
  }

  /**
   * Drain all particle batches accumulated since the last call.
   * Returns a flat array of PendingParticle objects.
   */
  drain(): PendingParticle[] {
    if (this.batches.length === 0) return [];
    if (this.batches.length === 1) {
      const batch = this.batches[0];
      this.batches.length = 0;
      return batch;
    }
    // Multiple batches: flatten
    const result: PendingParticle[] = [];
    for (const batch of this.batches) {
      for (let i = 0; i < batch.length; i++) result.push(batch[i]);
    }
    this.batches.length = 0;
    return result;
  }

  /** Unpack the transferable Float32Array into PendingParticle objects. */
  private _unpack(data: Float32Array, count: number): PendingParticle[] {
    const result: PendingParticle[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const off = i * STRIDE;
      result[i] = {
        lx:          data[off],
        ly:          data[off + 1],
        arrivalTime: data[off + 2],
        hue:         data[off + 3],
        brightness:  data[off + 4],
        hitSize:     data[off + 5],
        tailAngle:   data[off + 6],
      };
    }
    return result;
  }

  dispose(): void {
    this.worker.terminate();
  }
}
