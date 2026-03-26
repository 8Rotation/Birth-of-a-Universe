/**
 * physics-bridge.ts — Main-thread interface to N physics Web Workers.
 *
 * Creates `workerCount` workers (from hardware budget), partitions the
 * particle rate across them, and accumulates particle batches for the
 * main animation loop to drain each frame.
 *
 * Perturbation field coherence: the O-U coefficient evolution is driven
 * centrally on the main thread and broadcast to all workers each tick.
 * This ensures spatial structure is identical across workers — only the
 * random sampling positions differ (each worker has a unique PRNG seed).
 *
 * Particles produced by worker tick N arrive on the main thread one
 * frame later (~16 ms latency at 60 fps) — imperceptible for this
 * visualization, and it frees the main thread for rendering + UI.
 */

import {
  generatePerturbCoeffs,
  evolveCoeffs,
  rescaleCoeffSigmas,
  splitmix32,
  DEFAULT_SILK_DAMPING,
} from "./perturbation.js";
import type { PerturbMode } from "./perturbation.js";

/** A raw particle batch from the worker — avoids per-particle object creation. */
export interface RawParticleBatch {
  data: Float32Array;
  count: number;
}

/**
 * Packed float stride: 8 floats per particle.
 *   [0] lx   [1] ly   [2] arrivalTime   [3] hue
 *   [4] brightness   [5] eps   [6] hitSize   [7] tailAngle
 */
export const PARTICLE_STRIDE = 8;

export interface PhysicsBridgeConfig {
  beta: number;
  kCurvature: number;
  perturbAmplitude: number;
  lMax: number;
  nS: number;
  arrivalSpread: number;
  seed: number;
  fieldEvolution: number;
  doubleBounce: boolean;
  betaPP: number;
  silkDamping?: number;
  hueMin?: number;
  hueRange?: number;
  brightnessFloor?: number;
  brightnessCeil?: number;
  dbSecondHueShift?: number;
  dbSecondBriScale?: number;
  ppHueShift?: number;
  ppBriBoost?: number;
  ppSizeScale?: number;
  ppBaseDelay?: number;
  ppScatterRange?: number;
  sizeVariation?: number;
}

type TickParams = {
  beta: number;
  kCurvature: number;
  perturbAmplitude: number;
  lMax: number;
  nS: number;
  arrivalSpread: number;
  fieldEvolution: number;
  doubleBounce: boolean;
  betaPP: number;
  silkDamping?: number;
  hueMin?: number;
  hueRange?: number;
  brightnessFloor?: number;
  brightnessCeil?: number;
  dbSecondHueShift?: number;
  dbSecondBriScale?: number;
  ppHueShift?: number;
  ppBriBoost?: number;
  ppSizeScale?: number;
  ppBaseDelay?: number;
  ppScatterRange?: number;
  sizeVariation?: number;
};

type TickMessage = {
  type: "tick";
  dt: number;
  simTime: number;
  particleRate: number;
  generation: number;
  coeffs: Float64Array;
} & TickParams;

interface WorkerTickState {
  busy: boolean;
  pendingTick: TickMessage | null;
}

export class PhysicsBridge {
  private workers: Worker[] = [];
  private workerStates: WorkerTickState[] = [];
  private batches: RawParticleBatch[] = [];
  private generation = 0;
  readonly workerCount: number;

  // ── CPU timing aggregation ──────────────────────────────────────
  // Workers report elapsed ms per tick; we aggregate into utilization %.
  private _workerTickMsAccum = 0;   // total worker ms accumulated
  private _workerTickCount = 0;     // number of tick reports received
  private _cpuLoadSmooth = 0;       // EMA-smoothed CPU load (0–1)

  /** EMA-smoothed CPU utilization (0–1): fraction of available worker time used for physics. */
  get cpuLoad(): number { return this._cpuLoadSmooth; }

  // ── Centralised perturbation state ──────────────────────────────
  // Evolved on the main thread; broadcast to all workers each tick
  // so the spatial pattern is coherent across workers.
  private coeffs: PerturbMode[];
  private coeffRng: () => number;
  private _lastLMax: number;
  private _lastAmplitude: number;
  private _lastNS: number;
  private _lastSilkDamping: number;

  private _postTick(index: number, msg: TickMessage): void {
    const state = this.workerStates[index];
    if (!state) return;
    if (state.busy) {
      state.pendingTick = msg;
      return;
    }
    state.busy = true;
    state.pendingTick = null;
    this.workers[index].postMessage(msg);
  }

  private _clearWorkerTickState(): void {
    for (let i = 0; i < this.workerStates.length; i++) {
      this.workerStates[i].busy = false;
      this.workerStates[i].pendingTick = null;
    }
  }

  private _createWorker(index: number, config: PhysicsBridgeConfig): Worker {
    const workerSeed = (config.seed ^ (index * 0x9e3779b9)) >>> 0;
    const worker = new Worker(
      new URL("./physics-worker.ts", import.meta.url),
      { type: "module" },
    );

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "particles" && msg.count > 0 && msg.data) {
        if (msg.generation !== undefined && msg.generation < this.generation) return;
        this.batches.push({ data: msg.data as Float32Array, count: msg.count as number });
      }
      if (typeof msg.tickMs === 'number') {
        this._workerTickMsAccum += msg.tickMs;
        this._workerTickCount++;
      }

      const state = this.workerStates[index];
      if (!state) return;
      state.busy = false;

      const pending = state.pendingTick;
      if (pending && pending.generation === this.generation) {
        state.pendingTick = null;
        this._postTick(index, pending);
      } else {
        state.pendingTick = null;
      }
    };

    worker.onerror = (err: ErrorEvent) => {
      console.error(`[bridge] Worker ${index} error:`, err.message);
      const state = this.workerStates[index];
      if (state) {
        state.busy = false;
        state.pendingTick = null;
      }
    };

    worker.postMessage({
      type: "init",
      ...config,
      seed: workerSeed,
      generation: this.generation,
      coeffs: this._packCoeffs(),
    });

    return worker;
  }

  constructor(config: PhysicsBridgeConfig, workerCount = 1) {
    this.workerCount = Math.max(1, workerCount);

    // Initialise central perturbation field
    const silkDamping = config.silkDamping ?? DEFAULT_SILK_DAMPING;
    this.coeffRng = splitmix32(config.seed);
    this.coeffs = generatePerturbCoeffs(
      config.lMax,
      config.perturbAmplitude,
      this.coeffRng,
      config.nS,
      silkDamping,
    );
    this._lastLMax = config.lMax;
    this._lastAmplitude = config.perturbAmplitude;
    this._lastNS = config.nS;
    this._lastSilkDamping = silkDamping;

    // Create N workers, each with a unique seed derived from the session seed
    for (let i = 0; i < this.workerCount; i++) {
      this.workerStates.push({ busy: false, pendingTick: null });
      this.workers.push(this._createWorker(i, config));
    }

    if (this.workerCount > 1) {
      console.log(`[bridge] Created ${this.workerCount} physics workers (centralised coefficients)`);
    }
  }

  /**
   * Compute and return EMA-smoothed CPU utilization, then reset accumulators.
   * Call once per HUD update interval (e.g. every 0.8s).
   * @param dtSec  Elapsed wall-clock seconds since last call.
   */
  updateCpuLoad(dtSec: number): number {
    if (this._workerTickCount > 0 && dtSec > 0) {
      // Total available worker time in this interval (ms)
      const availableMs = this.workerCount * dtSec * 1000;
      const rawLoad = availableMs > 0 ? this._workerTickMsAccum / availableMs : 0;
      // EMA smoothing (α ≈ 0.4 for responsive yet stable display)
      this._cpuLoadSmooth = this._cpuLoadSmooth * 0.6 + rawLoad * 0.4;
    }
    this._workerTickMsAccum = 0;
    this._workerTickCount = 0;
    return this._cpuLoadSmooth;
  }

  /** Pack coefficient `c` values into a Float64Array for transfer. */
  private _packCoeffs(): Float64Array {
    const packed = new Float64Array(this.coeffs.length);
    for (let i = 0; i < this.coeffs.length; i++) {
      packed[i] = this.coeffs[i].c;
    }
    return packed;
  }

  /**
   * Update centralised perturbation field when params change.
   * Called before broadcasting to workers.
   */
  private _syncCoeffs(params: {
    lMax: number;
    nS: number;
    perturbAmplitude: number;
    silkDamping?: number;
  }): void {
    const lMax = params.lMax;
    const nS = params.nS;
    const amplitude = params.perturbAmplitude;
    const silkDamping = params.silkDamping ?? this._lastSilkDamping;

    if (lMax !== this._lastLMax || nS !== this._lastNS || silkDamping !== this._lastSilkDamping) {
      // Regenerate from scratch — structural params changed
      this.coeffRng = splitmix32(((this._lastLMax * 6271) ^ lMax) >>> 0);
      this.coeffs = generatePerturbCoeffs(lMax, amplitude, this.coeffRng, nS, silkDamping);
      this._lastLMax = lMax;
      this._lastNS = nS;
      this._lastAmplitude = amplitude;
      this._lastSilkDamping = silkDamping;
    } else if (amplitude !== this._lastAmplitude) {
      rescaleCoeffSigmas(this.coeffs, lMax, amplitude, nS, silkDamping);
      this._lastAmplitude = amplitude;
    }
  }

  /** Send a tick to all workers — produces particles asynchronously. */
  tick(
    dt: number,
    simTime: number,
    particleRate: number,
    params: TickParams,
  ): void {
    // Update centralised perturbation coefficients
    this._syncCoeffs(params);

    // Evolve O-U coefficients centrally (one evolution for all workers)
    evolveCoeffs(this.coeffs, dt, params.fieldEvolution, this.coeffRng);

    // Pack coefficients for broadcast
    const packedCoeffs = this._packCoeffs();

    // Partition rate across workers (each gets an equal share)
    const ratePerWorker = particleRate / this.workerCount;

    const msg: TickMessage = {
      type: "tick" as const,
      dt,
      simTime,
      particleRate: ratePerWorker,
      generation: this.generation,
      coeffs: packedCoeffs,
      ...params,
    };

    for (let i = 0; i < this.workers.length; i++) {
      this._postTick(i, msg);
    }
  }

  /** Notify all workers that β or k has changed (recreates physics engine). */
  updatePhysics(beta: number, kCurvature: number): void {
    this.generation++;
    this._clearWorkerTickState();
    for (const worker of this.workers) {
      worker.postMessage({ type: "updateBeta", beta, kCurvature, generation: this.generation });
    }
    // Discard any queued particles baked at the old β/k
    this.batches.length = 0;
  }

  /**
   * Flush the pipeline — discard all in-flight and queued particle
   * batches.  Bumps the generation so any worker responses still in
   * transit are silently dropped by the onmessage handler.
   */
  flushPipeline(): void {
    this.generation++;
    this._clearWorkerTickState();
    this.batches.length = 0;
  }

  /** Reset all workers' emitters (e.g., on user "Clear"). */
  reset(config: PhysicsBridgeConfig): void {
    this.generation++;
    this._clearWorkerTickState();

    // Re-initialise central perturbation field
    const silkDamping = config.silkDamping ?? DEFAULT_SILK_DAMPING;
    this.coeffRng = splitmix32(config.seed);
    this.coeffs = generatePerturbCoeffs(
      config.lMax,
      config.perturbAmplitude,
      this.coeffRng,
      config.nS,
      silkDamping,
    );
    this._lastLMax = config.lMax;
    this._lastAmplitude = config.perturbAmplitude;
    this._lastNS = config.nS;
    this._lastSilkDamping = silkDamping;

    for (let i = 0; i < this.workers.length; i++) {
      const workerSeed = (config.seed ^ (i * 0x9e3779b9)) >>> 0;
      this.workers[i].postMessage({
        type: "reset",
        ...config,
        seed: workerSeed,
        generation: this.generation,
        coeffs: this._packCoeffs(),
      });
    }
    this.batches.length = 0;
  }

  /**
   * Drain all raw particle batches accumulated since the last call.
   * Returns the batch array directly — no per-particle object creation.
   * Caller reads Float32Array data by stride offset.
   */
  drain(): RawParticleBatch[] {
    if (this.batches.length === 0) return [];
    const result = this.batches;
    this.batches = [];
    return result;
  }

  /**
   * Full restart: terminate all workers and create fresh ones.
   * Recovers from worker crashes and fully resets emission state.
   * Equivalent to tearing down and reconstructing the bridge,
   * but reuses the same PhysicsBridge instance.
   */
  restart(config: PhysicsBridgeConfig): void {
    // Terminate all existing workers
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.workerStates = [];
    this.batches = [];
    this.generation++;

    // Re-initialise central perturbation field
    const silkDamping = config.silkDamping ?? DEFAULT_SILK_DAMPING;
    this.coeffRng = splitmix32(config.seed);
    this.coeffs = generatePerturbCoeffs(
      config.lMax,
      config.perturbAmplitude,
      this.coeffRng,
      config.nS,
      silkDamping,
    );
    this._lastLMax = config.lMax;
    this._lastAmplitude = config.perturbAmplitude;
    this._lastNS = config.nS;
    this._lastSilkDamping = silkDamping;

    // Create fresh workers
    for (let i = 0; i < this.workerCount; i++) {
      this.workerStates.push({ busy: false, pendingTick: null });
      this.workers.push(this._createWorker(i, config));
    }

    console.log(`[bridge] Restarted ${this.workerCount} physics workers`);
  }

  dispose(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
  }
}
