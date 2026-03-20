 # GPU Performance Fix Plan — WebGPU Architecture Optimization

## Background: What Went Wrong

The GPU migration (from `gpu-migration-plan.md`) correctly moved per-particle work from CPU to GPU shaders — no per-particle JS runs per frame, fade/color/visibility all computed in the vertex shader. That part is right.

But the migration built on the existing WebGPU/Sprite/TSL stack instead of switching to a leaner rendering path. The result is slower than the old JS-driven pipeline due to three compounding penalties:

| Problem | Current cost | Impact |
|---|---|---|
| **`THREE.Sprite` = quad per particle** | 4 vertices + 2 triangles per particle | 6× geometry vs point primitives. WebGPU caps `gl_PointSize` at 1px, so the migration used Sprite (screen-aligned quads). But `InstancedBufferGeometry` with a tiny 2-triangle quad template achieves the same thing with proper instancing and less overhead. |
| **`needsUpdate = true` re-uploads entire buffer** | Full 16 MB upload at 500K capacity | Three.js r183's WebGPU backend doesn't support partial buffer updates on `InstancedBufferAttribute`. Every `writeBatch()` call triggers a full re-upload of both Float32Arrays, even if only 100 particles were added. |
| **Two independent bloom chains** | ~23 render passes per frame | Particle bloom + ring bloom each do 5-level gaussian blur. At 4K this is massive fill-rate cost. |
| **All slots drawn including dead particles** | `sprite.count = activeCount` draws every filled slot | With a 5s fade and 66K buffer, ~50K slots may contain dead particles (bornTime + persistence < now), but the vertex shader still runs full Weibull fade + HSL→RGB on each before multiplying by `alive=0`. |

These four issues compound: 6× geometry × 16× wasted vertices × full-buffer re-upload × 23 bloom passes = catastrophic performance at scale.

## Strategy

Fix all four problems **within the existing WebGPU architecture** — no renderer swap, no loss of HDR.

## Current Architecture (files to modify)

```
src/rendering/renderer.ts        — SensorRenderer class (WebGPURenderer + PointsNodeMaterial + Sprite + bloom)
src/rendering/particle-ring-buffer.ts  — ParticleRingBuffer (2 vec4 InstancedBufferAttributes, needsUpdate)
src/rendering/particle-ring-buffer.test.ts — unit tests
src/main.ts                      — animate loop, writeBatch, HUD, controls-to-renderer wiring
```

### Preserved (do NOT change):
- `src/physics/` — workers, bridge, shell, perturbation, ECSK physics
- `src/ui/` — controls, screen-info, hardware-info, tooltips
- `src/types/` — type declarations
- HDR pipeline (`_setupHDR`, full/soft/none modes)
- All control wiring in `main.ts` (params → renderer property assignments)
- Ring buffer's write-once semantics, grow(), invalidateFuture(), clear()

---

## Task 1: Replace Sprite with InstancedBufferGeometry + InstancedMesh

**Objective:** Eliminate the `THREE.Sprite` (which has internal overhead for quad expansion and screen alignment) and replace it with an `InstancedBufferGeometry` carrying a minimal 2-triangle quad template plus the two packed vec4 instance attributes. This gives the same variable-size screen-aligned particles but with proper instancing and no Sprite overhead.

**Why this matters:**
`THREE.Sprite` + `PointsNodeMaterial` in Three.js WebGPU is not designed for hundreds of thousands of instances. `Sprite` has internal bookkeeping (matrix updates, raycasting helpers, bounding sphere, auto-scale for camera distance) that is unnecessary for a 2D particle system with an orthographic camera. An `InstancedBufferGeometry` with a simple quad is the standard pattern for GPU instanced particles.

**Files to modify:**
- `src/rendering/renderer.ts`

**What to implement:**

1. **Create a quad template geometry** in `_initGpuMaterial()`:
   ```typescript
   // Unit quad: 2 triangles, vertices at (±0.5, ±0.5, 0)
   const quadGeo = new THREE.InstancedBufferGeometry();
   const verts = new Float32Array([
     -0.5, -0.5, 0,   0.5, -0.5, 0,   0.5,  0.5, 0,
     -0.5, -0.5, 0,   0.5,  0.5, 0,  -0.5,  0.5, 0,
   ]);
   const uvs = new Float32Array([
     0, 0,  1, 0,  1, 1,
     0, 0,  1, 1,  0, 1,
   ]);
   quadGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
   quadGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
   ```

2. **Attach instance attributes** to the geometry:
   ```typescript
   quadGeo.setAttribute('aPackedA', this._ringBuf.packedAttrA);
   quadGeo.setAttribute('aPackedB', this._ringBuf.packedAttrB);
   ```

3. **Use a `THREE.Mesh`** (or `THREE.InstancedMesh`) instead of `THREE.Sprite`:
   ```typescript
   this.particleMesh = new THREE.Mesh(quadGeo, this.material);
   this.particleMesh.frustumCulled = false;
   this.scene.add(this.particleMesh);
   ```
   Set `quadGeo.instanceCount` instead of `sprite.count` to control visible instances.

4. **Adjust the positionNode / sizeNode / TSL** so the vertex shader:
   - Reads `aPackedA`/`aPackedB` as instance attributes
   - Scales the quad vertices by the computed particle size (in clip-space pixels)
   - Translates the quad centre to `(lx, ly, 0)` in world space
   - The UV is already on the quad template, so `gpuCircleOpacity` (circular clipping) works unchanged.

5. **Remove all `THREE.Sprite` references** — `this.sprite` field, `sprite.count` assignments in `updateUniforms()`, etc.

**Note on TSL compatibility:** `PointsNodeMaterial` may not work with `InstancedBufferGeometry`. If so, switch to `NodeMaterial` (or `MeshNodeMaterial`) and handle the quad expansion in the `positionNode` manually — this is actually simpler and gives full control.

**Dependencies:** None — this is the first task.

**Verification:**
```bash
npm run build    # zero errors
npx vitest run   # all existing tests pass
```
Visual verification: particles should look identical (same positions, sizes, colors, bloom). 

**Acceptance criteria:**
- No `THREE.Sprite` in the codebase
- Particles rendered via `InstancedBufferGeometry` with a 2-triangle quad template
- Instance count controlled via `geometry.instanceCount`
- Visual output identical to current (same Weibull fade, HSL→RGB, circular clip, bloom)

---

## Task 2: Partial Buffer Uploads via Direct GPUBuffer Write

**Objective:** Eliminate the full-buffer re-upload caused by `needsUpdate = true`. Instead, write only the newly-added particles directly to the GPU buffer using `device.queue.writeBuffer()`.

**Why this matters:**
At 500K capacity, `needsUpdate = true` uploads 2 × 500K × 16 = 16 MB every frame that has new particles. At 120 Hz with continuous emission, that's ~1.9 GB/s of CPU→GPU copies. The actual new data per frame is typically 50-500 particles × 32 bytes = 1.6-16 KB. That's a 1000× waste.

**Files to modify:**
- `src/rendering/particle-ring-buffer.ts`
- `src/rendering/renderer.ts` (pass backend reference into ring buffer)

**What to implement:**

1. **After `renderer.init()`, extract the WebGPU device** from the backend:
   ```typescript
   const backend = (this.renderer as any).backend;
   const device: GPUDevice = backend.device;
   ```

2. **Pass the device to `ParticleRingBuffer`** (new method or constructor param):
   ```typescript
   this._ringBuf.setGpuDevice(device);
   ```

3. **In `writeBatch()`, after writing to the JS Float32Arrays, do a direct GPU write** instead of setting `needsUpdate`:
   ```typescript
   // Get the underlying GPUBuffer from the Three.js attribute
   // Three.js WebGPU backend stores this on the attribute's internal data
   const gpuBufA = backend.get(this._attrA)?.buffer;  // GPUBuffer
   const gpuBufB = backend.get(this._attrB)?.buffer;

   if (gpuBufA && gpuBufB) {
     // Case 1: contiguous write (no wrap-around)
     if (writeStart + count <= this._capacity) {
       const byteOffsetA = writeStart * 4 * 4; // 4 floats × 4 bytes
       device.queue.writeBuffer(gpuBufA, byteOffsetA, a, writeStart * 4, count * 4);
       device.queue.writeBuffer(gpuBufB, byteOffsetA, b, writeStart * 4, count * 4);
     } else {
       // Case 2: wrap-around — two writes
       const firstChunk = this._capacity - writeStart;
       const byteOffset1 = writeStart * 4 * 4;
       device.queue.writeBuffer(gpuBufA, byteOffset1, a, writeStart * 4, firstChunk * 4);
       device.queue.writeBuffer(gpuBufB, byteOffset1, b, writeStart * 4, firstChunk * 4);
       // Second chunk starts at index 0
       device.queue.writeBuffer(gpuBufA, 0, a, 0, (count - firstChunk) * 4);
       device.queue.writeBuffer(gpuBufB, 0, b, 0, (count - firstChunk) * 4);
     }
     // Do NOT set needsUpdate — we already wrote directly to the GPU
   } else {
     // Fallback: GPUBuffer not yet created (first frame). Use needsUpdate.
     this._attrA.needsUpdate = true;
     this._attrB.needsUpdate = true;
   }
   ```

4. **`clear()` and `invalidateFuture()` still use `needsUpdate = true`** — these are rare operations (user reset / settings change), not per-frame hot paths.

5. **`grow()` still uses `needsUpdate = true`** — the entire buffer is being replaced, so a full upload is necessary.

6. **Important: Three.js backend buffer reference timing.** The GPU buffer is created lazily by Three.js on the first render. The first `writeBatch()` call will happen before any render, so the GPUBuffer won't exist yet. Handle this with the fallback (`needsUpdate = true`). After the first render, the buffer exists and all subsequent writes go directly to the GPU.

**Backend API exploration needed:** The exact path to get the underlying `GPUBuffer` from an `InstancedBufferAttribute` in Three.js r183 WebGPU must be verified. Likely paths:
- `backend.get(attribute).buffer` — Three.js stores backend resources in a WeakMap
- `renderer.backend.get(attribute).buffer`
- Check Three.js source for `WebGPUAttributeUtils` or `WebGPUBackend.get()`

If the Three.js backend doesn't expose the GPU buffer directly, an alternative is to create a standalone `GPUBuffer` with `mappedAtCreation` or `writeBuffer`, and replace the attribute's internal buffer reference. This is more complex but guaranteed to work.

**Dependencies:** Task 1 (geometry change — so attribute references are stable).

**Verification:**
```bash
npm run build
npx vitest run
```
Performance: add a console timer around `writeBatch` to verify that upload time drops from ~1-5ms to ~0.01ms.

**Acceptance criteria:**
- `needsUpdate = true` is NOT set on the per-frame `writeBatch()` path (except first frame fallback)
- New particles are uploaded via `device.queue.writeBuffer()` with byte offset and byte length covering only the newly-written range
- `clear()`, `invalidateFuture()`, and `grow()` still use `needsUpdate = true` (fine for rare ops)
- Visual output identical

---

## Task 3: Consolidate to Single Bloom Pass

**Objective:** Replace the two-pass bloom pipeline (particles + ring, two independent bloom chains, ~23 render passes) with a single bloom pass covering both scenes.

**Why this matters:**
Each bloom chain runs a 5-level gaussian blur pyramid. At 4K that's ~33M pixels × 10 blur passes = 330M pixel shader invocations per bloom chain. Two chains = 660M. A single chain = 330M — 2× reduction in bloom cost, which is the dominant GPU cost when bloom is enabled.

The ring sits at r=2.0 (disk edge) where particles are sparse. There's no visual need for independent bloom parameters — the ring bloom is subtle and overlaps with particle bloom at the edge anyway.

**Files to modify:**
- `src/rendering/renderer.ts` — `_initBloom()` and `render()`

**What to implement:**

1. **Move the disk ring mesh into the main scene** instead of a separate `_ringScene`:
   ```typescript
   this.scene.add(this.diskRing);
   ```

2. **Remove `_ringScene`, ring scene pass, ring bloom chain.** The bloom pipeline becomes:
   ```typescript
   const scenePass = pass(this.scene, this.camera);
   const scenePassColor = scenePass.getTextureNode("output");
   const bloomNode = bloom(scenePassColor, this.bloomStrength, this.bloomRadius, this.bloomThreshold);
   this.pipeline.outputNode = scenePassColor.add(bloomNode);
   ```
   This is one scene render + one bloom chain = ~12 render passes total (vs ~23).

3. **Remove the ring bloom mask** (`smoothstep` world-distance mask, `_frustumHalfW`/`_frustumHalfH` uniforms). No longer needed — ring glow is handled naturally by the single bloom.

4. **Remove `_ringBloomMul`, `_ringBloomNode`, `_ringBloomEnabled`** uniforms and all associated control wiring. Simplify `render()` to a single path.

5. **Keep `ringOpacity` and `ringColor` controls** — these still apply to the ring `MeshBasicMaterial`. The ring is just rendered as part of the main scene now.

6. **Adjust the no-bloom fallback** to a single `renderer.render(this.scene, this.camera)` call.

7. **Update `main.ts`** to remove references to `ringBloomStrength`, `ringBloomRadius`, `ringBloomEnabled` if they were renderer properties. The control panel can keep a single "Bloom" toggle/strength that applies to everything.

**Dependencies:** None (independent of Tasks 1-2).

**Verification:**
```bash
npm run build
npx vitest run
```
Visual: ring should still glow when bloom is enabled. The glow parameters are now shared with particle bloom.

**Acceptance criteria:**
- Single bloom chain in `_initBloom()`
- Half the render passes (~12 vs ~23) when bloom is on
- Ring rendered in main scene
- Visual output nearly identical (ring glow may differ slightly — acceptable)

---

## Task 4: Skip Dead Particles — Alive-Range Draw Optimization

**Objective:** Avoid running the vertex shader on dead particles by tracking the alive range and only drawing particles that could potentially be visible.

**Why this matters:**
With a 5s fade, 6K/s rate, and 66K buffer capacity, at steady state ~30K particles are alive and ~36K are dead but still occupy buffer slots. Every dead particle runs the full vertex shader (Weibull fade → 0, `alive` → 0, size → 0) before being discarded. That's 55% wasted vertex shader invocations.

At 500K capacity with 30K alive, it's 94% wasted.

**Approach:** The ring buffer writes particles in chronological order. `bornTime` increases monotonically (within wrapping). The vertex shader's `alive` test is:
```
alive = step(0, rawAge) × step(FADE_THRESHOLD, fade)
```
where `rawAge = uTime - bornTime` and `fade = exp(-(age/tau)^k)`.

A particle is dead when `bornTime + cutoffDuration < uTime`. Since particles are written chronologically, all dead particles form a contiguous block in the ring buffer between the current write head (newest) and the oldest alive particle.

**Files to modify:**
- `src/rendering/particle-ring-buffer.ts` — add alive-range tracking
- `src/rendering/renderer.ts` — use alive range for `instanceCount`/draw range

**What to implement:**

1. **Add `computeAliveRange(now: number, cutoffDuration: number)` to `ParticleRingBuffer`:**
   ```typescript
   /**
    * Returns {start, count} — the contiguous range of potentially-alive slots.
    * Particles outside this range are guaranteed dead (bornTime + cutoff < now).
    * May overestimate (include some dead particles at the edges) but never
    * underestimates (never skips a particle that could be alive).
    */
   computeAliveRange(now: number, cutoffDuration: number): { start: number; count: number } {
     if (this._totalWritten === 0) return { start: 0, count: 0 };
     if (this._totalWritten <= this._capacity) {
       // Buffer hasn't wrapped yet — all written slots may be alive
       return { start: 0, count: this._totalWritten };
     }
     // Buffer has wrapped. Find the oldest alive particle by scanning
     // from writeHead forward (oldest first) until we find one that's alive.
     const a = this._attrA.array as Float32Array;
     const cutoff = now - cutoffDuration;
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
   ```

2. **In `updateUniforms()`, compute the alive range and set draw limits:**
   ```typescript
   const cutoff = this.fadeSharpness > 0
     ? tau * Math.pow(-Math.log(FADE_THRESHOLD), 1 / this.fadeSharpness) * 1.2
     : this._ringBuf.activeCount; // fallback: draw everything
   const { start, count } = this._ringBuf.computeAliveRange(now, cutoff);
   ```

3. **Set the draw range on the instanced geometry:**
   - If using `InstancedBufferGeometry`, set `geometry.instanceCount = count`.
   - If the alive range is contiguous (no wrap-around), this works directly.
   - If the range wraps around the ring buffer, there are two options:
     a. **Two draw calls** — split into [start, capacity) and [0, wrapEnd). Simple but requires re-setting draw range.
     b. **Accept minor overdraw** — draw `activeCount` instances but the shader already culls dead particles via `alive=0 → size=0`. The optimization here is reducing `instanceCount` from `activeCount` (all filled slots) to `count` (only potentially-alive slots). Even without handling wrap-around, if the buffer has been running long enough, `count << activeCount`.
   
   **Recommended approach:** Option (b) — set `instanceCount = count`, accept that wrap-around may include some dead particles at the seam. The vertex shader already handles them (size=0), and the benefit (drawing 30K instead of 500K) far outweighs the minor seam overhead.

   However, `InstancedBufferGeometry` draws instances starting from index 0. If `start > 0`, we'd need to use `geometry.drawRange` or `gl.drawArraysInstanced(mode, 0, vertCount, count)` with a base-instance offset. Three.js doesn't natively support base-instance. So:

   **Alternative for non-zero start:** Add a uniform `uAliveStart` and `uAliveCount` to the shader. The instance index `gl_InstanceID` (or TSL equivalent) is compared against this range. Instances outside the range get `alive=0` immediately, skipping all other computation:
   ```glsl
   // At the very top of the vertex shader, before any other work:
   int idx = gl_InstanceID;
   bool inRange;
   if (uAliveStart + uAliveCount <= capacity) {
     inRange = idx >= uAliveStart && idx < uAliveStart + uAliveCount;
   } else {
     // Wrap-around: alive range spans [start..capacity) + [0..wrapEnd)
     inRange = idx >= uAliveStart || idx < (uAliveStart + uAliveCount) % capacity;
   }
   if (!inRange) { gl_Position = vec4(0); return; } // or size=0
   ```
   This costs 1 comparison per vertex but saves 100% of the remaining shader work for dead particles.

**Dependencies:** Task 1 (geometry changes affect how instance count is set).

**Verification:**
```bash
npm run build
npx vitest run
```
Add a HUD readout: `hud.drawCount` showing how many instances are actually drawn vs total active. At steady state with 5s fade, 6K/s rate, and 66K buffer, should show ~30K drawn / 66K active.

**Acceptance criteria:**
- Dead particles are not drawn (or are trivially skipped in the vertex shader)
- `instanceCount` reflects alive particle count, not total buffer occupancy
- At steady state, drawn count ≈ rate × persistence (not capacity)
- Visual output identical (alive particles unchanged)

---

## Task 5: Bloom Resolution Cap

**Objective:** Cap bloom resolution to 1080p equivalent regardless of actual display resolution.

**Why this matters:**
Bloom is a low-frequency effect — the gaussian blur immediately destroys pixel-level detail. Running it at 4K (3840×2160 = 8.3M pixels × ~10 blur passes) is pure waste. Capping at 1080p (1920×1080 = 2.1M pixels × ~10 blur passes) gives 4× reduction in bloom fill-rate cost with no visible quality difference.

The existing `bloomQuality: 'low'` mode already halves resolution via a patched `setSize()`. This task changes the default to always cap rather than making it quality-tier dependent.

**Files to modify:**
- `src/rendering/renderer.ts` — `_initBloom()` setSize patch

**What to implement:**

1. **In the `setSize` patch** inside `_initBloom()`, replace the quality-based logic:
   ```typescript
   node.setSize = (w: number, h: number) => {
     // Cap bloom at 1080p equivalent — bloom is low-frequency,
     // higher resolution is wasted fill-rate
     const maxBloomPixels = 1920 * 1080;
     const pixels = w * h;
     if (pixels > maxBloomPixels) {
       const scale = Math.sqrt(maxBloomPixels / pixels);
       origSetSize(Math.round(w * scale), Math.round(h * scale));
     } else {
       origSetSize(w, h);
     }
   };
   ```

2. **Remove the `bloomQuality` / `bloomAutoResolvedQuality` properties** from the renderer and the related control wiring in `main.ts`. Bloom is always capped now — no user toggle needed.

**Dependencies:** Task 3 (bloom consolidation — apply to the single bloom node).

**Verification:**
Visual: bloom should look identical at 1080p. At 4K, bloom quality should be indistinguishable but frame time should measurably decrease.

**Acceptance criteria:**
- Bloom resolution never exceeds ~1080p equivalent
- `bloomQuality` / `bloomAutoResolvedQuality` removed
- Visual output at 1080p: identical
- Visual output at 4K: indistinguishable (bloom is blurry by design)

---

## Implementation Order

```
Task 1: Sprite → InstancedBufferGeometry     (renderer.ts)
Task 2: Partial buffer uploads                (particle-ring-buffer.ts, renderer.ts)
Task 3: Single bloom pass                     (renderer.ts)
Task 4: Alive-range draw optimization         (particle-ring-buffer.ts, renderer.ts)
Task 5: Bloom resolution cap                  (renderer.ts)
```

Tasks 1 and 2 are sequential (geometry must be stable before wiring GPU buffer writes).
Task 3 is independent — can be done before, after, or in parallel with 1-2.
Task 4 depends on Task 1 (needs InstancedBufferGeometry for instanceCount).
Task 5 depends on Task 3 (operates on the single bloom node).

**Recommended order:** 3 → 1 → 2 → 4 → 5 (start with the independent easy win, then the sequential pair, then the optimization that builds on both).

## Expected Performance Impact

| Metric | Current (66K buffer, 4K 120Hz) | After all tasks |
|---|---|---|
| Vertices per frame | 66K × 4 (Sprite quads) = 264K vertices | 30K × 4 (alive quads) = 120K vertices |
| Upload per frame | 2.1 MB (full buffer) | ~16 KB (new particles only) |
| Bloom render passes | ~23 (two chains) | ~12 (one chain, 1080p capped) |
| Dead particle vertex cost | Full shader (~40 ALU ops) | 1 comparison (alive-range skip) |
| Estimated GPU load @ 66K | 55-62% | ~5-10% |
| Particle count before freeze | ~100K | ~500K-1M |

Combined impact: **~10-20× headroom improvement**, with full HDR preserved and zero visual degradation.

## Verification Checklist (all tasks)

After all tasks are complete:
1. `npm run build` — zero errors
2. `npx vitest run` — all tests pass
3. Visual: particles look identical (positions, colors, fade, bloom, circular clip)
4. HDR: full HDR still works on Chrome (rgba16float canvas, extended tone mapping)
5. HUD: FPS at 120 Hz, GPU load < 15% at 66K capacity
6. Ramp test: increase particle rate to 50K/s, persistence to 30s — should handle 500K+ particles without freezing
7. Controls: all sliders still work (beta, persistence, bloom, hue, etc.)

## Files NOT modified by this plan

These files are untouched — all changes are confined to the rendering layer:
- `src/physics/*` — workers, bridge, shell, perturbation, ECSK physics
- `src/ui/*` — controls, screen-info, hardware-info, tooltips  
- `src/types/*` — type declarations
- `index.html`, `package.json`, `tsconfig.json`, `vite.config.ts`
- Source papers and design documents
   }
   getBrightness(index: number): number {
     return (this._attrB.array as Float32Array)[index * 4];
   }
   ```

### In `renderer.ts` (`_initGpuMaterial()`):

8. **Read packed attributes via TSL:**
   ```typescript
   const packedA = instancedDynamicBufferAttribute(this._ringBuf.packedAttrA, "vec4");
   const packedB = instancedDynamicBufferAttribute(this._ringBuf.packedAttrB, "vec4");
   
   // Unpack in shader:
   const aLx       = packedA.x;
   const aLy       = packedA.y;
   const aBornTime = packedA.z;
   const aHue      = packedA.w;
   const aBri      = packedB.x;
   const aEps      = packedB.y;
   const aSize     = packedB.z;
   ```
   Then use these aliases exactly where the old attribute names were used.

9. **Update `updateUniforms()` auto-ring-color** to use `getHue(i)` / `getBrightness(i)` instead of `hueAttribute.array[i]` / `brightnessAttribute.array[i]`.

### In tests:

10. **Update `particle-ring-buffer.test.ts`** to verify packed layout: read `packedAttrA.array[slot*4+2]` for bornTime, etc. Update the `needsUpdate`/version tests to check 2 attrs instead of 6. Remove tests for individual attribute getters that no longer exist.

**Dependencies:** None (can be done in parallel with Task 1).

**Verification:**
```bash
npm run build    # zero errors
npx vitest run   # all tests pass
```
Manually verify:
- Particles appear at correct positions with correct colors
- Fade, bloom, HDR all work
- No visual difference from before

**Acceptance criteria:**
- Only 2 `InstancedBufferAttribute`s exist (both vec4, `DynamicDrawUsage`)
- `writeBatch()` sets `needsUpdate` on 2 attrs, not 6
- `clear()`, `invalidateFuture()`, `grow()` all work with packed layout
- Shader reads unpacked components from vec4s
- Auto-ring-color sampling works via stride-aware access
- All tests pass
- No visual regressions

---

## Task 3: Share Fade Computation Between Size and Color Nodes

**Objective:** Compute the Weibull fade and alive flag ONCE per vertex, shared between `sizeNode` and `colorNode`. This eliminates the most expensive per-vertex duplication.

**Context:**

In `_initGpuMaterial()` of `src/rendering/renderer.ts`, the fade is computed independently in both nodes:

**`sizeNode`** (line ~777):
```typescript
const sizeNode = Fn(() => {
  const rawAge = uTime.sub(aBornTime);                              // ← computed here
  const age = max(float(0.0), rawAge);                              // ← and here
  const fade = exp(pow(age.div(uTau), uFadeSharpness).negate());    // ← and here (EXPENSIVE)
  const alive = step(float(0.0), rawAge).mul(step(float(FADE_THRESHOLD), fade));
  return aSize.mul(uHitBaseSize).mul(alive);
})();
```

**`colorNode`** (line ~795):
```typescript
const colorNode = Fn(() => {
  const rawAge = uTime.sub(aBornTime);                              // ← DUPLICATE
  const age = max(float(0.0), rawAge);                              // ← DUPLICATE
  const fade = exp(pow(age.div(uTau), uFadeSharpness).negate());    // ← DUPLICATE (EXPENSIVE)
  // ... then 2× tslHslToRgb, mix, scale, clamp ...
})();
```

`exp(pow(...))` is the most expensive operation here — two transcendental function evaluations per vertex, done twice = 4 transcendental ops per vertex instead of 2.

**TSL node sharing:** When TSL node expressions are defined outside `Fn()` blocks and referenced in multiple `Fn()` blocks, Three.js **should** emit them once in the generated WGSL and reuse the result. This is the standard TSL pattern for shared computations. Define fade/alive as top-level nodes, then reference in both sizeNode and colorNode.

**Files to modify:**
- `src/rendering/renderer.ts` — refactor `_initGpuMaterial()`

**What to implement:**

1. **Move fade computation outside both Fn() blocks:**
   ```typescript
   // ── Shared per-vertex fade (computed once, used by size + color) ──
   const rawAge = uTime.sub(aBornTime);
   const age = max(float(0.0), rawAge);
   const fade = exp(pow(age.div(uTau), uFadeSharpness).negate());
   const alive = step(float(0.0), rawAge).mul(step(float(FADE_THRESHOLD), fade));
   ```

2. **Simplify sizeNode:**
   ```typescript
   const sizeNode = aSize.mul(uHitBaseSize).mul(alive);
   ```
   No `Fn()` wrapper needed — it's a simple expression using the shared `alive` node.

3. **Simplify colorNode** to use shared `fade` and `alive`:
   ```typescript
   const colorNode = Fn(() => {
     // SDR path
     const sdrLightness = uLFloor.add(aBrightness.mul(uLRange));
     const sdrSaturation = uSFloor.add(aBrightness.oneMinus().mul(uSRange));
     const sdrRgb = tslHslToRgb(aHue, sdrSaturation, sdrLightness);
     const sdrScale = fade.mul(uBri);  // ← uses shared `fade`

     // HDR path
     const isHdr = step(float(0.5), uHdrMode);
     const hdrSat = min(float(1.0), uSFloor.add(uSRange));
     const hdrRgb = tslHslToRgb(aHue, hdrSat, float(0.5));
     // ... eps→nits mapping ...
     const hdrScale = fade.mul(linearRelSDR).mul(uBri.div(SDR_BRI_REF));  // ← shared `fade`

     const rgb = mix(sdrRgb, hdrRgb, isHdr);
     const scale = mix(sdrScale, hdrScale, isHdr);
     const finalScale = min(scale.mul(uAutoGain), uPeakScale);
     return rgb.mul(finalScale);
   })();
   ```

**Performance impact:** Eliminates 2 transcendental ops per vertex (exp + pow). At ~4 cycles each on a GPU ALU, this is ~8 cycles saved per vertex × 66K vertices = ~528K cycles/frame. **This is a guaranteed ~30% reduction in vertex shader cost** with zero trade-offs.

**Risk:** TSL might NOT share the node computation if both Fn() blocks reference it — it might inline it twice. **Verify by inspecting the generated WGSL** in Chrome DevTools → Application → WebGPU → Shader Modules. If the fade appears twice, we need to use a TSL `varying()` to explicitly pass the computed value from vertex to fragment stages, or restructure as a single Fn() that returns both size and color.

**Dependencies:** Task 2 (if done first, the attribute unpacking changes are in place). Can also be done independently — just reference the correct attribute names.

**Verification:**
```bash
npm run build    # zero errors
npx vitest run   # all tests pass
```
Manually verify:
- Fade curve unchanged (exponential dimming, not abrupt)
- Colors identical to before
- All HDR modes work

**Acceptance criteria:**
- `exp(pow(...))` appears in shader code only once, shared between size and color
- `alive` flag computed once, used by both nodes
- No visual regressions
- Build passes

---

## Task 4: Use `select()` for SDR/HDR and Gate Dead Particles

**Objective:** (a) Use TSL `select()` to skip the unused HDR or SDR color path, and (b) gate the entire colorNode output by `alive` so dead particles produce `vec3(0)` with minimal work.

**Context:**

After Task 3, the `colorNode` still has two problems:

1. **Both SDR and HDR paths always execute.** The shader computes:
   ```typescript
   const sdrRgb = tslHslToRgb(aHue, sdrSaturation, sdrLightness);  // EXPENSIVE
   const hdrRgb = tslHslToRgb(aHue, hdrSat, float(0.5));           // EXPENSIVE
   const rgb = mix(sdrRgb, hdrRgb, isHdr);  // evaluates BOTH operands
   ```
   In SDR mode (uHdrMode = 0, isHdr = 0), the HDR `tslHslToRgb()` call is pure waste. Each `tslHslToRgb()` involves 5 `step()` + 6 `mul()` + 3 `add()` = ~14 ALU ops.

2. **Dead particles (alive=0) still run full color computation.** After Task 3, they contribute `vec3(0)` via `size=0` → zero fragments, but the colorNode still computes 1-2× HSL→RGB for nothing.

**`select()` is already imported** in renderer.ts (from `"three/tsl"`). In TSL, `select(condition, ifTrue, ifFalse)` generates WGSL `select()` which is a ternary — the GPU MAY optimize it to skip the unchosen branch (especially when the condition is warp-uniform, which `uHdrMode` is — it's the same for ALL vertices).

**Files to modify:**
- `src/rendering/renderer.ts` — update `colorNode` in `_initGpuMaterial()`

**What to implement:**

1. **Replace `mix()` with `select()` for SDR/HDR branching:**
   ```typescript
   const isHdr = uHdrMode.greaterThan(float(0.5));  // returns bool node
   
   // SDR path (always needed — HDR path reuses it in "soft" mode):
   const sdrLightness = uLFloor.add(aBrightness.mul(uLRange));
   const sdrSaturation = uSFloor.add(aBrightness.oneMinus().mul(uSRange));
   const sdrRgb = tslHslToRgb(aHue, sdrSaturation, sdrLightness);
   const sdrScale = fade.mul(uBri);

   // HDR path:
   const hdrSat = min(float(1.0), uSFloor.add(uSRange));
   const hdrRgb = tslHslToRgb(aHue, hdrSat, float(0.5));
   // ... eps→nits ...
   const hdrScale = fade.mul(linearRelSDR).mul(uBri.div(SDR_BRI_REF));

   // select(condition, ifTrue, ifFalse) — condition is uniform (same for all verts)
   const rgb = select(isHdr, hdrRgb, sdrRgb);
   const scale = select(isHdr, hdrScale, sdrScale);
   ```

   **Note on `select()` behavior:** WGSL `select(f, t, cond)` is defined as evaluating both operands (like a ternary, not a branch). However, because `isHdr` is derived from a uniform (`uHdrMode`), the GPU compiler can constant-fold the unused branch away — this is a standard optimization for uniform-driven conditionals. The best case is the compiler eliminates the dead HSL→RGB entirely; the worst case is the same as `mix()` (no regression).

2. **Gate the entire colorNode output by `alive`:**
   ```typescript
   const finalScale = min(scale.mul(uAutoGain), uPeakScale);
   return rgb.mul(finalScale).mul(alive);  // ← dead → vec3(0,0,0)
   ```
   
   This has two benefits:
   - For dead particles with `alive = 0`: the final multiply produces zero, and the GPU compiler can potentially skip upstream computation via dead-code elimination
   - For alive particles: `alive = 1.0`, so it's a no-op multiply (free)

3. **Consider restructuring as a single TSL function** if TSL doesn't optimize well with separate nodes. If profiling shows the `select()` doesn't help (WGSL still evaluates both), restructure the colorNode to early-multiply by alive before doing HSL→RGB:
   ```typescript
   // Fallback: If select() doesn't help, compute minimal color for dead particles
   // aliveFade = alive * fade (0 for dead, normal fade for alive)
   const aliveFade = alive.mul(fade);
   // HSL→RGB only produces meaningful output when aliveFade > 0
   // But GPU will still evaluate it — this is just a correctness gate
   ```

**Performance impact:**
- `select()` with uniform condition: potential elimination of one `tslHslToRgb()` for 100% of vertices in SDR mode = ~14 ALU ops saved per vertex → **~25% color node reduction for SDR users**
- `alive` gating: dead particles produce zero with no additional cost for alive particles. Compiler benefit is driver-dependent.
- Combined with Task 3 (shared fade): total vertex shader improvement of **~50-60%** vs current implementation

**Dependencies:** Task 3 (shared fade must be in place so `fade` and `alive` are available outside Fn blocks).

**Verification:**
```bash
npm run build    # zero errors
npx vitest run   # all tests pass
```
Manually verify:
- SDR colors unchanged (toggle `select` vs `mix` to A/B compare)
- HDR modes (soft, full) still produce correct colors
- Dead particles no longer contribute visible color (they shouldn't have before either, but verify)
- Fade curve unchanged

**Acceptance criteria:**
- `select()` used instead of `mix()` for SDR/HDR path selection
- Color output gated by `alive` — dead particles produce `vec3(0)`
- SDR-only users don't pay for HDR HSL→RGB computation (if compiler optimizes)
- No visual regressions in any mode
- Build passes

---

## Task 5: Manual Validation — Performance and Visual Correctness

**Objective:** Verify that the shader and upload optimizations produce measurable GPU improvement, and confirm no visual regressions.

**Context:**

After Tasks 1-4:
- Upload commands reduced from 6 to 2 per frame (Task 2)
- Vertex shader fade computed once instead of twice (Task 3)
- Unused HDR path skipped via `select()`, dead particles gated by `alive` (Task 4)
- HUD and back-pressure bugs fixed (Task 1)

**What to validate (manual):**

1. **Build and test suite:**
   ```bash
   npm run build          # zero errors, zero warnings
   npx vitest run         # all tests pass
   ```

2. **Visual regression checks:**
   - Fade curve: smooth exponential dimming at sharpness 1.0 (default)
   - All three sharpness values (0.5, 1.0, 2.0) produce correct curves
   - Colors: amber (low ω_eff) to violet (high ω_eff)
   - Auto-brightness: toggle on/off — brightness normalizes, no flicker
   - Round particles: soft circles; square: sharp quads
   - Bloom: particle + ring glow (both independently toggleable)
   - Ring auto-color: ring matches average particle hue
   - HDR modes: none, soft, full (if display supports)
   - Freeze/unfreeze: particles stop aging when frozen
   - Reset: screen clears instantly and refills
   - Settings change (β slider): old particles clear, new ones appear (no flash-to-black)

3. **HUD correctness:**
   - "On screen" shows ~rate × persistence (e.g., ~30K at 6K/s × 5s)
   - "Buffer fill" shows "66K / 66K" at steady state  
   - Neither grows without bound

4. **GPU utilization (Task Manager → Performance → GPU):**
   - Default settings (no bloom, 5s fade, ~6K rate, round particles) — note NVIDIA GPU %
   - Enable bloom — note change
   - Set fade to 45s, max rate — run for 60+ seconds, verify stable (no stall/freeze)
   - Compare to pre-fix baseline: NVIDIA was at ~55-62% without bloom

5. **45-second fade stress test:**
   - Fade 45s, birth rate max, bloom on, round particles on
   - Run for 120 seconds continuously
   - Must NOT stall, freeze, or show mass particle vanishing
   - Ring buffer `grow()` messages in console as buffer expands (expected and correct)

6. **Inspect generated WGSL (optional but valuable):**
   - Chrome DevTools → Application → WebGPU → Shader Modules
   - Verify `exp`/`pow` appears once (not twice) in vertex shader — confirms Task 3
   - Check if `select()` produces a branch or evaluates both operands — informs whether Task 4's `select()` is effective

**Dependencies:** Tasks 1-4 must all be complete.

**Acceptance criteria:**
- Zero build errors and warnings
- All tests pass
- No visual regressions in any mode
- HUD readouts show correct, bounded values
- 45-second fade runs stable for 120+ seconds
- GPU utilization noticeably lower than pre-fix baseline
