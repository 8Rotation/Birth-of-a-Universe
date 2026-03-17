# GPU Performance Fix Plan — Shader & Upload Optimization

## Summary

After the GPU migration (Tasks 1-4 in `gpu-migration-plan.md`), the simulation shows ~55-62% GPU utilization even without bloom, at only ~66K buffer capacity on an RTX 3060 Laptop at 4K 120Hz. The CPU bottleneck is fixed (45s-fade no longer stalls), but the GPU shader implementation has avoidable waste that eats the freed headroom.

### Root cause comparison

| Factor | Old (JS) pipeline | Current GPU pipeline | Optimal GPU |
|---|---|---|---|
| Vertices drawn/frame | ~30K (alive only) | 66K (alive + dead) | 66K (inherent to ring buffer) |
| GPU upload commands/frame | 2 attrs | **6 attrs** | **2 packed vec4 attrs** |
| Fade computation per vertex | 1× (in JS) | **2×** (sizeNode + colorNode dupl) | **1× shared** |
| HSL→RGB evaluations per vertex | 1 (JS picks mode) | **2 always** (SDR + HDR, mix) | **1** (select) |
| Dead particle vertex cost | 0 (not drawn) | Full shader (exp/pow + 2× HSL) | Minimal (mul by alive) |

The duplicate fade + dual HSL→RGB make each vertex ~3× more expensive than necessary. That on 2.2× more vertices = **~6× the GPU shader work vs optimal**. Total upload bandwidth (~1.8 MB vs ~0.7 MB) is negligible on a GPU with ~300 GB/s memory bandwidth — the real cost is 6 separate upload commands (CPU-side validation + GPU synchronization per command) and the bloated vertex shader.

### What the fixes do

1. **Pack 6 attributes → 2 vec4 attributes** — reduces upload command count from 6 to 2 (matching old pipeline), eliminating 4× per-frame GPU sync overhead
2. **Compute fade once, share between sizeNode and colorNode** — eliminates duplicate `exp(pow())` = ~30% vertex ALU reduction, guaranteed
3. **Use `select()` for SDR vs HDR path** — eliminates dead-code HSL→RGB call in SDR mode (99% of users). `select` is already imported in renderer.ts.
4. **Gate color output by `alive`** — dead particles produce `vec3(0)` immediately, giving the GPU compiler the signal to skip work for zero-contribution vertices

Combined estimated impact: ~4-6× reduction in vertex shader cost. Dead particles still cost some ALU (ring buffer design — vertices 0..activeCount are all drawn), but the per-vertex work drops from ~40 ALU ops to ~12 for dead and ~25 for alive.

Additionally, two bugs in `main.ts`:
- **HUD "On screen" shows `totalWritten`** (monotonically increasing lifetime counter, 138K+) instead of actual alive count
- **Back-pressure compares `totalWritten` against `capacity`** — permanently maxed once buffer fills

---

## Task 1: Fix HUD Readouts and Back-Pressure Logic

**Objective:** Fix the two bugs in `main.ts` where `totalWritten` (monotonic lifetime counter) is used instead of `activeCount` (current buffer occupancy).

**Context:**

`ParticleRingBuffer` (in `src/rendering/particle-ring-buffer.ts`) has three count properties:
- `totalWritten: number` — monotonically increasing, never decreases, counts every particle ever written. After 2 minutes at 6K/s this is ~720K even though the buffer only holds 66K.
- `capacity: number` — current buffer size (starts at `initialGpuCapacity`, doubles on grow)
- `activeCount: number` — `Math.min(totalWritten, capacity)` — slots containing real data (may be alive or dead)

The HUD readout (line ~674 of `main.ts`) shows:
```typescript
hud.visible = String(renderer.ringBuffer.totalWritten);  // BUG: shows 138K+ and climbing
```

The back-pressure logic (lines ~551-553 of `main.ts`):
```typescript
if (renderer.ringBuffer.totalWritten > renderer.ringBuffer.capacity * 0.8) {       // BUG
  const fillRatio = renderer.ringBuffer.totalWritten / renderer.ringBuffer.capacity; // BUG
  effectiveRate *= Math.exp(-0.5 * (fillRatio - 0.8));
}
```
Once `totalWritten` exceeds `capacity` (which happens quickly and permanently), `fillRatio` grows without bound (e.g., 720K / 66K ≈ 10.9), making back-pressure `Math.exp(-0.5 * 10.1) ≈ 0.006` — effectively clamping rate to the 100/s floor forever.

The buffer fill HUD (line ~711):
```typescript
hud.bufferFill = `${(renderer.ringBuffer.totalWritten / 1000).toFixed(0)}K / ${(renderer.ringBuffer.capacity / 1000).toFixed(0)}K`;
```
Shows e.g. "138K / 66K" which is nonsensical.

**Files to modify:**
- `src/main.ts` — fix 3 lines

**What to implement:**

1. **HUD "On screen" (line ~674):** Change to show a meaningful count. The ideal metric is an estimate of visually-alive particles: `rate × persistence`. Since we already have `arrivalRateSmooth` and `params.persistence`, use:
   ```typescript
   const estAlive = Math.min(
     Math.round(arrivalRateSmooth * params.persistence),
     renderer.ringBuffer.activeCount
   );
   hud.visible = String(estAlive);
   ```
   This shows ~30K when rate=6K and fade=5s, matching what the user sees on screen.

2. **Back-pressure (lines ~551-553):** The intent is to throttle when the ring buffer is running out of room for *new* particles before old ones expire. The correct metric is: how full is the alive window relative to capacity?
   ```typescript
   const aliveEstimate = Math.min(arrivalRateSmooth * params.persistence * CUTOFF_MARGIN, renderer.ringBuffer.activeCount);
   const fillRatio = aliveEstimate / renderer.ringBuffer.capacity;
   if (fillRatio > 0.8) {
     effectiveRate *= Math.exp(-0.5 * (fillRatio - 0.8));
   }
   ```
   This correctly triggers back-pressure only when alive particles approach capacity.

3. **Buffer fill HUD (line ~711):** Show active count (capped at capacity) vs capacity:
   ```typescript
   hud.bufferFill = `${(renderer.ringBuffer.activeCount / 1000).toFixed(0)}K / ${(renderer.ringBuffer.capacity / 1000).toFixed(0)}K`;
   ```

**Dependencies:** None.

**Verification:**
```bash
npm run build    # zero errors
npx vitest run   # all tests pass
```
Then manually verify:
- HUD "On screen" shows a plausible number (~rate × persistence)
- Buffer fill shows "66K / 66K" at steady state (not "138K / 66K")
- Particle birth rate doesn't get permanently stuck at 100/s after the buffer fills

**Acceptance criteria:**
- HUD "On screen" shows estimated alive count, not lifetime total
- Buffer fill HUD never exceeds "capacity / capacity"
- Back-pressure triggers based on alive-to-capacity ratio, not lifetime-to-capacity
- No behavioral changes to rendering — visual output identical

---

## Task 2: Pack 6 Attributes → 2 vec4 Attributes

**Objective:** Reduce per-frame GPU upload commands from 6 to 2 by packing particle data into two vec4 `InstancedBufferAttribute`s, matching the old pipeline's upload command count.

**Context:**

The old JS pipeline had 2 attributes (`posAttr: vec3`, `colorAttr: vec3`) = 2 GPU upload commands per frame. The new pipeline has 6 separate attributes = 6 upload commands per frame. Each upload command has non-trivial CPU-side overhead (validation, binding, synchronization) in the WebGPU backend. At 120 Hz, that's 720 upload commands/sec vs the old 240.

The total upload bandwidth is similar (~1.8 MB vs ~1.4 MB), and GPU memory bandwidth (300+ GB/s on a 3060) makes this negligible. **The issue is command overhead, not bytes.** Packing 7 floats into 2 vec4s eliminates 4 upload commands per frame.

Current 6 attributes (7 floats per particle):
```
posAttr   (vec2): lx, ly           — 2 floats
bornAttr  (f32):  arrivalTime      — 1 float
hueAttr   (f32):  hue [0, 360]     — 1 float
briAttr   (f32):  brightness [0,1] — 1 float
epsAttr   (f32):  eps              — 1 float
sizeAttr  (f32):  hitSize [0, 1]   — 1 float
```

Packed into 2 vec4s (8 floats per particle, 1 float padding):
```
attrA (vec4): [lx, ly, arrivalTime, hue]
attrB (vec4): [brightness, eps, hitSize, 0.0]  // .w unused padding
```

At 66K capacity: 2 × 66K × 16 bytes = ~2.1 MB per frame (slightly more bytes due to vec4 padding, but 2 uploads instead of 6 — net win from reduced command overhead).

**Files to modify:**
- `src/rendering/particle-ring-buffer.ts` — replace 6 separate attrs with 2 vec4 attrs
- `src/rendering/particle-ring-buffer.test.ts` — update tests for new attr layout
- `src/rendering/renderer.ts` — update `_initGpuMaterial()` to read from packed attrs

**What to implement:**

### In `particle-ring-buffer.ts`:

1. **Replace the 6 private attribute members** with 2:
   ```typescript
   // Packed: [lx, ly, bornTime, hue] per particle
   private _attrA: THREE.InstancedBufferAttribute;
   // Packed: [brightness, eps, hitSize, 0] per particle
   private _attrB: THREE.InstancedBufferAttribute;
   ```

2. **Constructor:** Allocate two `Float32Array`s of `capacity × 4` each. Fill bornTime sentinel: `_attrA.array[i * 4 + 2] = -1e9` for all slots. Both use `DynamicDrawUsage`.

3. **`writeBatch()`:** Write to packed positions:
   ```typescript
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
   this._attrA.needsUpdate = true;
   this._attrB.needsUpdate = true;
   ```

4. **Update `clear()`:** Fill bornTime slot (`_attrA.array[i*4+2]`) with sentinel. Only 2 attrs to mark dirty.

5. **Update `invalidateFuture()`:** Scan `_attrA.array[i*4+2]` for bornTime > cutoff.

6. **Update `grow()`:** Grow 2 arrays instead of 6. Fill sentinel in new slots of attrA.

7. **Update public getters** — expose the 2 packed attributes:
   ```typescript
   get packedAttrA(): THREE.InstancedBufferAttribute { return this._attrA; }
   get packedAttrB(): THREE.InstancedBufferAttribute { return this._attrB; }
   ```
   
   **Keep backward-compatible getters** that return views/proxies if existing code (like `updateUniforms()` auto-ring-color sampling) reads `hueAttribute.array` and `brightnessAttribute.array` directly. These now need to sample from packed arrays with stride 4:
   ```typescript
   // For auto-ring-color in updateUniforms(), provide stride-aware access:
   getHue(index: number): number {
     return (this._attrA.array as Float32Array)[index * 4 + 3];
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
