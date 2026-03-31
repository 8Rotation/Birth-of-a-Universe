# GPU Compute Migration Plan — Particle Emission on GPU

**Goal:** Move the per-particle physics (spherical harmonics, bounce lookup, visual encoding) from CPU Web Workers to a WebGPU compute shader. The CPU workers currently do all the math then ship Float32Arrays to the GPU for rendering. This migration makes the GPU do the math *and* the rendering, eliminating the CPU→GPU transfer and unlocking 10–50× higher particle throughput.

**Current architecture:**
```
CPU Workers (1-4) ──Float32Array──> Main Thread ──writeBatch──> GPU Ring Buffer ──> Render
     │                                   │
     ├─ evaluatePerturbationFast()       ├─ evolveCoeffs() (O-U per tick)
     ├─ bounceProps()                    └─ ring buffer write (memcpy)
     ├─ visual encoding
     └─ PRNG (splitmix32)
```

**Target architecture:**
```
Main Thread                              GPU
├─ evolveCoeffs() (O-U)                 ├─ Compute shader (per-particle):
├─ upload coeffs uniform (~5KB)    ──>  │   ├─ PRNG (PCG)
├─ upload params uniform (~128B)   ──>  │   ├─ sphere sampling
└─ dispatch compute                     │   ├─ evaluatePerturbation (SH)
                                        │   ├─ bounceProps (algebraic)
                                        │   ├─ visual encoding
                                        │   └─ write to shared buffer
                                        │
                                        ├─ Render pipeline:
                                        │   └─ reads same buffer (zero-copy)
                                        │
                                        └─ (CPU workers kept as fallback)
```

**Key files in the existing codebase:**

| File | Role |
|------|------|
| `src/physics/ecsk-physics.ts` | `ECSKPhysics` class — `bounceProps(betaEff)` returns `{a, eps, wEff, acc, S, n}`. Also `productionProps()` for pair production. All algebraic (sqrt, division, no ODE). |
| `src/physics/perturbation.ts` | `evaluatePerturbationFast()` — walks Associated Legendre recurrence for all (l,m) modes. `evolveCoeffs()` does O-U random walk on coefficients. `generatePerturbCoeffs()` creates initial spectrum. |
| `src/physics/shell.ts` | `StreamEmitter.tick()` — the main per-particle loop. Samples S², evaluates perturbation, calls bounceProps, encodes visuals. Uses splitmix32 PRNG. Stride-8 output: `[lx, ly, arrivalTime, hue, brightness, eps, hitSize, tailAngle]`. Has a TWO-PASS hue normalization (min/max wEff across batch, then normalize). Also handles double-bounce modulation and pair-production particles. |
| `src/physics/physics-worker.ts` | Worker message loop. Caps at 50,000 particles/tick. Calls `emitter.tick()`. |
| `src/physics/physics-bridge.ts` | Main-thread side. Spawns N workers, evolves coefficients centrally, partitions rate across workers, drains results via `drain()`. |
| `src/rendering/renderer.ts` | `SensorRenderer` — WebGPU renderer using Three.js r183. `_initGpuMaterial()` builds TSL NodeMaterial with packed ring buffer attributes (2×vec4). `updateUniforms()` sets per-frame uniforms (time, tau, fade, HDR, alive-range). `render()` does bloom pipeline. Ring buffer is `ParticleRingBuffer` with `writeBatch()` that does partial GPU uploads via `device.queue.writeBuffer()`. |
| `src/rendering/particle-ring-buffer.ts` | `ParticleRingBuffer` — circular buffer of 2 packed vec4 attrs (attrA: `[lx, ly, bornTime, hue]`, attrB: `[brightness, eps, hitSize, 0]`). Write-once semantics. Supports direct GPU partial uploads via `setGpuBackend()`. |
| `src/main.ts` | Animation loop. Calls `bridge.tick()` then `bridge.drain()` to get batches, writes to `renderer.ringBuffer.writeBatch()`, then `renderer.updateUniforms()` + `renderer.render()`. |

---

## Task 1: WGSL Compute Shader — Core Physics

**Objective:** Write the WGSL compute shader that evaluates the perturbation field and bounce physics for each particle. This is a standalone `.wgsl` file — no integration with Three.js yet.

**What to read first:**
- `src/physics/perturbation.ts` — `evaluatePerturbationFast()` (lines 240–347). This is the fast path that walks Associated Legendre recurrence once across all (m,l) pairs. The WGSL must replicate this exact algorithm.
- `src/physics/ecsk-physics.ts` — `bounceProps(betaEff)` (lines 139–181). Returns `{a, eps, wEff, acc, S, n}`.
- `src/physics/shell.ts` — `StreamEmitter.tick()` (lines 325–465). This is the per-particle loop. Note the TWO-PASS hue normalization.

**Create:** `src/compute/particle-emit.wgsl`

**Shader specification:**

### Bindings

```wgsl
// Group 0: Perturbation coefficients (read-only storage, not uniform — may exceed 16KB)
struct Coeff {
  l: u32,
  m: i32,
  c: f32,
  sigma: f32,  // unused by shader, but keeps alignment with CPU struct
};
@group(0) @binding(0) var<storage, read> coeffs: array<Coeff>;
// Use arrayLength(&coeffs) instead of a separate numCoeffs binding.
// Runtime-sized storage arrays support arrayLength() natively in WGSL.

// Group 1: Frame parameters (uniform, ~128 bytes)
struct Params {
  beta: f32,             // global spin parameter
  kCurvature: f32,       // -1, 0, or +1
  perturbAmplitude: f32, // δ scaling (used in arrival-time formula, NOT in betaEff — see warning below)
  lMax: u32,             // maximum multipole degree (loop bound for perturbation evaluation)
  arrivalSpread: f32,    // seconds
  simTime: f32,          // current simulation time
  emitCount: u32,        // particles to emit this dispatch
  frameSeed: u32,        // per-frame PRNG seed (incremented each dispatch)
  sensitivity: f32,      // dT_half/dβ (precomputed on CPU)

  // Visual encoding
  hueMin: f32,
  hueRange: f32,
  brightnessFloor: f32,
  brightnessCeil: f32,
  sizeVariation: f32,

  // Acceleration range (precomputed on CPU for stable size normalization)
  globalMinAcc: f32,
  globalMaxAcc: f32,

  // Hue normalization (pre-computed on CPU, not per-batch)
  // These match CPU semantics: minWEff < maxWEff (both negative at bounce).
  minWEff: f32,          // wEff at β*(1-amplitude) — the MOST negative (deep repulsive)
  maxWEff: f32,          // wEff at β*(1+amplitude) — the LEAST negative (radiation-like)

  // Ring buffer write position
  writeOffset: u32,      // where to start writing in output buffer
  bufferCapacity: u32,   // ring buffer capacity (for modulo wrap)
};
@group(1) @binding(0) var<uniform> params: Params;

// Group 2: Output particle buffer (read-write storage)
// Layout: 2 × vec4 per particle (matches ParticleRingBuffer packed format)
//   attrA: [lx, ly, bornTime, hue]
//   attrB: [brightness, eps, hitSize, 0.0]
@group(2) @binding(0) var<storage, read_write> outA: array<vec4<f32>>;
@group(2) @binding(1) var<storage, read_write> outB: array<vec4<f32>>;
```

### PRNG

Use PCG (permuted congruential generator) — faster than splitmix32 on GPU, good statistical quality:

```wgsl
fn pcg(state: ptr<function, u32>) -> u32 {
  let old = *state;
  *state = old * 747796405u + 2891336453u;
  let word = ((old >> ((old >> 28u) + 4u)) ^ old) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand01(state: ptr<function, u32>) -> f32 {
  return f32(pcg(state)) / 4294967296.0;
}
```

Seed per-invocation: `var rng: u32 = params.frameSeed ^ (gid.x * 2654435761u);`

### Sphere sampling

```wgsl
let u1 = rand01(&rng);
let u2 = rand01(&rng);
let cosTheta = 1.0 - 2.0 * u1;
let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
let phi = 6.283185307 * u2;
```

### Perturbation evaluation

Port `evaluatePerturbationFast` from `perturbation.ts` lines 265–347. Key algorithm:

1. Outer loop: `m = 0..lMax` (use `params.lMax` as the loop bound)
2. For m > 0: advance sectoral Legendre `P_m^m *= -(2m-1) * sinT` and trig recurrence `cos(mφ), sin(mφ)` via angle addition.
3. Inner loop: `l = m..lMax` — upward Legendre recurrence in l for fixed m.
4. Normalization: `N_l^m = sqrt((2l+1) / (4π × fac))` where fac is maintained incrementally.
5. Accumulate: `delta += c[idx] * norm * plm * (cos/sin factor)`

### betaEff computation

**CRITICAL — do NOT multiply delta by perturbAmplitude!** The coefficients' `c` values already incorporate amplitude (it's baked in via `generatePerturbCoeffs(lMax, amplitude, ...)` and maintained by the O-U sigma targets). The correct formula is:

```wgsl
let betaEff = clamp(params.beta * (1.0 + delta), 0.002, 0.2499);
```

**WARNING:** The older design document `GPU_COMPUTE_DESIGN.md` in this project incorrectly uses `params.perturbAmplitude * delta`. That is WRONG — it double-counts amplitude. The authoritative reference is `shell.ts` line ~432: `const betaEff = this.physics.beta * (1 + delta);`.

The `perturbAmplitude` field in Params IS still needed — it's used in the arrival-time delay denominator (see Visual encoding section below), not in betaEff.

The coefficient index into the flat array is: `idx = l*l + l + m - 1` for m > 0, `idx = l*l + l - 1` for m = 0, `idx = l*l + l - m - 1` for m < 0 (as documented in the TypeScript). The coefficient array starts at l=1 (no l=0 mode), so the total count for lMax=L is L² + 2L.

**AGENT WARNING — DO NOT port the index formula in isolation.** The TypeScript `evaluatePerturbationFast()` (perturbation.ts lines 265–347) walks coefficients via a nested m/l loop with inline index computation. The WGSL port must replicate the **exact loop structure** from that function: outer loop `m = 0..lMax`, inner loop `l = m..lMax`, with the index computed inside the inner loop body. Read the actual TypeScript function and port it line-by-line. The loop also maintains `cosMPhi`/`sinMPhi` via angle-addition recurrence and `pmm`/`plm_prev`/`plm_curr` for Legendre — these are **stateful across iterations** and cannot be separated from the loop structure.

**CRITICAL:** WGSL has no recursion. The Legendre recurrence is already iterative in the TypeScript — port the exact loop directly, preserving all state variables.

**CRITICAL:** WGSL f32 only (no f64). The TypeScript uses f64 (JS default). For β ∈ [0.005, 0.2499]:
- `sqrt(1 - 4*beta)`: when beta = 0.2499, this is `sqrt(0.0004)` = 0.02 — fine in f32.
- `(1 - disc) / 2`: when disc ≈ 0.02, result ≈ 0.49 — no cancellation problem.
- Worst case is beta very close to 0.25 where disc → 0, but BETA_MAX = 0.2499 prevents this.

### Bounce physics

Port `bounceProps()` from `ecsk-physics.ts` lines 139–181:

```wgsl
fn bounceProps(betaEff: f32, k: f32) -> BounceResult {
  let be = clamp(betaEff, 0.002, 0.2499);
  var a2: f32;
  if (k > 0.5) {
    // k=+1: a² = (1 - sqrt(1 - 4β)) / 2
    let disc = sqrt(max(0.0, 1.0 - 4.0 * be));
    a2 = (1.0 - disc) / 2.0;
  } else if (k > -0.5) {
    // k=0: a² = β
    a2 = be;
  } else {
    // k=-1: a² = (-1 + sqrt(1 + 4β)) / 2
    let disc = sqrt(1.0 + 4.0 * be);
    a2 = max(1e-12, (-1.0 + disc) / 2.0);
  }
  let a = sqrt(a2);

  let wDenom = 3.0 * (a2 - be);
  let wEff: f32;
  if (abs(wDenom) > 1e-12) {
    wEff = (a2 - 3.0 * be) / wDenom;
  } else {
    wEff = -1.0;
  }

  let eps = 1.0 / (a2 * a2);
  let acc = -1.0 / (a2 * a) + (2.0 * be) / (a2 * a2 * a);
  // S and n omitted — only used for HUD display, not particle data

  return BounceResult(a, a2, eps, wEff, acc);
}
```

### Visual encoding

```wgsl
let EPS_LOG_REF = log(10001.0);

// Brightness: log-compressed eps
let brightness = clamp(log(props.eps + 1.0) / EPS_LOG_REF, params.brightnessFloor, params.brightnessCeil);

// Arrival time
let denom = max(1e-6, abs(params.sensitivity) * params.beta * params.perturbAmplitude);
let td = params.arrivalSpread / denom;
let rawDelay = params.sensitivity * (betaEff - params.beta) * td;
let maxDelay = params.arrivalSpread * 1.5;
let arrivalTime = params.simTime + clamp(rawDelay, -maxDelay, maxDelay);

// Hue: pre-computed min/max (no per-batch reduction needed)
// CPU semantics: minW is most negative, maxW is least negative.
// wR = minW - maxW → negative. norm = (w - maxW) / wR → 0 at maxW, 1 at minW.
let wRange = params.minWEff - params.maxWEff;
let wNorm = select((props.wEff - params.maxWEff) / wRange, 0.5, abs(wRange) < 1e-12);
let hue = min(params.hueMin + params.hueRange, params.hueMin + wNorm * params.hueRange);

// Size: lerp between uniform and physics-driven
let normAcc = clamp((props.acc - params.globalMinAcc) / max(1e-6, params.globalMaxAcc - params.globalMinAcc), 0.0, 1.0);
let hitSize = 1.0 - params.sizeVariation * 0.5 + normAcc * params.sizeVariation;

// Tail angle (random)
let tailAngle = rand01(&rng) * 6.283185307;

// Lambert projection
let theta = acos(cosTheta);
let lx = 2.0 * sin(theta / 2.0) * cos(phi);
let ly = 2.0 * sin(theta / 2.0) * sin(phi);
```

### Main entry point

```wgsl
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.emitCount) { return; }

  // ... PRNG, sphere sampling, perturbation, bounce, visual encoding ...

  // Write to ring buffer (modulo wrap)
  let slot = (params.writeOffset + idx) % params.bufferCapacity;
  outA[slot] = vec4(lx, ly, arrivalTime, hue);
  outB[slot] = vec4(brightness, eps, hitSize, 0.0);
}
```

**Create:** `src/compute/particle-emit.test.ts`

Write a vitest test that:
1. Imports the WGSL as a string (use vite's `?raw` import — this works by default in Vite, no config change needed).
2. Validates it parses without WGSL syntax errors. **Do NOT use `navigator.gpu`** — it doesn't exist in Node/vitest. Instead, install and use `@aspect-build/naga-wgsl-validator` (npm package that validates WGSL syntax offline via Naga). If that package is unavailable, fall back to string checks: assert non-empty, contains `@compute`, `fn main`, `fn bounceProps`, `fn pcg`, `fn evalPerturbation`.
3. Tests the TypeScript reference implementations (`bounceProps`, `evaluatePerturbationFast`) at edge cases to establish golden values that the WGSL will need to match (β = 0.005, 0.10, 0.2499; k = -1, 0, +1; lMax = 2, 8, 16).

**Acceptance criteria:**
- `src/compute/particle-emit.wgsl` exists and is syntactically valid WGSL.
- All functions are ported: PCG PRNG, Legendre recurrence, perturbation evaluation, bounceProps, Lambert projection, visual encoding.
- No recursion, no dynamic allocation, no unsupported WGSL features.
- Writes directly to the ring buffer's packed vec4 format (attrA/attrB).
- Hue normalization uses pre-computed min/max wEff from params (no reduction pass).
- Golden-value tests exist for the TypeScript reference functions.
- `npm run build` and `npx vitest run` pass.

**Does NOT include:** Three.js integration, buffer creation, dispatch logic, or the double-bounce/pair-production features. Those come in later tasks.

---

## Task 2: Compute Pipeline Integration — `ComputeEmitter` Class

**Objective:** Create a TypeScript class that wraps the WGSL shader from Task 1 and dispatches it each frame. This class handles GPU buffer management, uniform uploads, and integrates with the existing `ParticleRingBuffer`.

**What to read first:**
- `src/compute/particle-emit.wgsl` (from Task 1)
- `src/rendering/particle-ring-buffer.ts` — understand `packedAttrA`, `packedAttrB`, `_writeHead`, `_capacity`, `_totalWritten`. The ring buffer currently writes to `InstancedBufferAttribute` arrays on CPU and does partial GPU uploads via `device.queue.writeBuffer()`.
- `src/rendering/renderer.ts` — `_initGpuMaterial()` to see how the render pipeline reads from ring buffer attrs. The key insight: the compute shader must write to the **same GPU buffers** that the render pipeline reads from.
- `src/physics/physics-bridge.ts` — `tick()` and `drain()` interface. The `ComputeEmitter` will replace the `PhysicsBridge` when GPU compute is active.

**Create:** `src/compute/compute-emitter.ts`

### Class API

```typescript
export class ComputeEmitter {
  constructor(
    device: GPUDevice,
    ringBuffer: ParticleRingBuffer,
    shaderSource: string,  // WGSL from ?raw import
  );

  /**
   * Initialize the compute pipeline and bind groups.
   * Must be called after the ring buffer's GPU buffers are created
   * (i.e., after the first render frame).
   */
  init(): void;

  /**
   * Emit particles for one frame.
   *
   * @param commandEncoder  Active GPUCommandEncoder (from Three.js frame)
   * @param emitCount       Number of particles to emit this frame
   * @param params          Physics + visual parameters for this frame
   * @param coeffs          Packed perturbation coefficients (from evolveCoeffs)
   */
  dispatch(
    commandEncoder: GPUCommandEncoder,
    emitCount: number,
    params: ComputeParams,
    coeffs: Float32Array,
  ): void;

  /**
   * Whether the compute pipeline initialized successfully.
   */
  get ready(): boolean;

  /**
   * Release GPU resources.
   */
  dispose(): void;
}
```

### ComputeParams interface

```typescript
export interface ComputeParams {
  beta: number;
  kCurvature: number;
  perturbAmplitude: number;
  lMax: number;            // maximum SH degree (loop bound for perturbation)
  arrivalSpread: number;
  simTime: number;
  sensitivity: number;  // from physics.sensitivity()

  hueMin: number;
  hueRange: number;
  brightnessFloor: number;
  brightnessCeil: number;
  sizeVariation: number;

  globalMinAcc: number;
  globalMaxAcc: number;
  minWEff: number;         // most negative wEff (from low betaEff)
  maxWEff: number;         // least negative wEff (from high betaEff)
}
```

### Implementation details

**Buffer access — the hard part:**

The existing ring buffer's `packedAttrA` and `packedAttrB` are `THREE.InstancedBufferAttribute` objects. Their underlying `GPUBuffer` is created by Three.js's WebGPU backend and is accessible (hackily) via:

```typescript
const backend = (renderer as any).backend;
const gpuBufA: GPUBuffer = backend.get(ringBuffer.packedAttrA)?.buffer;
const gpuBufB: GPUBuffer = backend.get(ringBuffer.packedAttrB)?.buffer;
```

This is already done in `particle-ring-buffer.ts` `writeBatch()` method (see `setGpuBackend(device, backend)` and the direct `device.queue.writeBuffer()` calls). The `ComputeEmitter` needs these same GPUBuffer references.

**Add to `ParticleRingBuffer`:**
- A method `getGpuBuffers(): { bufA: GPUBuffer; bufB: GPUBuffer } | null` that returns the underlying GPUBuffers (using the same backend lookup already in `writeBatch()`).
- A method `advanceWriteHead(count: number): void` that advances `_writeHead` and `_totalWritten` by `count` WITHOUT writing any CPU-side data (the compute shader wrote directly to GPU). This is needed so the ring buffer's bookkeeping stays in sync. **IMPORTANT:** This method must also check if `_writeHead + count` would exceed `_capacity` and call `grow()` if needed, just like `writeBatch()` does. The `grow()` call also triggers re-creation of GPU staging buffers in `ComputeEmitter` — see the bind group invalidation note above.

**Uniform buffers:**

Create two GPU buffers:
1. `paramsBuffer` (uniform, ~128 bytes) — updated each frame via `device.queue.writeBuffer()`.
2. `coeffsBuffer` (storage, read-only, dynamic size) — holds packed coefficients. At lMax=16 that's 289 coefficients × 16 bytes = 4.6KB. At lMax=96 it's 9409 × 16 = ~150KB. Use storage buffer (not uniform) to handle large lMax.

**Coefficient packing:**

The CPU evolves coefficients as `PerturbMode[]` with `{l, m, c, sigma}`. Pack into the Coeff struct: `[l as u32, m as i32 (via bitcast), c as f32, sigma as f32]` — 16 bytes aligned. Write the entire array to `coeffsBuffer` each frame.

**Frame seed:**

Increment a `u32` counter each frame. The WGSL shader XORs this with the invocation index for per-particle PRNG state.

**Pipeline creation:**

```typescript
const pipeline = device.createComputePipeline({
  layout: 'auto',
  compute: {
    module: device.createShaderModule({ code: shaderSource }),
    entryPoint: 'main',
  },
});
```

**Bind groups:**

- Group 0: coeffsBuffer (storage, read) — runtime-sized array; shader uses `arrayLength(&coeffs)` to get count
- Group 1: paramsBuffer (uniform)
- Group 2: computeBufA (storage, read_write) + computeBufB (storage, read_write) — staging buffers owned by ComputeEmitter

**IMPORTANT:** The outA/outB bind group must be **recreated** whenever the ring buffer grows (because grow() creates new Float32Arrays and Three.js creates new GPUBuffers on the next render). Add an `invalidateBindGroup()` method that the ring buffer can call after grow, or check buffer identity each frame.

**Dispatch:**

```typescript
const workgroupSize = 64;
const dispatchCount = Math.ceil(emitCount / workgroupSize);
const passEncoder = commandEncoder.beginComputePass();
passEncoder.setPipeline(this.pipeline);
passEncoder.setBindGroup(0, this.coeffsBindGroup);
passEncoder.setBindGroup(1, this.paramsBindGroup);
passEncoder.setBindGroup(2, this.outputBindGroup);
passEncoder.dispatchWorkgroups(dispatchCount);
passEncoder.end();
```

**Buffer usage flags:**

The output GPUBuffers (attrA, attrB) need `GPUBufferUsage.STORAGE` in addition to their current `GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST`. **Three.js r183 does NOT set the STORAGE flag on `InstancedBufferAttribute` buffers** — it only sets `VERTEX | COPY_DST`.

**Resolution:** Use **staging buffers owned by `ComputeEmitter`** (Option B below). This is the correct approach — do not attempt to monkey-patch Three.js buffer creation.

**NOTE:** The project's `src/types/three-webgpu.d.ts` already declares `StorageInstancedBufferAttribute extends StorageBufferAttribute`. This Three.js class creates buffers with `STORAGE | VERTEX` usage. However, switching the ring buffer from `InstancedBufferAttribute` to `StorageInstancedBufferAttribute` would require changes to `ParticleRingBuffer` construction and the renderer — a larger refactor. The staging-buffer approach avoids this.

**Mandatory approach — staging buffer + copy:**
1. `ComputeEmitter` creates its own `GPUBuffer` pair (`computeBufA`, `computeBufB`) with `GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC`.
2. The compute shader writes to these staging buffers.
3. After the compute pass ends, use `commandEncoder.copyBufferToBuffer(computeBufA, ..., gpuBufA, ...)` to copy the written region (writeOffset × 16 bytes, emitCount × 16 bytes) from the staging buffer to the Three.js attribute buffer. Handle wrap-around with two copy commands if needed.
4. This adds one GPU-to-GPU copy per frame (negligible — fully on-device) but cleanly avoids any Three.js internal changes.
5. The staging buffers must be re-created when the ring buffer grows. Listen for the ring buffer's grow event or check capacity each frame.

**Write-head synchronization:**

After dispatch, call `ringBuffer.advanceWriteHead(emitCount)` so the ring buffer's CPU-side bookkeeping (writeHead, totalWritten, activeCount) tracks the GPU writes. The CPU-side Float32Array data will be stale (compute wrote to GPU only), but that's fine — the CPU ring buffer data is only read by `computeAliveRange()` (which reads `bornTime` from CPU arrays). This needs fixing: see Task 5.

**For now:** Use the conservative alive-range approach described in Task 5 Option C: when GPU compute is active, always set `aliveStart = 0, aliveCount = capacity`. The vertex shader already checks each particle's age — this just means the GPU processes some dead particles unnecessarily.

**Create:** `src/compute/compute-emitter.test.ts`

Test that:
1. `ComputeEmitter` can be constructed (mock GPUDevice if WebGPU not available in test env).
2. `ComputeParams` interface covers all required fields.
3. Coefficient packing produces correct byte layout.

**Acceptance criteria:**
- `ComputeEmitter` class exists in `src/compute/compute-emitter.ts`.
- `ParticleRingBuffer` has `getGpuBuffers()` and `advanceWriteHead(count)` methods.
- Compute pipeline is created from the WGSL shader module.
- Bind groups wire coefficients, params, and output buffers correctly.
- Frame seed increments each dispatch.
- Write-head synchronization keeps ring buffer bookkeeping in sync.
- Alive-range works (conservative estimate: aliveStart=0, aliveCount=capacity when compute active).
- Output bind group is invalidated/recreated when ring buffer grows.
- `npm run build` and `npx vitest run` pass.
- Compute is NOT yet wired into the animation loop (that's Task 3).

---

## Task 3: Wire Compute Emitter into Animation Loop

**Objective:** Connect the `ComputeEmitter` (Task 2) into `main.ts` so it runs alongside (or instead of) the CPU worker pipeline. Add a feature flag to switch between CPU and GPU emission.

**What to read first:**
- `src/main.ts` — the animation loop (lines 400–800). Key sequence per frame: `bridge.tick()` → `bridge.drain()` → `renderer.ringBuffer.writeBatch()` → `renderer.updateUniforms()` → `renderer.render()`.
- `src/compute/compute-emitter.ts` (from Task 2)
- `src/rendering/renderer.ts` — need to hook into the `GPUCommandEncoder` that Three.js creates for each frame.

**Modify:** `src/main.ts`, `src/rendering/renderer.ts`, `src/ui/controls.ts`

### Feature flag

Add to `SimParams` in `src/ui/controls.ts`:
```typescript
gpuCompute: boolean;  // default: false (CPU workers)
```

Add a toggle in the Performance folder of the controls panel.

### Integration in main.ts

After the renderer is initialized and the first frame has rendered (so GPU buffers exist):

```typescript
import { ComputeEmitter } from "./compute/compute-emitter.js";
import shaderSource from "./compute/particle-emit.wgsl?raw";

// After renderer.init():
const backend = (renderer.renderer as any).backend;
const gpuDevice: GPUDevice | undefined = backend?.device;
let computeEmitter: ComputeEmitter | null = null;

if (gpuDevice) {
  computeEmitter = new ComputeEmitter(gpuDevice, renderer.ringBuffer, shaderSource);
  // Defer init() to after first render (GPUBuffers exist)
  requestAnimationFrame(() => {
    try {
      computeEmitter!.init();
      console.log("[main] GPU compute emitter ready");
    } catch (e) {
      console.warn("[main] GPU compute init failed, using CPU workers:", e);
      computeEmitter = null;
    }
  });
}
```

In the animation loop, replace the bridge.tick/drain block:

```typescript
if (params.gpuCompute && computeEmitter?.ready) {
  // GPU compute path
  const emitCount = Math.floor(effectiveRate * dt);
  if (emitCount > 0) {
    // Get the command encoder from Three.js backend
    // Three.js r183 WebGPU: the backend creates a command encoder per frame.
    // We need to insert our compute pass BEFORE the render pass.
    // Option A: Use renderer.renderer.compute() if available (experimental TSL compute).
    // Option B: Get the raw device and submit our own command encoder before render.
    //
    // Option B is simpler and doesn't depend on Three.js compute API stability:
    const encoder = gpuDevice.createCommandEncoder();
    computeEmitter.dispatch(encoder, emitCount, {
      beta: params.beta,
      kCurvature: Number(params.kCurvature),
      perturbAmplitude: params.perturbAmplitude,
      lMax: params.lMax,
      arrivalSpread: params.arrivalSpread,
      simTime,
      sensitivity: physics.sensitivity(),
      hueMin: params.hueMin,
      hueRange: params.hueRange,
      brightnessFloor: params.brightnessFloor,
      brightnessCeil: params.brightnessCeil,
      sizeVariation: params.sizeVariation,
      globalMinAcc: physics.bounceAccRange(params.perturbAmplitude).minAcc,
      globalMaxAcc: physics.bounceAccRange(params.perturbAmplitude).maxAcc,
      // minWEff = most negative wEff (low betaEff, deep repulsive)
      // maxWEff = least negative wEff (high betaEff, radiation-like)
      // This matches CPU shell.ts: minW < maxW (both negative at bounce).
      minWEff: physics.bounceProps(physics.beta * Math.max(0.001, 1 - params.perturbAmplitude)).wEff,
      maxWEff: physics.bounceProps(physics.beta * (1 + params.perturbAmplitude)).wEff,
    }, computeEmitter.packCoeffs(bridge.getCoeffs()));
    gpuDevice.queue.submit([encoder.finish()]);
    arrivalCounter += emitCount;
  }
} else {
  // CPU worker path (existing code, unchanged)
  bridge.tick(dt, simTime, effectiveRate, { ...tickParams }, budget.maxParticlesPerTick);
  const batches = bridge.drain();
  // ... existing writeBatch logic ...
}
```

### Coefficient evolution on main thread

The O-U coefficient evolution already runs on the main thread (in `PhysicsBridge.tick()`). When using GPU compute, we still need these coefficients. Extract the evolution logic so it can be called independently:

Either:
- Call `bridge.tick()` even in GPU mode (it will evolve coefficients but workers won't produce particles since rate=0).
- Or extract `evolveCoeffs` into a standalone call in main.ts.

The **second option is recommended.** `evolveCoeffs()` is already a standalone export in `perturbation.ts` (lines 197–212). Calling `bridge.tick()` with rate=0 still broadcasts `postMessage` to all workers each frame, wasting IPC overhead. Instead:

```typescript
// In GPU compute path, evolve coefficients directly:
import { evolveCoeffs } from "./physics/perturbation.js";
// bridge.getCoeffs() returns the PerturbMode[] (add this getter)
evolveCoeffs(bridge.getCoeffs(), dt, params.fieldEvolution, coeffRng);
```

This avoids touching the worker pipeline entirely when GPU compute is active. The `coeffRng` should be a splitmix32 seeded from the same source as the bridge's `coeffRng`.

**Add to PhysicsBridge:** `getCoeffs(): ReadonlyArray<PerturbMode>` — exposes the current coefficients for the GPU compute path. The packing into `Float32Array` format `[l, m, c, sigma]` per mode is done by `ComputeEmitter.packCoeffs()` or a helper in `compute-emitter.ts`.

**Bridge coefficient internals (needed for implementation):**
- `PhysicsBridge` stores `private coeffs: PerturbMode[]` (line ~130 in physics-bridge.ts).
- `PerturbMode` is defined in `perturbation.ts` (lines 117–121):
  ```typescript
  export interface PerturbMode {
    l: number;
    m: number;
    c: number;     // current coefficient
    sigma: number; // O-U diffusion scale = amplitude × √C_l
  }
  ```
- The bridge evolves coefficients each tick via `evolveCoeffs(this.coeffs, dt, fieldEvolution, this.coeffRng)` (line ~238).
- Since `coeffs` is private, add: `getCoeffs(): ReadonlyArray<PerturbMode> { return this.coeffs; }`.
- Also add: `getCoeffRng(): () => number { return this.coeffRng; }` so the GPU path can evolve coefficients directly without the bridge.

### Vite config

WGSL files need to be importable as raw strings. Add to `vite.config.ts` if not already present:

```typescript
assetsInclude: ['**/*.wgsl'],
```

Or use the `?raw` suffix on import (works by default in Vite).

**Acceptance criteria:**
- `gpuCompute` toggle exists in the controls panel (Performance folder).
- When `gpuCompute` is true and `ComputeEmitter` is ready, particles are emitted via GPU compute.
- When `gpuCompute` is false, the existing CPU worker path is used (completely unchanged behavior).
- Coefficient evolution continues running on the main thread in both modes.
- The compute dispatch runs before the render pass each frame.
- Particles appear on screen and have correct positions, colors, fade, sizes.
- HUD counters (flux, visible, buffer fill) update correctly in both modes.
- If GPU compute initialization fails, the system falls back to CPU workers automatically.
- `npm run build` and `npx vitest run` pass.

---

## Task 4: Double-Bounce and Pair-Production in Compute Shader

**Objective:** Extend the WGSL compute shader and `ComputeEmitter` to handle double-bounce rate modulation (k=+1 cyclic cosmology) and pair-production secondary particles.

**What to read first:**
- `src/physics/shell.ts` — lines 340–385 (double-bounce modulation) and lines 465–600 (pair production). These are the two features that Task 1's shader omitted.
- `src/physics/ecsk-physics.ts` — `productionProps()` (lines 230–275) and `BETA_CR = 1/929`.

**Modify:** `src/compute/particle-emit.wgsl`, `src/compute/compute-emitter.ts`

### Double-bounce

Add to `Params`:
```wgsl
  doubleBounce: u32,      // bool as u32 (0 or 1)
  dbPhase: f32,           // current phase accumulator [0, 1) — evolved on CPU
  dbSecondHueShift: f32,
  dbSecondBriScale: f32,
  bounceCount: u32,       // number of bounce particles (rest are production); 0 if no PP
```

Note: `dbModFloor` and `dbModMean` are NOT in the shader — the CPU computes the modulated count (Approach A). Only `dbPhase` is needed by the shader for the visual shift.

The phase accumulator (`_dbPhase` in shell.ts) must be maintained on the CPU (it's stateful across frames). Add it as a field on `ComputeEmitter` or pass it through `ComputeParams`. Each frame: `phase += dt / visualPeriod; phase %= 1.0`.

In the shader (Approach A — CPU passes pre-modulated emitCount, no rejection needed):
```wgsl
// Double-bounce visual shift only — rate modulation is handled on CPU.
// All emitCount particles are written; the CPU computed:
//   emitCount = floor(baseRate * mod / DB_MOD_MEAN * dt)
if (params.doubleBounce == 1u && params.kCurvature > 0.5) {
  let isSecond = params.dbPhase > 0.25 && params.dbPhase < 0.75;
  if (isSecond) {
    hue += params.dbSecondHueShift;
    brightness *= params.dbSecondBriScale;
    eps *= params.dbSecondBriScale;  // eps tracks brightness scaling (matches CPU)
  }
}
```

The CPU computes the modulated count each frame:
```typescript
const cosVal = Math.cos(2 * Math.PI * 2 * dbPhase);
const mod = Math.max(DB_MOD_FLOOR, cosVal > 0 ? cosVal * cosVal : 0);
const modulatedRate = baseRate * mod / DB_MOD_MEAN;
const emitCount = Math.floor(modulatedRate * dt);
```

Note: The CPU code modulates the _rate_ (effectiveRate × mod). On GPU, there are two viable approaches:

**Approach A (recommended): CPU-side modulated count.** Compute the modulated emit count on the CPU and pass it as `emitCount` to the shader. This matches the current architecture, keeps the ring buffer's `advanceWriteHead(emitCount)` bookkeeping correct (every dispatched slot gets a valid particle), and avoids GPU-side gaps. The CPU already has the phase accumulator and can compute `mod = max(DB_MOD_FLOOR, cos²(2π·2·phase))` trivially. The shader just emits all `emitCount` particles — no rejection logic needed. Apply the second-bounce visual shift (hue/brightness) in the shader based on `params.dbPhase`.

**Approach B (NOT recommended): GPU rejection sampling.** Emit at full rate and probabilistically discard invocations. **WARNING:** This breaks write-head bookkeeping — the GPU writes fewer particles than `emitCount`, leaving gaps with stale/zero data in the ring buffer, which causes visual artifacts (ghost particles). Would require an atomic counter in the shader to track actual writes and a GPU→CPU readback to sync the write head. Not worth the complexity.

Use Approach A.

### Pair production

Add to `Params`:
```wgsl
  betaPP: f32,            // pair-production rate coefficient
  ppFraction: f32,        // betaPP / BETA_CR, capped at ppFractionCap
  ppHueShift: f32,
  ppBriBoost: f32,
  ppSizeScale: f32,
  ppBaseDelay: f32,
  ppScatterRange: f32,
```

The CPU code emits `ppCount = floor(bounceCount * ppFraction)` additional particles after the bounce particles. In the shader, the simplest approach is:

1. Increase `emitCount` by `(1 + ppFraction)` on the CPU side.
2. Each invocation checks: `if (idx < bounceCount) { /* bounce particle */ } else { /* production particle */ }`.

**Add `bounceCount: u32` to the Params struct** so the shader knows the boundary. The CPU sets `bounceCount = emitCount_before_pP; emitCount = bounceCount + ppCount`.

**Production particles need separate normalization bounds.** The CPU code (shell.ts lines 500–565) runs a separate min/max wEff pass and uses `productionAccRange()` for production particles. Add these to Params:
```wgsl
  ppMinWEff: f32,      // from productionProps at β*(1-amplitude)
  ppMaxWEff: f32,      // from productionProps at β*(1+amplitude)
  ppGlobalMinAcc: f32, // from physics.productionAccRange(amplitude, betaPP)
  ppGlobalMaxAcc: f32,
```
Without these, production particle hue and size would be mapped against bounce-physics bounds, producing visually wrong results.

For production particles, port `productionProps()`:
- Production epoch scale: `a_post = a_bounce * sqrt(2)`
- Different hue shift, brightness boost, size scale
- Later arrival time: `arrivalTime += ppBaseDelay + rand * ppScatterRange + PP_SCATTER_BIAS`

`PP_SCATTER_BIAS = -0.6`, `PP_BRIGHTNESS_CEIL = 1.5`, `PP_FRACTION_CAP = 3.0` — these constants from shell.ts.

### Compute the visual period on CPU

The double-bounce visual period depends on `physics.fullPeriod()` and the derived time dilation. This is already computed in `shell.ts` tick() but needs to be extracted for the compute path. Add to `ComputeParams`:

```typescript
dbVisualPeriod: number;  // computed from physics.fullPeriod() × TD / DB_VIS_NORM
```

Compute on CPU each frame and pass to `ComputeEmitter`.

**Acceptance criteria:**
- Double-bounce pulsation works visually identically to CPU path when `doubleBounce` is enabled and k=+1.
- Pair-production particles appear with correct visual encoding (shifted hue, boosted brightness, smaller size, delayed arrival).
- Both features can be toggled via existing UI controls.
- `npm run build` and `npx vitest run` pass.

---

## Task 5: Alive-Range Optimization for GPU Compute Path

**Objective:** Fix the alive-range binary search so it works correctly when particles are emitted by GPU compute (where the CPU-side Float32Array doesn't have bornTime data).

**What to read first:**
- `src/rendering/particle-ring-buffer.ts` — `computeAliveRange(now, cutoffDuration)`. This method binary-searches the CPU-side `bornTime` values (attrA[i*4+2]) to find the oldest alive particle. When GPU compute writes directly to GPU buffers, the CPU array is stale.
- `src/rendering/renderer.ts` — `updateUniforms()` calls `computeAliveRange()` and sets `_uAliveStart` / `_uAliveCount` uniforms.

**The problem:**
When GPU compute is active, the CPU-side Float32Array backing `packedAttrA` is never updated with the new particles' bornTimes. The `computeAliveRange()` method reads stale data and computes wrong alive ranges, causing visible particles to be culled.

**Solution options (implement ONE):**

### Option A: CPU-side bornTime tracking (recommended — simplest)

Since the compute shader writes `arrivalTime = simTime + clamp(delay, -maxDelay, maxDelay)`, all arrival times fall within `[simTime - 1.5*arrivalSpread, simTime + 1.5*arrivalSpread]`. The ring buffer write head advances by `emitCount` each frame.

Add to `ParticleRingBuffer`:
```typescript
/**
 * Record that `count` particles were written starting at the current
 * writeHead, with bornTimes approximately in [minBorn, maxBorn].
 * Used by GPU compute path where CPU array is stale.
 */
recordGpuWrite(count: number, minBorn: number, maxBorn: number): void;
```

Modify `computeAliveRange()`: when GPU writes have been recorded, use bounds-based range estimation instead of binary search. The alive range is:
- `start`: oldest write whose `maxBorn > now - cutoffDuration`
- `count`: from start to current write head

Track a small circular history of `{writeHead, minBorn, maxBorn}` per frame (last 600 entries ≈ 10 seconds at 60fps). Binary search this history instead of the per-particle array.

### Option B: GPU→CPU bornTime readback

After each compute dispatch, copy the bornTime column from the GPU buffer back to CPU via `copyBufferToBuffer` + `mapAsync`. This is async (1+ frame latency) but gives exact data.

This is more complex and adds latency. Not recommended unless Option A proves insufficient.

### Option C: Conservative alive range (no optimization)

When GPU compute is active, always set `aliveStart = 0, aliveCount = capacity`. The vertex shader already checks each particle's age — this just means the GPU processes some dead particles unnecessarily.

This is the absolute simplest fix. Task 2 uses this as the initial approach. This task upgrades to Option A for better performance.

**Implementation guidance:**

Implement Option C first as a boolean flag (`gpuComputeMode` on ParticleRingBuffer). If perf is acceptable, stop. Otherwise, implement Option A.

For Option A, the frame-history approach:

```typescript
interface GpuWriteRecord {
  writeHead: number;   // ring buffer position after this write
  minBorn: number;     // earliest possible bornTime in this batch
  maxBorn: number;     // latest possible bornTime in this batch
}

private _gpuHistory: GpuWriteRecord[] = [];  // circular, capped at 600

computeAliveRange(now: number, cutoff: number): { start: number; count: number } {
  if (!this._gpuComputeMode) {
    return this._binarySearchAliveRange(now, cutoff);
  }
  // Binary search _gpuHistory for the oldest entry where maxBorn > now - cutoff
  const deadline = now - cutoff;
  let lo = 0, hi = this._gpuHistory.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (this._gpuHistory[mid].maxBorn < deadline) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= this._gpuHistory.length) return { start: this._writeHead, count: 0 };
  return {
    start: this._gpuHistory[lo].writeHead,
    count: (this._writeHead - this._gpuHistory[lo].writeHead + this._capacity) % this._capacity,
  };
}
```

**Acceptance criteria:**
- `computeAliveRange()` returns correct results when GPU compute is active.
- No visible particle culling artifacts (particles appearing/disappearing incorrectly).
- The approach is documented in a code comment explaining why it differs from the binary-search path.
- `npm run build` and `npx vitest run` pass.

---

## Task 6: Validation and Visual Regression Testing

**Objective:** Verify that GPU compute particles look visually identical to CPU worker particles. Fix any discrepancies.

**What to read first:**
- `src/compute/particle-emit.wgsl` (Task 1)
- `src/physics/shell.ts` — the reference CPU implementation
- `src/physics/ecsk-physics.test.ts` — existing golden-value tests for bounce physics

**Create:** `src/compute/gpu-cpu-validation.test.ts`

### Numeric validation

Write tests that compare CPU vs GPU output at known inputs:

1. **bounceProps accuracy:** For β = [0.005, 0.05, 0.10, 0.15, 0.20, 0.2499] and k = [-1, 0, +1]:
   - Compute `bounceProps` on CPU (f64) and record `{eps, wEff, acc}`.
   - Compute the same in a reference f32 TypeScript implementation (cast all intermediates to `Math.fround()`).
   - Assert relative error < 0.1% for eps, < 1% for wEff, < 1% for acc.
   - Document any cases where f32 diverges significantly.

2. **Perturbation evaluation:** For lMax = [2, 4, 8, 16] with known seed:
   - Generate coefficients with `generatePerturbCoeffs`.
   - Evaluate at 100 random (θ,φ) points using f64 `evaluatePerturbationFast`.
   - Evaluate the same points using an f32 reference (Math.fround all trig).
   - Assert absolute error < 0.01 (perturbation values are typically O(0.1)).

3. **Visual encoding:** For known `{eps, wEff, acc}`:
   - Compute hue, brightness, hitSize using f64 and f32.
   - Assert hue differs by < 2°, brightness by < 0.02, hitSize by < 0.05.

### Integration validation

**WebGPU is NOT available in vitest's default Node environment.** For GPU integration tests, use one of these approaches (in order of preference):

1. **Playwright browser test (recommended):** Create a separate test file `src/compute/gpu-integration.spec.ts` that runs in a headed Chromium instance via `@playwright/test`. Chromium supports WebGPU natively. The test creates a minimal compute pipeline, dispatches 1000 particles, reads back the output buffer, and compares against CPU reference values. Mark this test in a separate `playwright.config.ts` so it doesn't run in `npx vitest run`.

2. **Node with Dawn bindings:** Use `@aspect-build/wgpu-node` or `node-webgpu` to get a `GPUDevice` in Node. These packages are experimental and may require native compilation. Only use if Playwright is not feasible.

3. **Skip with message:** If neither option is set up, the integration test should `test.skip('WebGPU not available in test environment')`. The numeric validation (f32 vs f64 comparison) tests above run without WebGPU and provide sufficient coverage.

When WebGPU IS available:

1. Create a minimal WebGPU compute pipeline with the WGSL shader.
2. Dispatch 1000 particles with known parameters.
3. Read back the output buffer.
4. Compare each particle's `[lx, ly, arrivalTime, hue, brightness, eps, hitSize]` against CPU-computed values for the same PRNG sequence.
5. Assert all values match within the f32 tolerances established above.

If WebGPU is not available in the test environment, skip integration tests with a clear skip message.

### Fallback behavior test

1. With `gpuCompute = false`: verify CPU workers produce particles (existing behavior).
2. With `gpuCompute = true` but `ComputeEmitter` not ready: verify fallback to CPU workers.
3. Toggle `gpuCompute` mid-session: verify no crash, particles continue appearing.

**Acceptance criteria:**
- f32 precision analysis is documented with actual numbers.
- Any precision issues at extreme β values are identified and mitigated (e.g., clamping).
- Integration test exists (even if skipped when WebGPU unavailable).
- Fallback behavior is tested.
- `npm run build` and `npx vitest run` pass.

---

## Task 7: Performance Benchmarking and Tuning

**Objective:** Measure actual throughput on real hardware and tune workgroup size, dispatch strategy, and particle rate limits.

**What to read first:**
- `src/compute/compute-emitter.ts` (Task 2)
- `src/ui/hardware-info.ts` — existing CPU benchmark. We need a GPU compute benchmark.
- `src/main.ts` — compound-budget throttling logic (lines 540–600).

**Modify:** `src/ui/hardware-info.ts`, `src/main.ts`, `src/ui/controls.ts`

### GPU compute benchmark

Add to `HardwareDetector` (or create a standalone utility):

```typescript
/**
 * Benchmark GPU compute throughput by dispatching a small test shader
 * and measuring wall-clock time. Returns particles/second capability.
 */
async benchmarkGpuCompute(device: GPUDevice): Promise<number>;
```

The benchmark shader should be a simplified version of particle-emit.wgsl that does the core work (PRNG + perturbation eval at lMax=8 + bounceProps + visual encoding) for 10,000 particles. Time the dispatch + queue submit + fence. Run 3 iterations, take the median. Convert to particles/sec.

### Adaptive rate limiting

When GPU compute is active, the budget system should use the GPU benchmark result instead of the CPU benchmark to set rate limits:

- `maxParticlesPerFrame` = GPU benchmark rate / target FPS
- Cap at `min(maxParticlesPerFrame, VRAM_BUDGET_PARTICLES / persistence)`

### Workgroup size tuning

The shader uses `@workgroup_size(64)`. This is a reasonable default but may not be optimal for all GPUs:
- NVIDIA: optimal at 256 (full warp occupancy)
- AMD: optimal at 64 or 128
- Apple: optimal at 32 or 64
- Intel iGPU: optimal at 32

Consider making workgroup size selectable (32, 64, 128, 256) based on GPU vendor from `adapter.info`. Or just benchmark all four sizes in the GPU benchmark and pick the fastest.

### HUD integration

Add to HUD readouts:
- GPU compute status: "ON (X k/frame)" or "OFF (CPU)"
- GPU compute throughput: measured particles/sec from benchmark

### Slider limit updates

When GPU compute is active, allow the `particleRate` slider to go higher than the CPU-based maximum:
- CPU mode: max from `budget.sliderLimits.particleRateMax` (up to 200K)
- GPU mode: max = GPU benchmark rate (could be 1M+)

Update `SliderLimits` in `hardware-info.ts` and the controls setup.

**Acceptance criteria:**
- GPU compute benchmark exists and reports particles/sec.
- Rate limiting uses GPU capability when compute is active.
- HUD shows GPU compute status and throughput.
- Slider limits adapt when switching between CPU and GPU modes.
- The simulation runs without frame drops at the auto-detected rate.
- `npm run build` and `npx vitest run` pass.

---

## Task Order and Dependencies

```
Task 1 (WGSL shader)
  │
  ▼
Task 2 (ComputeEmitter class)
  │
  ├──▶ Task 3 (wire into animation loop)
  │      │
  │      ├──▶ Task 4 (double-bounce + pair production)
  │      │
  │      └──▶ Task 5 (alive-range fix)
  │
  └──▶ Task 6 (validation tests) — can start after Task 2, finalize after Task 4
         │
         ▼
       Task 7 (benchmarking + tuning) — last, after everything works
```

Tasks 4 and 5 are independent and can be done in parallel.
Task 6 should be started after Task 2 (for f32 precision tests) and finalized after Task 4 (for feature parity tests).
Task 7 is the final polish step.

---

## Known Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Three.js r183 WebGPU backend doesn't set `STORAGE` usage on InstancedBufferAttribute GPUBuffers | Compute shader can't write to render buffers directly | Use staging buffer + `copyBufferToBuffer` (documented in Task 2) |
| f32 precision divergence at extreme β | Visible color/position differences vs CPU | Task 6 quantifies this; clamp β_eff away from singularities in WGSL |
| Three.js internal API changes in future versions | `backend.get(attr).buffer` accessor breaks | Pin Three.js version; document the dependency |
| Ring buffer grow() invalidates GPUBuffers | Compute bind group + staging buffers reference stale buffers | Invalidate/recreate bind group + staging buffers on grow (documented in Task 2) |
| WebGPU compute not available (Safari, older browsers) | Feature entirely unavailable | CPU worker fallback is preserved; `gpuCompute` toggle defaults to false |
| GPU_COMPUTE_DESIGN.md has stale betaEff formula | Agent reads wrong formula and double-counts amplitude | FIXED in this plan; authoritative reference is shell.ts line ~432 |
