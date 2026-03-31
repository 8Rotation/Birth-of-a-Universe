import { describe, it, expect, vi } from "vitest";
import { ComputeEmitter, ComputeParams } from "./compute-emitter";
import type { PerturbMode } from "../physics/perturbation";

// ── Mock GPUDevice / GPUBuffer / GPUBindGroup ───────────────────────────

function makeMockBuffer(size: number) {
  return {
    size,
    usage: 0,
    destroy: vi.fn(),
    mapState: "unmapped" as const,
    label: "",
    getMappedRange: vi.fn(),
    mapAsync: vi.fn(),
    unmap: vi.fn(),
  } as unknown as GPUBuffer;
}

function makeMockDevice() {
  const buffers: GPUBuffer[] = [];
  return {
    createBuffer(desc: GPUBufferDescriptor) {
      const buf = makeMockBuffer(desc.size);
      buffers.push(buf);
      return buf;
    },
    createShaderModule: vi.fn().mockReturnValue({}),
    createComputePipeline: vi.fn().mockReturnValue({
      getBindGroupLayout: vi.fn().mockReturnValue({}),
    }),
    createBindGroup: vi.fn().mockReturnValue({}),
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    },
    _buffers: buffers,
  } as unknown as GPUDevice & { _buffers: GPUBuffer[] };
}

function makeMockRingBuffer(capacity = 1024) {
  let writeHead = 0;
  let totalWritten = 0;
  const gpuBufA = makeMockBuffer(capacity * 16);
  const gpuBufB = makeMockBuffer(capacity * 16);

  return {
    capacity,
    get writeHead() { return writeHead; },
    get totalWritten() { return totalWritten; },
    getGpuBuffers() { return { bufA: gpuBufA, bufB: gpuBufB }; },
    advanceWriteHead(count: number) {
      writeHead = (writeHead + count) % capacity;
      totalWritten += count;
    },
    recordGpuWrite(count: number, _minBorn: number, _maxBorn: number) {
      writeHead = (writeHead + count) % capacity;
      totalWritten += count;
    },
    _gpuBufA: gpuBufA,
    _gpuBufB: gpuBufB,
  };
}

// ── ComputeParams helper ────────────────────────────────────────────────

function defaultParams(): ComputeParams {
  return {
    beta: 0.10,
    kCurvature: 1,
    perturbAmplitude: 0.05,
    lMax: 8,
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

    // Double-bounce
    doubleBounce: false,
    dbPhase: 0,
    dbSecondHueShift: 15,
    dbSecondBriScale: 0.82,

    // Pair production
    bounceCount: 0,
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
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("ComputeEmitter", () => {
  it("can be constructed with mock device and ring buffer", () => {
    const device = makeMockDevice();
    const rb = makeMockRingBuffer();
    const emitter = new ComputeEmitter(device, rb as any, "/* wgsl */");
    expect(emitter.ready).toBe(false);
  });

  it("init() creates pipeline and sets ready=true", () => {
    const device = makeMockDevice();
    const rb = makeMockRingBuffer();
    const emitter = new ComputeEmitter(device, rb as any, "/* wgsl */");

    emitter.init();

    expect(emitter.ready).toBe(true);
    expect(device.createShaderModule).toHaveBeenCalled();
    expect(device.createComputePipeline).toHaveBeenCalled();
  });

  it("dispatch() encodes a compute pass and copies to ring buffer", () => {
    const device = makeMockDevice();
    const rb = makeMockRingBuffer();
    const emitter = new ComputeEmitter(device, rb as any, "/* wgsl */");
    emitter.init();

    const beginComputePass = vi.fn().mockReturnValue({
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      end: vi.fn(),
    });
    const copyBufferToBuffer = vi.fn();
    const encoder = {
      beginComputePass,
      copyBufferToBuffer,
      finish: vi.fn(),
    } as unknown as GPUCommandEncoder;

    const coeffs = ComputeEmitter.packCoeffs([
      { l: 1, m: 0, c: 0.5, sigma: 0.01 },
      { l: 1, m: 1, c: -0.3, sigma: 0.01 },
    ]);

    emitter.dispatch(encoder, 128, defaultParams(), coeffs);

    expect(beginComputePass).toHaveBeenCalled();
    // Should copy staging → vertex buffers (2 copy calls for contiguous write)
    expect(copyBufferToBuffer).toHaveBeenCalledTimes(2);
    // Ring buffer write head should have advanced
    expect(rb.writeHead).toBe(128);
    expect(rb.totalWritten).toBe(128);
  });

  it("dispatch() does nothing when emitCount is 0", () => {
    const device = makeMockDevice();
    const rb = makeMockRingBuffer();
    const emitter = new ComputeEmitter(device, rb as any, "/* wgsl */");
    emitter.init();

    const beginComputePass = vi.fn();
    const encoder = { beginComputePass } as unknown as GPUCommandEncoder;

    emitter.dispatch(encoder, 0, defaultParams(), new Float32Array(0));

    expect(beginComputePass).not.toHaveBeenCalled();
  });

  it("dispatch() does nothing when not ready", () => {
    const device = makeMockDevice();
    const rb = makeMockRingBuffer();
    const emitter = new ComputeEmitter(device, rb as any, "/* wgsl */");
    // NOT calling init()

    const beginComputePass = vi.fn();
    const encoder = { beginComputePass } as unknown as GPUCommandEncoder;

    emitter.dispatch(encoder, 100, defaultParams(), new Float32Array(0));

    expect(beginComputePass).not.toHaveBeenCalled();
  });

  it("dispose() releases GPU buffers and sets ready=false", () => {
    const device = makeMockDevice();
    const rb = makeMockRingBuffer();
    const emitter = new ComputeEmitter(device, rb as any, "/* wgsl */");
    emitter.init();
    expect(emitter.ready).toBe(true);

    emitter.dispose();
    expect(emitter.ready).toBe(false);
  });

  it("handles wrap-around copy correctly", () => {
    const cap = 256;
    const rb = makeMockRingBuffer(cap);
    // Advance write head near the end so the next write wraps
    rb.advanceWriteHead(cap - 10);

    const device = makeMockDevice();
    const emitter = new ComputeEmitter(device, rb as any, "/* wgsl */");
    emitter.init();

    const copyBufferToBuffer = vi.fn();
    const encoder = {
      beginComputePass: vi.fn().mockReturnValue({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(),
      }),
      copyBufferToBuffer,
      finish: vi.fn(),
    } as unknown as GPUCommandEncoder;

    const coeffs = new Float32Array(0);

    // Write 20 particles: 10 at end + 10 at start (wrap)
    emitter.dispatch(encoder, 20, defaultParams(), coeffs);

    // Should produce 4 copy calls (2 chunks × 2 attributes)
    expect(copyBufferToBuffer).toHaveBeenCalledTimes(4);
  });
});

// ── Coefficient packing ─────────────────────────────────────────────────

describe("ComputeEmitter.packCoeffs", () => {
  it("packs PerturbMode[] into correct byte layout", () => {
    const modes: PerturbMode[] = [
      { l: 1, m: 0, c: 0.5, sigma: 0.01 },
      { l: 2, m: -1, c: -0.3, sigma: 0.02 },
      { l: 3, m: 3, c: 0.1, sigma: 0.005 },
    ];

    const packed = ComputeEmitter.packCoeffs(modes);
    expect(packed.length).toBe(12); // 3 modes × 4 floats

    const u32 = new Uint32Array(packed.buffer);
    const i32 = new Int32Array(packed.buffer);

    // Mode 0: l=1, m=0, c=0.5, sigma=0.01
    expect(u32[0]).toBe(1);
    expect(i32[1]).toBe(0);
    expect(packed[2]).toBeCloseTo(0.5);
    expect(packed[3]).toBeCloseTo(0.01);

    // Mode 1: l=2, m=-1, c=-0.3, sigma=0.02
    expect(u32[4]).toBe(2);
    expect(i32[5]).toBe(-1);
    expect(packed[6]).toBeCloseTo(-0.3);
    expect(packed[7]).toBeCloseTo(0.02);

    // Mode 2: l=3, m=3, c=0.1, sigma=0.005
    expect(u32[8]).toBe(3);
    expect(i32[9]).toBe(3);
    expect(packed[10]).toBeCloseTo(0.1);
    expect(packed[11]).toBeCloseTo(0.005);
  });

  it("returns empty Float32Array for empty input", () => {
    const packed = ComputeEmitter.packCoeffs([]);
    expect(packed.length).toBe(0);
  });
});

// ── ComputeParams interface coverage ────────────────────────────────────

describe("ComputeParams", () => {
  it("covers all required fields", () => {
    const p = defaultParams();
    const requiredKeys: Array<keyof ComputeParams> = [
      "beta", "kCurvature", "perturbAmplitude", "lMax",
      "arrivalSpread", "simTime", "sensitivity",
      "hueMin", "hueRange", "brightnessFloor", "brightnessCeil",
      "sizeVariation", "globalMinAcc", "globalMaxAcc",
      "minWEff", "maxWEff",
      // Double-bounce
      "doubleBounce", "dbPhase", "dbSecondHueShift", "dbSecondBriScale",
      // Pair production
      "bounceCount", "ppHueShift", "ppBriBoost", "ppSizeScale",
      "ppBaseDelay", "ppScatterRange", "ppBrightnessCeil",
      "ppMinWEff", "ppMaxWEff", "ppGlobalMinAcc", "ppGlobalMaxAcc",
    ];
    for (const key of requiredKeys) {
      expect(p).toHaveProperty(key);
    }
  });
});
