import { afterEach, describe, expect, it, vi } from "vitest";
import { PhysicsBridge } from "./physics-bridge";

function baseConfig(seed = 1234) {
  return {
    beta: 0.10,
    kCurvature: 1,
    perturbAmplitude: 0.12,
    lMax: 4,
    nS: 0.965,
    arrivalSpread: 1.0,
    seed,
    fieldEvolution: 0,
    doubleBounce: false,
    betaPP: 0,
  };
}

function tickParams(seed = 1234) {
  const { seed: _seed, ...params } = baseConfig(seed);
  return params;
}

class PassiveWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {}
}

describe("PhysicsBridge worker robustness", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stops restarting after five construction failures", async () => {
    vi.useFakeTimers();

    class ThrowingWorker {
      static constructions = 0;

      constructor() {
        ThrowingWorker.constructions++;
        throw new Error("worker unavailable");
      }
    }

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("Worker", ThrowingWorker);

    const bridge = new PhysicsBridge(baseConfig(), 1);

    await vi.runAllTimersAsync();
    expect(ThrowingWorker.constructions).toBe(5);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("permanently disabled");

    await vi.runAllTimersAsync();
    expect(ThrowingWorker.constructions).toBe(5);

    bridge.dispose();
  });

  it("mixes the session seed into coefficient reseeding", () => {
    vi.stubGlobal("Worker", PassiveWorker);

    const bridgeA = new PhysicsBridge(baseConfig(101), 1);
    const bridgeB = new PhysicsBridge(baseConfig(202), 1);

    const nextParams = { ...tickParams(), lMax: 6 };
    bridgeA.tick(1 / 60, 0, 0, nextParams, 1_000);
    bridgeB.tick(1 / 60, 0, 0, nextParams, 1_000);

    const rngA = bridgeA.getCoeffRng();
    const rngB = bridgeB.getCoeffRng();
    const streamA = [rngA(), rngA(), rngA()];
    const streamB = [rngB(), rngB(), rngB()];

    expect(streamA).not.toEqual(streamB);

    bridgeA.dispose();
    bridgeB.dispose();
  });
});