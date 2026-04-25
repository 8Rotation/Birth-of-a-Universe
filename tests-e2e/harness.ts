// tests-e2e/harness.ts - Browser-side GPU/CPU validation harness.
//
// Boots a WebGPU device, dispatches the real ComputeEmitter on a fixed
// configuration, computes the same particles with a CPU f32 mirror of the
// WGSL shader, reads the GPU buffers back, and exposes the comparison at
// `window.__result__` for Playwright to assert against.

import { ComputeEmitter, type ComputeParams } from "../src/compute/compute-emitter.ts";
import shaderSource from "../src/compute/particle-emit.wgsl?raw";

interface PerturbModeLike {
  l: number;
  m: number;
  c: number;
  sigma: number;
}

interface ComparisonStats {
  maxAbsErr: number;
  maxRelErr: number;
  worstIndex: number;
  worstField: string;
  cpuValue: number;
  gpuValue: number;
}

interface ValidationResult {
  ok: boolean;
  reason?: string;
  emitCount: number;
  capacity: number;
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
    comparison: ComparisonStats;
  };
  /** First two raw GPU records (8 floats each) for debugging. */
  samples: number[][];
}

declare global {
  // eslint-disable-next-line no-var
  var __result__: ValidationResult | undefined;
  // eslint-disable-next-line no-var
  var __ready__: boolean | undefined;
}

const f = Math.fround;
const TWO_PI = f(6.283185307179586);
const SQRT2 = f(1.4142135623730951);
const LOG_4PI = f(2.5310242469692907);
const EPS_LOG_REF = f(9.210440366976517);
const FRAME_SEED = 1;

const log = (msg: string) => {
  const el = document.getElementById("log");
  if (el) el.textContent = (el.textContent ?? "") + "\n" + msg;
  // eslint-disable-next-line no-console
  console.log(msg);
};

async function run(): Promise<ValidationResult> {
  if (!("gpu" in navigator)) {
    return failed("navigator.gpu missing");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    return failed("no GPUAdapter");
  }
  const device = await adapter.requestDevice();

  const capacity = 1024;
  const emitCount = 256;
  const lMax = 8;

  // Two destination buffers that mimic Three.js vertex buffers.
  // ComputeEmitter copies into these via copyBufferToBuffer().
  const bytesPerParticle = 16;
  const totalBytes = capacity * bytesPerParticle;
  const dstA = device.createBuffer({
    size: totalBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  const dstB = device.createBuffer({
    size: totalBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });

  const writes: Array<{ count: number }> = [];
  const ringBufferStub = {
    capacity,
    get writeHead() { return 0; },
    get totalWritten() { return writes.reduce((sum, write) => sum + write.count, 0); },
    getGpuBuffers() { return { bufA: dstA, bufB: dstB }; },
    advanceWriteHead(_count: number) { /* unused for GPU path */ },
    recordGpuWrite(count: number, _minBorn: number, _maxBorn: number) { writes.push({ count }); },
  };

  const emitter = new ComputeEmitter(device, ringBufferStub as any, shaderSource);
  emitter.init();

  const params: ComputeParams = {
    beta: 0.10,
    kCurvature: 1,
    perturbAmplitude: 0.05,
    lMax,
    arrivalSpread: 0.5,
    simTime: 10.0,
    sensitivity: -2.5,
    hueMin: 30,
    hueRange: 270,
    brightnessFloor: 0.05,
    brightnessCeil: 0.95,
    sizeVariation: 0.6,
    globalMinAcc: -100,
    globalMaxAcc: 100,
    minWEff: -5.0,
    maxWEff: -0.5,
    doubleBounce: false,
    dbPhase: 0,
    dbSecondHueShift: 15,
    dbSecondBriScale: 0.82,
    bounceCount: emitCount,
    ppHueShift: 60,
    ppBriBoost: 1.3,
    ppSizeScale: 0.7,
    ppBaseDelay: 1.5,
    ppScatterRange: 1.0,
    ppBrightnessCeil: 1.5,
    ppMinWEff: -3.0,
    ppMaxWEff: -0.3,
    ppGlobalMinAcc: -50,
    ppGlobalMaxAcc: 50,
  };

  const modes = makeDenseCoeffs(lMax);
  const coeffs = ComputeEmitter.packCoeffs(modes);

  const encoder = device.createCommandEncoder();
  emitter.dispatch(encoder, emitCount, params, coeffs);

  const readA = device.createBuffer({
    size: emitCount * bytesPerParticle,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const readB = device.createBuffer({
    size: emitCount * bytesPerParticle,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  encoder.copyBufferToBuffer(dstA, 0, readA, 0, emitCount * bytesPerParticle);
  encoder.copyBufferToBuffer(dstB, 0, readB, 0, emitCount * bytesPerParticle);

  device.queue.submit([encoder.finish()]);

  await readA.mapAsync(GPUMapMode.READ);
  await readB.mapAsync(GPUMapMode.READ);

  const a = new Float32Array(readA.getMappedRange().slice(0));
  const b = new Float32Array(readB.getMappedRange().slice(0));
  readA.unmap();
  readB.unmap();

  const cpu = computeCpuReference(params, modes, emitCount, FRAME_SEED);
  const stats = aggregateStats(a, b, cpu, emitCount);

  const samples: number[][] = [];
  for (let i = 0; i < Math.min(2, emitCount); i++) {
    samples.push(readGpuParticle(a, b, i));
  }

  emitter.dispose();
  dstA.destroy();
  dstB.destroy();
  readA.destroy();
  readB.destroy();
  device.destroy();

  return { ok: true, emitCount, capacity, stats, samples };
}

function failed(reason: string): ValidationResult {
  return { ok: false, reason, emitCount: 0, capacity: 0, stats: emptyStats(), samples: [] };
}

function makeDenseCoeffs(lMax: number): PerturbModeLike[] {
  const modes: PerturbModeLike[] = [];
  for (let l = 1; l <= lMax; l++) {
    for (let m = -l; m <= l; m++) {
      const highMProbe = l === 8 && Math.abs(m) === 8 ? 0.01 : 0;
      modes.push({
        l,
        m,
        c: f(0.012 * Math.sin(l * 1.713 + m * 0.917) + highMProbe),
        sigma: f(0.001 * (1 + l)),
      });
    }
  }
  return modes;
}

function computeCpuReference(
  params: ComputeParams,
  coeffs: PerturbModeLike[],
  emitCount: number,
  frameSeed: number,
): Float32Array {
  const out = new Float32Array(emitCount * 8);
  for (let idx = 0; idx < emitCount; idx++) {
    const rng = { value: (frameSeed ^ Math.imul(idx, 2654435761)) >>> 0 };

    const u1 = rand01(rng);
    const u2 = rand01(rng);
    const cosTheta = f(1.0 - f(2.0 * u1));
    const sinTheta = f(Math.sqrt(f(Math.max(0.0, f(1.0 - f(cosTheta * cosTheta))))));
    const phi = f(TWO_PI * u2);

    const delta = evalPerturbationF32(coeffs, params.lMax, cosTheta, sinTheta, phi);
    const betaEff = f(clamp(f(params.beta * f(1.0 + delta)), 0.002, 0.2499));

    const denom = f(Math.max(1e-6, f(f(Math.abs(params.sensitivity)) * f(params.beta) * f(params.perturbAmplitude))));
    const td = f(params.arrivalSpread / denom);
    const rawDelay = f(f(params.sensitivity) * f(betaEff - f(params.beta)) * td);
    const maxDelay = f(params.arrivalSpread * 1.5);

    const theta = f(Math.acos(cosTheta));
    const halfThetaSin = f(Math.sin(f(theta / 2.0)));
    const lx = f(f(2.0 * halfThetaSin) * f(Math.cos(phi)));
    const ly = f(f(2.0 * halfThetaSin) * f(Math.sin(phi)));
    const tailAngle = f(rand01(rng) * TWO_PI);

    const props = bouncePropsF32(betaEff, params.kCurvature);
    const brightness = f(clamp(f(f(Math.log(f(props.eps + 1.0))) / EPS_LOG_REF), params.brightnessFloor, params.brightnessCeil));
    const arrivalTime = f(params.simTime + clamp(rawDelay, -maxDelay, maxDelay));

    const wRange = f(params.minWEff - params.maxWEff);
    const wNorm = Math.abs(wRange) < 1e-12
      ? f(0.5)
      : f(f(props.wEff - f(params.maxWEff)) / wRange);
    const hue = f(Math.min(f(params.hueMin + params.hueRange), f(f(params.hueMin) + f(wNorm * f(params.hueRange)))));

    const accRange = f(Math.max(1e-6, f(params.globalMaxAcc - params.globalMinAcc)));
    const normAcc = f(clamp(f(f(props.acc - f(params.globalMinAcc)) / accRange), 0.0, 1.0));
    const hitSize = f(f(1.0 - f(params.sizeVariation * 0.5)) + f(normAcc * f(params.sizeVariation)));

    const base = idx * 8;
    out[base + 0] = lx;
    out[base + 1] = ly;
    out[base + 2] = arrivalTime;
    out[base + 3] = hue;
    out[base + 4] = brightness;
    out[base + 5] = props.eps;
    out[base + 6] = hitSize;
    out[base + 7] = tailAngle;
  }
  return out;
}

function pcg(state: { value: number }): number {
  const old = state.value >>> 0;
  state.value = (Math.imul(old, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((((old >>> ((old >>> 28) + 4)) ^ old) >>> 0), 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

function rand01(state: { value: number }): number {
  return f(pcg(state) / 4294967296.0);
}

function bouncePropsF32(betaEff: number, k: number) {
  const be = f(clamp(betaEff, 0.002, 0.2499));
  let a2: number;
  if (k > 0.5) {
    const disc = f(Math.sqrt(f(Math.max(0.0, f(1.0 - f(4.0 * be))))));
    a2 = f(f(1.0 - disc) / 2.0);
  } else if (k > -0.5) {
    a2 = be;
  } else {
    const disc = f(Math.sqrt(f(1.0 + f(4.0 * be))));
    a2 = f(Math.max(1e-12, f(f(-1.0 + disc) / 2.0)));
  }
  const a = f(Math.sqrt(a2));
  const wDenom = f(3.0 * f(a2 - be));
  const wEff = Math.abs(wDenom) > 1e-12
    ? f(f(a2 - f(3.0 * be)) / wDenom)
    : f(-1.0);
  const eps = f(1.0 / f(a2 * a2));
  const acc = f(f(-1.0 / f(a2 * a)) + f(f(2.0 * be) / f(f(a2 * a2) * a)));
  return { a, a2, eps, wEff, acc };
}

function evalPerturbationF32(
  coeffs: PerturbModeLike[],
  lMax: number,
  cosT: number,
  sinT: number,
  phi: number,
): number {
  if (lMax < 1 || coeffs.length === 0) return f(0.0);

  const fCosT = f(cosT);
  const fSinT = f(sinT);
  const cosPhi = f(Math.cos(phi));
  const sinPhi = f(Math.sin(phi));
  let pmm = f(1.0);
  let cosMPhi = f(1.0);
  let sinMPhi = f(0.0);
  let delta = f(0.0);

  for (let m = 0; m <= lMax; m++) {
    if (m > 0) {
      pmm = f(pmm * f(f(-(f(2 * m) - 1.0)) * fSinT));
      const c = f(f(cosMPhi * cosPhi) - f(sinMPhi * sinPhi));
      const s = f(f(sinMPhi * cosPhi) + f(cosMPhi * sinPhi));
      cosMPhi = c;
      sinMPhi = s;
    }

    let logFactorial2m = f(0.0);
    for (let i = 1; i <= 2 * m; i++) {
      logFactorial2m = f(logFactorial2m + f(Math.log(f(i))));
    }
    let norm2 = f(Math.exp(f(f(Math.log(f(2 * m + 1))) - LOG_4PI - logFactorial2m)));

    let plmPrev = f(0.0);
    let plmCurr = f(pmm);

    for (let l = m; l <= lMax; l++) {
      if (l > m) {
        const plmNext = f(
          f(f(f(2 * l - 1) * fCosT * plmCurr) - f(f(l + m - 1) * plmPrev)) /
          f(l - m),
        );
        plmPrev = plmCurr;
        plmCurr = plmNext;
        norm2 = f(norm2 * f(f(f(2 * l + 1) / f(2 * l - 1)) * f(f(l - m) / f(l + m))));
      }

      if (l < 1) continue;

      const norm = f(Math.sqrt(norm2));
      if (m === 0) {
        const coeff = coeffs[l * l + l - 1];
        if (coeff) delta = f(delta + f(f(coeff.c) * f(norm * plmCurr)));
      } else {
        const nPlm = f(norm * f(plmCurr * SQRT2));
        const coeffPos = coeffs[l * l + l + m - 1];
        if (coeffPos) delta = f(delta + f(f(coeffPos.c) * f(nPlm * cosMPhi)));
        const coeffNeg = coeffs[l * l + l - m - 1];
        if (coeffNeg) delta = f(delta + f(f(coeffNeg.c) * f(nPlm * sinMPhi)));
      }
    }
  }
  return delta;
}

function aggregateStats(
  a: Float32Array,
  b: Float32Array,
  cpu: Float32Array,
  emitCount: number,
): ValidationResult["stats"] {
  const stats = emptyStats();
  let nan = 0;
  let finite = 0;
  const fields = ["lx", "ly", "arrivalTime", "hue", "brightness", "eps", "hitSize", "tailAngle"];

  for (let i = 0; i < emitCount; i++) {
    const gpu = readGpuParticle(a, b, i);
    const allFinite = gpu.every(Number.isFinite);
    if (!allFinite) {
      nan++;
      continue;
    }
    finite++;

    const [lx, ly, , hue, brightness, eps, hitSize] = gpu;
    if (lx < stats.lxRange[0]) stats.lxRange[0] = lx;
    if (lx > stats.lxRange[1]) stats.lxRange[1] = lx;
    if (ly < stats.lyRange[0]) stats.lyRange[0] = ly;
    if (ly > stats.lyRange[1]) stats.lyRange[1] = ly;
    const radius = Math.sqrt(lx * lx + ly * ly);
    if (radius > stats.rMax) stats.rMax = radius;
    if (hue < stats.hueRange[0]) stats.hueRange[0] = hue;
    if (hue > stats.hueRange[1]) stats.hueRange[1] = hue;
    if (brightness < stats.brightnessRange[0]) stats.brightnessRange[0] = brightness;
    if (brightness > stats.brightnessRange[1]) stats.brightnessRange[1] = brightness;
    if (eps < stats.epsRange[0]) stats.epsRange[0] = eps;
    if (eps > stats.epsRange[1]) stats.epsRange[1] = eps;
    if (hitSize < stats.hitSizeRange[0]) stats.hitSizeRange[0] = hitSize;
    if (hitSize > stats.hitSizeRange[1]) stats.hitSizeRange[1] = hitSize;

    for (let field = 0; field < fields.length; field++) {
      const cpuValue = cpu[i * 8 + field];
      const gpuValue = gpu[field];
      const absErr = Math.abs(gpuValue - cpuValue);
      const relErr = absErr / Math.max(1.0, Math.abs(cpuValue), Math.abs(gpuValue));
      if (relErr > stats.comparison.maxRelErr) {
        stats.comparison = {
          maxAbsErr: absErr,
          maxRelErr: relErr,
          worstIndex: i,
          worstField: fields[field],
          cpuValue,
          gpuValue,
        };
      } else if (absErr > stats.comparison.maxAbsErr) {
        stats.comparison.maxAbsErr = absErr;
      }
    }
  }

  stats.nanCount = nan;
  stats.finiteCount = finite;
  return stats;
}

function readGpuParticle(a: Float32Array, b: Float32Array, index: number): number[] {
  return [
    a[index * 4 + 0],
    a[index * 4 + 1],
    a[index * 4 + 2],
    a[index * 4 + 3],
    b[index * 4 + 0],
    b[index * 4 + 1],
    b[index * 4 + 2],
    b[index * 4 + 3],
  ];
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function emptyComparison(): ComparisonStats {
  return {
    maxAbsErr: 0,
    maxRelErr: 0,
    worstIndex: -1,
    worstField: "",
    cpuValue: 0,
    gpuValue: 0,
  };
}

function emptyStats(): ValidationResult["stats"] {
  return {
    lxRange: [Infinity, -Infinity],
    lyRange: [Infinity, -Infinity],
    rMax: 0,
    hueRange: [Infinity, -Infinity],
    brightnessRange: [Infinity, -Infinity],
    epsRange: [Infinity, -Infinity],
    hitSizeRange: [Infinity, -Infinity],
    nanCount: 0,
    finiteCount: 0,
    comparison: emptyComparison(),
  };
}

run()
  .then((res) => {
    window.__result__ = res;
    window.__ready__ = true;
    log(
      `done: ok=${res.ok} reason=${res.reason ?? ""} ` +
      `finite=${res.stats.finiteCount}/${res.emitCount} ` +
      `maxRelErr=${res.stats.comparison.maxRelErr}`,
    );
  })
  .catch((err) => {
    window.__result__ = {
      ok: false,
      reason: `exception: ${(err as Error).message}`,
      emitCount: 0,
      capacity: 0,
      stats: emptyStats(),
      samples: [],
    };
    window.__ready__ = true;
    log("error: " + ((err as Error).stack ?? String(err)));
  });