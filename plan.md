# Plan: Bloom Performance Fix & Load Readout Improvements

## Summary

The simulation's high idle GPU usage (~45% in Task Manager) is caused by two full-screen bloom passes (particle bloom + ring bloom) running every frame regardless of whether there are visible particles. The bloom pipeline executes multiple gaussian blur operations on black textures — pure waste when idle.

**Root cause confirmed:** In `src/rendering/renderer.ts`, when `useBloom = true` (default on mid/high/ultra hardware), `this.pipeline.render()` executes every frame at L911. Each bloom pass does multiple full-screen gaussian blur operations. With 0 particles, the particle bloom blurs a black texture. The ring bloom similarly wastes GPU when ring opacity is 0.

**Key observation explained:** Increasing particle count lowers GPU% because the bloom cost is fixed (full-screen blur) while particle rendering is cheap (instanced sprites). More particles = more CPU work (physics workers) but same GPU cost. The ratio shifts, making GPU% appear lower relative to total system load.

**CPU/GPU split readout already exists** — `cpuLoad` and `gpuLoad` are separate HUD fields in `controls.ts` and `main.ts`. No changes needed there.

---

## Task 1: Add Init Timing Breakpoints

**Goal:** Quantify where load time is spent during startup so future optimizations target the right bottleneck. Diagnostic only — no functional changes.

**Context:** `main()` in `src/main.ts` (starts ~L80) runs three sequential awaits:
1. `screenDetector.init()` (~250-500ms, rAF-based refresh rate measurement)
2. `hwDetector.detect(renderPixels)` (~50ms, CPU bench + GPU adapter query internally parallelized)
3. `renderer.init(screenInfo)` (variable — WebGPU pipeline compilation, bloom node creation)

Steps 1 and 2 already have `console.log` timing. Step 3 (renderer init) and subsequent steps (controls creation, bridge setup) are untimed.

**Files to modify:**
- `src/main.ts` — Add `performance.now()` timing around:
  - `renderer.init(screenInfo)` call (after the existing `const t2 = performance.now()`)
  - `createSensorControls()` call
  - `PhysicsBridge` construction
  - Pattern: `const tN = performance.now(); /* await step */ console.log(\`[main] StepName: ${(performance.now() - tN).toFixed(0)} ms\`);`

**Acceptance criteria:**
- Console output shows millisecond timing for each init phase: screen detection, hardware detection, renderer init, controls creation, bridge setup
- No functional changes — diagnostic only
- Existing timing logs remain unchanged

---

## Task 2: Skip Bloom Passes When Nothing to Bloom

**Goal:** Eliminate ~40% idle GPU usage by not running 2 full-screen multi-pass bloom operations when they produce no visible output. This is the single highest-impact change in the entire plan.

**Context:** In `src/rendering/renderer.ts`:
- Lines 557-613: Two bloom passes are set up — particle bloom (L567-576) and ring bloom (L577-586). They use TSL `bloom()` nodes from `three/addons/tsl/display/BloomNode.js`.
- Line 911: `render()` method chooses between bloom pipeline path (`this.pipeline.render()`) and lightweight no-bloom path based on `this.useBloom && this.pipeline`.
- The bloom pipeline **always** runs both bloom passes even when `this.sprite.count === 0` (no particles visible) or ring opacity is 0.
- The no-bloom fallback path (L921-932) is already clean and correct: just two `this.renderer.render()` calls with conditional ring overlay.

**The render path selection block currently looks like (L911):**
```typescript
if (this.useBloom && this.pipeline) {
  try {
    this.pipeline.render();
  } catch (e) {
    // ... fallback to async
  }
} else {
  // Lightweight no-bloom path
  const r = this.renderer as any;
  r.autoClear = true;
  this.renderer.render(this.scene, this.camera);
  if (this._ringScene && this.ringOpacity > 0) {
    r.autoClear = false;
    this.renderer.render(this._ringScene, this.camera);
    r.autoClear = true;
  }
}
```

**Implementation:** Add a condition before the bloom pipeline path. When there are no visible particles (`this.sprite.count === 0`), fall through to the lightweight no-bloom path regardless of `useBloom`. The lightweight path already handles ring overlay correctly.

Change the condition at L911 from:
```typescript
if (this.useBloom && this.pipeline) {
```
to:
```typescript
const needsBloom = this.useBloom && this.pipeline && this.sprite.count > 0;
if (needsBloom) {
```

This is the minimal change. The ring still renders via the lightweight fallback path when particles are absent.

**Files to modify:**
- `src/rendering/renderer.ts` — One-line change in the render path selection block at ~L911

**Acceptance criteria:**
- With 0 particles and bloom enabled: GPU % in Task Manager drops from ~45% to near 0%
- With particles visible and bloom enabled: bloom renders normally (no visual regression)
- Ring still renders correctly when particles are absent but ring opacity > 0
- GPU load readout in HUD reflects the drop
- No console errors or warnings

---

## Task 3: Zero-Strength Bloom Bypass

**Goal:** When user sets both bloom intensity sliders to 0, skip the expensive bloom pipeline even if `bloomEnabled` is true.

**Context:** After Task 2, the bloom pipeline still runs when `sprite.count > 0` even if `bloomStrength = 0` and `ringBloomStrength = 0`. The pipeline does full-screen gaussian blurs that produce zero visible output — pure waste.

In `src/rendering/renderer.ts`, the render path (modified by Task 2) will look like:
```typescript
const needsBloom = this.useBloom && this.pipeline && this.sprite.count > 0;
```

**Implementation:** Extend the condition to also check bloom strength values:
```typescript
const needsBloom = this.useBloom && this.pipeline
  && this.sprite.count > 0
  && (this.bloomStrength > 0 || this.ringBloomStrength > 0);
```

`this.bloomStrength` and `this.ringBloomStrength` are public properties on `SensorRenderer` that are set from params every frame in `main.ts`'s animate loop (~L1200).

**Files to modify:**
- `src/rendering/renderer.ts` — Extend the `needsBloom` condition (same block as Task 2)

**Acceptance criteria:**
- Setting both bloom strength sliders to 0 causes GPU load to drop to lightweight-path level
- Increasing either bloom slider above 0 restores bloom rendering immediately
- No visual regression when bloom strengths are non-zero

**Dependency:** Task 2 must be completed first (this extends its condition).

---

## Task 4: Parallelize Screen and Hardware Detection ✅

**Goal:** Reduce startup wall-clock time by overlapping independent benchmark work with the ~300ms rAF screen measurement.

**Context:** In `src/main.ts` L88-99, screen detection and hardware detection run sequentially:
```
1. await screenDetector.init()        // 250-500ms (rAF measurement)
2. await hwDetector.detect(renderPixels) // ~50ms (needs renderPixels from step 1)
3. await renderer.init(screenInfo)     // variable (needs screenInfo from step 1)
```

Inside `HardwareDetector.detect()` (`src/ui/hardware-info.ts` L556-560), the GPU adapter request and CPU benchmark already run in parallel via `Promise.all`. Neither depends on `renderPixels` — only the final capability score calculation does (`renderPixels` is used for the screen penalty divisor at L435-443).

**Implementation approach:** Split `HardwareDetector.detect()` into two phases:
1. `startBenchmarks()` — returns a Promise that kicks off CPU bench + GPU adapter query (no `renderPixels` needed). Stores intermediate results internally.
2. `finalize(renderPixels)` — awaits internal benchmarks if not done, applies screen penalty, computes budget. Returns `HardwareInfo`.
3. Keep `detect(renderPixels)` as a backward-compatible wrapper that calls both.

Then in `main.ts`, change:
```typescript
const screenInfo = await screenDetector.init();  // 300ms
const hwInfo = await hwDetector.detect(renderPixels);  // 50ms sequential
```
to:
```typescript
const hwDetector = new HardwareDetector();
hwDetector.startBenchmarks();  // fire immediately (no await)
const screenInfo = await screenDetector.init();  // 300ms (benchmarks run in parallel)
const hwInfo = await hwDetector.finalize(renderPixels);  // instant if benchmarks done
```

**Files to modify:**
- `src/ui/hardware-info.ts` — Split `detect()` into `startBenchmarks()` + `finalize(renderPixels)`. The `detect()` method calls both for backward compat.
  - Key lines: L556-560 (the existing `Promise.all` for GPU + CPU), L435-443 (screen penalty), L565-569 (budget interpolation)
- `src/main.ts` — Reorder init calls: fire benchmarks before screen detection, finalize after

**Acceptance criteria:**
- Total startup time reduced by ~50ms (visible in console timing from Task 1)
- `hwDetector.detect(renderPixels)` still works as before (backward-compatible wrapper)
- All hardware info values unchanged
- No race conditions or undefined values

---

## Task 5: Defer Bloom Pipeline Compilation ✅

**Goal:** Show first frame faster by deferring bloom shader compilation to after the first render.

**Context:** In `src/rendering/renderer.ts` L557-613, the bloom pipeline (two `bloom()` nodes, `RenderPipeline`, shader compilation) is constructed during `init()`. WebGPU shader compilation for bloom nodes may block the first visible frame for hundreds of milliseconds.

The simulation could render its first frame using the lightweight no-bloom path (already working), then compile bloom in the background and enable it once ready.

**Implementation approach:** In `renderer.init()`:
1. Move the bloom pipeline setup (L557-613) into a separate `async _initBloom()` method
2. Set `this.useBloom = false` and `this._ready = true` before bloom compiles
3. Call `this._initBloom()` without await — let it resolve in background
4. `_initBloom()` does the try/catch bloom setup, then sets `this.useBloom = true` on success
5. The Task 2 condition (`needsBloom`) already handles `this.pipeline` being null gracefully

**Files to modify:**
- `src/rendering/renderer.ts` — Extract bloom setup into `_initBloom()`, call it non-blocking after `_ready = true`. Key lines: L557-613 (bloom pipeline creation), L608 (`this.useBloom = true`), L619 (`this._ready = true`)

**Acceptance criteria:**
- First frame renders faster (no bloom compilation blocking)
- Bloom appears within ~1 second of startup (not user-perceptible delay)
- No visual glitches during the transition from no-bloom to bloom
- If bloom compilation fails, graceful fallback to no-bloom (existing behavior preserved)

**Dependency:** Task 2 should be completed first (the `needsBloom` guard handles null pipeline).

---

## Task 6: Update GPU Load Tooltip ✅

**Goal:** Make the GPU load readout tooltip accurately describe what's measured and why bloom is the primary driver.

**Context:** Current GPU load measurement in `src/main.ts` (~L1218-1221):
```typescript
const renderStart = performance.now();
renderer.render();
renderMsAccum += performance.now() - renderStart;
```
This uses wall-clock timing around `renderer.render()`, which captures CPU-side submission time + sync overhead, not true GPU execution time. WebGPU command submission returns quickly — GPU work runs asynchronously. However, the bloom pipeline's synchronous `pipeline.render()` does block CPU proportionally to GPU work, making wall-clock timing directionally accurate for bloom-heavy workloads.

After Tasks 2-3, the measurement becomes much more accurate because:
- When bloom is bypassed, wall-clock time correctly shows near-zero (matching Task Manager)
- When bloom is active, wall-clock time tracks GPU cost (bloom dominates)

The existing tooltip in `src/ui/tooltips.ts` (`gpuLoad` key in `READOUT_TOOLTIPS`, ~L939) should be updated to explain the measurement method and bloom's role.

**Files to modify:**
- `src/ui/tooltips.ts` — Update the `gpuLoad` entry in `READOUT_TOOLTIPS`. Clarify that it measures render submission time as a fraction of frame budget, and note that bloom is the primary GPU cost driver. Mention that the measurement becomes a close proxy for true GPU load when bloom is active.

**Acceptance criteria:**
- GPU load tooltip accurately describes what's measured (render submission time, not true GPU execution)
- Tooltip mentions bloom as primary cost driver
- After Tasks 2-3 are implemented, GPU load readout drops to near-zero with 0 particles (matching Task Manager)

---

## Task 7: Bloom Quality Dropdown (Optional) ✅

**Goal:** Give users direct control over bloom GPU cost via a quality setting. Lower priority — only needed if bloom is too expensive even when actively rendering particles.

**Context:** The two bloom passes are the single largest GPU expense. A quality dropdown could offer:
- **High:** Full-resolution bloom (current default)
- **Low:** Half-resolution bloom (~4x cheaper)
- **Auto:** Choose based on hardware tier from `ComputeBudget`

The TSL `bloom()` node from Three.js may support a resolution parameter. If not, an alternative is to render the bloom input at half resolution via a separate render target.

**Files to modify:**
- `src/ui/controls.ts`:
  - Add `bloomQuality: 'auto' | 'high' | 'low'` to `SensorParams` interface (~L69 area, Bloom section)
  - Add default value `bloomQuality: 'auto'` in params initialization (~L300)
  - Add dropdown in the Bloom folder: `bloomFolder.add(params, "bloomQuality", ['auto', 'high', 'low']).name("Bloom quality")`
  - Add to `conditionalProps` so it's only shown when `bloomEnabled` is true
- `src/rendering/renderer.ts`:
  - Add `bloomQuality` property
  - Apply resolution scale to bloom passes based on quality setting
  - May require recreating bloom nodes or using `BloomNode`'s resolution parameter
- `src/ui/tooltips.ts`:
  - Add tooltip for `bloomQuality` control

**Acceptance criteria:**
- Low quality bloom reduces GPU load by ~50-75% with visible but acceptable quality reduction
- Auto selects appropriate quality for hardware tier
- Switching quality doesn't crash or require page reload
- High quality matches current visual output exactly

**Note:** This task is lower priority. Task 2 (conditional bypass) solves the idle cost problem. This is only needed if bloom is too expensive even when actively rendering many particles.

---

## Relevant Files Reference

| File | Role | Key Lines |
|------|------|-----------|
| `src/rendering/renderer.ts` | Bloom pipeline setup, render loop, bloom uniforms | L557-613 (bloom setup), L900-935 (render), L890 (bloom uniforms) |
| `src/main.ts` | Startup sequence, animate loop, HUD updates, GPU timing | L80-110 (init), L1025+ (animate), L1226-1280 (HUD), L1218-1221 (GPU timing) |
| `src/physics/physics-bridge.ts` | Worker coordination, CPU load calculation | L146-159 (CPU load EMA), L82 (cpuLoad getter) |
| `src/physics/physics-worker.ts` | Per-tick timing reported to bridge | L142 (tick start), L158 (elapsed), L167 (tickMs in response) |
| `src/ui/controls.ts` | SensorParams interface, HUDData interface, slider definitions | Full file |
| `src/ui/tooltips.ts` | Tooltip text for all controls and readout fields | ~L930 (cpuLoad), ~L939 (gpuLoad) |
| `src/ui/hardware-info.ts` | ComputeBudget, HardwareDetector.detect(), benchmarks | L556-560 (Promise.all), L435-443 (screen penalty) |
| `src/ui/screen-info.ts` | ScreenDetector.init(), refresh rate measurement | L537-540 (parallel init) |

## Verification Checklist

1. **Task 2:** Open simulation → bloom on, 0 particles → Task Manager GPU should be <5% (was ~45%)
2. **Task 2:** Add particles → bloom visuals identical to current behavior
3. **Task 3:** Set both bloom strength sliders to 0 → GPU load drops to lightweight-path levels
4. **Task 4:** Compare console timing before/after → startup ~50ms faster
5. **Task 5:** First visible frame appears faster; bloom fades in within ~1s
6. **Task 6:** GPU load tooltip accurately describes measurement method
7. **General:** Increasing particle count raises CPU load; GPU load stays flat unless bloom is on

## Key Decisions

- **CPU/GPU split readout already exists** — `cpuLoad` and `gpuLoad` are already separate HUD fields. No work needed.
- **Wall-clock GPU timing is acceptable** for now — WebGPU timestamp queries are browser-dependent and complex. The bloom bypass fix makes wall-clock measurement accurate enough.
- **Bloom bypass is the single highest-impact change** — Task 2 alone solves the reported 45% idle GPU issue.
- **Priority order:** Tasks 1-3 (must-do) → Tasks 4-5 (startup optimization) → Task 6 (tooltip polish) → Task 7 (optional power-user feature)
