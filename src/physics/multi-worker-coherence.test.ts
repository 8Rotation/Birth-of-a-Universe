import { describe, expect, it } from "vitest";
import { generatePerturbCoeffs, splitmix32 } from "./perturbation";
import { createWorkerRuntime, stepWorkerRuntime } from "./physics-worker";
import type { WorkerInitMsg, WorkerTickMsg } from "./worker-protocol";

function bytes(data: Float32Array | null): number[] {
  if (!data) return [];
  return Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

describe("multi-worker coefficient coherence", () => {
  it("produces byte-identical batches for matching seeds and coefficients", () => {
    const baseParams = {
      beta: 0.10,
      kCurvature: 1,
      perturbAmplitude: 0.12,
      lMax: 4,
      nS: 0.965,
      arrivalSpread: 1.0,
      fieldEvolution: 0,
      doubleBounce: false,
      betaPP: 0,
      maxParticlesPerTick: 2_000,
    };
    const centralCoeffs = new Float64Array(
      generatePerturbCoeffs(
        baseParams.lMax,
        baseParams.perturbAmplitude,
        splitmix32(777),
        baseParams.nS,
      ).map((mode) => mode.c),
    );
    const init = {
      kind: "init",
      ...baseParams,
      seed: 42,
      generation: 0,
      coeffs: centralCoeffs,
    } satisfies WorkerInitMsg;

    const runtimeA = createWorkerRuntime(init);
    const runtimeB = createWorkerRuntime(init);

    for (let i = 0; i < 100; i++) {
      const tick = {
        kind: "tick",
        ...baseParams,
        dt: 1 / 60,
        simTime: i / 60,
        particleRate: 600,
        generation: 0,
        coeffs: centralCoeffs,
      } satisfies WorkerTickMsg;

      const outA = stepWorkerRuntime(runtimeA, tick, () => i);
      const outB = stepWorkerRuntime(runtimeB, tick, () => i);

      expect(outA?.count).toBe(outB?.count);
      expect(bytes(outA?.data ?? null)).toEqual(bytes(outB?.data ?? null));
    }
  });
});