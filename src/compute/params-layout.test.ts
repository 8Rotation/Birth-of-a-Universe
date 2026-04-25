// Params struct layout assertion (GPU-01 / Task A2)
//
// The WGSL `struct Params` in `particle-emit.wgsl` and the hand-packed
// DataView writes in `ComputeEmitter._uploadParams` share a 144-byte
// binary layout. Any field rename / reorder on one side silently corrupts
// the uniform. This test parses both sources and asserts:
//
//   1. Every WGSL field lands at the expected WGSL std140 offset.
//   2. Each TS `setFloat32/setUint32/setInt32(offset, ...)` call matches
//      the corresponding WGSL field's offset and numeric kind (f32/u32/i32).
//   3. The total struct size (144 bytes) matches PARAMS_BUFFER_SIZE on the
//      TS side and the round-up-to-16 of the WGSL field end.
//   4. A live `_uploadParams` call writes a 144-byte ArrayBuffer whose
//      values at known offsets decode back to the sentinel inputs.

import { describe, it, expect, vi } from "vitest";
import { ComputeEmitter, type ComputeParams } from "./compute-emitter";
// Vite `?raw` import: loads the file contents as a string (works under Vitest
// via the shared Vite pipeline). Using this instead of `node:fs` avoids
// pulling `@types/node` into the strict TS build.
import wgslSrc from "./particle-emit.wgsl?raw";
import tsSrc from "./compute-emitter.ts?raw";

// ── WGSL parsing ─────────────────────────────────────────────────────────

type Kind = "f32" | "u32" | "i32" | "vec3f" | "vec4f";

interface Field {
  name: string;
  kind: Kind;
  offset: number;
  size: number;
  align: number;
}

function alignOf(k: Kind): number {
  switch (k) {
    case "f32": case "u32": case "i32": return 4;
    case "vec3f": case "vec4f": return 16;
  }
}
function sizeOf(k: Kind): number {
  switch (k) {
    case "f32": case "u32": case "i32": return 4;
    case "vec3f": return 12;  // consumed as 16 when followed, but size is 12
    case "vec4f": return 16;
  }
}

/** Parse the `struct Params { ... };` block out of the WGSL source. */
function parseWgslParams(src: string): { fields: Field[]; totalSize: number } {
  const m = src.match(/struct\s+Params\s*\{([\s\S]*?)\}\s*;/);
  if (!m) throw new Error("could not locate `struct Params` in WGSL source");
  const body = m[1];

  const fieldRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_<>]+)\s*,/gm;
  const fields: Field[] = [];
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = fieldRe.exec(body)) !== null) {
    const name = match[1];
    const rawType = match[2];
    let kind: Kind;
    if (rawType === "f32") kind = "f32";
    else if (rawType === "u32") kind = "u32";
    else if (rawType === "i32") kind = "i32";
    else if (rawType === "vec3<f32>") kind = "vec3f";
    else if (rawType === "vec4<f32>") kind = "vec4f";
    else throw new Error(`unsupported WGSL type in Params: ${rawType}`);

    const a = alignOf(kind);
    offset = Math.ceil(offset / a) * a;
    fields.push({ name, kind, offset, size: sizeOf(kind), align: a });
    offset += sizeOf(kind);
  }
  // WGSL uniform struct size rounded up to the struct's max alignment.
  // All our field alignments are ≤ 16, and 144 is 16-aligned anyway.
  const totalSize = Math.ceil(offset / 16) * 16;
  return { fields, totalSize };
}

// ── TS parsing ───────────────────────────────────────────────────────────

interface TsWrite {
  /** Call index in source order (0-based). */
  index: number;
  kind: "f32" | "u32" | "i32";
  /** Trailing `// N` comment offset, if present. */
  annotatedOffset: number | null;
}

/** Extract every `wf/wu/wi(...)` (or `setFloat32/setUint32/setInt32`) call
 *  inside `_uploadParams`, in source order. Since the helpers advance a
 *  running `off` by 4 each call, the effective offset of call N is N*4. */
function parseTsUploadParams(src: string): TsWrite[] {
  const fnMatch = src.match(/_uploadParams\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n\s{2}\}/);
  if (!fnMatch) throw new Error("could not locate `_uploadParams` body");
  const body = fnMatch[1];

  // Match the per-field helper call sites only. The helper *definitions*
  // (`const wf = (v) => { dv.setFloat32(...) }`) live above and use
  // setFloat32/setUint32 internally — we must NOT count those, or each
  // helper adds a spurious "write". Sticking to `wf(`/`wu(`/`wi(` keeps
  // us tied to actual per-field calls.
  const writeRe = /\b(wf|wu|wi)\s*\(/g;
  const lineRe = /\n/g;
  const writes: TsWrite[] = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = writeRe.exec(body)) !== null) {
    const helper = m[1];
    let kind: TsWrite["kind"];
    if (helper === "wf" || helper === "setFloat32") kind = "f32";
    else if (helper === "wu" || helper === "setUint32") kind = "u32";
    else kind = "i32";

    // Capture the rest of the line to look for `// <offset>` comment.
    lineRe.lastIndex = m.index;
    const nl = lineRe.exec(body);
    const lineEnd = nl ? nl.index : body.length;
    const tail = body.slice(m.index, lineEnd);
    const cm = tail.match(/\/\/\s*(\d+)\b/);
    writes.push({
      index: idx++,
      kind,
      annotatedOffset: cm ? parseInt(cm[1], 10) : null,
    });
  }
  return writes;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Params struct layout (WGSL ↔ TS parity)", () => {
  const { fields, totalSize } = parseWgslParams(wgslSrc);
  const writes = parseTsUploadParams(tsSrc);

  it("WGSL Params has the pinned 144-byte size", () => {
    expect(totalSize).toBe(144);
  });

  it("PARAMS_BUFFER_SIZE on the TS side matches the WGSL struct size", () => {
    const m = tsSrc.match(/PARAMS_BUFFER_SIZE\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(parseInt(m![1], 10)).toBe(totalSize);
  });

  it("has one TS write per WGSL scalar field (no vec3/vec4 in current layout)", () => {
    const scalarFields = fields.filter(f => f.kind === "f32" || f.kind === "u32" || f.kind === "i32");
    // If a vec3/vec4 is added later, this test must be generalised — fail loudly.
    expect(scalarFields.length, "vec3/vec4 fields require per-field expansion").toBe(fields.length);
    expect(writes.length).toBe(scalarFields.length);
  });

  it("every TS write matches the WGSL field's offset and numeric kind", () => {
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const w = writes[i];
      const expectedOffset = i * 4; // all scalar → dense 4-byte packing
      expect.soft(expectedOffset, `field #${i} ${f.name}: offset drift`).toBe(f.offset);
      expect.soft(w.kind, `field #${i} ${f.name}: kind mismatch (WGSL=${f.kind}, TS=${w.kind})`)
        .toBe(f.kind === "vec3f" || f.kind === "vec4f" ? "f32" : f.kind);
      if (w.annotatedOffset !== null) {
        expect.soft(w.annotatedOffset, `field #${i} ${f.name}: // N comment drift`).toBe(f.offset);
      }
    }
  });

  it("TS writes fill the buffer contiguously from 0 to <= totalSize", () => {
    // Each write advances by 4 bytes → last byte written is (writes.length*4 - 1).
    const lastByte = writes.length * 4;
    expect(lastByte).toBeLessThanOrEqual(totalSize);
    // Padding at the tail (if any) must leave the buffer 16-aligned.
    expect(totalSize % 16).toBe(0);
  });
});

// ── Smoke test: live _uploadParams round-trip ────────────────────────────

function makeMockBuffer(size: number): GPUBuffer {
  return {
    size, usage: 0, destroy: vi.fn(),
    mapState: "unmapped", label: "",
    getMappedRange: vi.fn(), mapAsync: vi.fn(), unmap: vi.fn(),
  } as unknown as GPUBuffer;
}

function makeRecordingDevice() {
  const writes: Array<{ buffer: GPUBuffer; offset: number; data: ArrayBuffer }> = [];
  const device = {
    createBuffer(desc: GPUBufferDescriptor) { return makeMockBuffer(desc.size); },
    createShaderModule: vi.fn().mockReturnValue({}),
    createComputePipeline: vi.fn().mockReturnValue({
      getBindGroupLayout: vi.fn().mockReturnValue({}),
    }),
    createBindGroup: vi.fn().mockReturnValue({}),
    queue: {
      writeBuffer: (buffer: GPUBuffer, offset: number, data: ArrayBuffer) => {
        // Clone so later mutations can't affect recorded copy.
        writes.push({ buffer, offset, data: data.slice(0) });
      },
      submit: vi.fn(),
    },
  } as unknown as GPUDevice;
  return { device, writes };
}

function makeMockRingBuffer(capacity = 1024) {
  let writeHead = 0;
  let totalWritten = 0;
  const bufA = makeMockBuffer(capacity * 16);
  const bufB = makeMockBuffer(capacity * 16);
  return {
    capacity,
    get writeHead() { return writeHead; },
    get totalWritten() { return totalWritten; },
    getGpuBuffers() { return { bufA, bufB }; },
    advanceWriteHead(n: number) { writeHead = (writeHead + n) % capacity; totalWritten += n; },
    recordGpuWrite(n: number) { writeHead = (writeHead + n) % capacity; totalWritten += n; },
  };
}

describe("_uploadParams binary round-trip", () => {
  it("writes a 144-byte uniform whose known offsets decode to the inputs", () => {
    const { device, writes } = makeRecordingDevice();
    const rb = makeMockRingBuffer(2048);
    const emitter = new ComputeEmitter(device, rb as any, "/* wgsl */");
    emitter.init();

    const params: ComputeParams = {
      beta: 0.125,
      kCurvature: 1,
      perturbAmplitude: 0.0625,
      lMax: 7,
      arrivalSpread: 0.375,
      simTime: 42.5,
      sensitivity: -2.25,
      hueMin: 15,
      hueRange: 300,
      brightnessFloor: 0.1,
      brightnessCeil: 0.9,
      sizeVariation: 0.5,
      globalMinAcc: -123.5,
      globalMaxAcc: 456.25,
      minWEff: -4.5,
      maxWEff: -0.75,
      doubleBounce: true,
      dbPhase: 0.3125,
      dbSecondHueShift: 15,
      dbSecondBriScale: 0.82,
      bounceCount: 17,
      ppHueShift: 60,
      ppBriBoost: 1.25,
      ppSizeScale: 0.75,
      ppBaseDelay: 1.5,
      ppScatterRange: 1.0,
      ppBrightnessCeil: 1.5,
      ppMinWEff: -3.5,
      ppMaxWEff: -0.5,
      ppGlobalMinAcc: -50,
      ppGlobalMaxAcc: 50,
    };

    // Dispatch is the only public path that triggers _uploadParams.
    const coeffs = ComputeEmitter.packCoeffs([{ l: 1, m: 0, c: 0.1, sigma: 0.01 }]);
    const encoder = {
      beginComputePass: vi.fn().mockReturnValue({
        setPipeline: vi.fn(), setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(), end: vi.fn(),
      }),
      copyBufferToBuffer: vi.fn(),
      finish: vi.fn(),
    } as unknown as GPUCommandEncoder;

    emitter.dispatch(encoder, 128, params, coeffs);

    // Find the 144-byte uniform write (there may be a coeffs write too).
    const paramsWrite = writes.find(w => w.data.byteLength === 144);
    expect(paramsWrite, "expected a 144-byte writeBuffer call").toBeDefined();
    const dv = new DataView(paramsWrite!.data);

    // Spot-check: first scalar, a middle scalar, and the last scalar.
    expect(dv.getFloat32(0, true)).toBeCloseTo(params.beta, 6);          // beta
    expect(dv.getUint32(12, true)).toBe(params.lMax);                    // lMax
    expect(dv.getFloat32(32, true)).toBeCloseTo(params.sensitivity, 6);  // sensitivity
    expect(dv.getUint32(80, true)).toBe(1);                              // doubleBounce (true → 1)
    expect(dv.getUint32(96, true)).toBe(params.bounceCount);             // bounceCount
    expect(dv.getFloat32(136, true)).toBeCloseTo(params.ppGlobalMaxAcc, 4); // last field
    // Tail padding is zero.
    expect(dv.getUint32(140, true)).toBe(0);
  });
});
