/**
 * particle-ring-buffer.ts — GPU ring buffer for immutable per-particle birth data.
 *
 * Stores 7 floats per particle as separate InstancedBufferAttributes:
 *   posAttr  (2 floats: lx, ly)
 *   bornAttr (1 float: wall-clock birth time)
 *   hueAttr  (1 float: hue degrees [0, 360])
 *   briAttr  (1 float: brightness [0, 1])
 *   epsAttr  (1 float: raw energy density)
 *   sizeAttr (1 float: hit size [0, 1])
 *
 * Write-once semantics: particles are written at birth and never touched
 * from JS again. The GPU shader reads birth data + a single time uniform
 * to compute fade, color, and visibility each frame — zero per-particle JS.
 */

import * as THREE from "three";

/** Sentinel value for unborn/dead slots — yields huge rawAge so fade → 0. */
const BORN_SENTINEL = -1e9;

export class ParticleRingBuffer {
  private _capacity: number;
  private _writeHead = 0;
  private _totalWritten = 0;

  // Per-particle InstancedBufferAttributes (all DynamicDrawUsage)
  private _posAttr: THREE.InstancedBufferAttribute;
  private _bornAttr: THREE.InstancedBufferAttribute;
  private _hueAttr: THREE.InstancedBufferAttribute;
  private _briAttr: THREE.InstancedBufferAttribute;
  private _epsAttr: THREE.InstancedBufferAttribute;
  private _sizeAttr: THREE.InstancedBufferAttribute;

  constructor(initialCapacity: number) {
    this._capacity = initialCapacity;

    this._posAttr = this._makeAttr(new Float32Array(initialCapacity * 2), 2);
    this._bornAttr = this._makeAttr(new Float32Array(initialCapacity), 1);
    this._hueAttr = this._makeAttr(new Float32Array(initialCapacity), 1);
    this._briAttr = this._makeAttr(new Float32Array(initialCapacity), 1);
    this._epsAttr = this._makeAttr(new Float32Array(initialCapacity), 1);
    this._sizeAttr = this._makeAttr(new Float32Array(initialCapacity), 1);

    // Fill bornAttr with sentinel so unwritten slots are always dead
    (this._bornAttr.array as Float32Array).fill(BORN_SENTINEL);
  }

  // ── Public getters ──────────────────────────────────────────────────

  get capacity(): number { return this._capacity; }
  get totalWritten(): number { return this._totalWritten; }
  get activeCount(): number { return Math.min(this._totalWritten, this._capacity); }

  get positionAttribute(): THREE.InstancedBufferAttribute { return this._posAttr; }
  get bornTimeAttribute(): THREE.InstancedBufferAttribute { return this._bornAttr; }
  get hueAttribute(): THREE.InstancedBufferAttribute { return this._hueAttr; }
  get brightnessAttribute(): THREE.InstancedBufferAttribute { return this._briAttr; }
  get epsAttribute(): THREE.InstancedBufferAttribute { return this._epsAttr; }
  get sizeAttribute(): THREE.InstancedBufferAttribute { return this._sizeAttr; }

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
    // Check if wrapping would overwrite still-alive slots
    if (this._totalWritten >= this._capacity) {
      // Check the next slot(s) we'd overwrite
      const nextHead = this._writeHead;
      const bornArr = this._bornAttr.array as Float32Array;
      const oldest = bornArr[nextHead];
      if (oldest > now - cutoffDuration) {
        // Still alive — grow to accommodate
        this.grow(this._capacity + needed);
      }
    }

    const posArr = this._posAttr.array as Float32Array;
    const bornArr = this._bornAttr.array as Float32Array;
    const hueArr = this._hueAttr.array as Float32Array;
    const briArr = this._briAttr.array as Float32Array;
    const epsArr = this._epsAttr.array as Float32Array;
    const sizeArr = this._sizeAttr.array as Float32Array;

    for (let i = 0; i < count; i++) {
      const src = i * stride;
      const slot = this._writeHead;

      posArr[slot * 2] = data[src];         // lx
      posArr[slot * 2 + 1] = data[src + 1]; // ly
      bornArr[slot] = data[src + 2];        // arrivalTime
      hueArr[slot] = data[src + 3];         // hue
      briArr[slot] = data[src + 4];         // brightness
      epsArr[slot] = data[src + 5];         // eps
      sizeArr[slot] = data[src + 6];        // hitSize

      this._writeHead = (this._writeHead + 1) % this._capacity;
      this._totalWritten++;
    }

    this._posAttr.needsUpdate = true;
    this._bornAttr.needsUpdate = true;
    this._hueAttr.needsUpdate = true;
    this._briAttr.needsUpdate = true;
    this._epsAttr.needsUpdate = true;
    this._sizeAttr.needsUpdate = true;
  }

  // ── Clear ───────────────────────────────────────────────────────────

  /** Reset the ring buffer — fills bornAttr with sentinel, resets writeHead. */
  clear(): void {
    this._writeHead = 0;
    this._totalWritten = 0;
    (this._bornAttr.array as Float32Array).fill(BORN_SENTINEL);
    this._bornAttr.needsUpdate = true;
    this._posAttr.needsUpdate = true;
    this._hueAttr.needsUpdate = true;
    this._briAttr.needsUpdate = true;
    this._epsAttr.needsUpdate = true;
    this._sizeAttr.needsUpdate = true;
  }

  // ── Invalidate future ───────────────────────────────────────────────

  /**
   * Kill particles born after cutoffTime (e.g. after a settings change).
   * Sets their bornTime to sentinel so the shader treats them as dead.
   */
  invalidateFuture(cutoffTime: number): void {
    const bornArr = this._bornAttr.array as Float32Array;
    const len = this._capacity;
    for (let i = 0; i < len; i++) {
      if (bornArr[i] > cutoffTime) {
        bornArr[i] = BORN_SENTINEL;
      }
    }
    this._bornAttr.needsUpdate = true;
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

    this._growAttr(this._posAttr, 2, oldCap);
    this._growAttr(this._bornAttr, 1, oldCap);
    this._growAttr(this._hueAttr, 1, oldCap);
    this._growAttr(this._briAttr, 1, oldCap);
    this._growAttr(this._epsAttr, 1, oldCap);
    this._growAttr(this._sizeAttr, 1, oldCap);

    // Fill new bornAttr slots with sentinel
    const bornArr = this._bornAttr.array as Float32Array;
    for (let i = oldCap; i < newCap; i++) {
      bornArr[i] = BORN_SENTINEL;
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
      `(${(newCap * 28 / 1024 / 1024).toFixed(1)} MB)`
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
    itemSize: number,
    oldCap: number,
  ): void {
    const oldArr = attr.array as Float32Array;
    const newArr = new Float32Array(this._capacity * itemSize);
    newArr.set(oldArr.subarray(0, oldCap * itemSize));
    attr.array = newArr;
    attr.needsUpdate = true;
  }
}
