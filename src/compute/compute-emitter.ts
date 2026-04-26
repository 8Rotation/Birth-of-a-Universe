/**
 * compute-emitter.ts — GPU compute pipeline for particle emission.
 *
 * Wraps the WGSL compute shader (particle-emit.wgsl) and dispatches it
 * each frame. Handles GPU buffer management, uniform uploads, and
 * integrates with the existing ParticleRingBuffer via staging buffers
 * + copyBufferToBuffer.
 */

import type { ParticleRingBuffer } from "../rendering/particle-ring-buffer.js";
import type { PerturbMode } from "../physics/perturbation.js";

// ── ComputeParams interface ─────────────────────────────────────────────

export interface ComputeParams {
  beta: number;
  kCurvature: number;
  perturbAmplitude: number;
  lMax: number;
  arrivalSpread: number;
  simTime: number;
  sensitivity: number;

  hueMin: number;
  hueRange: number;
  brightnessFloor: number;
  brightnessCeil: number;
  sizeVariation: number;

  globalMinAcc: number;
  globalMaxAcc: number;
  minWEff: number;
  maxWEff: number;

  // Double-bounce modulation (Cubero & Popławski 2019 §26)
  doubleBounce: boolean;
  dbPhase: number;
  dbSecondHueShift: number;
  dbSecondBriScale: number;

  // Pair production (Popławski 2014; 2021)
  /** Number of bounce particles; remaining (emitCount - bounceCount) are production. 0 = no PP. */
  bounceCount: number;
  ppHueShift: number;
  ppBriBoost: number;
  ppSizeScale: number;
  ppBaseDelay: number;
  ppScatterRange: number;
  ppBrightnessCeil: number;

  // Production particle normalization bounds
  ppMinWEff: number;
  ppMaxWEff: number;
  ppGlobalMinAcc: number;
  ppGlobalMaxAcc: number;
}

// ── Params uniform layout ───────────────────────────────────────────────
// Must match the Params struct in particle-emit.wgsl exactly.
// 35 fields × 4 bytes = 140 bytes, padded to 144 for 16-byte alignment.
const PARAMS_BUFFER_SIZE = 144;

// Workgroup size must match the @workgroup_size in the WGSL shader.
const WORKGROUP_SIZE = 64;

// GPUBufferUsage flag constants (avoids reliance on browser global in tests)
const BUF_UNIFORM  = 0x0040; // GPUBufferUsage.UNIFORM
const BUF_STORAGE  = 0x0080; // GPUBufferUsage.STORAGE
const BUF_COPY_DST = 0x0008; // GPUBufferUsage.COPY_DST
const BUF_COPY_SRC = 0x0004; // GPUBufferUsage.COPY_SRC

// ── ComputeEmitter ──────────────────────────────────────────────────────

export class ComputeEmitter {
  private _device: GPUDevice;
  private _ringBuffer: ParticleRingBuffer;
  private _shaderSource: string;

  private _pipeline: GPUComputePipeline | null = null;
  private _paramsBuffer: GPUBuffer | null = null;
  private _coeffsBuffer: GPUBuffer | null = null;
  private _coeffsBufferSize = 0;

  // Staging buffers (STORAGE | COPY_SRC) — compute writes here, then
  // we copyBufferToBuffer into the Three.js vertex buffers.
  private _stagingBufA: GPUBuffer | null = null;
  private _stagingBufB: GPUBuffer | null = null;
  private _stagingCapacity = 0;

  // Bind groups
  private _coeffsBindGroup: GPUBindGroup | null = null;
  private _paramsBindGroup: GPUBindGroup | null = null;
  private _outputBindGroup: GPUBindGroup | null = null;

  // Frame seed counter (incremented each dispatch)
  private _frameSeed = 1;
  private _paramsScratch: ArrayBuffer;
  private _paramsView: DataView;

  private _ready = false;

  constructor(
    device: GPUDevice,
    ringBuffer: ParticleRingBuffer,
    shaderSource: string,
  ) {
    this._device = device;
    this._ringBuffer = ringBuffer;
    this._shaderSource = shaderSource;
    this._paramsScratch = new ArrayBuffer(PARAMS_BUFFER_SIZE);
    this._paramsView = new DataView(this._paramsScratch);
  }

  // ── Public API ──────────────────────────────────────────────────────

  get ready(): boolean { return this._ready; }

  /**
   * Initialize the compute pipeline and persistent GPU buffers.
   * Must be called after the ring buffer's GPU buffers exist
   * (i.e., after the first render frame).
   */
  init(): void {
    const device = this._device;

    // Create shader module
    const module = device.createShaderModule({ code: this._shaderSource });

    // Create compute pipeline
    this._pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    // Params uniform buffer (fixed size)
    this._paramsBuffer = device.createBuffer({
      size: PARAMS_BUFFER_SIZE,
      usage: BUF_UNIFORM | BUF_COPY_DST,
    });

    // Params bind group (group 1) — stable across frames
    this._paramsBindGroup = device.createBindGroup({
      layout: this._pipeline.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: this._paramsBuffer } }],
    });

    // Ensure staging buffers match current ring buffer capacity
    this._ensureStagingBuffers();

    this._ready = true;
  }

  /**
   * Emit particles for one frame via GPU compute.
   */
  dispatch(
    commandEncoder: GPUCommandEncoder,
    emitCount: number,
    params: ComputeParams,
    coeffs: Float32Array,
  ): boolean {
    if (!this._ready || !this._pipeline) return false;
    if (emitCount <= 0) return false;

    const device = this._device;
    const rb = this._ringBuffer;

    // Ensure staging buffers match ring buffer capacity (may have grown)
    this._ensureStagingBuffers();

    // If Three.js has not created or refreshed the render-side buffers yet
    // (first frame or right after grow()), do not advance GPU history. A
    // compute-only write into staging buffers would be invisible to render.
    const gpuBufs = rb.getGpuBuffers();
    if (!gpuBufs || !this._stagingBufA || !this._stagingBufB) return false;

    // Upload coefficients
    this._uploadCoeffs(coeffs);

    // Upload params uniform
    const writeOffset = rb.writeHead;
    const bufferCapacity = rb.capacity;
    this._uploadParams(params, emitCount, writeOffset, bufferCapacity);

    // Ensure output bind group is valid (recreated if staging buffers changed)
    if (!this._outputBindGroup) {
      this._createOutputBindGroup();
    }

    // Dispatch compute
    const dispatchCount = Math.ceil(emitCount / WORKGROUP_SIZE);
    const pass = commandEncoder.beginComputePass();
    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, this._coeffsBindGroup!);
    pass.setBindGroup(1, this._paramsBindGroup!);
    pass.setBindGroup(2, this._outputBindGroup!);
    pass.dispatchWorkgroups(dispatchCount);
    pass.end();

    // Copy staging buffers → Three.js vertex buffers
    const bytesPerParticle = 16; // 4 floats × 4 bytes
    if (writeOffset + emitCount <= bufferCapacity) {
      // Contiguous region
      const byteOffset = writeOffset * bytesPerParticle;
      const byteSize = emitCount * bytesPerParticle;
      commandEncoder.copyBufferToBuffer(this._stagingBufA, byteOffset, gpuBufs.bufA, byteOffset, byteSize);
      commandEncoder.copyBufferToBuffer(this._stagingBufB, byteOffset, gpuBufs.bufB, byteOffset, byteSize);
    } else {
      // Wrap-around: two copy commands
      const firstChunk = bufferCapacity - writeOffset;
      const firstOffset = writeOffset * bytesPerParticle;
      const firstSize = firstChunk * bytesPerParticle;
      commandEncoder.copyBufferToBuffer(this._stagingBufA, firstOffset, gpuBufs.bufA, firstOffset, firstSize);
      commandEncoder.copyBufferToBuffer(this._stagingBufB, firstOffset, gpuBufs.bufB, firstOffset, firstSize);

      const wrapSize = (emitCount - firstChunk) * bytesPerParticle;
      commandEncoder.copyBufferToBuffer(this._stagingBufA, 0, gpuBufs.bufA, 0, wrapSize);
      commandEncoder.copyBufferToBuffer(this._stagingBufB, 0, gpuBufs.bufB, 0, wrapSize);
    }

    // Record GPU write with arrivalTime bounds for alive-range estimation.
    // Bounce arrivals fall within ±1.5*spread. Production arrivals use the
    // shader's wider pp clamp, so include it whenever this dispatch contains
    // production particles. The history may overestimate, but must not cull
    // delayed production particles early.
    const bounceDelay = params.arrivalSpread * 1.5;
    const productionCount = params.bounceCount > 0 ? Math.max(0, emitCount - params.bounceCount) : 0;
    const productionDelay = productionCount > 0
      ? Math.max(0, params.ppBaseDelay + params.ppScatterRange + 2.0)
      : 0;
    const maxDelay = Math.max(bounceDelay, productionDelay);
    rb.recordGpuWrite(emitCount, params.simTime - maxDelay, params.simTime + maxDelay);

    // Intentional u32 wrap: the seed is a per-frame decorrelator with a 2^32 period.
    this._frameSeed = (this._frameSeed + 1) >>> 0;
    return true;
  }

  /**
   * Pack PerturbMode[] into the flat Float32Array format expected by the
   * WGSL Coeff struct: [l as u32 bits, m as i32 bits, c, sigma] × N.
   */
  static packCoeffs(modes: ReadonlyArray<PerturbMode>): Float32Array {
    const buf = new Float32Array(modes.length * 4);
    const u32View = new Uint32Array(buf.buffer);
    const i32View = new Int32Array(buf.buffer);
    for (let i = 0; i < modes.length; i++) {
      const off = i * 4;
      u32View[off] = modes[i].l;
      i32View[off + 1] = modes[i].m;
      buf[off + 2] = modes[i].c;
      buf[off + 3] = modes[i].sigma;
    }
    return buf;
  }

  /**
   * Release GPU resources.
   */
  dispose(): void {
    this._paramsBuffer?.destroy();
    this._coeffsBuffer?.destroy();
    this._stagingBufA?.destroy();
    this._stagingBufB?.destroy();
    this._paramsBuffer = null;
    this._coeffsBuffer = null;
    this._stagingBufA = null;
    this._stagingBufB = null;
    this._coeffsBindGroup = null;
    this._paramsBindGroup = null;
    this._outputBindGroup = null;
    this._pipeline = null;
    this._ready = false;
  }

  // ── Internal helpers ────────────────────────────────────────────────

  /** Ensure staging buffers match ring buffer capacity. */
  private _ensureStagingBuffers(): void {
    const cap = this._ringBuffer.capacity;
    if (this._stagingCapacity === cap && this._stagingBufA && this._stagingBufB) return;

    // Destroy old staging buffers
    this._stagingBufA?.destroy();
    this._stagingBufB?.destroy();

    const byteSize = cap * 16; // 4 floats × 4 bytes per particle
    this._stagingBufA = this._device.createBuffer({
      size: byteSize,
      usage: BUF_STORAGE | BUF_COPY_SRC,
    });
    this._stagingBufB = this._device.createBuffer({
      size: byteSize,
      usage: BUF_STORAGE | BUF_COPY_SRC,
    });
    this._stagingCapacity = cap;

    // Invalidate output bind group — it references the old staging buffers
    this._outputBindGroup = null;
  }

  /** Create or recreate the output bind group (group 2). */
  private _createOutputBindGroup(): void {
    if (!this._pipeline || !this._stagingBufA || !this._stagingBufB) return;
    this._outputBindGroup = this._device.createBindGroup({
      layout: this._pipeline.getBindGroupLayout(2),
      entries: [
        { binding: 0, resource: { buffer: this._stagingBufA } },
        { binding: 1, resource: { buffer: this._stagingBufB } },
      ],
    });
  }

  /** Upload packed coefficients to GPU storage buffer. */
  private _uploadCoeffs(coeffs: Float32Array): void {
    const device = this._device;
    const byteSize = coeffs.byteLength;

    // Reallocate if needed (coeffs array size may change with lMax)
    if (!this._coeffsBuffer || this._coeffsBufferSize < byteSize) {
      this._coeffsBuffer?.destroy();
      // Allocate with some headroom to avoid frequent reallocs
      const allocSize = Math.max(byteSize, 4096);
      this._coeffsBuffer = device.createBuffer({
        size: allocSize,
        usage: BUF_STORAGE | BUF_COPY_DST,
      });
      this._coeffsBufferSize = allocSize;

      // Recreate coeffs bind group (group 0)
      this._coeffsBindGroup = device.createBindGroup({
        layout: this._pipeline!.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this._coeffsBuffer } }],
      });
    }

    device.queue.writeBuffer(this._coeffsBuffer, 0, coeffs as Float32Array<ArrayBuffer>);
  }

  /** Upload frame params to the uniform buffer. */
  private _uploadParams(
    params: ComputeParams,
    emitCount: number,
    writeOffset: number,
    bufferCapacity: number,
  ): void {
    // Pack into a Float32Array matching the WGSL Params struct layout.
    // Mixed f32/u32 fields use DataView for correct bit patterns.
    const dv = this._paramsView;
    let off = 0;

    const wf = (v: number) => { dv.setFloat32(off, v, true); off += 4; };
    const wu = (v: number) => { dv.setUint32(off, v, true); off += 4; };

    wf(params.beta);               // 0
    wf(params.kCurvature);         // 4
    wf(params.perturbAmplitude);   // 8
    wu(params.lMax);               // 12
    wf(params.arrivalSpread);      // 16
    wf(params.simTime);            // 20
    wu(emitCount);                 // 24
    wu(this._frameSeed);           // 28
    wf(params.sensitivity);        // 32

    wf(params.hueMin);             // 36
    wf(params.hueRange);           // 40
    wf(params.brightnessFloor);    // 44
    wf(params.brightnessCeil);     // 48
    wf(params.sizeVariation);      // 52

    wf(params.globalMinAcc);       // 56
    wf(params.globalMaxAcc);       // 60

    wf(params.minWEff);            // 64
    wf(params.maxWEff);            // 68

    wu(writeOffset);               // 72
    wu(bufferCapacity);            // 76

    // Double-bounce
    wu(params.doubleBounce ? 1 : 0); // 80
    wf(params.dbPhase);              // 84
    wf(params.dbSecondHueShift);     // 88
    wf(params.dbSecondBriScale);     // 92

    // Pair production
    wu(params.bounceCount);          // 96
    wf(params.ppHueShift);           // 100
    wf(params.ppBriBoost);           // 104
    wf(params.ppSizeScale);          // 108
    wf(params.ppBaseDelay);          // 112
    wf(params.ppScatterRange);       // 116
    wf(params.ppBrightnessCeil);     // 120

    // Production normalization bounds
    wf(params.ppMinWEff);            // 124
    wf(params.ppMaxWEff);            // 128
    wf(params.ppGlobalMinAcc);       // 132
    wf(params.ppGlobalMaxAcc);       // 136
    // Tail padding remains zero in the reused scratch buffer.

    this._device.queue.writeBuffer(this._paramsBuffer!, 0, this._paramsScratch);
  }
}
