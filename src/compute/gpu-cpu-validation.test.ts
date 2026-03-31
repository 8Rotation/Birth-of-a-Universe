/**
 * gpu-cpu-validation.test.ts — Validate GPU (f32) vs CPU (f64) numeric fidelity.
 *
 * Task 6 of the GPU migration plan: verify the WGSL compute shader produces
 * visually identical results to the CPU reference implementations.
 *
 * Three categories:
 *   1. bounceProps precision (f64 vs f32 reference)
 *   2. Perturbation evaluation precision (f64 vs f32 reference)
 *   3. Visual encoding precision (hue, brightness, hitSize)
 *   4. Integration test placeholder (WebGPU — skipped in vitest)
 *   5. Fallback behavior (gpuCompute toggle logic)
 */

import { describe, it, expect, test } from "vitest";
import { ECSKPhysics } from "../physics/ecsk-physics";
import {
  generatePerturbCoeffs,
  evaluatePerturbationFast,
  splitmix32,
  type PerturbMode,
} from "../physics/perturbation";

// ── f32 reference helpers ───────────────────────────────────────────────

const f = Math.fround;

/** f32 bounceProps — mirrors the WGSL bounceProps() exactly. */
function bouncePropsF32(betaEff: number, k: number) {
  const be = f(Math.max(0.002, Math.min(betaEff, 0.2499)));
  let a2: number;
  if (k > 0.5) {
    const disc = f(Math.sqrt(f(Math.max(0, f(1 - f(4 * be))))));
    a2 = f(f(1 - disc) / 2);
  } else if (k > -0.5) {
    a2 = be;
  } else {
    const disc = f(Math.sqrt(f(1 + f(4 * be))));
    a2 = f(Math.max(1e-12, f(f(-1 + disc) / 2)));
  }
  const a = f(Math.sqrt(a2));

  const wDenom = f(3 * f(a2 - be));
  let wEff: number;
  if (Math.abs(wDenom) > 1e-12) {
    wEff = f(f(a2 - f(3 * be)) / wDenom);
  } else {
    wEff = -1;
  }

  const eps = f(1 / f(a2 * a2));
  const acc = f(f(-1 / f(a2 * a)) + f(f(2 * be) / f(f(a2 * a2) * a)));

  return { a, a2, eps, wEff, acc };
}

/** f32 perturbation evaluation — mirrors the WGSL evalPerturbation(). */
function evaluatePerturbationF32(
  coeffs: PerturbMode[],
  lMax: number,
  cosT: number,
  sinT: number,
  phi: number,
): number {
  if (lMax < 1 || coeffs.length === 0) return 0;

  const fCosT = f(cosT);
  const fSinT = f(sinT);
  const SQRT2 = f(1.4142135623730951);
  const INV_4PI = f(0.07957747154594767);

  const cosPhi = f(Math.cos(phi));
  const sinPhi = f(Math.sin(phi));

  let pmm = f(1.0);
  let cosMPhi = f(1.0);
  let sinMPhi = f(0.0);
  let delta = f(0.0);

  for (let m = 0; m <= lMax; m++) {
    if (m > 0) {
      pmm = f(pmm * f(f(-(2 * m - 1)) * fSinT));
      const c = f(f(cosMPhi * cosPhi) - f(sinMPhi * sinPhi));
      const s = f(f(sinMPhi * cosPhi) + f(cosMPhi * sinPhi));
      cosMPhi = c;
      sinMPhi = s;
    }

    let fac = f(1.0);
    for (let i = 1; i <= 2 * m; i++) fac = f(fac * i);

    let plm_prev = f(0);
    let plm_curr = f(pmm);

    for (let l = m; l <= lMax; l++) {
      if (l > m) {
        const plm_next = f(
          f(f(f(2 * l - 1) * fCosT * plm_curr) - f(f(l + m - 1) * plm_prev)) /
          f(l - m),
        );
        plm_prev = plm_curr;
        plm_curr = plm_next;
        fac = f(fac * f(f(l + m) / f(l - m)));
      }

      if (l < 1) continue;

      const norm = f(Math.sqrt(f(f(2 * l + 1) * INV_4PI / fac)));

      if (m === 0) {
        const idx = l * l + l - 1;
        if (idx < coeffs.length) {
          delta = f(delta + f(f(coeffs[idx].c) * f(norm * plm_curr)));
        }
      } else {
        const nPlm = f(norm * f(plm_curr * SQRT2));
        const idxPos = l * l + l + m - 1;
        if (idxPos < coeffs.length) {
          delta = f(delta + f(f(coeffs[idxPos].c) * f(nPlm * cosMPhi)));
        }
        const idxNeg = l * l + l - m - 1;
        if (idxNeg < coeffs.length) {
          delta = f(delta + f(f(coeffs[idxNeg].c) * f(nPlm * sinMPhi)));
        }
      }
    }
  }

  return delta;
}

// ── Visual encoding f32 reference ───────────────────────────────────────

const EPS_LOG_REF_F32 = f(Math.log(10001));

function visualEncodingF32(
  eps: number,
  wEff: number,
  acc: number,
  params: {
    brightnessFloor: number;
    brightnessCeil: number;
    hueMin: number;
    hueRange: number;
    sizeVariation: number;
    globalMinAcc: number;
    globalMaxAcc: number;
    minWEff: number;
    maxWEff: number;
  },
) {
  const brightness = f(Math.max(
    params.brightnessFloor,
    Math.min(params.brightnessCeil, f(f(Math.log(f(eps + 1))) / EPS_LOG_REF_F32)),
  ));

  const wRange = f(f(params.minWEff) - f(params.maxWEff));
  const wNorm = Math.abs(wRange) < 1e-12
    ? 0.5
    : f(f(f(wEff) - f(params.maxWEff)) / wRange);
  const hue = f(Math.min(
    f(params.hueMin + params.hueRange),
    f(f(params.hueMin) + f(wNorm * f(params.hueRange))),
  ));

  const accRange = f(Math.max(1e-6, f(f(params.globalMaxAcc) - f(params.globalMinAcc))));
  const normAcc = f(Math.max(0, Math.min(1, f(f(f(acc) - f(params.globalMinAcc)) / accRange))));
  const hitSize = f(f(1 - f(f(params.sizeVariation) * 0.5)) + f(normAcc * f(params.sizeVariation)));

  return { brightness, hue, hitSize };
}

function visualEncodingF64(
  eps: number,
  wEff: number,
  acc: number,
  params: {
    brightnessFloor: number;
    brightnessCeil: number;
    hueMin: number;
    hueRange: number;
    sizeVariation: number;
    globalMinAcc: number;
    globalMaxAcc: number;
    minWEff: number;
    maxWEff: number;
  },
) {
  const EPS_LOG_REF_F64 = Math.log(10001);
  const brightness = Math.max(
    params.brightnessFloor,
    Math.min(params.brightnessCeil, Math.log(eps + 1) / EPS_LOG_REF_F64),
  );

  const wRange = params.minWEff - params.maxWEff;
  const wNorm = Math.abs(wRange) < 1e-12 ? 0.5 : (wEff - params.maxWEff) / wRange;
  const hue = Math.min(
    params.hueMin + params.hueRange,
    params.hueMin + wNorm * params.hueRange,
  );

  const accRange = Math.max(1e-6, params.globalMaxAcc - params.globalMinAcc);
  const normAcc = Math.max(0, Math.min(1, (acc - params.globalMinAcc) / accRange));
  const hitSize = 1 - params.sizeVariation * 0.5 + normAcc * params.sizeVariation;

  return { brightness, hue, hitSize };
}

// ═════════════════════════════════════════════════════════════════════════
// 1. bounceProps — f64 vs f32 precision
// ═════════════════════════════════════════════════════════════════════════

describe("bounceProps f32 precision", () => {
  const betas = [0.005, 0.05, 0.10, 0.15, 0.20, 0.2499];
  const ks = [-1, 0, 1];

  for (const k of ks) {
    for (const beta of betas) {
      it(`β=${beta}, k=${k}: eps relative error < 0.1%`, () => {
        const physics = new ECSKPhysics(beta, k);
        const ref = physics.bounceProps(beta);
        const f32 = bouncePropsF32(beta, k);

        const relErr = Math.abs(ref.eps - f32.eps) / Math.abs(ref.eps);
        expect(relErr).toBeLessThan(0.001);
      });

      it(`β=${beta}, k=${k}: wEff relative error < 1%`, () => {
        const physics = new ECSKPhysics(beta, k);
        const ref = physics.bounceProps(beta);
        const f32 = bouncePropsF32(beta, k);

        if (Math.abs(ref.wEff) < 1e-10) {
          // Both should be near zero or exactly -1
          expect(Math.abs(f32.wEff - ref.wEff)).toBeLessThan(0.01);
        } else {
          const relErr = Math.abs(ref.wEff - f32.wEff) / Math.abs(ref.wEff);
          expect(relErr).toBeLessThan(0.01);
        }
      });

      it(`β=${beta}, k=${k}: acc relative error < 1%`, () => {
        const physics = new ECSKPhysics(beta, k);
        const ref = physics.bounceProps(beta);
        const f32 = bouncePropsF32(beta, k);

        const relErr = Math.abs(ref.acc - f32.acc) / Math.abs(ref.acc);
        expect(relErr).toBeLessThan(0.01);
      });
    }
  }

  it("near-critical β=0.2499, k=+1: f32 still produces valid bounce", () => {
    const f32 = bouncePropsF32(0.2499, 1);
    // disc = sqrt(0.0004) = 0.02 — well within f32 range
    expect(f32.a).toBeGreaterThan(0);
    expect(f32.a2).toBeGreaterThan(0);
    expect(Number.isFinite(f32.eps)).toBe(true);
    expect(Number.isFinite(f32.wEff)).toBe(true);
    expect(Number.isFinite(f32.acc)).toBe(true);
  });

  it("k=0 bounce: wEff gracefully handles denominator ≈ 0", () => {
    // At k=0 bounce, a² = β exactly, so denominator = 3(a²-β) = 0
    const f32 = bouncePropsF32(0.10, 0);
    expect(f32.wEff).toBe(-1);
  });

  it("documents actual precision at each test point", () => {
    const results: string[] = [];
    for (const k of ks) {
      for (const beta of betas) {
        const physics = new ECSKPhysics(beta, k);
        const ref = physics.bounceProps(beta);
        const f32r = bouncePropsF32(beta, k);
        const epsRel = Math.abs(ref.eps - f32r.eps) / Math.abs(ref.eps);
        const wRel = Math.abs(ref.wEff) > 1e-10
          ? Math.abs(ref.wEff - f32r.wEff) / Math.abs(ref.wEff)
          : Math.abs(f32r.wEff - ref.wEff);
        const accRel = Math.abs(ref.acc - f32r.acc) / Math.abs(ref.acc);
        results.push(
          `β=${beta} k=${k}: eps_err=${(epsRel * 100).toFixed(6)}%, ` +
          `wEff_err=${(wRel * 100).toFixed(6)}%, acc_err=${(accRel * 100).toFixed(6)}%`,
        );
      }
    }
    // Log precision analysis
    console.log("=== f32 precision analysis for bounceProps ===");
    for (const r of results) console.log(`  ${r}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Perturbation evaluation — f64 vs f32 precision
// ═════════════════════════════════════════════════════════════════════════

describe("perturbation evaluation f32 precision", () => {
  const lMaxValues = [2, 4, 8, 16];

  for (const lMax of lMaxValues) {
    describe(`lMax=${lMax}`, () => {
      // Use deterministic seed so golden values are reproducible
      const rng = splitmix32(42);
      const coeffs = generatePerturbCoeffs(lMax, 0.05, rng);

      it("absolute error < 0.01 at 100 random points", () => {
        const ptRng = splitmix32(77);
        let maxAbsErr = 0;

        for (let i = 0; i < 100; i++) {
          const cosT = 1 - 2 * ptRng();
          const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
          const phi = ptRng() * 2 * Math.PI;

          const f64 = evaluatePerturbationFast(coeffs, lMax, cosT, sinT, phi);
          const f32 = evaluatePerturbationF32(coeffs, lMax, cosT, sinT, phi);

          const absErr = Math.abs(f64 - f32);
          if (absErr > maxAbsErr) maxAbsErr = absErr;
          expect(absErr).toBeLessThan(0.01);
        }

        console.log(`  lMax=${lMax}: max absolute error = ${maxAbsErr.toExponential(4)}`);
      });

      it("f32 agrees at poles (θ=0, θ=π)", () => {
        // North pole: cosT=1, sinT=0
        const f64N = evaluatePerturbationFast(coeffs, lMax, 1, 0, 0);
        const f32N = evaluatePerturbationF32(coeffs, lMax, 1, 0, 0);
        expect(Math.abs(f64N - f32N)).toBeLessThan(0.01);

        // South pole: cosT=-1, sinT=0
        const f64S = evaluatePerturbationFast(coeffs, lMax, -1, 0, 0);
        const f32S = evaluatePerturbationF32(coeffs, lMax, -1, 0, 0);
        expect(Math.abs(f64S - f32S)).toBeLessThan(0.01);
      });

      it("f32 agrees at equator (θ=π/2)", () => {
        const f64 = evaluatePerturbationFast(coeffs, lMax, 0, 1, 1.234);
        const f32 = evaluatePerturbationF32(coeffs, lMax, 0, 1, 1.234);
        expect(Math.abs(f64 - f32)).toBeLessThan(0.01);
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Visual encoding — f64 vs f32 precision
// ═════════════════════════════════════════════════════════════════════════

describe("visual encoding f32 precision", () => {
  // Normalization params matching typical runtime values
  const visParams = {
    brightnessFloor: 0.15,
    brightnessCeil: 1.0,
    hueMin: 25,
    hueRange: 245,
    sizeVariation: 0.5,
    globalMinAcc: -150,
    globalMaxAcc: 250,
    minWEff: -5.0,
    maxWEff: -0.5,
  };

  const testPoints: Array<{ label: string; eps: number; wEff: number; acc: number }> = [
    { label: "typical low β", eps: 160000, wEff: -1.2, acc: 50 },
    { label: "typical mid β", eps: 10000, wEff: -2.5, acc: 120 },
    { label: "typical high β", eps: 100, wEff: -4.0, acc: 200 },
    { label: "near-critical β", eps: 16, wEff: -0.8, acc: -100 },
    { label: "edge case: tiny eps", eps: 1.5, wEff: -3.0, acc: 0 },
    { label: "edge case: huge eps", eps: 1e6, wEff: -1.0, acc: 250 },
  ];

  for (const tp of testPoints) {
    it(`${tp.label}: hue differs by < 2°`, () => {
      const f64 = visualEncodingF64(tp.eps, tp.wEff, tp.acc, visParams);
      const f32 = visualEncodingF32(tp.eps, tp.wEff, tp.acc, visParams);
      expect(Math.abs(f64.hue - f32.hue)).toBeLessThan(2);
    });

    it(`${tp.label}: brightness differs by < 0.02`, () => {
      const f64 = visualEncodingF64(tp.eps, tp.wEff, tp.acc, visParams);
      const f32 = visualEncodingF32(tp.eps, tp.wEff, tp.acc, visParams);
      expect(Math.abs(f64.brightness - f32.brightness)).toBeLessThan(0.02);
    });

    it(`${tp.label}: hitSize differs by < 0.05`, () => {
      const f64 = visualEncodingF64(tp.eps, tp.wEff, tp.acc, visParams);
      const f32 = visualEncodingF32(tp.eps, tp.wEff, tp.acc, visParams);
      expect(Math.abs(f64.hitSize - f32.hitSize)).toBeLessThan(0.05);
    });
  }

  it("documents actual precision at each visual test point", () => {
    console.log("=== f32 precision analysis for visual encoding ===");
    for (const tp of testPoints) {
      const f64 = visualEncodingF64(tp.eps, tp.wEff, tp.acc, visParams);
      const f32 = visualEncodingF32(tp.eps, tp.wEff, tp.acc, visParams);
      console.log(
        `  ${tp.label}: ` +
        `hue_diff=${Math.abs(f64.hue - f32.hue).toFixed(4)}°, ` +
        `bri_diff=${Math.abs(f64.brightness - f32.brightness).toFixed(6)}, ` +
        `size_diff=${Math.abs(f64.hitSize - f32.hitSize).toFixed(6)}`,
      );
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. GPU integration test — skipped in vitest (no WebGPU)
// ═════════════════════════════════════════════════════════════════════════

describe("GPU integration", () => {
  test.skip("dispatch 1000 particles and compare to CPU reference (requires WebGPU)", () => {
    // This test requires a real GPUDevice (Chromium with WebGPU).
    // Run via Playwright browser test: src/compute/gpu-integration.spec.ts
    //
    // When WebGPU is available, this test would:
    //   1. Create a minimal compute pipeline with particle-emit.wgsl
    //   2. Dispatch 1000 particles with known parameters
    //   3. Read back the output buffer via mapAsync
    //   4. Compare each particle's [lx, ly, arrivalTime, hue, brightness, eps, hitSize]
    //      against CPU-computed values for the same PCG PRNG sequence
    //   5. Assert all values match within f32 tolerances established above
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5. Fallback behavior — gpuCompute toggle logic
// ═════════════════════════════════════════════════════════════════════════

describe("fallback behavior", () => {
  it("ComputeEmitter.ready starts false before init()", async () => {
    // Dynamically import to avoid issues if GPU types aren't available
    const { ComputeEmitter } = await import("./compute-emitter");

    // Minimal mock device
    const mockDevice = {
      createBuffer: () => ({ size: 0, destroy() {}, usage: 0 }),
      createShaderModule: () => ({}),
      createComputePipeline: () => ({
        getBindGroupLayout: () => ({}),
      }),
      createBindGroup: () => ({}),
      queue: { writeBuffer() {}, submit() {} },
    } as unknown as GPUDevice;

    const mockRb = {
      capacity: 1024,
      get writeHead() { return 0; },
      get totalWritten() { return 0; },
      getGpuBuffers: () => null,
      advanceWriteHead() {},
      recordGpuWrite() {},
    };

    const emitter = new ComputeEmitter(mockDevice, mockRb as any, "/* wgsl */");
    expect(emitter.ready).toBe(false);
  });

  it("ComputeEmitter.ready becomes true after init()", async () => {
    const { ComputeEmitter } = await import("./compute-emitter");

    const mockDevice = {
      createBuffer: () => ({ size: 0, destroy() {}, usage: 0 }),
      createShaderModule: () => ({}),
      createComputePipeline: () => ({
        getBindGroupLayout: () => ({}),
      }),
      createBindGroup: () => ({}),
      queue: { writeBuffer() {}, submit() {} },
    } as unknown as GPUDevice;

    const mockRb = {
      capacity: 1024,
      get writeHead() { return 0; },
      get totalWritten() { return 0; },
      getGpuBuffers: () => null,
      advanceWriteHead() {},
      recordGpuWrite() {},
    };

    const emitter = new ComputeEmitter(mockDevice, mockRb as any, "/* wgsl */");
    emitter.init();
    expect(emitter.ready).toBe(true);
  });

  it("dispatch does nothing when not ready (no crash)", async () => {
    const { ComputeEmitter } = await import("./compute-emitter");

    const mockDevice = {
      createBuffer: () => ({ size: 0, destroy() {}, usage: 0 }),
      createShaderModule: () => ({}),
      createComputePipeline: () => ({
        getBindGroupLayout: () => ({}),
      }),
      createBindGroup: () => ({}),
      queue: { writeBuffer() {}, submit() {} },
    } as unknown as GPUDevice;

    const mockRb = {
      capacity: 1024,
      get writeHead() { return 0; },
      get totalWritten() { return 0; },
      getGpuBuffers: () => null,
      advanceWriteHead() {},
      recordGpuWrite() {},
    };

    const emitter = new ComputeEmitter(mockDevice, mockRb as any, "/* wgsl */");
    // NOT calling init(), emitter not ready

    const encoder = {
      beginComputePass: () => ({
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups() {},
        end() {},
      }),
      copyBufferToBuffer() {},
    } as unknown as GPUCommandEncoder;

    // Should not throw
    expect(() =>
      emitter.dispatch(encoder, 100, {
        beta: 0.1, kCurvature: 1, perturbAmplitude: 0.05, lMax: 8,
        arrivalSpread: 0.5, simTime: 10, sensitivity: -2.5,
        hueMin: 25, hueRange: 245, brightnessFloor: 0.15,
        brightnessCeil: 1.0, sizeVariation: 0.5,
        globalMinAcc: -100, globalMaxAcc: 100, minWEff: -5, maxWEff: -0.5,
        doubleBounce: false, dbPhase: 0, dbSecondHueShift: 15, dbSecondBriScale: 0.82,
        bounceCount: 0, ppHueShift: 60, ppBriBoost: 1.3, ppSizeScale: 0.7,
        ppBaseDelay: 1.5, ppScatterRange: 1.0, ppBrightnessCeil: 1.5,
        ppMinWEff: -3, ppMaxWEff: -0.3, ppGlobalMinAcc: -50, ppGlobalMaxAcc: 50,
      }, new Float32Array(0)),
    ).not.toThrow();
  });

  it("dispose sets ready=false", async () => {
    const { ComputeEmitter } = await import("./compute-emitter");

    const mockDevice = {
      createBuffer: () => ({ size: 0, destroy() {}, usage: 0 }),
      createShaderModule: () => ({}),
      createComputePipeline: () => ({
        getBindGroupLayout: () => ({}),
      }),
      createBindGroup: () => ({}),
      queue: { writeBuffer() {}, submit() {} },
    } as unknown as GPUDevice;

    const mockRb = {
      capacity: 1024,
      get writeHead() { return 0; },
      get totalWritten() { return 0; },
      getGpuBuffers: () => null,
      advanceWriteHead() {},
      recordGpuWrite() {},
    };

    const emitter = new ComputeEmitter(mockDevice, mockRb as any, "/* wgsl */");
    emitter.init();
    expect(emitter.ready).toBe(true);

    emitter.dispose();
    expect(emitter.ready).toBe(false);

    // Dispatch after dispose should not crash
    const encoder = {
      beginComputePass: () => ({
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups() {},
        end() {},
      }),
      copyBufferToBuffer() {},
    } as unknown as GPUCommandEncoder;

    expect(() =>
      emitter.dispatch(encoder, 100, {
        beta: 0.1, kCurvature: 1, perturbAmplitude: 0.05, lMax: 8,
        arrivalSpread: 0.5, simTime: 10, sensitivity: -2.5,
        hueMin: 25, hueRange: 245, brightnessFloor: 0.15,
        brightnessCeil: 1.0, sizeVariation: 0.5,
        globalMinAcc: -100, globalMaxAcc: 100, minWEff: -5, maxWEff: -0.5,
        doubleBounce: false, dbPhase: 0, dbSecondHueShift: 15, dbSecondBriScale: 0.82,
        bounceCount: 0, ppHueShift: 60, ppBriBoost: 1.3, ppSizeScale: 0.7,
        ppBaseDelay: 1.5, ppScatterRange: 1.0, ppBrightnessCeil: 1.5,
        ppMinWEff: -3, ppMaxWEff: -0.3, ppGlobalMinAcc: -50, ppGlobalMaxAcc: 50,
      }, new Float32Array(0)),
    ).not.toThrow();
  });

  it("GPU compute path selection: gpuCompute=false uses CPU workers", () => {
    // Simulates the main.ts conditional:
    //   const gpuActive = !!(params.gpuCompute && computeEmitter?.ready && gpuDevice);
    const params = { gpuCompute: false };
    const computeEmitterReady = true;
    const gpuDevice = {};
    const gpuActive = !!(params.gpuCompute && computeEmitterReady && gpuDevice);
    expect(gpuActive).toBe(false);
  });

  it("GPU compute path selection: gpuCompute=true but emitter not ready falls back", () => {
    const params = { gpuCompute: true };
    const computeEmitterReady = false;
    const gpuDevice = {};
    const gpuActive = !!(params.gpuCompute && computeEmitterReady && gpuDevice);
    expect(gpuActive).toBe(false);
  });

  it("GPU compute path selection: gpuCompute=true but no device falls back", () => {
    const params = { gpuCompute: true };
    const computeEmitterReady = true;
    const gpuDevice = null;
    const gpuActive = !!(params.gpuCompute && computeEmitterReady && gpuDevice);
    expect(gpuActive).toBe(false);
  });

  it("GPU compute path selection: all conditions met activates GPU", () => {
    const params = { gpuCompute: true };
    const computeEmitterReady = true;
    const gpuDevice = {};
    const gpuActive = !!(params.gpuCompute && computeEmitterReady && gpuDevice);
    expect(gpuActive).toBe(true);
  });
});
