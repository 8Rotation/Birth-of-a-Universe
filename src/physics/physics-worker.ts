/**
 * physics-worker.ts — Off-thread particle emission.
 *
 * Runs StreamEmitter + ECSKPhysics in a Web Worker so the main
 * thread is free for rendering and UI.  Communicates via transferable
 * Float32Arrays for zero-copy particle delivery.
 *
 * Message protocol is typed in worker-protocol.ts.
 *
 * Packed particle layout (8 × Float32 per particle, stride 8):
 *   [0] lx   [1] ly   [2] arrivalTime   [3] hue
 *   [4] brightness   [5] eps   [6] hitSize   [7] tailAngle
 */

import { ECSKPhysics } from "./ecsk-physics.js";
import { StreamEmitter, estimateMaxEmissionMultiplier } from "./shell.js";
import type { EmitterConfig } from "./shell.js";
import type {
  WorkerInMsg,
  WorkerInitMsg,
  WorkerOutMsg,
  WorkerParticlesMsg,
  WorkerPhysicsParams,
  WorkerResetMsg,
  WorkerTickMsg,
  WorkerUpdateBetaMsg,
} from "./worker-protocol.js";

/**
 * Hard ceiling on particles produced per tick.
 * Dynamically set per-device via ComputeBudget.maxParticlesPerTick;
 * this fallback is used only if the budget value is missing.
 */
const DEFAULT_MAX_PARTICLES_PER_TICK = 50_000;

// Worker global scope — typed to expose onmessage/postMessage without full `any`.
// DedicatedWorkerGlobalScope is in lib.webworker.d.ts (not included alongside DOM),
// so we use a narrow interface instead.
interface WorkerSelf {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export interface WorkerRuntimeState {
  physics: ECSKPhysics;
  emitter: StreamEmitter;
  generation: number;
  currentK: number;
}

function assertNever(msg: never): never {
  throw new Error(`Unhandled worker message kind: ${JSON.stringify(msg)}`);
}

/** Extract an EmitterConfig (with defaults via Partial) from a worker message. */
export function configFromMsg(msg: WorkerInMsg): Partial<EmitterConfig> {
  switch (msg.kind) {
    case "init":
    case "reset":
    case "tick":
      return configFromFields(msg);
    case "updateBeta":
      return {};
    default:
      return assertNever(msg);
  }
}

function configFromFields(msg: WorkerPhysicsParams): Partial<EmitterConfig> {
  return {
    perturbAmplitude: msg.perturbAmplitude,
    lMax: msg.lMax,
    nS: msg.nS,
    arrivalSpread: msg.arrivalSpread,
    fieldEvolution: msg.fieldEvolution,
    doubleBounce: msg.doubleBounce,
    betaPP: msg.betaPP,
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
    sizeVariation: msg.sizeVariation,
    ppFractionCap: msg.ppFractionCap,
  };
}

export function createWorkerRuntime(msg: WorkerInitMsg | WorkerResetMsg): WorkerRuntimeState {
  const currentK = msg.kCurvature;
  const physics = new ECSKPhysics(msg.beta, currentK);
  const emitter = new StreamEmitter(physics, configFromMsg(msg), msg.seed);
  if (msg.coeffs) emitter.applyCoeffs(msg.coeffs);
  return {
    physics,
    emitter,
    generation: msg.generation,
    currentK,
  };
}

export function updateWorkerRuntimePhysics(state: WorkerRuntimeState, msg: WorkerUpdateBetaMsg): void {
  state.generation = msg.generation;
  state.currentK = msg.kCurvature;
  state.physics = new ECSKPhysics(msg.beta, state.currentK);
}

export function stepWorkerRuntime(
  state: WorkerRuntimeState,
  msg: WorkerTickMsg,
  nowMs: () => number = () => performance.now(),
): WorkerParticlesMsg | null {
  if (msg.generation < state.generation) return null;

  // Adopt the latest generation so responses carry the current tag.
  // Without this, flushPipeline() bumps the bridge generation but the
  // worker keeps stamping responses with the old value — the bridge
  // then silently discards every response as "stale".
  state.generation = msg.generation;

  const tickStart = nowMs();

  // Continuously track β and k from tick params so slider drags
  // propagate without a disruptive generation bump.
  const tickK = msg.kCurvature;
  if (Math.abs(msg.beta - state.physics.beta) > 1e-6 || tickK !== state.currentK) {
    state.currentK = tickK;
    state.physics = new ECSKPhysics(msg.beta, state.currentK);
  }

  const tickConfig = configFromMsg(msg);
  state.emitter.update(state.physics, tickConfig);

  // Apply centrally-evolved coefficients (multi-worker coherence).
  // When the bridge sends coeffs, the emitter skips its own O-U
  // evolution and uses these authoritative values instead.
  state.emitter.applyCoeffs(msg.coeffs);

  const maxParticlesPerTick = msg.maxParticlesPerTick ?? DEFAULT_MAX_PARTICLES_PER_TICK;
  const maxEmissionMultiplier = estimateMaxEmissionMultiplier(tickConfig, tickK);
  const cappedRate = Math.min(
    msg.particleRate,
    maxParticlesPerTick / (Math.max(msg.dt, 1e-4) * Math.max(1, maxEmissionMultiplier)),
  );
  const batch = state.emitter.tick(msg.dt, msg.simTime, cappedRate);

  const tickElapsedMs = nowMs() - tickStart;

  if (batch.count === 0) {
    return { kind: "particles", count: 0, data: null, generation: state.generation, tickMs: tickElapsedMs };
  }

  return {
    kind: "particles",
    count: batch.count,
    data: batch.data,
    generation: state.generation,
    tickMs: tickElapsedMs,
  };
}

let runtime: WorkerRuntimeState | null = null;

function postWorkerMessage(scope: WorkerSelf, msg: WorkerOutMsg): void {
  if (msg.data) {
    scope.postMessage(msg, [msg.data.buffer as Transferable]);
  } else {
    scope.postMessage(msg);
  }
}

function handleWorkerMessage(scope: WorkerSelf, msg: WorkerInMsg): void {
  switch (msg.kind) {
    case "init": {
      runtime = createWorkerRuntime(msg);
      break;
    }

    case "updateBeta": {
      if (runtime) updateWorkerRuntimePhysics(runtime, msg);
      break;
    }

    case "reset": {
      runtime = createWorkerRuntime(msg);
      break;
    }

    case "tick": {
      if (!runtime) break;
      const result = stepWorkerRuntime(runtime, msg);
      if (result) postWorkerMessage(scope, result);
      break;
    }

    default:
      assertNever(msg);
  }
}

const _self: WorkerSelf | null = typeof self === "undefined" ? null : self as unknown as WorkerSelf;
if (_self) {
  _self.onmessage = (e: MessageEvent) => {
    handleWorkerMessage(_self, e.data as WorkerInMsg);
  };
}
