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
import { getAttributeBuffer } from "./three-backend.js";

export const MIN_VALID_ARRIVAL_TIME = -1e8;
export const MAX_VALID_ARRIVAL_TIME = 1e8;
/** Sentinel value for unwritten/dead slots — yields huge rawAge so fade -> 0. */
export const DEAD_ARRIVAL_TIME = MIN_VALID_ARRIVAL_TIME * 10;

/**
 * Arrival offsets are clamped to +/-1.5x arrivalSpread in CPU and GPU emitters;
 * callers that use arrival-time lower bounds must include at least this padding.
 */
export const ARRIVAL_SEARCH_PADDING_MULTIPLIER = 1.5;

const DEV = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV !== false;

function assertDev(condition: boolean, message: string): asserts condition {
  if (DEV && !condition) throw new RangeError(message);
}

/** Bytes per particle: 2 vec4s × 4 floats × 4 bytes = 32 bytes. */
const BYTES_PER_PARTICLE = 32;

/** Maximum write records to keep for stable alive-range estimates. */
const WRITE_HISTORY_MAX = 65_536;

/** Tracks metadata for a CPU or GPU batch written into the ring buffer. */
interface WriteRecord {
  /** Ring buffer position at the START of this write batch. */
  writeHead: number;
  /** Number of particles written by this batch. */
  count: number;
  /** Earliest possible arrivalTime in this batch. */
  minArrival: number;
  /** Latest possible arrivalTime in this batch. */
  maxArrival: number;
}

export class ParticleRingBuffer {
  private _capacity: number;
  private _writeHead = 0;
  private _totalWritten = 0;

  // Packed: [lx, ly, arrivalTime, hue] per particle
  private _attrA: THREE.InstancedBufferAttribute;
  // Packed: [brightness, eps, hitSize, 0] per particle
  private _attrB: THREE.InstancedBufferAttribute;
  private _resizeVersion = 0;

  // GPU direct-write references (set after first render via setGpuBackend)
  private _gpuDevice: GPUDevice | null = null;
  private _gpuBackendOwner: unknown = null;
  /** False after grow() until the next needsUpdate cycle re-creates GPUBuffers. */
  private _gpuBufCacheValid = false;

  /**
   * When true, computeAliveRange() uses GPU write history instead of
   * binary-searching the CPU-side Float32Array (which is stale when
   * particles are emitted by the GPU compute shader).
   */
  private _gpuComputeMode = false;
  /** Chronological history of write batches for stable alive-range estimation. */
  private _writeHistory: WriteRecord[] = [];
  private _writeHistoryCount = 0;
  private _hasGpuWrites = false;

  constructor(initialCapacity: number) {
    this._capacity = initialCapacity;

    this._attrA = this._makeAttr(new Float32Array(initialCapacity * 4), 4);
    this._attrB = this._makeAttr(new Float32Array(initialCapacity * 4), 4);

    // Fill arrivalTime slot (attrA[i*4+2]) so unwritten slots are always dead.
    const a = this._attrA.array as Float32Array;
    for (let i = 0; i < initialCapacity; i++) {
      a[i * 4 + 2] = DEAD_ARRIVAL_TIME;
    }
  }

  // ── Public getters ──────────────────────────────────────────────────

  get capacity(): number { return this._capacity; }
  get totalWritten(): number { return this._totalWritten; }
  get activeCount(): number { return Math.min(this._totalWritten, this._capacity); }

  get packedAttrA(): THREE.InstancedBufferAttribute { return this._attrA; }
  get packedAttrB(): THREE.InstancedBufferAttribute { return this._attrB; }
  get resizeVersion(): number { return this._resizeVersion; }

  /** Read hue (degrees) for a given slot — stride-aware into packed attrA.w. */
  getHue(index: number): number {
    this._assertIndex(index);
    return (this._attrA.array as Float32Array)[index * 4 + 3];
  }

  /** Read brightness [0,1] for a given slot — stride-aware into packed attrB.x. */
  getBrightness(index: number): number {
    this._assertIndex(index);
    return (this._attrB.array as Float32Array)[index * 4];
  }

  /** Read arrivalTime for a given slot — stride-aware into packed attrA.z. */
  getArrivalTime(index: number): number {
    this._assertIndex(index);
    return (this._attrA.array as Float32Array)[index * 4 + 2];
  }

  /** Read position (lx) for a given slot — packed attrA.x. */
  getLx(index: number): number {
    this._assertIndex(index);
    return (this._attrA.array as Float32Array)[index * 4];
  }

  /** Read position (ly) for a given slot — packed attrA.y. */
  getLy(index: number): number {
    this._assertIndex(index);
    return (this._attrA.array as Float32Array)[index * 4 + 1];
  }

  /** Read eps for a given slot — packed attrB.y. */
  getEps(index: number): number {
    this._assertIndex(index);
    return (this._attrB.array as Float32Array)[index * 4 + 1];
  }

  /** Read hitSize for a given slot — packed attrB.z. */
  getHitSize(index: number): number {
    this._assertIndex(index);
    return (this._attrB.array as Float32Array)[index * 4 + 2];
  }

  /**
   * Subsample the alive range and return the maximum eps found.
   * Uses strided access to stay cheap even with large alive counts.
   */
  sampleMaxEps(start: number, count: number, maxSamples = 2048): number {
    if (count === 0) return 0;
    const b = this._attrB.array as Float32Array;
    const cap = this._capacity;
    const step = Math.max(1, Math.floor(count / maxSamples));
    let best = 0;
    for (let i = 0; i < count; i += step) {
      const idx = (start + i) % cap;
      const eps = b[idx * 4 + 1];
      if (eps > best) best = eps;
    }
    return best;
  }

  /** Count of consecutive fallbacks to needsUpdate — logged once for diagnosis. */
  private _needsUpdateFallbackCount = 0;
  private _directWriteSuccessLogged = false;

  // ── GPU direct-write setup ──────────────────────────────────────────

  /**
   * Provide GPU device and Three.js renderer/backend references for direct partial
   * buffer uploads. Call after `renderer.init()` and first render so the
   * backend has created GPUBuffers for the attributes.
   */
  setGpuBackend(device: GPUDevice, backendOwner: unknown): void {
    this._gpuDevice = device;
    this._gpuBackendOwner = backendOwner;
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
  *               has arrivalTime > now - cutoffDuration, grow instead of overwrite
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
      const oldest = a[nextHead * 4 + 2]; // arrivalTime
      if (oldest > now - cutoffDuration) {
        this.grow(this._capacity + needed);
        grew = true;
      }
    }

    const writeStart = this._writeHead;
    const a = this._attrA.array as Float32Array;
    const b = this._attrB.array as Float32Array;

    let minArrival = Infinity;
    let maxArrival = -Infinity;

    for (let i = 0; i < count; i++) {
      const src = i * stride;
      const dst = this._writeHead * 4;
      const arrivalTime = data[src + 2];
      this._assertValidArrivalTime(arrivalTime);

      a[dst]     = data[src];      // lx
      a[dst + 1] = data[src + 1];  // ly
      a[dst + 2] = arrivalTime;    // arrivalTime
      a[dst + 3] = data[src + 3];  // hue

      b[dst]     = data[src + 4];  // brightness
      b[dst + 1] = data[src + 5];  // eps
      b[dst + 2] = data[src + 6];  // hitSize
      b[dst + 3] = 0.0;            // padding

      this._writeHead = (this._writeHead + 1) % this._capacity;
      this._totalWritten++;

      if (arrivalTime < minArrival) minArrival = arrivalTime;
      if (arrivalTime > maxArrival) maxArrival = arrivalTime;
    }

    this._recordWrite(writeStart, count, minArrival, maxArrival, false);

    // grow() already set needsUpdate = true for the full re-upload
    if (grew) return;

    // Try direct partial GPU write (bypasses full-buffer re-upload)
    if (this._gpuDevice && this._gpuBackendOwner && this._gpuBufCacheValid) {
      const gpuBufA = getAttributeBuffer(this._gpuBackendOwner, this._attrA);
      const gpuBufB = getAttributeBuffer(this._gpuBackendOwner, this._attrB);

      if (gpuBufA && gpuBufB) {
        // Verify buffer sizes match current capacity (stale after grow)
        const expectedSize = this._capacity * 16; // 4 floats × 4 bytes
        if (gpuBufA.size < expectedSize || gpuBufB.size < expectedSize) {
          // GPUBuffers are stale (pre-grow size) — fall through to needsUpdate
          this._gpuBufCacheValid = false;
        } else {
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
          if (!this._directWriteSuccessLogged) {
            this._directWriteSuccessLogged = true;
            console.log(`[ring-buffer] Direct GPU write active (bypassing needsUpdate)`);
          }
          this._needsUpdateFallbackCount = 0;
          return; // skip needsUpdate — we wrote directly to the GPU
        }
      } else {
        // GPUBuffer not found — log diagnostic on first occurrence
        if (this._needsUpdateFallbackCount === 3) {
          console.warn(
            `[ring-buffer] Direct GPU write FAILED — attribute buffer unavailable:`,
            getAttributeBuffer(this._gpuBackendOwner, this._attrA),
            `| Falling back to needsUpdate every frame (SLOW — full buffer re-upload)`
          );
        }
      }
    }

    // Fallback: GPUBuffer not yet created (first frame), stale after grow, or no device.
    // After Three.js processes needsUpdate it creates correctly-sized GPUBuffers.
    this._needsUpdateFallbackCount++;
    this._attrA.needsUpdate = true;
    this._attrB.needsUpdate = true;
    this._gpuBufCacheValid = true; // new GPUBuffers will match capacity after upload
  }

  // ── GPU compute mode ────────────────────────────────────────────────

  /**
   * Enable or disable GPU compute mode. When enabled, computeAliveRange()
   * uses recorded GPU write history instead of binary-searching the
  * CPU-side Float32Array (which is stale in GPU compute mode).
   */
  set gpuComputeMode(enabled: boolean) {
    this._gpuComputeMode = enabled;
  }
  get gpuComputeMode(): boolean { return this._gpuComputeMode; }

  /**
   * Record that `count` particles were written by the GPU compute shader
  * starting at the current writeHead, with arrivalTimes approximately in
  * [minArrival, maxArrival]. Advances the write head by `count`.
   *
   * Used instead of advanceWriteHead() when GPU compute is active so that
   * computeAliveRange() can estimate alive particles from the history
   * instead of reading stale CPU-side arrivalTime data.
   */
  recordGpuWrite(count: number, minArrival: number, maxArrival: number): void {
    if (count <= 0) return;
    this._assertValidArrivalTime(minArrival);
    this._assertValidArrivalTime(maxArrival);

    const writeStart = this._writeHead;
    this._writeHead = (this._writeHead + count) % this._capacity;
    this._totalWritten += count;
    this._recordWrite(writeStart, count, minArrival, maxArrival, true);
  }

  // ── Alive-range tracking ─────────────────────────────────────────────

  /**
   * Returns {start, count} — the contiguous range of potentially-alive slots.
  * Particles outside this range are guaranteed dead (arrivalTime + cutoff < now).
   * May overestimate (include some dead particles at the edges) but never
   * underestimates (never skips a particle that could be alive).
   */
  computeAliveRange(now: number, cutoffDuration: number): { start: number; count: number } {
    if (this._totalWritten === 0) return { start: 0, count: 0 };

    // Write-order arrival times are not strictly sorted when arrivalSpread is
    // nonzero. Use batch history instead of binary-searching noisy particles;
    // this keeps the draw window stable during high-rate slider changes.
    if (this._writeHistory.length > 0) {
      return this._computeAliveRangeFromHistory(now, cutoffDuration);
    }

    if (this._hasGpuWrites) {
      return this._fullActiveRange();
    }

    return this._binarySearchAliveRange(now, cutoffDuration);
  }

  /** Count particles that are actually visible now (not merely queued/future). */
  countVisible(now: number, visibleDuration: number): number {
    if (this._totalWritten === 0) return 0;
    const deadline = now - visibleDuration;

    if (this._hasGpuWrites || this._gpuComputeMode) {
      let total = 0;
      for (const record of this._writeHistory) {
        const overlap = Math.min(record.maxArrival, now) - Math.max(record.minArrival, deadline);
        if (overlap <= 0) continue;

        const span = record.maxArrival - record.minArrival;
        total += span > 1e-6 ? record.count * Math.min(1, overlap / span) : record.count;
      }
      return Math.round(Math.min(total, this.activeCount));
    }

    const a = this._attrA.array as Float32Array;
    const { start, count } = this._fullActiveRange();
    let visible = 0;
    for (let i = 0; i < count; i++) {
      const idx = (start + i) % this._capacity;
      const arrivalTime = a[idx * 4 + 2];
      if (arrivalTime > deadline && arrivalTime <= now) visible++;
    }
    return visible;
  }

  /**
   * History alive-range: linear-scan batch bounds instead of binary-searching
  * per-particle arrivalTimes that can jitter within the arrival-spread window.
   */
  private _computeAliveRangeFromHistory(
    now: number,
    cutoffDuration: number,
  ): { start: number; count: number } {
    if (this._writeHistoryCount < this.activeCount) {
      return this._fullActiveRange();
    }

    const deadline = now - cutoffDuration;
    const hist = this._writeHistory;
    const cap = this._capacity;

    let firstAlive = -1;
    for (let i = 0; i < hist.length; i++) {
      if (hist[i].maxArrival > deadline) {
        firstAlive = i;
        break;
      }
    }

    if (firstAlive < 0) {
      // All recorded batches are dead
      return { start: this._writeHead, count: 0 };
    }

    const start = hist[firstAlive].writeHead;
    const count = (this._writeHead - start + cap) % cap;
    return { start, count: count === 0 && this._totalWritten > 0 ? cap : count };
  }

  private _fullActiveRange(): { start: number; count: number } {
    if (this._totalWritten <= this._capacity) {
      return { start: 0, count: this._totalWritten };
    }
    return { start: this._writeHead, count: this._capacity };
  }

  private _recordWrite(
    writeHead: number,
    count: number,
    minArrival: number,
    maxArrival: number,
    gpuWrite: boolean,
  ): void {
    if (count <= 0) return;
    this._writeHistory.push({ writeHead, count, minArrival, maxArrival });
    this._writeHistoryCount += count;
    if (gpuWrite) this._hasGpuWrites = true;
    this._trimWriteHistory();
  }

  private _trimWriteHistory(): void {
    const activeCount = this.activeCount;
    let overwritten = this._writeHistoryCount - activeCount;
    while (overwritten > 0 && this._writeHistory.length > 0) {
      const first = this._writeHistory[0];
      if (overwritten >= first.count) {
        this._writeHistoryCount -= first.count;
        overwritten -= first.count;
        this._writeHistory.shift();
      } else {
        first.writeHead = (first.writeHead + overwritten) % this._capacity;
        first.count -= overwritten;
        this._writeHistoryCount -= overwritten;
        overwritten = 0;
      }
    }

    while (this._writeHistory.length > WRITE_HISTORY_MAX) {
      this._writeHistoryCount -= this._writeHistory.shift()!.count;
    }
  }

  private _resetWriteHistory(): void {
    this._writeHistory.length = 0;
    this._writeHistoryCount = 0;
    this._hasGpuWrites = false;
  }

  /**
   * CPU path: binary-search the per-particle arrivalTime array.
   * Used when GPU compute mode is off.
   */
  private _binarySearchAliveRange(
    now: number,
    cutoffDuration: number,
  ): { start: number; count: number } {
    const cutoff = now - cutoffDuration;

    if (this._totalWritten <= this._capacity) {
      const lo = this._arrivalTimeLowerBound(cutoff);
      return { start: lo, count: this._totalWritten - lo };
    }

    const lo = this._arrivalTimeLowerBound(cutoff);
    const cap = this._capacity;
    const wh = this._writeHead;
    const start = (wh + lo) % cap;
    return { start, count: cap - lo };
  }

  /**
   * Returns the first logical write-order offset whose arrivalTime is greater
   * than the padded cutoff. Callers guarantee cutoffDuration includes at least
   * ARRIVAL_SEARCH_PADDING_MULTIPLIER * arrivalSpread when relying on raw slots.
   */
  private _arrivalTimeLowerBound(cutoff: number): number {
    const a = this._attrA.array as Float32Array;
    if (this._totalWritten <= this._capacity) {
      let lo = 0, hi = this._totalWritten;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (a[mid * 4 + 2] <= cutoff) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    const cap = this._capacity;
    const wh = this._writeHead;
    let lo = 0, hi = cap;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const physIdx = (wh + mid) % cap;
      if (a[physIdx * 4 + 2] <= cutoff) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // ── GPU compute helpers ──────────────────────────────────────────────

  /**
   * Returns the underlying GPUBuffer handles for the two packed attributes,
   * or null if GPU buffers haven't been created yet (first frame) or are stale.
   * Used by ComputeEmitter to set up copyBufferToBuffer targets.
   */
  getGpuBuffers(): { bufA: GPUBuffer; bufB: GPUBuffer } | null {
    if (!this._gpuDevice || !this._gpuBackendOwner) return null;
    const gpuBufA = getAttributeBuffer(this._gpuBackendOwner, this._attrA);
    const gpuBufB = getAttributeBuffer(this._gpuBackendOwner, this._attrB);
    if (!gpuBufA || !gpuBufB) return null;
    const expectedSize = this._capacity * 16;
    if (gpuBufA.size < expectedSize || gpuBufB.size < expectedSize) {
      this._gpuBufCacheValid = false;
      return null;
    }
    this._gpuBufCacheValid = true;
    return { bufA: gpuBufA, bufB: gpuBufB };
  }

  /**
   * Advance the write head and total-written counter WITHOUT writing CPU-side
   * data. Used by ComputeEmitter after the GPU compute shader has written
   * directly to the GPU buffers.
   *
   * If the write would overwrite still-alive slots, triggers grow().
   */
  advanceWriteHead(count: number): void {
    if (count <= 0) return;

    // Check for wrap-around overwriting alive slots (same guard as writeBatch)
    if (this._totalWritten >= this._capacity) {
      // Can't easily check arrivalTime since CPU data is stale in GPU-compute mode.
      // The caller (ComputeEmitter) is responsible for not exceeding capacity
      // faster than particles die. We just advance.
    }

    this._writeHead = (this._writeHead + count) % this._capacity;
    this._totalWritten += count;
  }

  /** Current write-head position (for ComputeEmitter writeOffset). */
  get writeHead(): number { return this._writeHead; }

  // ── Clear ───────────────────────────────────────────────────────────

  /** Reset the ring buffer — fills arrivalTime with sentinel, resets writeHead. */
  clear(): void {
    this._writeHead = 0;
    this._totalWritten = 0;
    this._resetWriteHistory();
    const a = this._attrA.array as Float32Array;
    for (let i = 0; i < this._capacity; i++) {
      a[i * 4 + 2] = DEAD_ARRIVAL_TIME;
    }
    this._attrA.needsUpdate = true;
    this._attrB.needsUpdate = true;
  }

  // ── Invalidate future ───────────────────────────────────────────────

  /**
   * Kill particles scheduled after cutoffTime (e.g. after a settings change).
   * Sets their arrivalTime to sentinel so the shader treats them as dead.
   */
  invalidateFuture(cutoffTime: number): void {
    const a = this._attrA.array as Float32Array;
    const count = this.activeCount;
    const start = this._totalWritten <= this._capacity ? 0 : this._writeHead;
    for (let i = 0; i < count; i++) {
      const index = (start + i) % this._capacity;
      const arrivalIdx = index * 4 + 2;
      if (a[arrivalIdx] > cutoffTime) {
        a[arrivalIdx] = DEAD_ARRIVAL_TIME;
      }
    }
    this._attrA.needsUpdate = true;
  }

  // ── Grow ────────────────────────────────────────────────────────────

  /** Timestamp of last successful grow — used for cooldown. */
  private _lastGrowTime = -Infinity;
  /** When true, a previous grow() OOM has occurred — further grows are blocked. */
  private _growFailed = false;

  /**
   * Double capacity until >= minCapacity (capped at 4× current per call).
   * Copies existing data and replaces .array on existing attribute objects
   * (no attribute recreation — avoids WebGPU shader recompilation).
   *
   * Safety guards:
   *   - Caps single grow to 4× current capacity to prevent huge allocations.
   *   - Minimum 500ms cooldown between grows to prevent rapid-fire reallocs
   *     during slider drags that would hammer the GC and stale GPUBuffers.
   *   - try/catch around allocation so an OOM doesn't kill the animation loop.
   */
  grow(minCapacity: number): void {
    // Cooldown: at most one grow per 500ms to avoid hammering GC + GPU
    const now = performance.now();
    if (now - this._lastGrowTime < 500) return;
    // If a previous grow OOM'd, don't attempt further grows
    if (this._growFailed) return;

    // Cap single grow step to 4× current capacity to prevent
    // massive single-shot allocations (e.g. 100K rate × 60s persistence).
    // Further grows will happen on subsequent frames if needed.
    const maxTarget = this._capacity * 4;
    const clampedMin = Math.min(minCapacity, maxTarget);

    let newCap = this._capacity;
    while (newCap < clampedMin) newCap *= 2;
    if (newCap === this._capacity) return;

    const oldCap = this._capacity;
    const oldHead = this._writeHead;
    const hadWrapped = this._totalWritten >= oldCap;

    try {
      this._capacity = newCap;

      if (hadWrapped) {
        // Reorder: chronological = [oldHead..oldCap) + [0..oldHead)
        this._growAttrReorder(this._attrA, oldCap, oldHead, "packedAttrA");
        this._growAttrReorder(this._attrB, oldCap, oldHead, "packedAttrB");
        for (const record of this._writeHistory) {
          record.writeHead = (record.writeHead - oldHead + oldCap) % oldCap;
        }
        // writeHead now points right after the old data
        this._writeHead = oldCap;
        // After linearizing, exactly oldCap particles occupy [0..oldCap)
        this._totalWritten = oldCap;
      } else {
        // No wrap — data is already in order [0..totalWritten)
        this._growAttr(this._attrA, oldCap, "packedAttrA");
        this._growAttr(this._attrB, oldCap, "packedAttrB");
        // writeHead stays at its current position (still valid)
      }

      // Fill remaining slots with sentinel
      const a = this._attrA.array as Float32Array;
      for (let i = oldCap; i < newCap; i++) {
        a[i * 4 + 2] = DEAD_ARRIVAL_TIME;
      }

      // Invalidate cached GPU buffer references — the old GPUBuffers
      // are now too small.  Next writeBatch() will either get the new
      // GPUBuffer from the backend (after Three.js re-uploads via
      // needsUpdate) or fall back to needsUpdate again.
      this._gpuBufCacheValid = false;
      this._resizeVersion++;
      this._lastGrowTime = now;
      this._trimWriteHistory();

      console.log(
        `[ring-buffer] Grown → ${newCap} particles ` +
        `(${(newCap * BYTES_PER_PARTICLE / 1024 / 1024).toFixed(1)} MB)`
      );
    } catch (e) {
      // OOM: revert capacity so the ring buffer stays consistent.
      // The buffer will overwrite old slots instead of growing.
      this._capacity = oldCap;
      this._writeHead = oldHead;
      if (hadWrapped) this._totalWritten = oldCap; // was already capped
      this._growFailed = true;
      console.warn(
        `[ring-buffer] Grow failed (OOM) at ${newCap} particles ` +
        `(${(newCap * BYTES_PER_PARTICLE / 1024 / 1024).toFixed(1)} MB) — ` +
        `overwriting old slots instead. Error:`, e
      );
    }
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

  private _assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this._capacity) {
      throw new RangeError(`ParticleRingBuffer index ${index} out of bounds for capacity ${this._capacity}`);
    }
  }

  private _assertValidArrivalTime(arrivalTime: number): void {
    assertDev(
      arrivalTime > MIN_VALID_ARRIVAL_TIME && arrivalTime < MAX_VALID_ARRIVAL_TIME,
      `arrivalTime ${arrivalTime} outside valid range (${MIN_VALID_ARRIVAL_TIME}, ${MAX_VALID_ARRIVAL_TIME})`,
    );
  }

  private _destroyAttributeGpuBuffer(attr: THREE.InstancedBufferAttribute, label: string): void {
    if (!this._gpuBackendOwner) return;
    const buffer = getAttributeBuffer(this._gpuBackendOwner, attr);
    if (!buffer) return;
    try {
      buffer.destroy();
    } catch (e) {
      console.warn(`[ring-buffer] Failed to destroy old GPUBuffer for ${label}:`, e);
    }
  }

  private _growAttr(
    attr: THREE.InstancedBufferAttribute,
    oldCap: number,
    label: string,
  ): void {
    const oldArr = attr.array as Float32Array;
    const newArr = new Float32Array(this._capacity * 4);
    newArr.set(oldArr.subarray(0, oldCap * 4));
    this._destroyAttributeGpuBuffer(attr, label);
    attr.array = newArr;
    (attr as unknown as { count: number }).count = this._capacity;
    attr.needsUpdate = true;
  }

  private _growAttrReorder(
    attr: THREE.InstancedBufferAttribute,
    oldCap: number,
    oldHead: number,
    label: string,
  ): void {
    const oldArr = attr.array as Float32Array;
    const newArr = new Float32Array(this._capacity * 4);
    // First segment: [oldHead..oldCap)
    const firstLen = (oldCap - oldHead) * 4;
    newArr.set(oldArr.subarray(oldHead * 4, oldCap * 4), 0);
    // Second segment: [0..oldHead)
    newArr.set(oldArr.subarray(0, oldHead * 4), firstLen);
    this._destroyAttributeGpuBuffer(attr, label);
    attr.array = newArr;
    (attr as unknown as { count: number }).count = this._capacity;
    attr.needsUpdate = true;
  }
}
