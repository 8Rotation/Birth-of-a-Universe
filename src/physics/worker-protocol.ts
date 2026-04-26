import type { EmitterConfig } from "./shell.js";

export interface WorkerPhysicsParams extends Partial<EmitterConfig> {
  beta: number;
  kCurvature: number;
  perturbAmplitude: number;
  lMax: number;
  nS: number;
  arrivalSpread: number;
  fieldEvolution: number;
  doubleBounce: boolean;
  betaPP: number;
}

export interface WorkerConfigFields extends WorkerPhysicsParams {
  seed: number;
}

export type WorkerInitMsg = {
  kind: "init";
  generation: number;
  coeffs?: Float64Array;
} & WorkerConfigFields;

export type WorkerResetMsg = {
  kind: "reset";
  generation: number;
  coeffs?: Float64Array;
} & WorkerConfigFields;

export interface WorkerUpdateBetaMsg {
  kind: "updateBeta";
  beta: number;
  kCurvature: number;
  generation: number;
}

export type WorkerTickMsg = {
  kind: "tick";
  dt: number;
  simTime: number;
  particleRate: number;
  generation: number;
  coeffs: Float64Array;
  maxParticlesPerTick?: number;
} & WorkerPhysicsParams;

export type WorkerInMsg = WorkerInitMsg | WorkerResetMsg | WorkerUpdateBetaMsg | WorkerTickMsg;

export interface WorkerParticlesMsg {
  kind: "particles";
  count: number;
  data: Float32Array | null;
  generation: number;
  tickMs: number;
}

export type WorkerOutMsg = WorkerParticlesMsg;