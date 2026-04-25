import { test, expect } from "@playwright/test";

// Task A3 / GPU-02: real-WebGPU validation that the compute emitter
// matches a CPU f32 mirror of the same WGSL algorithm.

test("ComputeEmitter dispatch matches CPU f32 reference under WebGPU", async ({ page }) => {
  const consoleMessages: string[] = [];
  page.on("console", (msg) => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleMessages.push(`[pageerror] ${err.message}`));

  // baseURL in playwright.config.ts already includes the Vite base path,
  // so we use a relative URL here (an absolute `/...` would bypass the base).
  await page.goto("tests-e2e/harness.html");

  // The harness signals completion via window.__ready__.
  await page.waitForFunction(() => (window as unknown as { __ready__?: boolean }).__ready__ === true,
    null,
    { timeout: 30_000 },
  );

  const result = await page.evaluate(() => (window as unknown as {
    __result__?: {
      ok: boolean;
      reason?: string;
      emitCount: number;
      stats: {
        lxRange: [number, number];
        lyRange: [number, number];
        rMax: number;
        hueRange: [number, number];
        brightnessRange: [number, number];
        epsRange: [number, number];
        hitSizeRange: [number, number];
        nanCount: number;
        finiteCount: number;
        comparison: {
          maxAbsErr: number;
          maxRelErr: number;
          worstIndex: number;
          worstField: string;
          cpuValue: number;
          gpuValue: number;
        };
      };
      samples: number[][];
    };
  }).__result__);

  if (!result?.ok) {
    // Surface browser console output to make CI failures debuggable.
    throw new Error(
      `harness failed: ${result?.reason ?? "no result"}\n` +
      consoleMessages.join("\n"),
    );
  }

  // 1. Every dispatched particle was written and is finite.
  expect(result.stats.nanCount).toBe(0);
  expect(result.stats.finiteCount).toBe(result.emitCount);

  // 2. Particles live inside the unit-disc projection (|lx|,|ly| ≤ 2,
  //    radius ≤ 2 since lx = 2·sin(θ/2)·cos(φ)).
  expect(result.stats.rMax).toBeLessThanOrEqual(2.0001);

  // 3. Visual ranges respect their pinned floors/ceilings.
  //    Params: hueMin=30, hueRange=270 → hue ∈ [30, 300].
  expect(result.stats.hueRange[0]).toBeGreaterThanOrEqual(30 - 1e-3);
  expect(result.stats.hueRange[1]).toBeLessThanOrEqual(300 + 1e-3);

  //    brightness ∈ [brightnessFloor=0.05, brightnessCeil=0.95].
  expect(result.stats.brightnessRange[0]).toBeGreaterThanOrEqual(0.05 - 1e-3);
  expect(result.stats.brightnessRange[1]).toBeLessThanOrEqual(0.95 + 1e-3);

  //    hitSize ≈ 1 ± sizeVariation/2 with sizeVariation=0.6 → [0.7, 1.3].
  expect(result.stats.hitSizeRange[0]).toBeGreaterThanOrEqual(0.7 - 1e-3);
  expect(result.stats.hitSizeRange[1]).toBeLessThanOrEqual(1.3 + 1e-3);

  // 4. eps is positive (1/a²·a²) for bounce particles.
  expect(result.stats.epsRange[0]).toBeGreaterThan(0);

  // 5. Actual CPU/GPU parity check. This is the Epic A contract: the
  //    browser harness runs the real WGSL and compares every particle field
  //    to a CPU f32 mirror with the same PCG sequence and dense lMax=8 coeffs.
  expect(result.stats.comparison.maxRelErr, JSON.stringify(result.stats.comparison))
    .toBeLessThan(1e-4);
  expect(result.stats.comparison.maxAbsErr, JSON.stringify(result.stats.comparison))
    .toBeLessThan(2e-3);

  // 6. At least some spatial spread (not all clustered at origin).
  const lxSpan = result.stats.lxRange[1] - result.stats.lxRange[0];
  const lySpan = result.stats.lyRange[1] - result.stats.lyRange[0];
  expect(lxSpan).toBeGreaterThan(0.5);
  expect(lySpan).toBeGreaterThan(0.5);
});
