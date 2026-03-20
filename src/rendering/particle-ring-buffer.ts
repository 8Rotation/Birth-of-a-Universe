/**
 * particle-ring-buffer.ts — GPU ring buffer for immutable per-particle birth data.
 *
 * Stores 7 floats per particle packed into two vec4 InstancedBufferAttributes:
 *   attrA (vec4): [lx, ly, arrivalTime, hue]
 *   attrB (vec4): [brightness, eps, hitSize, 0.0]
 *
 * This layout produces only 2 GPU upload commands per frame (vs 6 previously),
 * eliminating 4× per-frame GPU sync overhead.
 *
 * Write-once semantics: particles are written at birth and never touched
 * from JS again. The GPU shader reads birth data + a single time uniform
 * to compute fade, color, and visibility each frame — zero per-particle JS.
 */

import * as THREE from "three";

/** Sentinel value for unborn/dead slots — yields huge rawAge so fade → 0. */
const BORN_SENTINEL = -1e9;

/** Bytes per particle: 2 vec4s × 4 floats × 4 bytes = 32 bytes. */
const BYTES_PER_PARTICLE = 32;

export class ParticleRingBuffer {
  private _capacity: number;
  private _writeHead = 0;
  private _totalWritten = 0;

  // Packed: [lx, ly, bornTime, hue] per particle
  private _attrA: THREE.InstancedBufferAttribute;
  // Packed: [brightness, eps, hitSize, 0] per particle
  private _attrB: THREE.InstancedBufferAttribute;

  // GPU direct-write references (set after first render via setGpuBackend)
  private _gpuDevice: GPUDevice | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _gpuBackend: any = null;

  constructor(initialCapacity: number) {
    this._capacity = initialCapacity;

    this._attrA = this._makeAttr(new Float32Array(initialCapacity * 4), 4);
    this._attrB = this._makeAttr(new Float32Array(initialCapacity * 4), 4);

    // Fill bornTime slot (attrA[i*4+2]) with sentinel so unwritten slots are always dead
    const a = this._attrA.array as Float32Array;
    for (let i = 0; i < initialCapacity; i++) {
      a[i * 4 + 2] = BORN_SENTINEL;
    }
  }

  // ── Public getters ──────────────────────────────────────────────────

  get capacity(): number { return this._capacity; }
  get totalWritten(): number { return this._totalWritten; }
  get activeCount(): number { return Math.min(this._totalWritten, this._capacity); }

  get packedAttrA(): THREE.InstancedBufferAttribute { return this._attrA; }
  get packedAttrB(): THREE.InstancedBufferAttribute { return this._attrB; }

  /** Read hue (degrees) for a given slot — stride-aware into packed attrA.w. */
  getHue(index: number): number {
    return (this._attrA.array as Float32Array)[index * 4 + 3];
  }

  /** Read brightness [0,1] for a given slot — stride-aware into packed attrB.x. */
  getBrightness(index: number): number {
    return (this._attrB.array as Float32Array)[index * 4];
  }

  /** Read bornTime for a given slot — stride-aware into packed attrA.z. */
  getBornTime(index: number): number {
    return (this._attrA.array as Float32Array)[index * 4 + 2];
  }

  /** Read position (lx) for a given slot — packed attrA.x. */
  getLx(index: number): number {
    return (this._attrA.array as Float32Array)[index * 4];
  }

  /** Read position (ly) for a given slot — packed attrA.y. */
  getLy(index: number): number {
    return (this._attrA.array as Float32Array)[index * 4 + 1];
  }

  /** Read eps for a given slot — packed attrB.y. */
  getEps(index: number): number {
    return (this._attrB.array as Float32Array)[index * 4 + 1];
  }

  /** Read hitSize for a given slot — packed attrB.z. */
  getHitSize(index: number): number {
    return (this._attrB.array as Float32Array)[index * 4 + 2];
  }

  // ── GPU direct-write setup ──────────────────────────────────────────

  /**
   * Provide GPU device and Three.js backend references for direct partial
   * buffer uploads. Call after `renderer.init()` and first render so the
   * backend has created GPUBuffers for the attributes.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setGpuBackend(device: GPUDevice, backend: any): void {
    this._gpuDevice = device;
    this._gpuBackend = backend;
  }

  // ── Write batch ─────────────────────────────────────────────────────

  /**
   * Write a batch of particles from the worker's packed Float32Array format.
   *
   * @param data   Packed particle data (stride floats per particle)
   * @param count  Number of particles in this batch
   * @param stride Number of floats per particle in the packed format (typically 8)
   * @param now    Current wall-clock time (seconds)
   * @param cutoffDuration  Maximum lifetime — if the slot being overwritten
   *               has bornTime > now - cutoffDuration, grow instead of overwrite
   */
  writeBatch(
    data: Float32Array,
    count: number,
    stride: number,
    now: number,
    cutoffDuration: number,
  ): void {
    const needed = count;
    let grew = false;

    // Check if wrapping would overwrite still-alive slots
    if (this._totalWritten >= this._capacity) {
      const nextHead = this._writeHead;
      const a = this._attrA.array as Float32Array;
      const oldest = a[nextHead * 4 + 2]; // bornTime
      if (oldest > now - cutoffDuration) {
        this.grow(this._capacity + needed);
        grew = true;
      }
    }

    const writeStart = this._writeHead;
    const a = this._attrA.array as Float32Array;
    const b = this._attrB.array as Float32Array;

    for (let i = 0; i < count; i++) {
      const src = i * stride;
      const dst = this._writeHead * 4;

      a[dst]     = data[src];      // lx
      a[dst + 1] = data[src + 1];  // ly
      a[dst + 2] = data[src + 2];  // bornTime
      a[dst + 3] = data[src + 3];  // hue

      b[dst]     = data[src + 4];  // brightness
      b[dst + 1] = data[src + 5];  // eps
      b[dst + 2] = data[src + 6];  // hitSize
      b[dst + 3] = 0.0;            // padding

      this._writeHead = (this._writeHead + 1) % this._capacity;
      this._totalWritten++;
    }

    // grow() already set needsUpdate = true for the full re-upload
    if (grew) return;

    // Try direct partial GPU write (bypasses full-buffer re-upload)
    if (this._gpuDevice && this._gpuBackend) {
      const gpuBufA: GPUBuffer | undefined = this._gpuBackend.get(this._attrA)?.buffer;
      const gpuBufB: GPUBuffer | undefined = this._gpuBackend.get(this._attrB)?.buffer;

      if (gpuBufA && gpuBufB) {
        // Cast: TS infers Float32Array<ArrayBufferLike> from attr.array,
        // but these are always backed by a plain ArrayBuffer (not shared).
        const srcA = a as Float32Array<ArrayBuffer>;
        const srcB = b as Float32Array<ArrayBuffer>;

        if (writeStart + count <= this._capacity) {
          // Contiguous write — single GPU upload per attribute
          const byteOffset = writeStart * 16; // 4 floats × 4 bytes
          this._gpuDevice.queue.writeBuffer(gpuBufA, byteOffset, srcA, writeStart * 4, count * 4);
          this._gpuDevice.queue.writeBuffer(gpuBufB, byteOffset, srcB, writeStart * 4, count * 4);
        } else {
          // Wrap-around — two GPU uploads per attribute
          const firstChunk = this._capacity - writeStart;
          const byteOffset1 = writeStart * 16;
          this._gpuDevice.queue.writeBuffer(gpuBufA, byteOffset1, srcA, writeStart * 4, firstChunk * 4);
          this._gpuDevice.queue.writeBuffer(gpuBufB, byteOffset1, srcB, writeStart * 4, firstChunk * 4);
          const wrapCount = count - firstChunk;
          this._gpuDevice.queue.writeBuffer(gpuBufA, 0, srcA, 0, wrapCount * 4);
          this._gpuDevice.queue.writeBuffer(gpuBufB, 0, srcB, 0, wrapCount * 4);
        }
        return; // skip needsUpdate — we wrote directly to the GPU
      }
    }

    // Fallback: GPUBuffer not yet created (first frame) or no device
    this._attrA.needsUpdate = true;
    this._attrB.needsUpdate = true;
  }

  // ── Alive-range tracking ─────────────────────────────────────────────

  /**
   * Returns {start, count} — the contiguous range of potentially-alive slots.
   * Particles outside this range are guaranteed dead (bornTime + cutoff < now).
   * May overestimate (include some dead particles at the edges) but never
   * underestimates (never skips a particle that could be alive).
   */
  computeAliveRange(now: number, cutoffDuration: number): { start: number; count: number } {
    if (this._totalWritten === 0) return { start: 0, count: 0 };

    const a = this._attrA.array as Float32Array;
    const cutoff = now - cutoffDuration;

    if (this._totalWritten <= this._capacity) {
      // Buffer hasn't wrapped — particles are at slots [0, totalWritten).
      // Scan from 0 (oldest) to find first alive particle.
      let start = 0;
      while (start < this._totalWritten) {
        const born = a[start * 4 + 2];
        if (born > cutoff) break;
        start++;
      }
      return { start, count: this._totalWritten - start };
    }

    // Buffer has wrapped. Scan from writeHead (oldest slot) forward
    // until we find the first alive particle.
    let start = this._writeHead; // oldest slot
    let skipped = 0;
    while (skipped < this._capacity) {
      const born = a[start * 4 + 2];
      if (born > cutoff) break; // this particle is still alive
      start = (start + 1) % this._capacity;
      skipped++;
    }
    const count = this._capacity - skipped;
    return { start, count };
  }

  // ── Clear ───────────────────────────────────────────────────────────

  /** Reset the ring buffer — fills bornTime with sentinel, resets writeHead. */
  clear(): void {
    this._writeHead = 0;
    this._totalWritten = 0;
    const a = this._attrA.array as Float32Array;
    for (let i = 0; i < this._capacity; i++) {
      a[i * 4 + 2] = BORN_SENTINEL;
    }
    this._attrA.needsUpdate = true;
    this._attrB.needsUpdate = true;
  }

  // ── Invalidate future ───────────────────────────────────────────────

  /**
   * Kill particles born after cutoffTime (e.g. after a settings change).
   * Sets their bornTime to sentinel so the shader treats them as dead.
   */
  invalidateFuture(cutoffTime: number): void {
    const a = this._attrA.array as Float32Array;
    const len = this._capacity;
    for (let i = 0; i < len; i++) {
      const bornIdx = i * 4 + 2;
      if (a[bornIdx] > cutoffTime) {
        a[bornIdx] = BORN_SENTINEL;
      }
    }
    this._attrA.needsUpdate = true;
  }

  // ── Grow ────────────────────────────────────────────────────────────

  /**
   * Double capacity until >= minCapacity. Copies existing data and replaces
   * .array on existing attribute objects (no attribute recreation — avoids
   * WebGPU shader recompilation).
   */
  grow(minCapacity: number): void {
    let newCap = this._capacity;
    while (newCap < minCapacity) newCap *= 2;
    if (newCap === this._capacity) return;

    const oldCap = this._capacity;
    this._capacity = newCap;

    this._growAttr(this._attrA, oldCap);
    this._growAttr(this._attrB, oldCap);

    // Fill new bornTime slots with sentinel
    const a = this._attrA.array as Float32Array;
    for (let i = oldCap; i < newCap; i++) {
      a[i * 4 + 2] = BORN_SENTINEL;
    }

    // After grow, writeHead stays where it is (pointing at first empty slot
    // in the new region, or at an old slot that's now safe to continue from).
    // If we were at wrap-around, move writeHead to the old capacity
    // since those are the newly available empty slots.
    if (this._totalWritten >= oldCap) {
      this._writeHead = oldCap;
    }

    console.log(
      `[ring-buffer] Grown → ${newCap} particles ` +
      `(${(newCap * BYTES_PER_PARTICLE / 1024 / 1024).toFixed(1)} MB)`
    );
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private _makeAttr(
    array: Float32Array,
    itemSize: number,
  ): THREE.InstancedBufferAttribute {
    const attr = new THREE.InstancedBufferAttribute(array, itemSize);
    attr.setUsage(THREE.DynamicDrawUsage);
    return attr;
  }

  private _growAttr(
    attr: THREE.InstancedBufferAttribute,
    oldCap: number,
  ): void {
    const oldArr = attr.array as Float32Array;
    const newArr = new Float32Array(this._capacity * 4);
    newArr.set(oldArr.subarray(0, oldCap * 4));
    attr.array = newArr;
    attr.needsUpdate = true;
  }
}
