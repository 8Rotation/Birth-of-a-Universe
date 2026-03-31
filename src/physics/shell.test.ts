import { describe, it, expect } from "vitest";
import { StreamEmitter, defaultEmitterConfig } from "./shell";
import type { ParticleBatch } from "./shell";
import { ECSKPhysics } from "./ecsk-physics";

/** Read a single particle from a stride-8 flat buffer. */
function readParticle(data: Float32Array, index: number) {
  const o = index * 8;
  return {
    lx: data[o], ly: data[o+1], arrivalTime: data[o+2], hue: data[o+3],
    brightness: data[o+4], eps: data[o+5], hitSize: data[o+6], tailAngle: data[o+7],
  };
}

describe("defaultEmitterConfig", () => {
  it("returns complete config with all defaults", () => {
    const cfg = defaultEmitterConfig();
    expect(cfg.lMax).toBeGreaterThan(0);
    expect(cfg.arrivalSpread).toBeGreaterThan(0);
    expect(typeof cfg.doubleBounce).toBe("boolean");
    expect(typeof cfg.betaPP).toBe("number");
  });

  it("merges partial overrides", () => {
    const cfg = defaultEmitterConfig({ lMax: 12, arrivalSpread: 5.0 });
    expect(cfg.lMax).toBe(12);
    expect(cfg.arrivalSpread).toBe(5.0);
    // Others should still be default
    expect(cfg.doubleBounce).toBe(false);
  });
});

describe("StreamEmitter", () => {
  const physics = new ECSKPhysics(0.10, 1);

  it("constructs without error", () => {
    const emitter = new StreamEmitter(physics, {}, 42);
    expect(emitter).toBeDefined();
  });

  it("tick with zero dt produces no particles", () => {
    const emitter = new StreamEmitter(physics, {}, 42);
    const batch = emitter.tick(0, 0, 100);
    expect(batch.count).toBe(0);
  });

  it("tick with positive dt produces particles", () => {
    const emitter = new StreamEmitter(physics, {}, 42);
    // Run several ticks to accumulate enough for at least 1 particle
    let total = 0;
    for (let i = 0; i < 60; i++) {
      const batch = emitter.tick(1 / 60, i / 60, 500);
      total += batch.count;
    }
    expect(total).toBeGreaterThan(0);
  });

  it("particles have required fields", () => {
    const emitter = new StreamEmitter(physics, {}, 42);
    let found = false;
    for (let i = 0; i < 120 && !found; i++) {
      const batch = emitter.tick(1 / 60, i / 60, 1000);
      if (batch.count > 0) {
        const p = readParticle(batch.data, 0);
        expect(typeof p.lx).toBe("number");
        expect(typeof p.ly).toBe("number");
        expect(typeof p.arrivalTime).toBe("number");
        expect(typeof p.hue).toBe("number");
        expect(typeof p.brightness).toBe("number");
        expect(typeof p.eps).toBe("number");
        expect(typeof p.hitSize).toBe("number");
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it("update() changes physics without crash", () => {
    const emitter = new StreamEmitter(physics, {}, 42);
    const newPhysics = new ECSKPhysics(0.15, 1);
    emitter.update(newPhysics, { lMax: 12 });
    const batch = emitter.tick(0.1, 0, 500);
    // Should not throw and may produce particles
    expect(batch.data).toBeInstanceOf(Float32Array);
    expect(typeof batch.count).toBe("number");
  });
});
