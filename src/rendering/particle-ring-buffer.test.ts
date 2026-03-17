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

  it("fills bornAttr with sentinel on construction", () => {
    const buf = new ParticleRingBuffer(16);
    const born = buf.bornTimeAttribute.array as Float32Array;
    for (let i = 0; i < 16; i++) {
      expect(born[i]).toBe(BORN_SENTINEL);
    }
  });

  it("all attributes use DynamicDrawUsage", () => {
    const buf = new ParticleRingBuffer(8);
    const THREE_DYNAMIC = 35048; // THREE.DynamicDrawUsage
    expect(buf.positionAttribute.usage).toBe(THREE_DYNAMIC);
    expect(buf.bornTimeAttribute.usage).toBe(THREE_DYNAMIC);
    expect(buf.hueAttribute.usage).toBe(THREE_DYNAMIC);
    expect(buf.brightnessAttribute.usage).toBe(THREE_DYNAMIC);
    expect(buf.epsAttribute.usage).toBe(THREE_DYNAMIC);
    expect(buf.sizeAttribute.usage).toBe(THREE_DYNAMIC);
  });

  it("attributes have correct itemSize", () => {
    const buf = new ParticleRingBuffer(8);
    expect(buf.positionAttribute.itemSize).toBe(2);
    expect(buf.bornTimeAttribute.itemSize).toBe(1);
    expect(buf.hueAttribute.itemSize).toBe(1);
    expect(buf.brightnessAttribute.itemSize).toBe(1);
    expect(buf.epsAttribute.itemSize).toBe(1);
    expect(buf.sizeAttribute.itemSize).toBe(1);
  });

  // ── Single particle write ─────────────────────────────────────────

  it("writes a single particle and reads it back", () => {
    const buf = new ParticleRingBuffer(8);
    const batch = makeBatch([{ lx: 0.5, ly: -1.2, born: 10.0, hue: 120, bri: 0.7, eps: 500, size: 0.3 }]);
    buf.writeBatch(batch, 1, STRIDE, 10.0, 30.0);

    expect(buf.totalWritten).toBe(1);
    expect(buf.activeCount).toBe(1);

    const pos = buf.positionAttribute.array as Float32Array;
    expect(pos[0]).toBeCloseTo(0.5);
    expect(pos[1]).toBeCloseTo(-1.2);

    const born = buf.bornTimeAttribute.array as Float32Array;
    expect(born[0]).toBeCloseTo(10.0);

    const hue = buf.hueAttribute.array as Float32Array;
    expect(hue[0]).toBeCloseTo(120);

    const bri = buf.brightnessAttribute.array as Float32Array;
    expect(bri[0]).toBeCloseTo(0.7);

    const eps = buf.epsAttribute.array as Float32Array;
    expect(eps[0]).toBeCloseTo(500);

    const size = buf.sizeAttribute.array as Float32Array;
    expect(size[0]).toBeCloseTo(0.3);
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

    const born = buf.bornTimeAttribute.array as Float32Array;
    expect(born[0]).toBeCloseTo(1.0);
    expect(born[1]).toBeCloseTo(2.0);
    expect(born[2]).toBeCloseTo(3.0);
    // Unwritten slot still has sentinel
    expect(born[3]).toBe(BORN_SENTINEL);
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
    const pos = buf.positionAttribute.array as Float32Array;
    expect(pos[0]).toBeCloseTo(99);
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
    const pos = buf.positionAttribute.array as Float32Array;
    expect(pos[0]).toBeCloseTo(1); // slot 0 preserved
    expect(pos[2]).toBeCloseTo(2); // slot 1 preserved (itemSize=2, so index 2)
    expect(pos[4]).toBeCloseTo(3); // slot 2
    expect(pos[6]).toBeCloseTo(4); // slot 3

    // New particle should be in the grown region
    const born = buf.bornTimeAttribute.array as Float32Array;
    expect(born[4]).toBeCloseTo(12); // written to slot 4 (old capacity)
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
    const pos = buf.positionAttribute.array as Float32Array;
    expect(pos[0]).toBeCloseTo(1.5);
    expect(pos[1]).toBeCloseTo(-0.5);
    expect(pos[2]).toBeCloseTo(-1.5);
    expect(pos[3]).toBeCloseTo(0.5);

    const born = buf.bornTimeAttribute.array as Float32Array;
    expect(born[0]).toBeCloseTo(5);
    expect(born[1]).toBeCloseTo(6);
    // New slots filled with sentinel
    expect(born[4]).toBe(BORN_SENTINEL);
    expect(born[7]).toBe(BORN_SENTINEL);
  });

  it("grow() doubles capacity until >= minCapacity", () => {
    const buf = new ParticleRingBuffer(4);
    buf.grow(20);
    expect(buf.capacity).toBe(32); // 4 → 8 → 16 → 32
  });

  // ── Clear ─────────────────────────────────────────────────────────

  it("clear() fills bornAttr with sentinel and resets writeHead", () => {
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

    const born = buf.bornTimeAttribute.array as Float32Array;
    for (let i = 0; i < 8; i++) {
      expect(born[i]).toBe(BORN_SENTINEL);
    }

    // After clear, writing starts at slot 0 again
    const batch2 = makeBatch([
      { lx: 99, ly: 88, born: 20, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(batch2, 1, STRIDE, 20.0, 30.0);
    const pos = buf.positionAttribute.array as Float32Array;
    expect(pos[0]).toBeCloseTo(99);
    expect(pos[1]).toBeCloseTo(88);
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

    const born = buf.bornTimeAttribute.array as Float32Array;
    expect(born[0]).toBeCloseTo(5);  // kept (5 <= 12)
    expect(born[1]).toBeCloseTo(10); // kept (10 <= 12)
    expect(born[2]).toBe(BORN_SENTINEL); // killed (15 > 12)
    expect(born[3]).toBe(BORN_SENTINEL); // killed (20 > 12)
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
    const v0pos = buf.positionAttribute.version;
    const v0born = buf.bornTimeAttribute.version;
    const v0hue = buf.hueAttribute.version;
    const v0bri = buf.brightnessAttribute.version;
    const v0eps = buf.epsAttribute.version;
    const v0size = buf.sizeAttribute.version;

    const batch = makeBatch([
      { lx: 0, ly: 0, born: 1, hue: 0, bri: 0.5, eps: 10, size: 0.1 },
    ]);
    buf.writeBatch(batch, 1, STRIDE, 1.0, 30.0);

    expect(buf.positionAttribute.version).toBeGreaterThan(v0pos);
    expect(buf.bornTimeAttribute.version).toBeGreaterThan(v0born);
    expect(buf.hueAttribute.version).toBeGreaterThan(v0hue);
    expect(buf.brightnessAttribute.version).toBeGreaterThan(v0bri);
    expect(buf.epsAttribute.version).toBeGreaterThan(v0eps);
    expect(buf.sizeAttribute.version).toBeGreaterThan(v0size);
  });
});
