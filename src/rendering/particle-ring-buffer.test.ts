import { describe, it, expect, vi } from "vitest";
import { ParticleRingBuffer } from "./particle-ring-buffer";

const STRIDE = 8;
const BORN_SENTINEL = -1e9;

/** Helper: create a packed Float32Array for N particles with stride 8. */
function makeBatch(particles: Array<{
  lx: number; ly: number; born: number; hue: number;
  bri: number; eps: number; size: number; tail?: number;
}>): Float32Array {
  const data = new Float32Array(particles.length * STRIDE);
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const off = i * STRIDE;
    data[off] = p.lx;
    data[off + 1] = p.ly;
    data[off + 2] = p.born;
    data[off + 3] = p.hue;
    data[off + 4] = p.bri;
    data[off + 5] = p.eps;
    data[off + 6] = p.size;
    data[off + 7] = p.tail ?? 0;
  }
  return data;
}

describe("ParticleRingBuffer", () => {
  // ── Construction ──────────────────────────────────────────────────

  it("initializes with correct capacity and zero counts", () => {
    const buf = new ParticleRingBuffer(1024);
    expect(buf.capacity).toBe(1024);
    expect(buf.totalWritten).toBe(0);
    expect(buf.activeCount).toBe(0);
  });

  it("fills bornTime with sentinel on construction", () => {
    const buf = new ParticleRingBuffer(16);
    for (let i = 0; i < 16; i++) {
      expect(buf.getBornTime(i)).toBe(BORN_SENTINEL);
    }
  });

  it("both packed attributes use DynamicDrawUsage", () => {
    const buf = new ParticleRingBuffer(8);
    const THREE_DYNAMIC = 35048; // THREE.DynamicDrawUsage
    expect(buf.packedAttrA.usage).toBe(THREE_DYNAMIC);
    expect(buf.packedAttrB.usage).toBe(THREE_DYNAMIC);
  });

  it("packed attributes have itemSize 4", () => {
    const buf = new ParticleRingBuffer(8);
    expect(buf.packedAttrA.itemSize).toBe(4);
    expect(buf.packedAttrB.itemSize).toBe(4);
  });

  // ── Single particle write ─────────────────────────────────────────

  it("writes a single particle and reads it back", () => {
    const buf = new ParticleRingBuffer(8);
    const batch = makeBatch([{ lx: 0.5, ly: -1.2, born: 10.0, hue: 120, bri: 0.7, eps: 500, size: 0.3 }]);
    buf.writeBatch(batch, 1, STRIDE, 10.0, 30.0);

    expect(buf.totalWritten).toBe(1);
    expect(buf.activeCount).toBe(1);

    expect(buf.getLx(0)).toBeCloseTo(0.5);
    expect(buf.getLy(0)).toBeCloseTo(-1.2);
    expect(buf.getBornTime(0)).toBeCloseTo(10.0);
    expect(buf.getHue(0)).toBeCloseTo(120);
    expect(buf.getBrightness(0)).toBeCloseTo(0.7);
    expect(buf.getEps(0)).toBeCloseTo(500);
    expect(buf.getHitSize(0)).toBeCloseTo(0.3);
  });

  // ── Batch write ───────────────────────────────────────────────────

  it("writes a batch of N particles", () => {
    const buf = new ParticleRingBuffer(16);
    const batch = makeBatch([
      { lx: 1.0, ly: 2.0, born: 1.0, hue: 60, bri: 0.5, eps: 100, size: 0.1 },
      { lx: -1.0, ly: -2.0, born: 2.0, hue: 180, bri: 0.8, eps: 200, size: 0.5 },
      { lx: 0.0, ly: 0.0, born: 3.0, hue: 300, bri: 0.2, eps: 50, size: 0.9 },
    ]);
    buf.writeBatch(batch, 3, STRIDE, 3.0, 30.0);

    expect(buf.totalWritten).toBe(3);
    expect(buf.activeCount).toBe(3);

    expect(buf.getBornTime(0)).toBeCloseTo(1.0);
    expect(buf.getBornTime(1)).toBeCloseTo(2.0);
    expect(buf.getBornTime(2)).toBeCloseTo(3.0);
    // Unwritten slot still has sentinel
    expect(buf.getBornTime(3)).toBe(BORN_SENTINEL);
  });

  // ── Wrap-around ───────────────────────────────────────────────────

  it("wraps around and overwrites oldest slots when capacity exceeded and slots are dead", () => {
    const cap = 4;
    const buf = new ParticleRingBuffer(cap);

    // Write 4 particles (fill buffer) — all born at time 1
    const batch1 = makeBatch([
      { lx: 1, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 2, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 3, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 4, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(batch1, 4, STRIDE, 1.0, 5.0);
    expect(buf.totalWritten).toBe(4);

    // Write 1 more — now=100, cutoff=5 → slot[0] born at t=1 is dead (1 < 100-5=95)
    const batch2 = makeBatch([
      { lx: 99, ly: 0, born: 100, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(batch2, 1, STRIDE, 100.0, 5.0);

    // Should NOT have grown — slot was dead, safe to overwrite
    expect(buf.capacity).toBe(cap);
    expect(buf.totalWritten).toBe(5);

    // Slot 0 should now be overwritten with the new particle
    expect(buf.getLx(0)).toBeCloseTo(99);
  });

  // ── Safe-wrap: grow when overwriting alive slot ───────────────────

  it("grows instead of overwriting a still-alive slot", () => {
    const cap = 4;
    const buf = new ParticleRingBuffer(cap);

    // Fill buffer with particles born at time 10
    const batch1 = makeBatch([
      { lx: 1, ly: 0, born: 10, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 2, ly: 0, born: 10, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 3, ly: 0, born: 10, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 4, ly: 0, born: 10, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(batch1, 4, STRIDE, 10.0, 30.0);

    // Write 1 more at now=12, cutoff=30 → slot[0] born at 10 is still alive (10 > 12-30=-18)
    const batch2 = makeBatch([
      { lx: 99, ly: 0, born: 12, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(batch2, 1, STRIDE, 12.0, 30.0);

    // Should have grown — slot was alive
    expect(buf.capacity).toBeGreaterThan(cap);

    // Original data should be preserved
    expect(buf.getLx(0)).toBeCloseTo(1); // slot 0 preserved
    expect(buf.getLx(1)).toBeCloseTo(2); // slot 1 preserved
    expect(buf.getLx(2)).toBeCloseTo(3); // slot 2
    expect(buf.getLx(3)).toBeCloseTo(4); // slot 3

    // New particle should be in the grown region
    expect(buf.getBornTime(4)).toBeCloseTo(12); // written to slot 4 (old capacity)
  });

  // ── Grow preserves data ───────────────────────────────────────────

  it("grow() preserves existing data and doubles capacity", () => {
    const buf = new ParticleRingBuffer(4);

    const batch = makeBatch([
      { lx: 1.5, ly: -0.5, born: 5, hue: 90, bri: 0.3, eps: 42, size: 0.6 },
      { lx: -1.5, ly: 0.5, born: 6, hue: 270, bri: 0.9, eps: 99, size: 0.2 },
    ]);
    buf.writeBatch(batch, 2, STRIDE, 6.0, 30.0);

    buf.grow(8);
    expect(buf.capacity).toBe(8);

    // Original data intact
    expect(buf.getLx(0)).toBeCloseTo(1.5);
    expect(buf.getLy(0)).toBeCloseTo(-0.5);
    expect(buf.getLx(1)).toBeCloseTo(-1.5);
    expect(buf.getLy(1)).toBeCloseTo(0.5);

    expect(buf.getBornTime(0)).toBeCloseTo(5);
    expect(buf.getBornTime(1)).toBeCloseTo(6);
    // New slots filled with sentinel
    expect(buf.getBornTime(4)).toBe(BORN_SENTINEL);
    expect(buf.getBornTime(7)).toBe(BORN_SENTINEL);
  });

  it("grow() doubles capacity until >= minCapacity (capped at 4× per call)", () => {
    const buf = new ParticleRingBuffer(4);
    buf.grow(20);
    // 4× cap: 4 → 16 (capped at 4×4=16, even though 20 requested)
    expect(buf.capacity).toBe(16);
    // A second grow() is cooldown-blocked (500ms), so capacity stays 16.
    // In production, subsequent frames would eventually reach 32.
  });

  // ── Clear ─────────────────────────────────────────────────────────

  it("clear() fills bornTime with sentinel and resets writeHead", () => {
    const buf = new ParticleRingBuffer(8);

    // Write some particles
    const batch = makeBatch([
      { lx: 1, ly: 2, born: 10, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 3, ly: 4, born: 11, hue: 90, bri: 0.8, eps: 20, size: 0.5 },
    ]);
    buf.writeBatch(batch, 2, STRIDE, 11.0, 30.0);
    expect(buf.totalWritten).toBe(2);

    buf.clear();
    expect(buf.totalWritten).toBe(0);
    expect(buf.activeCount).toBe(0);

    for (let i = 0; i < 8; i++) {
      expect(buf.getBornTime(i)).toBe(BORN_SENTINEL);
    }

    // After clear, writing starts at slot 0 again
    const batch2 = makeBatch([
      { lx: 99, ly: 88, born: 20, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(batch2, 1, STRIDE, 20.0, 30.0);
    expect(buf.getLx(0)).toBeCloseTo(99);
    expect(buf.getLy(0)).toBeCloseTo(88);
  });

  // ── invalidateFuture ──────────────────────────────────────────────

  it("invalidateFuture() kills only slots born after cutoff", () => {
    const buf = new ParticleRingBuffer(8);

    const batch = makeBatch([
      { lx: 0, ly: 0, born: 5, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 0, ly: 0, born: 10, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 0, ly: 0, born: 15, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 0, ly: 0, born: 20, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(batch, 4, STRIDE, 20.0, 30.0);

    buf.invalidateFuture(12);

    expect(buf.getBornTime(0)).toBeCloseTo(5);  // kept (5 <= 12)
    expect(buf.getBornTime(1)).toBeCloseTo(10); // kept (10 <= 12)
    expect(buf.getBornTime(2)).toBe(BORN_SENTINEL); // killed (15 > 12)
    expect(buf.getBornTime(3)).toBe(BORN_SENTINEL); // killed (20 > 12)
  });

  // ── activeCount ───────────────────────────────────────────────────

  it("activeCount returns min(totalWritten, capacity)", () => {
    const buf = new ParticleRingBuffer(4);

    // Less than capacity
    const batch1 = makeBatch([
      { lx: 0, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(batch1, 1, STRIDE, 1.0, 30.0);
    expect(buf.activeCount).toBe(1);
    expect(buf.totalWritten).toBe(1);

    // Fill to capacity
    const batch2 = makeBatch([
      { lx: 0, ly: 0, born: 2, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 0, ly: 0, born: 3, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 0, ly: 0, born: 4, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(batch2, 3, STRIDE, 4.0, 30.0);
    expect(buf.activeCount).toBe(4);
    expect(buf.totalWritten).toBe(4);

    // Exceed capacity with dead oldest → wraps, activeCount stays at capacity
    const batch3 = makeBatch([
      { lx: 0, ly: 0, born: 100, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(batch3, 1, STRIDE, 100.0, 5.0);
    expect(buf.activeCount).toBe(4); // min(5, 4)
    expect(buf.totalWritten).toBe(5);
  });

  // ── needsUpdate flags ─────────────────────────────────────────────

  it("increments attribute version after writeBatch", () => {
    const buf = new ParticleRingBuffer(8);

    // Record initial versions
    const v0A = buf.packedAttrA.version;
    const v0B = buf.packedAttrB.version;

    const batch = makeBatch([
      { lx: 0, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(batch, 1, STRIDE, 1.0, 30.0);

    expect(buf.packedAttrA.version).toBeGreaterThan(v0A);
    expect(buf.packedAttrB.version).toBeGreaterThan(v0B);
  });

  // ── Direct GPU write (partial upload) ─────────────────────────────

  it("uses direct GPU write when backend provides GPUBuffers", () => {
    const buf = new ParticleRingBuffer(8);

    // First write to trigger needsUpdate (GPUBuffer creation via fallback)
    const init = makeBatch([
      { lx: 0, ly: 0, born: 0, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(init, 1, STRIDE, 0, 30.0);

    // Set up mock GPU device and backend
    const mockBufA = { label: "bufA" };
    const mockBufB = { label: "bufB" };
    const writeBuffer = vi.fn();
    const mockDevice = { queue: { writeBuffer } } as unknown as GPUDevice;
    const resources = new Map<object, { buffer: unknown }>();
    resources.set(buf.packedAttrA, { buffer: mockBufA });
    resources.set(buf.packedAttrB, { buffer: mockBufB });
    const mockBackend = { get: (key: object) => resources.get(key) };

    buf.setGpuBackend(mockDevice, mockBackend);

    // Record versions before second write
    const v0A = buf.packedAttrA.version;
    const v0B = buf.packedAttrB.version;

    const batch = makeBatch([
      { lx: 1, ly: 2, born: 5, hue: 90, bri: 0.7, eps: 200, size: 0.3 },
    ]);
    buf.writeBatch(batch, 1, STRIDE, 5.0, 30.0);

    // needsUpdate should NOT have been set (direct write path used)
    expect(buf.packedAttrA.version).toBe(v0A);
    expect(buf.packedAttrB.version).toBe(v0B);

    // writeBuffer should have been called twice (once per attribute)
    expect(writeBuffer).toHaveBeenCalledTimes(2);

    // Check args: writeBuffer(gpuBuf, byteOffset, typedArray, dataOffset, size)
    // Write started at slot 1 (after the init write), 1 particle
    // byteOffset = 1 * 16 = 16, dataOffset = 1 * 4 = 4, size = 1 * 4 = 4
    expect(writeBuffer).toHaveBeenCalledWith(mockBufA, 16, expect.any(Float32Array), 4, 4);
    expect(writeBuffer).toHaveBeenCalledWith(mockBufB, 16, expect.any(Float32Array), 4, 4);
  });

  it("uses wrap-around GPU write when batch crosses buffer boundary", () => {
    const cap = 4;
    const buf = new ParticleRingBuffer(cap);

    // Fill buffer (write head at 0 after wrapping 4 slots)
    const fill = makeBatch([
      { lx: 1, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 2, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 3, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(fill, 3, STRIDE, 1.0, 5.0);
    // writeHead is now at 3

    // Set up mock GPU
    const mockBufA = { label: "bufA" };
    const mockBufB = { label: "bufB" };
    const writeBuffer = vi.fn();
    const mockDevice = { queue: { writeBuffer } } as unknown as GPUDevice;
    const resources = new Map<object, { buffer: unknown }>();
    resources.set(buf.packedAttrA, { buffer: mockBufA });
    resources.set(buf.packedAttrB, { buffer: mockBufB });
    const mockBackend = { get: (key: object) => resources.get(key) };
    buf.setGpuBackend(mockDevice, mockBackend);

    // Write 2 particles starting at slot 3 → wraps: slot 3, then slot 0
    const wrap = makeBatch([
      { lx: 10, ly: 0, born: 100, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 11, ly: 0, born: 100, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(wrap, 2, STRIDE, 100.0, 5.0);

    // Should produce 4 writeBuffer calls (2 chunks × 2 attributes)
    expect(writeBuffer).toHaveBeenCalledTimes(4);

    // First chunk: slot 3 → byteOffset = 3*16 = 48, dataOffset = 3*4 = 12, size = 1*4 = 4
    expect(writeBuffer).toHaveBeenCalledWith(mockBufA, 48, expect.any(Float32Array), 12, 4);
    expect(writeBuffer).toHaveBeenCalledWith(mockBufB, 48, expect.any(Float32Array), 12, 4);

    // Second chunk: slot 0 → byteOffset = 0, dataOffset = 0, size = 1*4 = 4
    expect(writeBuffer).toHaveBeenCalledWith(mockBufA, 0, expect.any(Float32Array), 0, 4);
    expect(writeBuffer).toHaveBeenCalledWith(mockBufB, 0, expect.any(Float32Array), 0, 4);
  });

  it("falls back to needsUpdate when grow() is triggered", () => {
    const cap = 4;
    const buf = new ParticleRingBuffer(cap);

    // Fill buffer with alive particles (born at t=10, cutoff=30 → alive until t=40)
    const fill = makeBatch([
      { lx: 1, ly: 0, born: 10, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 2, ly: 0, born: 10, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 3, ly: 0, born: 10, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      { lx: 4, ly: 0, born: 10, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(fill, 4, STRIDE, 10.0, 30.0);

    // Set up mock GPU
    const writeBuffer = vi.fn();
    const mockDevice = { queue: { writeBuffer } } as unknown as GPUDevice;
    const resources = new Map<object, { buffer: unknown }>();
    resources.set(buf.packedAttrA, { buffer: { label: "a" } });
    resources.set(buf.packedAttrB, { buffer: { label: "b" } });
    const mockBackend = { get: (key: object) => resources.get(key) };
    buf.setGpuBackend(mockDevice, mockBackend);

    // Write 1 more at t=12 → oldest is alive → triggers grow()
    const extra = makeBatch([
      { lx: 99, ly: 0, born: 12, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(extra, 1, STRIDE, 12.0, 30.0);

    // grow() should have fired, capacity increased
    expect(buf.capacity).toBeGreaterThan(cap);

    // Direct GPU write should NOT have been called (grow sets needsUpdate instead)
    expect(writeBuffer).not.toHaveBeenCalled();
  });

  it("falls back to needsUpdate when GPUBuffer not yet created", () => {
    const buf = new ParticleRingBuffer(8);

    // Set GPU backend but DON'T register GPUBuffer for the attributes
    const writeBuffer = vi.fn();
    const mockDevice = { queue: { writeBuffer } } as unknown as GPUDevice;
    const mockBackend = { get: () => undefined };
    buf.setGpuBackend(mockDevice, mockBackend);

    const v0A = buf.packedAttrA.version;
    const batch = makeBatch([
      { lx: 0, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(batch, 1, STRIDE, 1.0, 30.0);

    // Should have used needsUpdate fallback
    expect(buf.packedAttrA.version).toBeGreaterThan(v0A);
    expect(writeBuffer).not.toHaveBeenCalled();
  });

  // ── computeAliveRange ─────────────────────────────────────────────

  describe("computeAliveRange", () => {
    it("returns {start:0, count:0} when no particles written", () => {
      const buf = new ParticleRingBuffer(8);
      const { start, count } = buf.computeAliveRange(10, 5);
      expect(start).toBe(0);
      expect(count).toBe(0);
    });

    it("returns all written slots when buffer hasn't wrapped", () => {
      const buf = new ParticleRingBuffer(8);
      const batch = makeBatch([
        { lx: 0, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 2, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 3, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      ]);
      buf.writeBatch(batch, 3, STRIDE, 3, 30);
      const { start, count } = buf.computeAliveRange(10, 30);
      expect(start).toBe(0);
      expect(count).toBe(3);
    });

    it("skips dead particles after buffer wraps", () => {
      const cap = 4;
      const buf = new ParticleRingBuffer(cap);

      // Fill buffer with particles born at t=1
      const batch1 = makeBatch([
        { lx: 0, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 2, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 3, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 4, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      ]);
      buf.writeBatch(batch1, 4, STRIDE, 4, 30);

      // Overwrite slot 0 with a new particle at t=100 (slot 0 is dead: 1 < 100-5)
      const batch2 = makeBatch([
        { lx: 0, ly: 0, born: 100, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      ]);
      buf.writeBatch(batch2, 1, STRIDE, 100, 5);

      // now=100, cutoff=5: alive if bornTime > 100-5=95
      // Slots: [born=100, born=2, born=3, born=4]
      // writeHead is at 1 (oldest slot)
      // Scan from slot 1: born=2 < 95 → dead, slot 2: born=3 < 95 → dead,
      // slot 3: born=4 < 95 → dead, slot 0: born=100 > 95 → alive!
      const { start, count } = buf.computeAliveRange(100, 5);
      expect(start).toBe(0);
      expect(count).toBe(1);
    });

    it("returns count=0 when all particles are dead", () => {
      const buf = new ParticleRingBuffer(4);
      const batch = makeBatch([
        { lx: 0, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 2, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 3, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 4, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      ]);
      buf.writeBatch(batch, 4, STRIDE, 4, 30);

      // Overwrite slot 0 so buffer has wrapped
      const batch2 = makeBatch([
        { lx: 0, ly: 0, born: 5, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      ]);
      buf.writeBatch(batch2, 1, STRIDE, 5, 30);

      // now=1000, cutoff=1: alive if born > 999 → all dead
      const { start, count } = buf.computeAliveRange(1000, 1);
      expect(count).toBe(0);
    });

    it("handles all-alive wrapped buffer correctly", () => {
      const cap = 4;
      const buf = new ParticleRingBuffer(cap);

      // Fill and wrap: born times 1,2,3,4 then 5 overwrites slot 0
      const batch1 = makeBatch([
        { lx: 0, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 2, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 3, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 4, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      ]);
      buf.writeBatch(batch1, 4, STRIDE, 4, 30);
      const batch2 = makeBatch([
        { lx: 0, ly: 0, born: 5, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      ]);
      buf.writeBatch(batch2, 1, STRIDE, 5, 30);

      // now=5, cutoff=100: alive if born > 5-100=-95 → all alive
      // After grow, buffer is linear: [1, 2, 3, 4, 5, sentinel, sentinel, sentinel]
      const { start, count } = buf.computeAliveRange(5, 100);
      expect(start).toBe(0); // buffer hasn't re-wrapped, first alive is slot 0
      expect(count).toBe(5); // all 5 written slots alive
    });

    it("returns correct alive range after grow() reorders a wrapped buffer", () => {
      const cap = 4;
      const buf = new ParticleRingBuffer(cap);

      // Fill buffer: born times 1,2,3,4 — writeHead wraps to 0
      const batch1 = makeBatch([
        { lx: 0, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 2, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 3, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 4, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      ]);
      buf.writeBatch(batch1, 4, STRIDE, 4.0, 30.0);

      // Overwrite slots 0,1 (buffer wraps): born=5,6 — writeHead now at 2
      const batch2 = makeBatch([
        { lx: 0, ly: 0, born: 5, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 6, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      ]);
      buf.writeBatch(batch2, 2, STRIDE, 6.0, 1.0);
      // Physical layout: [born=5, born=6, born=3, born=4], writeHead=2
      // Chronological from writeHead: 3, 4, 5, 6

      // Force grow by writing a particle when oldest (slot 2, born=3) is still alive
      const batch3 = makeBatch([
        { lx: 0, ly: 0, born: 7, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      ]);
      buf.writeBatch(batch3, 1, STRIDE, 7.0, 30.0);
      expect(buf.capacity).toBeGreaterThan(cap);

      // After grow + reorder, bornTimes should be monotonically increasing
      // from slot 0: 3, 4, 5, 6, 7, sentinel, sentinel, sentinel
      for (let i = 0; i < 4; i++) {
        expect(buf.getBornTime(i)).toBeCloseTo(3 + i);
      }
      expect(buf.getBornTime(4)).toBeCloseTo(7);
      for (let i = 5; i < buf.capacity; i++) {
        expect(buf.getBornTime(i)).toBe(BORN_SENTINEL);
      }

      // computeAliveRange should work correctly after growth
      // now=7, cutoff=30: alive if born > 7-30=-23 → all 5 particles alive
      const { start, count } = buf.computeAliveRange(7, 30);
      expect(start).toBe(0);
      expect(count).toBe(5);

      // now=7, cutoff=3: alive if born > 7-3=4 → born=5,6,7 alive
      const r2 = buf.computeAliveRange(7, 3);
      expect(r2.start).toBe(2); // slot 2 has born=5
      expect(r2.count).toBe(3);
    });

    it("correctly identifies alive range with mixed dead/alive after wrap", () => {
      const cap = 8;
      const buf = new ParticleRingBuffer(cap);

      // Fill buffer: born times 1 through 8
      const particles = [];
      for (let i = 1; i <= 8; i++) {
        particles.push({ lx: 0, ly: 0, born: i, hue: 0, bri: 0.5, eps: 10, size: 0.1 });
      }
      buf.writeBatch(makeBatch(particles), 8, STRIDE, 8, 30);

      // Overwrite slots 0,1,2 with new particles (born at t=50,51,52)
      const newBatch = makeBatch([
        { lx: 0, ly: 0, born: 50, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 51, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
        { lx: 0, ly: 0, born: 52, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
      ]);
      buf.writeBatch(newBatch, 3, STRIDE, 52, 5);

      // Buffer state: [born=50, born=51, born=52, born=4, born=5, born=6, born=7, born=8]
      // writeHead = 3
      // now=52, cutoff=5: alive if born > 52-5=47
      // Scan from slot 3: born=4 < 47 → dead, slot 4: born=5 < 47 → dead,
      // slot 5: born=6 < 47 → dead, slot 6: born=7 < 47 → dead,
      // slot 7: born=8 < 47 → dead, slot 0: born=50 > 47 → alive!
      const { start, count } = buf.computeAliveRange(52, 5);
      expect(start).toBe(0);
      expect(count).toBe(3); // slots 0,1,2 are alive
    });
  });
});
