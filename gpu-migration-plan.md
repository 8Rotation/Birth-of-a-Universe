# GPU-Native Particle Rendering — Migration Plan

## Summary

The current particle pipeline does all per-particle work (fade, color, position copy, lifecycle expiry) in JavaScript on the main thread every frame, then bulk-uploads results to the GPU. At 200k particles this consumes ~40% GPU (pipeline stalls from ~5 MB/frame CPU→GPU uploads) and causes GC-induced freezes at high fade durations (45s). The fix is moving particle state to the GPU and computing fade/color in shaders — "write once at birth, never touch from JS again."

**Target architecture:**
```
Worker produces particle → main thread writes 7 floats into GPU ring buffer (once) → done
GPU vertex shader: age, Weibull fade, visibility (size=0 if dead/future)
GPU fragment shader: HSL→RGB color, fade alpha, round clipping
Main thread per-frame: upload 1 uniform block (uTime, uTau, etc.) — zero per-particle JS
```

**Expected result:** 500k+ particles at 4K 120Hz with bloom, <10% GPU, no stalls.

---

## Task 1: Create GPU Ring Buffer Data Structure

**Objective:** Build a write-once ring buffer backed by `InstancedBufferAttribute`s that will store immutable per-particle birth data on the GPU.

**Context:**

This project is a Three.js WebGPU particle simulation (`src/rendering/renderer.ts`). Currently, the renderer stores particle visuals in two `InstancedBufferAttribute`s (`posAttr: vec3`, `colorAttr: vec3`) that are **fully rewritten from JavaScript every frame** via the `updateHits()` method. This per-frame rewrite is the primary performance bottleneck.

The renderer uses:
- `WebGPURenderer` + `PointsNodeMaterial` from `three/webgpu`
- `InstancedBufferAttribute` with `THREE.DynamicDrawUsage`
- A `THREE.Sprite` whose `.count` controls how many instances are drawn
- Capacity doubling via `_growBuffers()` which allocates new `Float32Array`s and replaces `.array` on existing attributes

Workers emit particles as `Float32Array` batches with 8-float stride (defined as `PARTICLE_STRIDE = 8` in `src/physics/physics-bridge.ts`):
```
[0] lx          — Lambert x ∈ [−2, 2]
[1] ly          — Lambert y ∈ [−2, 2]
[2] arrivalTime — wall-clock birth time (seconds)
[3] hue         — HSL hue [0, 360]
[4] brightness  — log-compressed [0, 1]
[5] eps         — raw energy density (for HDR)
[6] hitSize     — bounce kick [0, 1]
[7] tailAngle   — radians [0, 2π] (reserved, unused)
```

**Files to create/modify:**
- Create `src/rendering/particle-ring-buffer.ts` — new file
- Create `src/rendering/particle-ring-buffer.test.ts` — unit tests
- Modify `src/rendering/renderer.ts` — import and instantiate

**What to implement:**

Create a `ParticleRingBuffer` class in `src/rendering/particle-ring-buffer.ts` that manages:

1. **Per-particle attributes** stored as `InstancedBufferAttribute`s (all `DynamicDrawUsage`):
   - `posAttr`: `Float32Array`, 2 floats/particle — `[lx, ly]`
   - `bornAttr`: `Float32Array`, 1 float/particle — wall-clock birth time
   - `hueAttr`: `Float32Array`, 1 float/particle — hue degrees [0, 360]
   - `briAttr`: `Float32Array`, 1 float/particle — brightness [0, 1]
   - `epsAttr`: `Float32Array`, 1 float/particle — raw energy density
   - `sizeAttr`: `Float32Array`, 1 float/particle — hit size [0, 1]

   That's 7 floats per particle (28 bytes). At 500k capacity = 14 MB.

2. **Ring buffer write semantics:**
   - `writeHead: number` — wraps via `writeHead = (writeHead + 1) % capacity`
   - `writeBatch(data: Float32Array, count: number, stride: number, now: number, cutoffDuration: number): void` — writes a batch from the worker's packed format (stride=8). Maps offsets: `data[i*8+0]→lx, [1]→ly, [2]→born, [3]→hue, [4]→bri, [5]→eps, [6]→size`. Before wrapping `writeHead` past capacity, checks if the slot being overwritten is still alive: if `bornAttr[writeHead] > now - cutoffDuration`, calls `grow()` instead of overwriting. This prevents visual popping from killing still-visible particles. Sets `needsUpdate = true` on each attribute after writing. Note: Three.js r183's WebGPU backend does **not** support partial buffer updates (`updateRange`/`addUpdateRange`) on `InstancedBufferAttribute` — `needsUpdate = true` re-uploads the full array. This is acceptable because uploads only happen when new batches arrive, not every frame.
   - `clear(): void` — resets `writeHead = 0`, fills `bornAttr` with `-1e9` sentinel (so all particles read as dead in shader — `rawAge` will be huge, `fade` will be zero). Sets `needsUpdate` on all attributes.
   - `invalidateFuture(cutoffTime: number): void` — scans `bornAttr` and sets any values `> cutoffTime` to `-1e9` (kills far-future particles baked with stale physics, without wiping recently-arrived visible particles). Sets `needsUpdate` on `bornAttr`.
   - `grow(minCapacity: number): void` — doubles capacity until ≥ minCapacity, copies existing data, replaces `.array` on existing attribute objects (do NOT recreate attribute objects — this avoids WebGPU shader recompilation).
   - `readonly capacity: number`
   - `readonly totalWritten: number` — monotonically increasing count (for HUD diagnostics)
   - `readonly activeCount: number` — `Math.min(totalWritten, capacity)` — number of slots that contain real data (use for `sprite.count` and sampling loops)
   - Getters for each attribute: `get positionAttribute()`, `get bornTimeAttribute()`, etc.

3. The constructor takes `initialCapacity: number`. On construction, fill `bornAttr` with `-1e9` sentinel (not `0.0`) so unwritten slots are always shader-dead regardless of `uTime`.

4. Export the class.

In `src/rendering/renderer.ts`:
- Import `ParticleRingBuffer`
- Add `private _ringBuf!: ParticleRingBuffer` member
- In `init()`, after existing setup, instantiate: `this._ringBuf = new ParticleRingBuffer(this._capacity)`
- Add a public getter: `get ringBuffer(): ParticleRingBuffer { return this._ringBuf; }`
- **Do NOT change the material, shaders, `updateHits()`, or rendering pipeline.** This task is data structure only.

**Dependencies:** None — this is the first task.

**Verification:**
```bash
npm run build    # must succeed with zero errors
npx vitest run   # all existing tests must pass, PLUS new ring buffer tests
```

**Acceptance criteria:**
- `ParticleRingBuffer` class exists in `src/rendering/particle-ring-buffer.ts` with the API described above
- Ring buffer is instantiated in `SensorRenderer.init()` and accessible via `renderer.ringBuffer`
- All `InstancedBufferAttribute`s use `THREE.DynamicDrawUsage`
- `bornAttr` is initialized to `-1e9` sentinel, not `0.0`
- `writeBatch` checks slot liveness before overwriting (safe-wrap)
- `invalidateFuture(cutoffTime)` method exists for soft settings-change culling
- Unit tests exist in `src/rendering/particle-ring-buffer.test.ts` covering:
  - Basic write + read-back (single particle, batch of N)
  - Wrap-around: write more than capacity, verify oldest slots are overwritten correctly
  - Safe-wrap: verify `grow()` is called when overwriting a still-alive slot
  - `grow()` preserves existing data and doubles capacity
  - `clear()` fills `bornAttr` with sentinel, resets `writeHead`
  - `invalidateFuture()` only kills slots born after cutoff
  - `activeCount` returns `min(totalWritten, capacity)`
- Existing rendering is **completely unaffected** (no visual or behavioral changes)
- Build and tests pass

---

## Task 2: GPU-Side Fade and Color Shader

**Objective:** Replace the JS-side per-particle color/fade computation with a TSL shader that reads immutable birth attributes and computes everything on the GPU. **Both the old and new pipelines coexist behind a feature flag** so visual correctness can be A/B tested.

**Approach — feature flag:** Add a `useGpuFade: boolean` property on `SensorRenderer` (default `false`). When `false`, the existing `updateHits()` path runs unchanged. When `true`, the new `updateUniforms()` path runs instead. `main.ts` calls whichever path the flag selects. This flag costs ~10 lines and provides a rollback mechanism until Task 4 removes it.

**Context:**

This project uses Three.js WebGPU with TSL (Three Shading Language) node materials. The renderer (`src/rendering/renderer.ts`) currently has:

1. A `PointsNodeMaterial` (assigned to a `THREE.Sprite`) with TSL nodes:
   - `positionNode = instancedDynamicBufferAttribute(this.posAttr, "vec3")` — reads pre-computed xyz
   - `colorNode = instancedDynamicBufferAttribute(this.colorAttr, "vec3")` — reads pre-computed RGB
   - `sizeNode = this._sizeUniform` — a TSL `uniform(float)`
   - `opacityNode` — round-particle clipping via `smoothstep` on UV distance (toggleable via `_roundUniform`)

2. An `updateHits(hits: Hit[], count, now, persistence)` method that runs a **per-particle loop** every frame:
   - Computes `age = now - hit.born`, `fade = exp(-pow(age/persistence, fadeSharpness))`
   - Converts HSL→RGB (JS function `hslToRGB` at top of file)
   - Applies SDR lightness/saturation encoding OR HDR eps→nits mapping
   - Applies auto-brightness gain
   - Writes computed positions to `posAttr.array` and computed colors to `colorAttr.array`
   - Sets `needsUpdate = true` on both attributes → full buffer re-upload every frame

3. A bloom pipeline (two-pass: particle + ring) using TSL `pass()` + `bloom()` nodes that reads from `this.scene`.

4. HDR support in three modes (`_hdrMode: 'full' | 'soft' | 'none'`). The `epsToNits` function is in `src/ui/screen-info.ts` and does: `floorNits + (peakNits - floorNits) * clamp01(log(1 + eps - epsDim) / log(1 + epsBright - epsDim))`.

**Key constants for the shader:**
- `FADE_THRESHOLD = 0.003` — discard threshold
- `CIRCLE_OUTER_R = 0.50` — round-particle clip radius
- `EPS_LOG_REF = Math.log(10001)` — log reference for brightness encoding
- `SDR_REFERENCE_WHITE_NITS = 203` — SDR white point

**HSL→RGB algorithm** (currently JS, port to TSL):
```
h = mod(hue, 360)
c = (1 - abs(2*l - 1)) * s
x = c * (1 - abs(mod(h/60, 2) - 1))
m = l - c/2
// 6 hue sectors → r,g,b assignment (use step/mix for GPU-friendly branchless version)
```

Task 1 created a `ParticleRingBuffer` class (in `src/rendering/particle-ring-buffer.ts`) with per-particle `InstancedBufferAttribute`s: `posAttr` (vec2: lx,ly), `bornAttr` (float), `hueAttr` (float), `briAttr` (float), `epsAttr` (float), `sizeAttr` (float). These are accessible via `this._ringBuf.positionAttribute`, etc. The ring buffer is instantiated in `init()` and accessible via `this.ringBuffer`.

**Files to modify:**
- `src/rendering/renderer.ts` — Add new material setup, uniforms, shader logic, and `updateUniforms` method alongside existing code

**Implementation — split into 4 sub-tasks for incremental verification:**

### Task 2a: Wire `positionNode` from ring buffer + add feature flag

Create a second `PointsNodeMaterial` (stored as `_gpuMaterial`) that reads position from ring buffer attributes:
- `positionNode`: read `aPosition` (lx, ly from ring buffer's `posAttr`) → `vec3(lx, ly, 0.0)`
- `sizeNode`: initially just use `this._sizeUniform` (same as old material — no fade logic yet)
- `colorNode`: initially just `vec3(1.0, 1.0, 1.0)` (white — placeholder)
- `opacityNode`: copy existing round-particle clipping logic

Add a `useGpuFade: boolean` property (default `false`). In `init()`, create both materials and assign the old one to the sprite. Add a method or check in `render()` / `updateUniforms()` that swaps `sprite.material` when the flag changes.

Use `instancedDynamicBufferAttribute()` to read from ring buffer attributes, same as current code does with `posAttr`/`colorAttr`.

**Verify:** Set `useGpuFade = true`, write test particles to ring buffer → white dots appear at correct Lambert positions.

### Task 2b: Move fade/visibility to `sizeNode`

Replace the placeholder `sizeNode` on the GPU material with full Weibull fade logic:

Add **TSL uniforms** (all via `uniform()`):
- `uTime: float` — current display time (seconds)
- `uTau: float` — Weibull scale parameter (from `fadeDurationToTau()`)
- `uFadeSharpness: float` — Weibull k parameter
- `uHitBaseSize: float` — base particle size. **Bake screen density into this uniform**: `uHitBaseSize.value = this.hitBaseSize * this.hitSizeScaleFactor` (the current renderer multiplies these in `_sizeUniform.value` at line ~916)

**Vertex/size logic (TSL):**
```
rawAge = uTime - aBornTime
age = max(0.0, rawAge)
fade = exp(-pow(age / uTau, uFadeSharpness))
alive = step(0.0, rawAge) * step(0.003, fade)  // 1.0 if alive, 0.0 if dead/future
size = aSize * uHitBaseSize * alive
```

In `updateUniforms()`, set `this.sprite.count = this._ringBuf.activeCount` (from Task 1's `activeCount` getter = `Math.min(totalWritten, capacity)`). This is required for correctness — without it, never-written buffer slots at startup would render as ghost particles at position (0,0).

**Verify:** Set `useGpuFade = true` → particles appear, fade according to Weibull curve, disappear when dead.

### Task 2c: Move HSL→RGB + SDR brightness to `colorNode`

Add remaining **TSL uniforms**:
- `uBrightnessMultiplier: float` — user brightness slider value
- `uLightnessFloor: float`, `uLightnessRange: float` — SDR lightness encoding
- `uSaturationFloor: float`, `uSaturationRange: float` — SDR saturation encoding
- `uAutoGain: float` — auto-brightness gain
- `uPeakScale: float` — max brightness clamp (SDR: 20)

**Color logic (TSL, SDR path):**
```
lightness = uLightnessFloor + aBrightness * uLightnessRange
saturation = uSaturationFloor + (1.0 - aBrightness) * uSaturationRange
rgb = hslToRGB(aHue, saturation, lightness)
scale = fade * uBrightnessMultiplier * uAutoGain
finalRGB = rgb * min(scale, uPeakScale)
```

Implement `hslToRGB` as a TSL `Fn()` using branchless step/mix for the 6 hue sectors.

**Auto-brightness gain:** The gain is computed from scalar settings only (`maxEps`, `minEps`, lightness params, hitBaseSize, etc.) — it does NOT require per-particle iteration. The existing code block at ~lines 730-790 of renderer.ts (before the per-particle loop) already computes this from class properties. Port this logic into `updateUniforms()` and pass as `uAutoGain`.

**Auto-ring-color** (the `cosSum/sinSum` weighted-mean hue loop): keep it but read directly from `this._ringBuf.hueAttr.array` and `this._ringBuf.briAttr.array`, sampling every Nth element over `ringBuf.activeCount` elements (not `capacity` — avoids reading unwritten sentinel slots that would skew the average). Do NOT iterate `Hit` objects.

**Verify:** Set `useGpuFade = true` → SDR colors match the old pipeline (toggle flag to compare).

### Task 2d: Wire HDR path + bloom verification

Add HDR-specific **TSL uniforms**:
- `uHdrMode: float` — 0.0=none, 1.0=soft, 2.0=full
- `uPeakNits: float`, `uMinEps: float`, `uMaxEps: float` — HDR mapping params

**Color logic (TSL, HDR path):**
```
// HDR path (uHdrMode > 0.0):
hdrSat = min(1.0, uSaturationFloor + uSaturationRange)
rgb = hslToRGB(aHue, hdrSat, 0.5)
nits = epsToNits(aEps, uPeakNits, 20.0, uMinEps, uMaxEps)
scale = fade * (nits / 203.0) * (uBrightnessMultiplier / 5.0) * uAutoGain

finalRGB = rgb * min(scale, uPeakScale)
```

Where `uPeakScale` = `peakNits / 203 * 2` in HDR mode, `20` in SDR mode.

Use TSL `mix()` or conditional selection to choose SDR vs HDR path based on `uHdrMode`.

**Bloom compatibility:** The bloom pipeline reads from `this.scene`. The sprite with the new GPU material is still in the scene — bloom should work unchanged. Verify by testing with bloom enabled in both modes.

**Verify:** Compare all three HDR modes (none/soft/full) with flag on vs off. Bloom works in both modes.

---

### `updateUniforms()` method (called when `useGpuFade = true`)

```typescript
updateUniforms(now: number, tau: number): void {
  if (!this._ready) return;
  // Set all TSL uniform values from current class properties
  this._uTime.value = now;
  this._uTau.value = tau;
  this._uFadeSharpness.value = this.fadeSharpness;
  this._uHitBaseSize.value = this.hitBaseSize * this.hitSizeScaleFactor;
  this._uBrightnessMultiplier.value = this.brightnessMultiplier;
  // ... (all other uniforms)
  
  // Auto-brightness gain — computed from scalar settings, NOT per-particle.
  // Port the existing ~60-line block from updateHits() that uses maxEps,
  // minEps, lightness/saturation params, hitBaseSize.
  this._uAutoGain.value = computeAutoGain();  // extracted helper
  
  // Sprite count = only slots containing real data
  this.sprite.count = this._ringBuf.activeCount;
  
  // Auto-ring-color (sample from ring buffer arrays)
  // ... (existing cosSum/sinSum logic, reading hueAttr/briAttr)
  
  // Push ring material, size, round uniform updates
  // ... (same as end of current updateHits)
}
```

**Dependencies:** Task 1 must be complete (provides `ParticleRingBuffer` with per-particle attributes).

**Verification (each sub-task):**
```bash
npm run build    # must succeed with zero errors
npx vitest run   # all existing tests must pass
```
Then manually test each sub-task with `useGpuFade` toggled on/off: particles should look visually identical to the old pipeline (same colors, fade, sizes, bloom, round/square toggle, HDR modes). Toggle the flag back and forth to A/B compare.

**Acceptance criteria:**
- `useGpuFade` flag exists on `SensorRenderer`, defaults to `false`
- When `true`: material reads from ring buffer attributes, all rendering is GPU-computed
- When `false`: existing `updateHits()` path runs unchanged (rollback)
- `updateUniforms()` exists alongside `updateHits()` — both work
- `sprite.count = ringBuf.activeCount` (not `capacity`) when using GPU path
- `uHitBaseSize` includes `hitSizeScaleFactor` (screen density baked in)
- HSL→RGB, Weibull fade, dead-particle culling, HDR eps→nits all compute in shader
- Auto-brightness gain computed from scalar settings, passed as `uAutoGain`
- Auto-ring-color samples `hueAttr`/`briAttr` arrays over `activeCount`, not `capacity`
- Bloom works (particle + ring) in both old and new modes
- Round vs square particle toggle works
- All three HDR modes work (none/soft/full)
- Build and tests pass

---

## Task 3: Wire Ring Buffer Into Main Loop

**Objective:** Replace the `hits: Hit[]` array and O(n) fade-expire loop in `main.ts` with direct writes to the renderer's GPU ring buffer.

**Context:**

`src/main.ts` is the main animation loop for a Three.js WebGPU particle simulation. Currently it:

1. **Receives particles** from physics workers via `PhysicsBridge.drain()` which returns `RawParticleBatch` objects (each containing a `Float32Array` with 8-float stride and a `count`). The stride format (`PARTICLE_STRIDE = 8`) is defined in `src/physics/physics-bridge.ts`: `[lx, ly, arrivalTime, hue, brightness, eps, hitSize, tailAngle]`.

2. **Unpacks batches into JS objects** via `ingestBatchPrefix()` (~line 349) which creates `Hit` objects and pushes to `hits: Hit[]`.

3. **Fade-expire loop** (~lines 689-722): Every frame, iterates ALL elements of `hits[]`, computing `Math.exp(-Math.pow(age/tau, k))` per particle to partition visible vs expired. This is O(total_buffer) and is the primary CPU bottleneck.

4. **Soft-cap culling** (~lines 728-744): Drains visible particles when count exceeds hardware budget.

5. **Future-cap** (~lines 749-758): Limits buffered future particles.

6. **Emergency cap** (~lines 763-772): Hard truncation at `EMERGENCY_HIT_CAP`.

7. **Calls `renderer.updateHits(hits, visibleCount, displayTime, tau)`** which does another O(n) loop for color computation.

8. **Compound-budget throttling** (~lines 597-654): Limits `effectiveRate` based on `maxVisibleHits`, renderer iteration cost, buffer size, etc.

9. **Settings-change culling** (~lines 505-575): On physics param changes, discards future-born hits.

10. **Reset handler** (~line 186): Clears `hits = []; visibleCount = 0`.

After Tasks 1-2, the renderer now has:
- `renderer.ringBuffer` — a `ParticleRingBuffer` with `writeBatch(data, count, stride, now, cutoff)`, `clear()`, `invalidateFuture(cutoffTime)`, `capacity`, `totalWritten`, `activeCount` properties
- `renderer.updateUniforms(now, tau)` — sets shader uniforms (uTime, uTau, etc.) with zero per-particle work
- `renderer.useGpuFade` — feature flag (`false` = old pipeline, `true` = new pipeline)
- The GPU shader handles fade, color, and dead-particle culling — no JS involvement needed

The key function for computing Weibull τ from fade duration is `fadeDurationToTau(duration, sharpness)` in `main.ts` (~line 47):
```typescript
const FADE_THRESHOLD = 0.003;
const CUTOFF_MARGIN = 1.2;
function fadeDurationToTau(duration: number, sharpness: number): number {
  return duration / (Math.pow(-Math.log(FADE_THRESHOLD) * CUTOFF_MARGIN, 1 / sharpness));
}
```
This IS still needed — it computes `tau` passed to `renderer.updateUniforms()`.

**Files to modify:**
- `src/main.ts` — Major refactor

**What to implement:**

0. **Enable the GPU pipeline:** Set `renderer.useGpuFade = true` (flip the feature flag from Task 2). The old `updateHits()` path remains in code as a rollback — it will be removed in Task 4.

1. **Remove** the following (all in `main.ts`):
   - `hits: Hit[]` array, `_futureHits: Hit[]` buffer, `visibleCount` variable
   - `ingestBatchPrefix()` and `drainPendingBatches()` functions
   - The "Fade-expire & partition hits" block (the O(n) loop)
   - The "Soft cap: hardware-budget drain" block
   - The "Future cap" block
   - The "EMERGENCY_HIT_CAP" truncation block
   - The `Hit` type import from renderer (if no longer used elsewhere in the file)
   - `SPREAD_TAIL_MULT` and `FUTURE_MARGIN` constants (no longer used)

2. **Replace particle ingestion** with direct ring buffer writes:
   ```typescript
   const batches = bridge.drain();
   if (batches.length > 0) pendingBatches.push(...batches);
   const cutoff = params.persistence * CUTOFF_MARGIN;
   while (pendingBatches.length > 0) {
     const batch = pendingBatches.shift()!;
     renderer.ringBuffer.writeBatch(batch.data, batch.count, PARTICLE_STRIDE, displayTime, cutoff);
     arrivalCounter += batch.count;
   }
   ```
   No `maxIngestPerFrame` throttle needed — ring buffer writes are just memcpy.

   **⚠ Time basis verification:** The worker's `arrivalTime` (offset `[2]` in each particle) and `displayTime` (passed as `uTime` to the shader) **must share the same time basis**. In the current code, `simTime` is re-synced to wall-clock on the first frame (`if (simTime < 0) simTime = now`), and workers add offsets to `simTime`. So `arrivalTime` = `simTime + delay`, and `displayTime` = wall-clock `now` (or frozen snapshot). Since `simTime ≈ now` after the first frame, the bases match. **However**, if `simTime` drifts from `now` due to pause accumulation (`simTimePauseAccum`), the fade computation will be wrong. Verify this during integration: `console.log(simTime - now)` should always be near zero when running (not paused).

3. **Replace `renderer.updateHits(...)` call** with:
   ```typescript
   const tau = fadeDurationToTau(params.persistence, params.fadeSharpness);
   renderer.updateUniforms(displayTime, tau);
   ```

4. **Simplify compound-budget throttling** (~lines 597-654):
   - **Keep:** physics cost cap (`maxByPhysics`) — workers are still CPU-bound
   - **Keep:** reactive back-pressure, but base it on ring buffer fill: `if (renderer.ringBuffer.totalWritten > renderer.ringBuffer.capacity * 0.8)`
   - **Replace `maxByRenderer`** with a VRAM-based cap: `maxByVRAM = vramBudgetParticles / (persistence * totalMultiplier)` where `vramBudgetParticles = budget.emergencyHitCap` (at 28 bytes/particle, this prevents multi-hundred-MB allocations). The GPU handles rendering cheaply but unbounded VRAM growth is still dangerous.
   - **Remove:** `maxByBuffer` cap (no JS iteration cost)
   - **Remove:** `maxIngestPerFrame` throttle (ring buffer writes are trivial)

5. **Settings-change culling:** Replace the hit-array filtering (~lines 556-575) with `renderer.ringBuffer.invalidateFuture(now + 5)` when `physicsDirty` fires. This kills far-future particles baked with old physics settings while keeping recently-arrived visible particles intact. **Do NOT call `clear()`** — that would cause a jarring flash-to-black on every slider drag, which is a visual regression from the current gradual behavior.

6. **Reset handler:** Replace `hits = []; visibleCount = 0;` with `renderer.ringBuffer.clear()`. Full clear is appropriate here because the user explicitly requested a reset.

7. **HUD updates:**
   - `hud.visible`: change to `String(renderer.ringBuffer.totalWritten)` or a count based on ring buffer capacity usage
   - `hud.bufferFill`: change to `${(renderer.ringBuffer.totalWritten / 1000).toFixed(0)}K / ${(renderer.ringBuffer.capacity / 1000).toFixed(0)}K`

8. **Keep:** `fadeDurationToTau()`, `FADE_THRESHOLD`, `CUTOFF_MARGIN` — still needed to compute `tau` for the shader uniform.

9. **Freeze:** No change needed — `displayTime` already freezes when `params.frozen` is true, and it's passed to `updateUniforms()` as `uTime`.

**Dependencies:** Tasks 1 and 2 must be complete (provides ring buffer with `writeBatch`/`clear` and `updateUniforms` method on renderer).

**Verification:**
```bash
npm run build    # must succeed
npx vitest run   # all tests must pass
```
Then manually test:
- Run simulation for 30+ seconds — no stall
- Set fade to 45s — runs stable indefinitely
- Click Reset — screen clears and refills
- Change physics params (β slider) — old particles clear, new ones appear
- Freeze/unfreeze — works correctly

**Acceptance criteria:**
- `renderer.useGpuFade = true` is set (feature flag flipped)
- No `Hit[]` array or `_futureHits[]` buffer exists in `main.ts`
- No per-frame O(n) loop over particles in `main.ts`
- Worker batches write directly to `renderer.ringBuffer.writeBatch()` with `now` and `cutoff` params
- Fade-expire, soft-cap, future-cap, and emergency-cap blocks are all gone
- Settings-change culling uses `invalidateFuture()` (not `clear()`) — no flash-to-black
- Reset handler uses `clear()` — full wipe is intentional here
- VRAM-based rate cap replaces old renderer-cost-based cap
- Time basis verified: `simTime` and `displayTime` stay in sync (logged during dev)
- Reset, settings changes, freeze/unfreeze all work
- HUD readouts show ring buffer stats
- 45-second fade duration does not cause stalls or mass particle vanishing
- Build and tests pass

---

## Task 4: Dead Code Cleanup, Feature Flag Removal, and Budget Simplification

**Objective:** Remove the old JS-side particle pipeline (now behind the `useGpuFade` feature flag), remove the flag itself, and update the hardware budget system for GPU-native rendering.

**Context:**

After Tasks 1-3, the simulation runs entirely on the GPU pipeline (`useGpuFade = true`). The following code exists only for the old pipeline and is now dead:
- JS-side per-particle fade/color computation (`updateHits()` method)
- The `Hit` type for rendering (may still be exported — remove if unused)
- Buffer iteration caps (`maxVisibleHits`, `maxArrivalsPerFrame`, `maxHeapInsertsPerFrame`) that existed to throttle JS O(n) loops
- JS-side `hslToRGB()` function (now in the GPU shader)
- The `_growBuffers()` method (ring buffer handles growth internally)
- The old `posAttr` and `colorAttr` members (replaced by ring buffer attributes)
- The old `material` (replaced by `_gpuMaterial`)
- The `useGpuFade` feature flag itself (always `true` now)
- `SPREAD_TAIL_MULT`, `FUTURE_MARGIN` constants in `main.ts`
- `frameLeewayScale()` function (if no longer referenced by remaining throttle caps)

The hardware budget system is in `src/ui/hardware-info.ts`. The `ComputeBudget` interface (~line 100) and `buildBudget()` function (~line 434) define capability-scaled parameters. Several were designed for the JS pipeline:
- `maxVisibleHits` (line ~472): "CPU renderer iterates every visible hit per frame (~100 ns each)" — no longer relevant
- `maxArrivalsPerFrame` (line ~451): capped JS object creation — now just memcpy
- `maxHeapInsertsPerFrame` (line ~452): same — no longer relevant
- `emergencyHitCap` (line ~449): `lerpInt(200_000, 20_000_000, t, 1.5)` — repurpose as ring buffer VRAM cap
- `maxPhysicsCostPerSec` (line ~477): workers are still CPU-bound — **keep unchanged**
- `recommendedWorkers` (line ~462): still relevant — **keep unchanged**
- `sliderLimits` (line ~464): still relevant — **keep unchanged**

**Files to modify:**
- `src/rendering/renderer.ts` — remove dead methods, old material, feature flag, and JS functions
- `src/main.ts` — remove dead imports, constants, and functions
- `src/ui/hardware-info.ts` — simplify budget parameters and update comments

**What to implement:**

1. **In `src/rendering/renderer.ts`:**
   - Remove `function hslToRGB()` (top of file, ~line 86)
   - Remove `updateHits()` method and the old material creation path
   - Remove `_growBuffers()` method
   - Remove the old `posAttr` and `colorAttr` members (replaced by ring buffer attributes)
   - Remove the `useGpuFade` property and any branching on it — the GPU material becomes the only material
   - Remove unused `Hit` export if nothing outside renderer imports it. Check `main.ts` imports — if `Hit` is no longer imported there after Task 3, remove the export.
   - Clean up any remaining dead references

2. **In `src/main.ts`:**
   - Remove `Hit` import from renderer (if present)
   - Remove `SPREAD_TAIL_MULT`, `FUTURE_MARGIN` constants (if not removed in Task 3)
   - Remove `frameLeewayScale()` if no remaining code calls it
   - Remove any remaining compound-budget variables that reference removed caps (`maxByRenderer`, `maxByBuffer`, `baseVisibleHitBudget`, `effectiveMaxHits`)
   - Clean up the throttling block to be minimal: just physics cost cap + ring buffer fill-rate back-pressure

3. **In `src/ui/hardware-info.ts`:**
   - In `ComputeBudget` interface: mark `maxVisibleHits`, `maxArrivalsPerFrame`, `maxHeapInsertsPerFrame` as deprecated or remove them. If other code still reads them, keep but add `@deprecated` JSDoc comments. If nothing reads them, remove entirely.
   - In `buildBudget()`: update comments to say "ring buffer capacity" instead of "CPU renderer iteration budget"
   - Increase `emergencyHitCap` values if needed: at 28 bytes/particle, 2M = 56 MB VRAM, 10M = 280 MB — both reasonable for modern GPUs
   - Update the `particleRateMax` slider limit comments to reflect that the limit is now worker physics throughput, not renderer iteration cost

**Dependencies:** Tasks 1-3 must be complete.

**Verification:**
```bash
npm run build    # zero errors AND zero warnings
npx vitest run   # all tests pass
```
Then grep the codebase for removed function/variable names to confirm no dangling references:
```bash
npx grep -r "updateHits\|hslToRGB\|_growBuffers\|_futureHits\|SPREAD_TAIL_MULT\|FUTURE_MARGIN" src/
```

**Acceptance criteria:**
- No dead code from the old JS pipeline remains in `renderer.ts`, `main.ts`, or `hardware-info.ts`
- The `useGpuFade` feature flag is removed — GPU pipeline is the only path
- `updateHits()`, `hslToRGB()`, `_growBuffers()`, old `posAttr`/`colorAttr` are all gone
- `Hit` type is removed if nothing imports it
- Budget comments accurately describe the GPU-native architecture
- Zero build errors, zero build warnings
- All tests pass
- Simulation behaves identically to after Task 3

---

## Task 5: Validation, Performance Testing, and Tuning

**Objective:** Verify visual correctness, confirm the 45-second-fade stall is fixed, and tune ring buffer capacity for optimal performance.

**Context:**

After Tasks 1-4, the particle simulation has been migrated from a JS-side per-particle pipeline to a GPU-native architecture:
- Particles are written once to a ring buffer (`ParticleRingBuffer` in `src/rendering/particle-ring-buffer.ts`)
- The GPU vertex shader computes Weibull fade, age-based visibility (dead particles get size=0), and the fragment shader computes HSL→RGB color — all from immutable per-particle birth attributes
- `main.ts` no longer has any per-particle loops — it writes worker batches to the ring buffer and calls `renderer.updateUniforms()` once per frame
- Dead particles remain in the ring buffer until overwritten by the write pointer

The **original bug**: at 45-second fade duration with ~2000 particles/sec, the simulation would stall after 10-20 seconds due to (a) O(n) JS loops over 180k+ particles, (b) GC pressure from temporary allocations, and (c) a back-pressure throttle causing synchronized mass particle expiry. All three root causes have been removed.

**Hardware context** (from user's setup): NVIDIA RTX 3060 Laptop (6GB VRAM), 16 CPU threads, 4K display, 120Hz target.

**Files to modify:**
- Possibly `src/rendering/particle-ring-buffer.ts` — capacity tuning
- Possibly `src/rendering/renderer.ts` — shader tweaks if visual regressions found
- Possibly `src/main.ts` — integration fixes
- Test files if any reference removed APIs

**What to validate:**

1. **Visual regression checks** (manual):
   - Fade curve: set fade sharpness to 1.0 (default) — particles should dim exponentially, not abruptly
   - Colors: particles should range from amber (low w_eff) to violet (high w_eff), matching previous behavior
   - HSL encoding: SDR mode should show brightness driving both lightness and saturation
   - HDR modes: if available, test soft and full HDR — brightness should scale with eps→nits
   - Auto-brightness: toggle on — brightness should normalize to settings-dependent ceiling, no flicker
   - Round particles: toggle on — particles should be soft circles; toggle off — squares
   - Bloom: enable particle bloom + ring bloom — glow should appear around particles and ring edge
   - Ring auto-color: ring should match average particle hue

2. **The critical performance test** (manual):
   - Set fade duration to **45 seconds**
   - Set birth rate to maximum slider value
   - Enable bloom (both particle and ring)
   - Enable round particles
   - Run for **60+ seconds** continuously
   - **Must NOT stall**, freeze, or show mass particle vanishing
   - Monitor Task Manager: GPU should stay under 50%, CPU should stay under 30%

3. **Ring buffer capacity tuning:**
   - Default initial capacity should be based on hardware tier (from `ComputeBudget`):
     - LOW tier: 65,536 (2^16)
     - MID tier: 262,144 (2^18)
     - HIGH tier: 1,048,576 (2^20)
   - The ring buffer initial capacity is set from `budget.initialGpuCapacity` (already exists in `ComputeBudget` as `lerpPow2(14, 20, t, 1.2)` — i.e., 2^14 to 2^20 based on hardware score). Verify this is still wired correctly.
   - Growth: if more particles arrive than capacity, the ring buffer should grow (double) automatically. Verify this works under sustained high rates.

4. **Dead particle GPU cost:**
   - With ring buffer capacity at 256k and only 90k alive, ~166k dead particles still get processed by the vertex shader (but produce zero-size sprites → zero fragments). Verify this doesn't measurably impact GPU time.
   - `sprite.count` is already set to `ringBuf.activeCount` (= `min(totalWritten, capacity)`, wired in Task 2b), so never-written buffer tail slots are never drawn. The only overhead is from written-but-expired slots, which is inherent to the ring buffer design and should be negligible.

5. **Test suite:**
   - Run `npx vitest run` — all tests must pass
   - Check if any test files reference `Hit[]`, `updateHits`, `visibleCount`, or other removed APIs. If so, update to use new API or remove the affected assertions.
   - Physics tests (`ecsk-physics.test.ts`, `shell.test.ts`, `perturbation.test.ts`) should be unaffected — they test worker-side math, not rendering.

**Dependencies:** Tasks 1-4 must all be complete.

**Verification:**
```bash
npm run build          # zero errors, zero warnings
npx vitest run         # all tests pass
```
Plus the manual 60-second stability test described above.

**Acceptance criteria:**
- 45-second fade duration runs stable for 60+ seconds with no stall, freeze, or mass vanishing
- GPU usage stays under 50% at 200k particles + bloom + 4K
- No visual regressions (colors, fade, sizes, bloom, HDR, round particles all match pre-migration behavior)
- All tests pass
- Zero build errors and warnings
