# GPU Compute Shader Design — Particle Emission Pipeline

**Status:** Design document (not yet implemented)
**Author:** Generated from codebase analysis
**Date:** 2025-07-15

---

## 1. Motivation

The current particle emission pipeline runs on CPU Web Workers:

    main thread  →  PhysicsBridge  →  N Workers (1–4)
                                         ↓
                  Float32Array batches ←──┘
                                         ↓
                  renderer.setParticles() → GPU instanced draw

At high particle rates (>100 k/s), CPU-side emission becomes the
bottleneck.  Each particle requires:

1. **Spherical harmonic evaluation** — O(l_max²) trig per particle
2. **Physics lookup** — `bounceProps(β_eff)` → sqrt, division
3. **Visual encoding** — log, clamp, hue/brightness/hitSize mapping
4. **PRNG** — splitmix32 for θ, φ, tailAngle

Steps 1–3 are embarrassingly parallel and map perfectly to a GPU
compute shader.  Moving emission to the GPU eliminates the Worker→main
thread transfer (~1 frame latency) and frees CPU cores for UI/audio.

---

## 2. Architecture Overview

```
┌──────────────────── GPU ────────────────────────┐
│                                                  │
│  Compute Pipeline                                │
│  ┌──────────────────────────────────────────┐   │
│  │ @group(0) coefficients (uniform)         │   │
│  │ @group(1) params      (uniform)          │   │
│  │ @group(2) outputBuf   (storage, rw)      │   │
│  │ @group(3) counterBuf  (storage, rw)      │   │
│  │                                          │   │
│  │ workgroup_size(64, 1, 1)                 │   │
│  │ dispatch(ceil(N / 64), 1, 1)             │   │
│  └──────────────────────────────────────────┘   │
│                    ↓                             │
│  Render Pipeline (existing)                      │
│  ┌──────────────────────────────────────────┐   │
│  │ InstancedBufferAttribute ← outputBuf     │   │
│  │ PointsNodeMaterial (TSL)                  │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
└──────────────────────────────────────────────────┘
         ↑
    Main thread
    ├─ evolveCoeffs() each tick (O-U walk, ~0.1 ms)
    ├─ write params uniform (β, k, t, rate, hue/bri config)
    ├─ write coefficients uniform (packed Float32[])
    └─ dispatch compute, then render
```

The key insight: **coefficients and params are tiny uniform uploads
(< 4 KB/frame); the heavy per-particle work stays entirely on GPU.**

---

## 3. Data Layout

### 3.1 Particle Output Buffer (Storage)

Same 8-float stride as the current `PARTICLE_STRIDE`:

| Offset | Field        | Type  | Description                        |
|--------|------------- |-------|------------------------------------|
| 0      | lx           | f32   | Lambert x ∈ [−2, 2]               |
| 1      | ly           | f32   | Lambert y ∈ [−2, 2]               |
| 2      | arrivalTime  | f32   | simTime + delay (seconds)          |
| 3      | hue          | f32   | HSL hue in [0, 360]               |
| 4      | brightness   | f32   | normalised ∈ [0, 1]               |
| 5      | eps          | f32   | energy density (for HDR mapping)   |
| 6      | hitSize      | f32   | normalised ∈ [0, 1]               |
| 7      | tailAngle    | f32   | radians [0, 2π]                    |

**Buffer size:** `MAX_PARTICLES × 8 × 4` bytes.
At 500k particles: 500 000 × 32 = 16 MB — fits comfortably in VRAM.

### 3.2 Params Uniform

```wgsl
struct Params {
  beta:            f32,    // spin parameter
  kCurvature:      f32,    // −1, 0, +1
  perturbAmplitude:f32,    // perturbation strength [0, 1]
  timeDilation:    f32,    // time stretch multiplier
  simTime:         f32,    // current simulation time
  particleRate:    f32,    // particles to emit this tick
  seed:            u32,    // frame seed (incremented each dispatch)
  hueMin:          f32,
  hueRange:        f32,
  brightnessFloor: f32,
  brightnessCeil:  f32,
  // Double-bounce fields
  doubleBounce:    u32,    // bool as u32
  betaPP:          f32,
  dbSecondHueShift:f32,
  dbSecondBriScale:f32,
  // Counters
  writeOffset:     u32,    // where to start writing in output buffer
  maxParticles:    u32,    // capacity guard
};
```

### 3.3 Coefficients Uniform

```wgsl
struct Coeff {
  l: u32,
  m: i32,
  c: f32,
  _pad: f32,   // 16-byte alignment
};

@group(0) @binding(0) var<uniform> coeffs: array<Coeff, MAX_COEFFS>;
@group(0) @binding(1) var<uniform> numCoeffs: u32;
```

With `l_max = 16`, there are `(l_max+1)² = 289` coefficients.
At 16 bytes each = 4.6 KB — well within the 64 KB uniform limit.

---

## 4. WGSL Compute Shader Outline

```wgsl
// ── PRNG (PCG-style, GPU-friendly) ───────────────────────────────
fn pcg(state: ptr<function, u32>) -> u32 {
  let old = *state;
  *state = old * 747796405u + 2891336453u;
  let word = ((old >> ((old >> 28u) + 4u)) ^ old) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand01(state: ptr<function, u32>) -> f32 {
  return f32(pcg(state)) / 4294967296.0;
}

// ── Associated Legendre (inline for small l_max) ─────────────────
fn legendreP(l: u32, m: i32, x: f32) -> f32 {
  // Recurrence relation — same as CPU perturbation.ts
  // ...
}

// ── Spherical harmonic evaluation ────────────────────────────────
fn evaluateYlm(l: u32, m: i32, theta: f32, phi: f32) -> f32 {
  let ct = cos(theta);
  let plm = legendreP(l, abs(m), ct);
  let norm = ...; // pre-computed or inline factorial ratio
  if (m > 0) { return norm * plm * cos(f32(m) * phi); }
  if (m < 0) { return norm * plm * sin(f32(-m) * phi); }
  return norm * plm;
}

// ── Perturbation field δ(θ, φ) ───────────────────────────────────
fn evalPerturbation(theta: f32, phi: f32) -> f32 {
  var delta = 0.0;
  for (var i = 0u; i < numCoeffs; i++) {
    delta += coeffs[i].c * evaluateYlm(coeffs[i].l, coeffs[i].m, theta, phi);
  }
  return delta;
}

// ── Bounce physics (algebraic — no ODE integration) ──────────────
fn bounceProps(betaEff: f32, k: f32) -> BounceResult {
  // Mirrors ecsk-physics.ts bounceProps():
  //   aMin² = (1 − sqrt(1 − 4β)) / 2   (k=+1)
  //   eps = 1/aMin⁴, wEff, aDDot, S
  // All algebraic — ideal for GPU
  // ...
}

// ── Lambert azimuthal equal-area projection ──────────────────────
fn lambertProject(theta: f32, phi: f32) -> vec2<f32> {
  let r = 2.0 * sin(theta / 2.0);
  return vec2(r * cos(phi), r * sin(phi));
}

// ── Main compute entry point ────────────────────────────────────
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= u32(params.particleRate)) { return; }

  // Per-invocation PRNG seeded from frame seed + invocation index
  var rng = params.seed ^ (idx * 2654435761u);

  // Sample random position on S²
  let cosTheta = rand01(&rng) * 2.0 - 1.0;
  let theta = acos(cosTheta);
  let phi = rand01(&rng) * 6.283185307;

  // Evaluate perturbation → local β_eff
  let delta = evalPerturbation(theta, phi);
  // NOTE: Do NOT multiply delta by perturbAmplitude here — the coefficients
  // already incorporate amplitude via generatePerturbCoeffs() and O-U sigma
  // targets.  See shell.ts line ~432 for the authoritative formula.
  let betaEff = clamp(
    params.beta * (1.0 + delta),
    0.002, 0.2499
  );

  // Physics at this β_eff
  let props = bounceProps(betaEff, params.kCurvature);

  // Arrival time delay
  let naturalSpread = ...; // same formula as shell.ts
  let delay = naturalSpread * delta * params.timeDilation;
  let arrivalTime = params.simTime + clamp(delay, 0.0, 60.0);

  // Visual encoding
  let hue   = params.hueMin + (1.0 - props.wNorm) * params.hueRange;
  let bri   = params.brightnessFloor
            + (log(props.eps + 1.0) / log(10001.0))
            * (params.brightnessCeil - params.brightnessFloor);
  let size  = 0.5 + props.hitSizeNorm * 0.5;
  let tail  = rand01(&rng) * 6.283185307;

  // Lambert projection
  let lp = lambertProject(theta, phi);

  // Write to output buffer
  let writeIdx = params.writeOffset + idx;
  if (writeIdx < params.maxParticles) {
    let base = writeIdx * 8u;
    output[base + 0u] = lp.x;
    output[base + 1u] = lp.y;
    output[base + 2u] = arrivalTime;
    output[base + 3u] = hue;
    output[base + 4u] = bri;
    output[base + 5u] = props.eps;
    output[base + 6u] = size;
    output[base + 7u] = tail;
  }
}
```

---

## 5. Integration with Existing Renderer

### 5.1 Shared Storage Buffer (Zero-Copy)

The compute shader writes directly into the same GPU buffer used by
the instanced draw call.  Three.js r183 WebGPU backend supports this
via `StorageBufferAttribute`:

```typescript
import { StorageBufferAttribute } from "three/webgpu";

// Create shared buffer
const particleData = new Float32Array(capacity * 8);
const storageAttr = new StorageBufferAttribute(particleData, 8);

// Bind to compute shader as storage
computeBindGroup.setBuffer(0, storageAttr.buffer);

// Bind to render pipeline as instance attribute
geometry.setAttribute("instanceData", storageAttr);
```

This eliminates the CPU→GPU upload that currently happens in
`setParticles()` (which copies Float32Arrays into InstancedBufferAttribute).

### 5.2 Lifecycle Integration

```
Frame N:
  1. Main thread: evolveCoeffs() → pack into coefficients uniform
  2. Main thread: compute params (β, simTime, rate, writeOffset, ...)
  3. GPU: dispatch compute shader (writes N new particles)
  4. GPU: memory barrier
  5. GPU: render pass (reads same buffer as instanced attributes)
  6. Main thread: advance writeOffset by N emitted particles
```

### 5.3 Ring Buffer Strategy

Use a circular ring buffer for particles:

- `writeHead` advances by `emittedThisTick` each frame
- `readHead` advances as particles expire (arrivalTime + fadeout < simTime)
- When `writeHead` wraps, old particles are overwritten
- No CPU-side garbage collection needed

This requires a small auxiliary compute pass to compact or a simple
shader-side check: skip rendering if `arrivalTime + maxLifetime < simTime`.

---

## 6. Fallback Strategy

Not all browsers support WebGPU compute.  The system should detect
capabilities and fall back gracefully:

| Capability          | Pipeline                          |
|---------------------|-----------------------------------|
| WebGPU + Compute    | GPU compute emission + GPU render |
| WebGPU (render only)| CPU workers + GPU render (current)|
| WebGL 2             | CPU workers + WebGL render        |

Detection:

```typescript
const adapter = await navigator.gpu?.requestAdapter();
const hasCompute = adapter != null; // WebGPU always has compute
// If WebGPU adapter exists, compute is available
// If only WebGL context, fall back to current Worker pipeline
```

Since WebGPU guarantees compute support, the check is simply whether
the WebGPU backend initialized successfully (already done in renderer.ts).

---

## 7. Performance Estimates

### Current (CPU Workers)

| Metric                  | Value (4 workers)       |
|-------------------------|-----------------------|
| Max sustainable rate    | ~80–120 k particles/s |
| Bottleneck              | SH evaluation (trig)  |
| Transfer overhead       | ~0.5 ms/frame (postMessage + structured clone) |

### Projected (GPU Compute)

| Metric                  | Value                 |
|-------------------------|-----------------------|
| Workgroup size          | 64 threads            |
| Max dispatch            | 65535 × 64 = 4.2M/frame |
| SH evaluation (l=16)   | ~289 FMAs per thread  |
| Estimated throughput    | 1–5 M particles/s     |
| Transfer overhead       | 0 (shared buffer)     |

The 10–50× throughput improvement comes from:
1. Massive parallelism (GPU has 1000+ cores vs 4 CPU workers)
2. Zero transfer cost (no postMessage / structured clone)
3. GPU trig functions are hardware-accelerated (sin/cos in 1 cycle)

---

## 8. Implementation Phases

### Phase 1: Foundation (compute pipeline + simple emission)
- Create WGSL compute shader with PCG PRNG + Lambert projection
- Implement `ComputeEmitter` class wrapping WebGPU compute pipeline
- Uniform buffer management for params + coefficients
- Output to StorageBufferAttribute shared with render pipeline
- **No perturbation yet** — emit uniform random particles on S²

### Phase 2: Full Physics
- Port spherical harmonic evaluation to WGSL
- Port `bounceProps()` algebraic formulae
- Implement perturbation field evaluation
- Visual encoding (hue, brightness, hitSize, tailAngle)
- Match CPU output exactly (visual regression tests)

### Phase 3: Ring Buffer + Lifecycle
- Circular ring buffer with atomic writeHead
- GPU-side expiry check (skip expired particles in vertex shader)
- Eliminate CPU-side particle lifecycle management
- Dynamic capacity (grow buffer when utilisation > 75%)

### Phase 4: Double-Bounce + Pair Production
- Port double-bounce pulsation (k=+1 cyclic cosmology)
- Port pair-production secondary emission
- Match all current visual modes

### Phase 5: Hybrid Fallback
- `PhysicsBridge` detects GPU compute availability
- Seamless fallback to CPU workers when compute unavailable
- Unified interface: `bridge.tick()` works identically in both modes

---

## 9. WGSL Limitations & Workarounds

| Limitation                  | Workaround                                    |
|----------------------------|-----------------------------------------------|
| No recursion               | Iterative Legendre recurrence (already used)  |
| No dynamic arrays in uniform | Fixed `MAX_COEFFS = 289` (l_max=16)          |
| f32 only (no f64)          | Sufficient — CPU uses f64 but physics is f32-safe for β ∈ [0, 0.25) |
| No complex numbers         | Real spherical harmonics (already used)       |
| 16 KB uniform limit (some) | Use storage buffer for coefficients if needed  |
| Atomic ops (u32 only)      | Use `atomicAdd` on u32 counter for writeHead  |

---

## 10. Open Questions

1. **Coefficient update frequency:** Currently O-U evolution runs every
   tick (~16 ms).  Could reduce to every 2–4 frames if upload cost is
   significant (unlikely at 4.6 KB).

2. **Particle sorting:** Current system sorts by arrivalTime on CPU for
   correct alpha blending.  GPU radix sort would be needed for >100k
   particles.  Alternative: use additive blending (no sort needed).

3. **Three.js TSL integration:** r183 has experimental `compute()` and
   `StorageBufferAttribute`.  If the Three.js compute API stabilises,
   the WGSL shader could be written as TSL nodes instead of raw WGSL.
   This would provide automatic uniform binding and type safety.

4. **Memory budget:** Need to decide maximum VRAM allocation.  At 32
   bytes/particle: 1M particles = 32 MB, 5M = 160 MB.  Should be
   capped relative to detected GPU memory (if available via adapter
   limits).
