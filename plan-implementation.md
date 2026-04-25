# Birth-of-a-Universe — Implementation Plan

> **Purpose.** This document turns [plan.md](plan.md) (audit findings) into concrete,
> self-contained tasks. Each task is sized so a fresh agent with an empty context can
> complete it in a single ~170k-token session **without needing to read other tasks or
> re-discover information already in the task card**. Every task lists exactly which
> files the agent must read, what to change, and how to verify.
>
> **How to use.** Assign one task (or sub-task) per agent invocation. Start each session
> by having the agent read: (a) this plan's § "Shared context for every agent"; (b) the
> specific task card; (c) the source files it names. That is all the context required.
>
> **Finding IDs** such as `PHYS-01` refer to entries in [plan.md](plan.md). Agents do
> **not** need to read plan.md — everything they need is reproduced in the task card.

---

## Shared context for every agent

**Every task card begins by telling the agent to read this section.** Copy the
paragraphs below verbatim into the first instruction of every fresh chat.

### Project snapshot

- **Stack:** TypeScript 5.9, Vite 7, Vitest 4, Three.js 0.183 (WebGPU + TSL), lil-gui
  0.21, `@webgpu/types`. Windows dev host.
- **Build:** `npm run build` (tsc + vite build). Dev: `npm run dev`. Tests: `npm test`
  (Vitest, currently Node env — see BUILD-03).
- **Entry flow in [src/main.ts](src/main.ts):**
  hardware detect → screen detect → renderer init → `PhysicsBridge` (N Web Workers) →
  optional GPU compute emitter → controls → animate loop.
- **Physics:** Einstein–Cartan–Sciama–Kibble bounce cosmology. CPU path runs in workers
  ([src/physics/shell.ts](src/physics/shell.ts) inside
  [src/physics/physics-worker.ts](src/physics/physics-worker.ts), coordinated by
  [src/physics/physics-bridge.ts](src/physics/physics-bridge.ts)).
  GPU path runs the same physics in WGSL
  ([src/compute/particle-emit.wgsl](src/compute/particle-emit.wgsl) driven by
  [src/compute/compute-emitter.ts](src/compute/compute-emitter.ts), dispatched from
  `main.ts` animate loop).
- **Ring buffer:** [src/rendering/particle-ring-buffer.ts](src/rendering/particle-ring-buffer.ts).
  CPU path writes via `writeBatch`; GPU path writes via `copyBufferToBuffer` plus
  `advanceWriteHead`/`recordGpuWrite`.
- **Renderer:** [src/rendering/renderer.ts](src/rendering/renderer.ts) — Three.js TSL,
  instanced quad mesh, bloom post-process, HDR mode support.

### Invariants that MUST hold across any change

1. **CPU and GPU emission paths are numerically equivalent.** If you touch physics or
   emission, mirror the change on the other path or explicitly mark the task as
   CPU-only / GPU-only and coordinate with a follow-up task.
2. **The 144-byte params struct layout is shared** between TypeScript (hand-packed via
   `DataView` in [src/compute/compute-emitter.ts](src/compute/compute-emitter.ts), see
   `_uploadParams`) and WGSL (declared struct at the top of
   [src/compute/particle-emit.wgsl](src/compute/particle-emit.wgsl)). Any field add /
   rename / reorder must update **both** at identical byte offsets.
3. **`PARTICLE_STRIDE = 8` floats per particle** is shared across workers, main thread,
   and renderer. 8 floats on the wire; 2×vec4 = 8 floats on GPU.
4. **Perturbation coefficients are centralised on the main thread** in
   `PhysicsBridge` and broadcast to workers each tick. Workers must not generate their
   own coefficients.
5. **Tests currently run in the Node environment.** Several tests (screen-info,
   particle-ring-buffer) touch `window` anyway and pass by accident. Do not change
   this until BUILD-03 is done.

### House rules

- **No speculative refactors.** Only change what the task asks for.
- **Always run `npm test` and `npm run build` before declaring a task done**, unless
  the task explicitly skips build (pure-doc / pure-python tasks only).
- **Do not schedule withdrawn findings** (PHYS-07, REPO-04, REPO-05). If you
  encounter them, leave the code alone.
- **Private Three.js API** is accessed via `(renderer as any).backend.device` /
  `backend.get(attr).buffer`. Breaks on Three bumps. RING-05 will centralise this;
  until then, mirror the existing pattern.
- **Absolute paths on Windows:** use the workspace root
  `c:\Users\rvona\Documents\Birth-of-a-Universe\` for file edits.

---

## Task index

| Epic | Task | Title | Priority | Depends on |
|---|---|---|---|---|
| A | A1 | GPU emission accumulator (PHYS-01) | 🔴 | — |
| A | A2 | Params struct layout assertion test (GPU-01) | 🟠 | — |
| A | A3 | Playwright GPU test harness (GPU-02 / TEST-01) | 🔴 | — |
| A | A4a | Perturbation normalisation: CPU (PHYS-02 CPU) | 🔴 | A3 optional |
| A | A4b | Perturbation normalisation: GPU (PHYS-02 GPU) | 🔴 | A4a |
| B | B1 | `main.ts` lifecycle & disposables (LIFE-01/02/03/09) | 🟠 | — |
| B | B2 | `controls.ts` teardown (LIFE-04, LIFE-05) | 🟠 | — |
| B | B3 | `screen-info.ts` + `hardware-info.ts` teardown (LIFE-06, LIFE-08) | 🟠 | — |
| B | B4 | Renderer disposal (LIFE-07) | 🟠 | — |
| B | B5 | Init race fixes (INIT-01, INIT-02) | 🟠 | B1 |
| C | C1 | Ring-buffer bornTime/arrivalTime split (PHYS-03, RING-03) | 🟠 | — |
| C | C2 | Ring-buffer getter bounds & `grow()` destroy (RING-01, RING-02) | 🟡 | — |
| C | C3 | `invalidateFuture` populated-range scan (RING-04) | 🟡 | — |
| C | C4 | Three.js backend access helper (RING-05) | 🟡 | — |
| D | D1 | Worker restart ceiling (WORK-01) | 🟠 | — |
| D | D2 | Multi-worker coherence test (WORK-02 / TEST-02) | 🟠 | E2 |
| D | D3 | Typed worker messages (WORK-03, WORK-04) | 🟡 | — |
| D | D4 | Coefficient RNG session-seed mix (PHYS-04) | 🟠 | — |
| E | E1 | Vite base path + target (BUILD-01, BUILD-02) | 🟠 | — |
| E | E2 | Vitest jsdom environment (BUILD-03) | 🟠 | — |
| E | E3 | Strengthen unit tests (TEST-03, TEST-04, TEST-05) | 🟠 | E2 |
| F | F1 | Perturbation polish (PHYS-05, PHYS-06, PHYS-08, PHYS-09) | 🟡 | — |
| F | F2 | GPU micro-perf (GPU-03, GPU-04) | 🟡 | — |
| F | F3 | TSL `.d.ts` tightening (BUILD-05, BUILD-06) | 🟡 | — |
| F | F4 | Accessibility (A11Y-01/02/03) | 🟡 | — |
| F | F5 | CSS cleanup (CSS-01/02/03) | 🟡 | — |
| F | F6 | Repo hygiene (REPO-01/02/03) | 🟡 | — |

Suggested execution order: **E1 → E2 → B1..B5 in parallel → A1 → A2 → C1 → D1/D3/D4 → A3 → A4a → A4b → E3 → D2 → C2/C3/C4 → F1..F6**.

---

# Epic A — Emission correctness (CPU/GPU parity)

## Task A1 — GPU emission accumulator (PHYS-01)

**Priority:** 🔴 **Estimated diff:** ~30 LOC in one file + 1 new test.
**Files to read (in order):**

1. [src/main.ts](src/main.ts) — focus on lines ~820–880 (GPU compute dispatch in the
   animate loop) and the `bridge.restart()` path (search for `bridge.restart` and
   `gpuCompute`).
2. [src/physics/shell.ts](src/physics/shell.ts) — lines 370–420, the CPU accumulator
   pattern inside `tryEmitParticles` (search `accumulator`).
3. [src/compute/compute-emitter.ts](src/compute/compute-emitter.ts) — check what
   parameters the GPU emitter takes (esp. the `count` / bounces-per-dispatch field).
4. [src/compute/compute-emitter.test.ts](src/compute/compute-emitter.test.ts) — to
   understand the test style and make sure you don't break pinned counts.

### Problem

On the GPU path the animate loop does roughly:

```ts
const bounceCount = Math.floor(gpuEffectiveRate * dt);
```

This throws away the sub-1 remainder each frame. At 60 Hz with `particleRate = 100/s`,
1.67 floors to 1 → ~60/s observed (40% loss). At 144 Hz, 0.69 floors to 0 → **zero
particles** until `rate*dt ≥ 1`.

The CPU path already solves this with an accumulator (see `shell.ts` ~L380):

```ts
this.accumulator += dt * effectiveRate;
const count = Math.floor(this.accumulator);
this.accumulator -= count;
```

### Instructions

1. Add a module-scope (or renderer-scope) `gpuEmitAccumulator = 0` in
   [src/main.ts](src/main.ts).
2. Replace the `Math.floor(gpuEffectiveRate * dt)` computation with:
   ```ts
   gpuEmitAccumulator += gpuEffectiveRate * dt;
   const bounceCount = Math.floor(gpuEmitAccumulator);
   gpuEmitAccumulator -= bounceCount;
   ```
3. Reset `gpuEmitAccumulator = 0` anywhere the CPU accumulator is reset. Search for
   `bridge.restart` / physics-reset callbacks and mirror. Also reset when the user
   toggles GPU compute off/on (look for the `gpuCompute` toggle handler).
4. If `gpuEffectiveRate` can be 0 or negative, guard with
   `if (gpuEffectiveRate > 0) { ... }` before the accumulator update; otherwise leave
   the accumulator unchanged (do **not** decay it).
5. Add a tiny unit test at
   `src/compute/compute-emitter.test.ts` (append at the end) that exercises the
   accumulator pattern directly. Because the real loop is inside `main.ts`, the
   cleanest approach is to extract the 3-line accumulator into a helper inside
   `main.ts` (e.g. `export function stepEmitAccumulator(state, rate, dt): number`)
   and test that helper:
   - 60 ticks at dt = 1/60, rate = 100 → total count ≈ 100 (±1).
   - 144 ticks at dt = 1/144, rate = 100 → total count ≈ 100 (±1).
   - 60 ticks at dt = 1/60, rate = 0 → total count 0 and state unchanged.

   *Do not* change main.ts exports in a way that leaks DOM-dependent symbols; put the
   helper next to the existing pure helpers at the top of `main.ts`, or create a new
   module `src/compute/emit-accumulator.ts` with just the pure function + reset.

### Acceptance

- `npm test` passes; the new helper test shows the two rate-conservation cases above.
- `npm run build` passes.
- Manual sanity: run `npm run dev`, toggle GPU compute on with rate = 100/s, confirm
  emission visibly matches CPU rate (before the fix the GPU was visibly sparser).

### Risks

- **Parity (🔗).** This only affects the GPU path; the CPU path already has an
  accumulator. Do not touch `shell.ts`.
- Double-check no existing test asserts a specific low `bounceCount`.

---

## Task A2 — Params struct layout assertion test (GPU-01)

**Priority:** 🟠 **Estimated diff:** 1 new test file (~120 LOC), no source changes.
**Files to read:**

1. [src/compute/compute-emitter.ts](src/compute/compute-emitter.ts) — `_uploadParams`
   method (around L340–L400). Read the full method; note every `setFloat32`,
   `setUint32`, `setInt32` call and its byte offset.
2. [src/compute/particle-emit.wgsl](src/compute/particle-emit.wgsl) — the `Params`
   struct at the top (~L15–L62).

### Problem

The TypeScript packer and the WGSL struct are maintained by hand at identical byte
offsets. Any field rename or reorder on one side silently corrupts the uniform. There
is no test catching this.

### Instructions

Create `src/compute/params-layout.test.ts`:

1. **Harvest WGSL offsets.** `import params from "./particle-emit.wgsl?raw"` (see
   [src/types/wgsl-raw.d.ts](src/types/wgsl-raw.d.ts) for the `?raw` module
   declaration — confirm Vite serves this in test env; if not, read the file with
   `fs.readFileSync(path.join(__dirname, "particle-emit.wgsl"), "utf8")`).
2. Parse the `struct Params { ... }` block with a regex:
   - Field line form: `    fieldName: f32,` (or `u32`, `i32`, `vec3<f32>`, `vec4<f32>`).
   - Compute WGSL std140/std430 offsets manually with the
     [WebGPU uniform buffer layout rules](https://www.w3.org/TR/WGSL/#memory-layouts):
     `f32`/`u32`/`i32` are 4-byte aligned; `vec3<f32>` is 16-byte aligned and
     consumes 16 bytes; `vec4<f32>` is 16-byte aligned and consumes 16 bytes. After
     the last field, round the struct size up to 16.
   - Record an ordered list of `{ name, offset, size }`.
3. **Harvest TS offsets.** Read `compute-emitter.ts` source as text and parse every
   `view.setFloat32(X, ...)` / `setUint32(X, ...)` / `setInt32(X, ...)` inside
   `_uploadParams`. Extract `(offset, kind)` pairs in source order.
4. **Assert:**
   - Total TS write range spans exactly the WGSL struct size (should be 144).
   - Every WGSL field offset is covered by a TS write (allow `vec3`/`vec4` to
     correspond to 3/4 contiguous setFloat32 calls).
   - No TS write targets an offset outside the struct.
5. Also add a positive smoke test: instantiate a minimal mock (see existing
   `compute-emitter.test.ts` for the mock GPUDevice / buffer pattern), call
   `_uploadParams` with a sentinel config, then read back the `ArrayBuffer` passed to
   `writeBuffer` and spot-check three known offsets.

### Acceptance

- New test file passes under `npm test`.
- If you rename one field in either file as a manual smoke test, the test fails with
  a clear message pointing at the mismatched offset. (Revert the rename before
  committing.)

### Risks

- The WGSL std140 layout rules are tricky for `vec3` (padded to 16). Confirm actual
  offsets against a short runtime log: temporarily log `view.byteLength` and the
  highest offset written, ensure both are 144.

---

## Task A3 — Playwright GPU test harness (GPU-02 / TEST-01)

**Priority:** 🔴 (enables other Priority-1 work) **Estimated diff:** ~200 LOC
config + 1 test port.
**Files to read:**

1. [src/compute/gpu-cpu-validation.test.ts](src/compute/gpu-cpu-validation.test.ts) —
   entire file; the comparison logic at L160–L200 is the body that must run under a
   real GPU.
2. [package.json](package.json) — existing test scripts, dependencies.
3. [vite.config.ts](vite.config.ts) and [vitest.config.ts](vitest.config.ts).
4. [.github/workflows/deploy.yml](.github/workflows/deploy.yml) — to model a second
   workflow job.

### Problem

The GPU-vs-CPU validation comparison is currently behind `test.skip(...)` because
Vitest runs in Node where WebGPU is unavailable. As a result, nothing actually
catches CPU/GPU divergence.

### Instructions

**Step 1 — Add Playwright as a dev dependency.**
```
npm install --save-dev @playwright/test
npx playwright install --with-deps chromium
```

**Step 2 — Create `playwright.config.ts`** at the repo root:

```ts
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests-e2e",
  timeout: 60_000,
  use: {
    headless: true,
    launchOptions: {
      args: [
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--use-vulkan=swiftshader",
        "--use-gl=swiftshader",
        "--enable-webgpu-developer-features",
      ],
    },
  },
  webServer: {
    command: "npm run dev -- --port 5179",
    port: 5179,
    reuseExistingServer: !process.env.CI,
  },
});
```

**Step 3 — Create `tests-e2e/gpu-validation.spec.ts`.** Load a dedicated test page
(e.g. `/tests-e2e/harness.html`) that exposes a global `runGpuCpuValidation()`
returning `{ cpuCounts: number[], gpuCounts: number[], maxRelErr: number }`. The spec
asserts `maxRelErr < tolerance`.

The simplest harness: a new `tests-e2e/harness.html` that imports
`compute-emitter.ts` and a CPU copy of the same physics, runs K dispatches with a
fixed seed, reads back the GPU buffer, compares to the CPU result, and assigns to
`window.__result__`. Playwright evaluates `() => window.__result__`.

**Step 4 — Port the skipped body** from
[src/compute/gpu-cpu-validation.test.ts](src/compute/gpu-cpu-validation.test.ts#L169-L188)
into the harness. Keep the original Vitest file untouched (it still exercises
numeric helpers on Node).

**Step 5 — Wire into `package.json`:**

```json
"scripts": {
  "test": "vitest run",
  "test:e2e": "playwright test"
}
```

**Step 6 — Add a new CI job** to `.github/workflows/deploy.yml` (or a sibling file
`.github/workflows/e2e.yml`) that:

- Runs on `ubuntu-latest`.
- `npm ci && npx playwright install --with-deps chromium && npm run build && npm run test:e2e`.
- Uploads `playwright-report/` on failure.

Do **not** gate deploy on this job yet (mark it non-blocking). Allow a follow-up to
flip it to required after it stabilises.

### Acceptance

- `npm run test:e2e` succeeds locally on Windows (chromium with
  `--use-vulkan=swiftshader` typically works).
- The CI job runs and reports pass/fail, with artifacts on failure.
- The skipped Vitest test remains skipped with a comment pointing at the Playwright
  spec.

### Risks

- SwiftShader WebGPU support has been flaky historically; if chromium can't create a
  device, fall back to `--enable-unsafe-webgpu --use-gl=angle --use-angle=vulkan`.
- Headless chromium on Windows sometimes needs `--disable-gpu-sandbox`.

---

## Task A4a — Perturbation factorial precision: CPU (PHYS-02 CPU half)

**Priority:** 🔴 **Estimated diff:** ~40 LOC + test.
**Files to read:**

1. [src/physics/perturbation.ts](src/physics/perturbation.ts) — full file (302 lines).
   Focus on `evaluatePerturbationFast` (~L216 onward) and the `(2m)!` factor (~L239).
2. [src/physics/perturbation.test.ts](src/physics/perturbation.test.ts) — full.

### Problem

`evaluatePerturbationFast` computes the spherical-harmonic normalisation
`sqrt((2l+1)/(4π) · (l-m)!/(l+m)!)` by forming `(2m)!` directly:

```ts
let fac = 1;
for (let i = 1; i <= 2 * m; i++) fac *= i;
```

In JS `number` this is safe up to `m ≤ 85`, but the GPU mirror (f32) breaks at
`m ≈ 13`. Before the GPU fix (A4b) we want the CPU path to be **robust and
deterministic at high m** so it can serve as the oracle.

The algebra already maintains a running factor across the `l` loop — we should
compute the normalisation incrementally instead of materialising `(2m)!`. Specifically
for fixed `m`, as `l` increments, the squared normalisation scales by
`(2l+1)/(2l-1) · (l-m)/(l+m)` — multiply one factor per `l` step.

### Instructions

1. In `evaluatePerturbationFast`, precompute the initial squared normalisation at
   `l = m` analytically, then update it by
   `norm2 *= ((2l+1)/(2l-1)) * ((l-m)/(l+m))` when moving from `l → l+1`.
2. For `l = m` initialisation, use
   `norm2_lm = (2m+1) / (4π · (2m)!)`. Instead of `(2m)!`, keep
   `logFactorial2m` accumulated as `Σ log(i)` up to `2m` and compute
   `norm2_lm = exp(log(2m+1) - log(4π) - logFactorial2m)`. This never overflows.
3. Do **not** change any call sites or public signatures.
4. **Testing (add to [src/physics/perturbation.test.ts](src/physics/perturbation.test.ts)):**
   - For `m = 0..8` and a fixed direction, assert the old and new implementations
     agree to within `1e-10` (relative). Before deleting the old code path, keep
     `evaluatePerturbation` (the naive reference, see PHYS-08) as the oracle. If it is
     deleted, inline a textbook Legendre recurrence in the test file as a
     pure-function oracle.
   - Add a test at `m = 20, l = 20` that the new function returns a finite non-NaN
     number (the old factorial-based code would overflow f32 but still work in JS).
   - Golden-vector test: pin 8 sample values at `(theta, phi, l, m)` tuples to 6
     significant digits so future refactors catch drift.

### Acceptance

- `npm test` passes, all new cases green.
- No caller changes required.

### Risks

- **Do not touch the WGSL yet.** A4b does that. Divergence is temporary and acceptable
  between A4a and A4b; A3 (Playwright harness) should **not** be made blocking on
  A4a — run it only after A4b.

---

## Task A4b — Perturbation factorial precision: GPU mirror (PHYS-02 GPU half)

**Priority:** 🔴 **Estimated diff:** ~30 LOC WGSL.
**Depends on:** A4a merged; ideally A3 available to run the real comparison.
**Files to read:**

1. The final, merged [src/physics/perturbation.ts](src/physics/perturbation.ts) from
   A4a — specifically the rewritten `evaluatePerturbationFast`.
2. [src/compute/particle-emit.wgsl](src/compute/particle-emit.wgsl) — the
   Legendre/perturbation block at ~L180–L230.

### Problem

Mirror A4a in WGSL. The CPU uses `logFactorial` and `exp`; WGSL has `log` and `exp`
so the same transform applies directly.

### Instructions

1. Replace the inline `(2m)!` loop with either:
   - The incremental-update approach exactly mirroring A4a, accumulating
     `logFactorial` via `log(f32(i))` in a `for (var i = 1u; i <= 2u * m; i = i + 1u)`
     loop, then `exp(log(2m+1) - log(4π) - logFactorial)`.
   - OR a precomputed `logFactorial` array uploaded in a storage buffer if the `m`
     bound is known (avoid this — raises GPU-01 layout risk).
2. Keep identifier names and variable layout consistent with A4a so reviewers can
   diff the two side-by-side.
3. Verify float precision by running the A3 Playwright harness: the CPU/GPU max
   relative error at `m = 8, lMax = 8` should be ≤ `1e-4` (f32 floor).

### Acceptance

- `npm run test:e2e` passes the GPU-vs-CPU comparison within tolerance.
- `npm run build` passes.

### Risks

- f32 log/exp loses some precision vs. f64 CPU; tolerance must reflect that. If
  divergence exceeds `1e-3` relative at `m ≤ 8`, reconsider the algorithm rather than
  widening tolerance.

---

# Epic B — Teardown & lifecycle

## Task B1 — `main.ts` lifecycle & disposables (LIFE-01, LIFE-02, LIFE-03, LIFE-09)

**Priority:** 🟠 **Estimated diff:** ~60 LOC in one file + small test.
**Files to read:**

1. [src/main.ts](src/main.ts) — full file (948 lines). Focus on:
   - ~L376–L399 `visibilitychange` listener (LIFE-01).
   - ~L401–L404 mobile `blur`/`focus` listeners (LIFE-02).
   - ~L446 `animate` loop entry (LIFE-03 — unconditional `requestAnimationFrame`).
   - ~L305 `setOverridesCallback` (LIFE-09 — no try/catch).

### Problem

- Event listeners are added with no symmetric removal. If `main()` ever re-runs (HMR,
  test re-init), listeners duplicate.
- `visibilitychange` calls `bridge.flushPipeline()` without guarding `bridge` ≠
  undefined — crash risk during init failure.
- The animate loop has no stop flag.
- User-provided `overrides` callback can throw into the main loop.

### Instructions

1. Introduce an `AbortController` named `appAbort` near the top of `main()`. Pass
   `{ signal: appAbort.signal }` as the third arg to every `addEventListener` call
   (`visibilitychange`, `blur`, `focus`, and any in this file). This auto-removes
   them when `appAbort.abort()` is called.
2. Add a `let animateRunning = true;` flag; `animate` starts with
   `if (!animateRunning) return;` **before** the `requestAnimationFrame` line.
3. Guard the `visibilitychange` handler: `if (bridge) bridge.flushPipeline();`.
4. Wrap the `overrides` callback in `try { ... } catch (e) { console.error(...); }`.
5. Export a `dispose()` function from `main.ts` that:
   - sets `animateRunning = false`,
   - calls `appAbort.abort()`,
   - calls `bridge?.dispose?.()`, `renderer?.dispose?.()`,
     `computeEmitter?.dispose?.()`, `controls?.dispose?.()`, `hwDetector?.dispose?.()`,
     `screenDetector?.dispose?.()` (add stubs where missing — see B2/B3/B4).
6. **Do not** auto-call `dispose()` on unload unless you verify it can't interrupt a
   critical frame. Safer: expose it as `window.__disposeApp__` for tests only.

### Testing

- Add `src/main-lifecycle.test.ts` (Node env is fine): import only the pure helpers,
  if any, and assert that `dispose()` is exported. Full integration testing belongs
  to the E2E task and is out of scope here.
- Manual: run `npm run dev`, in devtools console run `__disposeApp__()`, confirm no
  console errors and that interacting with UI no longer emits rAF logs.

### Acceptance

- `npm run build` passes.
- `npm test` passes.
- Grep shows zero `addEventListener(` without `signal:` in `main.ts`.

### Risks

- HMR may not respect abort signals cleanly. If HMR breaks during dev, wrap the
  handler bodies in `if (appAbort.signal.aborted) return;` as belt-and-braces.

---

## Task B2 — `controls.ts` teardown (LIFE-04, LIFE-05)

**Priority:** 🟠 **Estimated diff:** ~80 LOC.
**Files to read:**

1. [src/ui/controls.ts](src/ui/controls.ts) — full file (1890 lines; budget ~60%
   of context). Focus on:
   - ~L63 OLED theme `<style>` element (LIFE-04).
   - ~L1173–L1205 mobile panel overlay + `orientationchange` + media-query
     listeners (LIFE-05).
   - ~L1230 `role="button"` divs and ~L1319 tooltip overlay (not in scope here —
     leave for F4).

### Instructions

1. Add a private `#disposables: Array<() => void> = []` to the main controls class.
   Helper `#addListener(target, type, fn, opts)` that registers the listener and
   pushes `() => target.removeEventListener(type, fn, opts)` onto `#disposables`.
2. Route **every** `addEventListener` in this file through the helper — including
   `matchMedia(...).addEventListener("change", ...)` and `window.addEventListener(
   "orientationchange", ...)`.
3. The OLED theme style element: keep a handle, push `() => el.remove()` onto
   `#disposables`.
4. The mobile panel overlay element: same pattern.
5. Implement `public dispose(): void` that calls every disposable in LIFO order and
   clears the array. Safe to call twice.
6. Add an idempotency guard: re-calling constructor on the same DOM should call
   `dispose()` on the prior instance. If constructor is only called once in the real
   app, document this as a contract and only enforce on re-entry.

### Testing

- BUILD-03 (E2) must be done first for DOM-dependent assertions. If E2 is not yet
  done, add a jsdom-only test guarded by `typeof document !== "undefined"` in the
  imports (lazy import) — skip otherwise.
- Test: construct controls, call `dispose()`, assert `document.head.querySelectorAll(
  "style[data-oled-theme]")` length is 0 (tag the style with a data attribute as
  part of this task).

### Acceptance

- No `addEventListener(` in the file outside the helper.
- `npm test && npm run build` green.

### Risks

- Large file; mechanical edits risk missing sites. Grep at the end:
  `grep -n "addEventListener\|matchMedia" src/ui/controls.ts` and verify every hit is
  either inside the helper or a call to the helper itself.

---

## Task B3 — `screen-info.ts` + `hardware-info.ts` teardown (LIFE-06, LIFE-08)

**Priority:** 🟠 **Estimated diff:** ~40 LOC each.
**Files to read:**

1. [src/ui/screen-info.ts](src/ui/screen-info.ts) — full (768 lines). Focus on
   ~L606–L610 (DPR `matchMedia` listeners) and ~L427 `singleMeasurementPass()`.
2. [src/ui/hardware-info.ts](src/ui/hardware-info.ts) — full (862 lines). Focus on
   ~L164 CPU bench tight loop.

### Instructions

1. Mirror the disposables pattern from B2: private array + helper.
2. Route every `matchMedia(...).addEventListener` through the helper.
3. `dispose()` clears all listeners and sets an `#aborted = true` flag that any
   long-running loop checks.
4. **Wall-clock cap (LIFE-08):** wrap the bench tight loops with `performance.now()`
   guards. If elapsed > 2× the budget, abort early and return whatever value was
   measured along with a `degraded: true` flag in the result. Document the cap in a
   comment.

### Acceptance

- `npm test && npm run build` pass.
- Manual: throttle the tab to 6× CPU in devtools, confirm init still completes in
  <10 s and does not hang.

### Risks

- Some DPR detection logic relies on `matchMedia` firing exactly once; confirm the
  abort path still sets the initial DPR before early-returning.

---

## Task B4 — Renderer bloom disposal (LIFE-07)

**Priority:** 🟠 **Estimated diff:** ~20 LOC.
**Files to read:**

1. [src/rendering/renderer.ts](src/rendering/renderer.ts) — focus on ~L330–L395
   (private backend access) and ~L555 (bloom node construction). Also the class's
   `dispose()` if one exists; search for it.

### Instructions

1. Keep a handle `private _bloomPass` to the bloom node.
2. In (or add) `public dispose(): void`:
   - call `this._bloomPass?.dispose?.()` (TSL nodes expose `.dispose()` — verify
     against the installed Three version in `node_modules/three/src/nodes/`),
   - set to null,
   - also dispose any render targets created for post-processing.
3. Make `dispose()` idempotent.

### Acceptance

- `npm run build` passes.
- Manual: run app, call `renderer.dispose()` from a devtools breakpoint, reload —
  no console errors or warnings on re-init.

### Risks

- Three TSL API may not expose `dispose()` on every node type. If not available,
  null out references and rely on GC; document this in a comment linking to the
  Three issue tracker.

---

## Task B5 — Init race fixes (INIT-01, INIT-02)

**Priority:** 🟠 **Depends on:** B1.
**Files to read:**

1. [src/main.ts](src/main.ts) — L85–L146 (screenDetector.onChange before renderer)
   and L355–L365 (GPU compute deferred across two rAFs).

### Instructions

1. **INIT-01.** Before `screenDetector.onChange` fires its first callback, ensure the
   renderer is constructed. Options:
   - Defer the `onChange` subscription until after `renderer = new Renderer(...)`.
   - OR queue the callback payload and flush once renderer is ready.
   Pick the simpler one (deferring subscription).
2. **INIT-02.** The two-rAF deferral for GPU compute init: wrap it in a promise
   `gpuComputeReady` and gate any GUI toggle that touches `computeEmitter` on that
   promise resolving. If the user flips the toggle early, queue the desired state
   and apply when `gpuComputeReady` resolves.

### Acceptance

- `npm test && npm run build` pass.
- Manual: rapidly toggle GPU compute during startup — no uncaught promise
  rejections, no stale dispatches.

### Risks

- Promise-based gating can mask errors. Always `.catch(console.error)` any dangling
  promise and surface failures in the GUI.

---

# Epic C — Ring-buffer hardening

## Task C1 — bornTime vs arrivalTime split (PHYS-03, RING-03)

**Priority:** 🟠 **Estimated diff:** ~50 LOC + padding adjustment in `main.ts`.
**Files to read:**

1. [src/rendering/particle-ring-buffer.ts](src/rendering/particle-ring-buffer.ts) —
   full (527 lines). Focus on:
   - ~L21 `BORN_SENTINEL` magic number (RING-03).
   - ~L385 and ~L404 alive-range binary search (PHYS-03).
   - `writeBatch` / `advanceWriteHead` / `recordGpuWrite`.
2. [src/main.ts](src/main.ts) — search for `arrivalSpread` usages related to the
   alive-range cutoff padding.
3. [src/rendering/particle-ring-buffer.test.ts](src/rendering/particle-ring-buffer.test.ts) —
   full; this is the biggest test file, budget ~15% of context for it.

### Problem

The value at `[i*4+2]` is commented as `bornTime` but is really
`arrivalTime = now + rawDelay` where `rawDelay ∈ [-1.5·spread, +1.5·spread]`. The
"binary search" depends on monotonicity that arrivalTime does not satisfy; currently
masked by 1.5× padding in `main.ts`.

### Instructions

1. Decide: (a) add a second float slot for true `bornTime`, or (b) keep one slot but
   formalise padding.
   **Recommendation:** (b), because (a) expands `PARTICLE_STRIDE` which is a
   cross-cutting invariant (see shared context #3) and would ripple into WGSL and
   renderer.
2. Rename the storage slot's accessor from `getBornTime` / `setBornTime` to
   `getArrivalTime` / `setArrivalTime` throughout the file and its callers. Update
   the comment at L21 and the JSDoc on the getter.
3. Replace `BORN_SENTINEL = -1e9` with a runtime-asserted bound: at write time,
   `assertDev(arrivalTime > MIN_VALID_ARRIVAL_TIME && arrivalTime < MAX_VALID_ARRIVAL_TIME)`,
   where `assertDev` is a no-op in production (check for an existing helper; if
   none, add a `const DEV = import.meta.env.DEV;` branch).
4. Document the padding invariant in code: add a constant
   `ARRIVAL_SEARCH_PADDING_MULTIPLIER = 1.5` with a comment proving why 1.5×
   `arrivalSpread` suffices (see plan.md PHYS-03). Export it and **use it** from
   `main.ts` at the cutoff site so the two can never drift.
5. Do not change the binary search itself; rename it to
   `arrivalTimeLowerBound` and add a docblock explaining "returns first index whose
   arrivalTime ≥ t − padding; caller guarantees padding ≥ 1.5 × spread".

### Testing

Add to `particle-ring-buffer.test.ts`:
- Write 100 particles with `arrivalTime = now + randomInRange(-1.5*spread, 1.5*spread)`,
  then query alive-range with the padding; assert every written particle is within
  the returned range.
- Assert that a write with `arrivalTime` less than `MIN_VALID_ARRIVAL_TIME` (in dev)
  throws / asserts.

### Acceptance

- All existing `particle-ring-buffer.test.ts` tests still pass.
- Grep confirms `BORN_SENTINEL` is gone and `bornTime` in comments/names is replaced.
- `npm run build` passes.

### Risks

- **🔗 Parity.** GPU path also writes to slot 2. Verify `particle-emit.wgsl` writes
  `arrivalTime`, not a true bornTime. If it writes something different, this task
  becomes "GPU-side rename only" and the shared-invariant #1 still holds.

---

## Task C2 — Ring-buffer getter bounds & `grow()` destroy (RING-01, RING-02)

**Priority:** 🟡 **Estimated diff:** ~30 LOC.
**Files to read:**

1. [src/rendering/particle-ring-buffer.ts](src/rendering/particle-ring-buffer.ts#L89-L122)
   and ~L640–L700 (`grow`).

### Instructions

1. **RING-01.** For every getter (`getHue`, `getBrightness`, `getArrivalTime`
   (post-C1), `getLx`, `getLy`, `getEps`, `getHitSize`): add
   `if (index < 0 || index >= this.capacity) throw new RangeError(...)`.
2. **RING-02.** In `grow()`, before overwriting the old attribute, obtain the old
   `GPUBuffer` via the same `backend.get(oldAttr).buffer` channel used for uploads,
   and call `.destroy()` on it. If the backend returns `undefined` (buffer not yet
   uploaded), skip. Guard with try/catch and `console.warn` on failure so Three
   internals changes don't crash the app.

### Testing

- Add unit tests in `particle-ring-buffer.test.ts`:
  - `getHue(-1)` throws.
  - `getHue(capacity)` throws.
  - `getHue(0)` returns default after init.

### Acceptance

- `npm test && npm run build` pass.

### Risks

- Some hot-path callers may rely on permissive reads; search before committing.

---

## Task C3 — `invalidateFuture` populated-range scan (RING-04)

**Priority:** 🟡 **Estimated diff:** ~20 LOC.
**Files to read:**

1. [src/rendering/particle-ring-buffer.ts](src/rendering/particle-ring-buffer.ts#L586-L600).
2. [src/main.ts](src/main.ts#L594-L600) — caller (debounced).

### Instructions

1. Replace the O(capacity) loop with iteration over
   `[writeHead − min(totalWritten, capacity), writeHead)` modulo capacity.
2. Keep the public signature unchanged.

### Testing

- Add a test that writes 10 particles into a capacity-1M ring, calls
  `invalidateFuture(cutoffTime)`, and asserts only the 10 slots were touched
  (use a spy on a per-slot write, or compare buffers before/after).

### Acceptance

- Benchmark before/after (optional, include numbers in the PR description).

### Risks

- Off-by-one in modulo arithmetic. Write the test first.

---

## Task C4 — Three.js backend access helper (RING-05)

**Priority:** 🟡 **Estimated diff:** ~80 LOC new file + refactors.
**Files to read:**

1. [src/main.ts](src/main.ts#L354) — one access site.
2. [src/rendering/renderer.ts](src/rendering/renderer.ts#L330-L395) — main access
   site.
3. [src/rendering/particle-ring-buffer.ts](src/rendering/particle-ring-buffer.ts#L47) —
   second access site.

### Instructions

1. Create `src/rendering/three-backend.ts` exporting:
   - `getWebGPUDevice(renderer): GPUDevice`.
   - `getAttributeBuffer(renderer, attr): GPUBuffer | undefined`.
   - `probeThreeBackend(renderer): { compatible: boolean; version: string; missing: string[] }`.
2. `probeThreeBackend` runs at renderer init and throws (not warns) if the private
   paths are missing, with an error message listing the probed paths and the
   Three.js version from `THREE.REVISION`.
3. Replace every `(renderer as any).backend...` with a helper call.
4. Keep the helper's `any` casts localised to one file.

### Testing

- Add a unit test that imports the helper, constructs a mock renderer with the
  expected shape, and asserts the probe returns `compatible: true`.
- Add a negative test with a renderer missing `.backend.device` → probe returns
  `compatible: false`, throws on `getWebGPUDevice`.

### Acceptance

- Grep: `(renderer as any).backend` appears only in `three-backend.ts`.
- Build passes.

### Risks

- Breaking change if Three moves internals between minor versions. The probe catches
  this at init instead of at dispatch time — which is the goal.

---

# Epic D — Worker robustness

## Task D1 — Worker restart ceiling (WORK-01)

**Priority:** 🟠 **Estimated diff:** ~30 LOC.
**Files to read:**

1. [src/physics/physics-bridge.ts](src/physics/physics-bridge.ts) — full (433 lines).
   Focus on ~L195–L205 (`_restartWorker`).

### Instructions

1. Add `private _workerAttempts: number[]` (one counter per worker index).
2. In the `onerror` handler, increment, cap at `MAX_WORKER_ATTEMPTS = 5`. When
   exceeded:
   - Mark the worker as permanently dead (add `private _workerDead: boolean[]`).
   - `console.error(...)` once.
   - Redistribute its share of `particleRate` across surviving workers by adjusting
     the per-worker rate at the next broadcast.
   - Never restart again.
3. On explicit `bridge.restart()`, reset attempts and dead flags.

### Testing

- Unit test: construct a `PhysicsBridge` with a mock `Worker` class that throws
  immediately on every instantiation. After 5 restart cycles, the bridge must stop
  restarting and emit exactly one `console.error` for that worker.
- Use `vi.useFakeTimers()` to advance the exponential backoff.

### Acceptance

- `npm test && npm run build` pass.

### Risks

- Rebalancing rate mid-session can cause a visible emission bump. Add a TODO
  comment if you want to smooth it later.

---

## Task D2 — Multi-worker coherence test (WORK-02 / TEST-02)

**Priority:** 🟠 **Depends on:** E2 (jsdom may not be needed — Node can run
`worker_threads`; verify first).
**Files to read:**

1. [src/physics/physics-worker.ts](src/physics/physics-worker.ts) — full (138 lines).
2. [src/physics/physics-bridge.ts](src/physics/physics-bridge.ts) — full.
3. [src/physics/shell.ts](src/physics/shell.ts) — full (510 lines).
4. [src/physics/perturbation.ts](src/physics/perturbation.ts) — full.

### Instructions

1. Create `src/physics/multi-worker-coherence.test.ts`.
2. Since Vitest's `Worker` shim differs, do one of:
   - **Preferred:** refactor `physics-worker.ts` so the per-tick pure step is
     importable without the `onmessage` glue. Test by running two instances of the
     step function with identical seeds and asserting bitwise-identical Float32Array
     output for K=100 ticks.
   - **Fallback:** run real `worker_threads` inside the test via
     `new Worker(new URL("./physics-worker.ts", import.meta.url), { type: "module" })`.
     Requires Vitest's worker pool config — document and skip if too flaky.
3. The assertion: for identical `(seed, coefficients, lMax, amplitude, dt)`, two
   workers produce `Float32Array` outputs equal byte-for-byte for K ticks.

### Acceptance

- Test passes reliably (run locally 5×).

### Risks

- JS `Math.random` is per-realm; workers **must** use the bridge-provided
  `splitmix32` seed. Verify no hidden `Math.random` in the worker.

---

## Task D3 — Typed worker messages (WORK-03, WORK-04)

**Priority:** 🟡 **Estimated diff:** ~50 LOC.
**Files to read:**

1. [src/physics/physics-worker.ts](src/physics/physics-worker.ts#L33) and #L51.
2. [src/physics/physics-bridge.ts](src/physics/physics-bridge.ts) — all
   `postMessage` sites.

### Instructions

1. Create `src/physics/worker-protocol.ts` exporting a discriminated union
   `WorkerInMsg = { kind: "config"; ... } | { kind: "tick"; ... } | ...` and the
   reverse `WorkerOutMsg`.
2. Replace `configFromMsg(msg: any)` with `configFromMsg(msg: WorkerInMsg)` + an
   exhaustive `switch`.
3. **WORK-04:** move `maxParticlesPerTick` from module-level mutable to a parameter
   carried in each tick message (or a one-shot `configure` message whose immutability
   is enforced).

### Acceptance

- No `any` in worker message paths.
- `npm run build` passes with `strict`.

### Risks

- Breaking the tick contract can silently break emission. Bisect changes behind a
  feature flag if needed.

---

## Task D4 — Coefficient RNG session-seed mix (PHYS-04)

**Priority:** 🟠 **Estimated diff:** 1 line + a test.
**Files to read:**

1. [src/physics/physics-bridge.ts](src/physics/physics-bridge.ts#L283).

### Instructions

1. Change
   `this.coeffRng = splitmix32(((this._lastLMax * 6271) ^ lMax) >>> 0);`
   to XOR in the session seed:
   `this.coeffRng = splitmix32(((this._lastLMax * 6271) ^ lMax ^ this._sessionSeed) >>> 0);`
2. Ensure `this._sessionSeed` is set from `config.seed` in the constructor.

### Testing

- Add a test: two bridges with different seeds but same `(oldLMax, newLMax)` produce
  different RNG streams after the re-seed.

### Acceptance

- Build and tests pass.

---

# Epic E — Build & test infra

## Task E1 — Vite base path + target (BUILD-01, BUILD-02)

**Priority:** 🟠 **Estimated diff:** 5 LOC.
**Files to read:**

1. [vite.config.ts](vite.config.ts) — full.

### Instructions

1. Replace hardcoded `base: "/Birth-of-a-Universe/"` with
   `base: process.env.VITE_BASE ?? "/Birth-of-a-Universe/"`. Default preserves today's
   deploy.
2. Change `build.target: "esnext"` to `"es2022"`.
3. Update the GitHub Actions deploy workflow only if it relies on the hardcoded base
   (it does not — the default still works).

### Acceptance

- `npm run build` passes; `dist/index.html` still references `/Birth-of-a-Universe/...`
  asset paths unless `VITE_BASE` is set.
- `VITE_BASE=/ npm run build` produces root-relative paths.

---

## Task E2 — Vitest jsdom environment (BUILD-03)

**Priority:** 🟠 **Estimated diff:** 3 LOC + 1 dep.
**Files to read:**

1. [vitest.config.ts](vitest.config.ts) — full.
2. [src/ui/screen-info.test.ts](src/ui/screen-info.test.ts) — full (169 lines).
3. [src/rendering/particle-ring-buffer.test.ts](src/rendering/particle-ring-buffer.test.ts) —
   full (647 lines).

### Instructions

1. `npm install --save-dev jsdom`.
2. Add to `vitest.config.ts`:
   ```ts
   test: { environment: "jsdom" }
   ```
3. Run `npm test`. If tests fail that passed in Node (e.g. because jsdom is stricter
   about missing globals), fix them minimally — do not rewrite. Common fixes:
   - Stub `performance.now` if missing.
   - Polyfill `matchMedia`: add a test setup file (see below).
4. If widespread fixes are needed, create `vitest.setup.ts`:
   ```ts
   // vitest.setup.ts
   Object.defineProperty(window, "matchMedia", {
     writable: true,
     value: (query: string) => ({
       matches: false, media: query, onchange: null,
       addEventListener() {}, removeEventListener() {},
       addListener() {}, removeListener() {}, dispatchEvent: () => false,
     }),
   });
   ```
   Reference from `vitest.config.ts` via `test.setupFiles: ["./vitest.setup.ts"]`.

### Acceptance

- `npm test` passes (same count of passing tests as before, at minimum).

### Risks

- Some existing passing tests may start failing with stricter DOM semantics. Investigate
  each and fix; do not `test.skip`.

---

## Task E3 — Strengthen unit tests (TEST-03, TEST-04, TEST-05)

**Priority:** 🟠 **Depends on:** E2.
**Files to read:**

1. [src/physics/shell.test.ts](src/physics/shell.test.ts#L57-L63) — TEST-03.
2. [src/physics/ecsk-physics.test.ts](src/physics/ecsk-physics.test.ts#L87) — TEST-04.
3. [src/compute/compute-emitter.test.ts](src/compute/compute-emitter.test.ts#L109-L142) —
   TEST-05.
4. Plus the source files each test covers (`shell.ts`, `ecsk-physics.ts`,
   `compute-emitter.ts`).

### Instructions

1. **TEST-03 — rate conservation.** Modify the existing test to run 60 ticks at
   500 req/s, dt = 1/60. Assert `Math.abs(total - 500) <= 2` (tolerance accounts for
   the last fractional tick).
2. **TEST-04 — ECSK sensitivity.** After the existing non-zero + caching assertions,
   add: for a closed bounce (positive curvature param), `dT/dβ < 0` across three
   perturbations of `β`.
3. **TEST-05 — ring buffer wrap.** Replace the mock-only assertions with a scenario
   that writes `capacity + 100` particles and verifies:
   - `writeHead` wraps to 100.
   - The first 100 slots contain the **final** 100 values, not the first.
   - `totalWritten` equals `capacity + 100` (or caps correctly — match the existing
     semantics).

### Acceptance

- `npm test` green, new assertions visibly stricter than before.

### Risks

- TEST-04 sign depends on physics conventions; verify sign with a quick finite
  difference in isolation before baking the assertion.

---

# Epic F — Polish

## Task F1 — Perturbation polish (PHYS-05, PHYS-06, PHYS-08, PHYS-09)

**Priority:** 🟡 **Estimated diff:** ~40 LOC.
**Files to read:**

1. [src/physics/perturbation.ts](src/physics/perturbation.ts) — full.
2. [src/physics/shell.ts](src/physics/shell.ts#L133) (dead `PendingParticle` export).

### Instructions

1. **PHYS-05.** In the Box-Muller site (~L171–L174), cache the `sin` branch as a
   pending sample on the RNG-owning object. Reset the cache on `seed()` /
   re-initialisation.
2. **PHYS-06.** Validate `lMax > 0` and `amplitude >= 0` in `generatePerturbCoeffs`;
   throw `RangeError` with a clear message.
3. **PHYS-08.** Keep `evaluatePerturbation` (the naive reference) — it will serve as
   the oracle for A4a. Mark with a comment `// Reference implementation — used by
   tests; do not inline into hot path.`
4. **PHYS-09.** Remove the unused `PendingParticle` export in `shell.ts`. If it has
   any imports (check grep), migrate them.

### Acceptance

- `npm test && npm run build` pass.

---

## Task F2 — GPU micro-perf (GPU-03, GPU-04)

**Priority:** 🟡 **Estimated diff:** ~15 LOC.
**Files to read:**

1. [src/compute/compute-emitter.ts](src/compute/compute-emitter.ts#L80), #L263,
   #L347-#L395.

### Instructions

1. **GPU-04.** Allocate the 144-byte scratch buffer once in the constructor; reuse
   the same `ArrayBuffer` + `DataView` in `_uploadParams`.
2. **GPU-03.** Add a comment at the `_frameSeed` wrap site documenting the 2³² period
   and that it is not considered a bug (or, if trivially cheap, re-seed from
   `performance.now()` ^ `_frameSeed` on wrap).

### Acceptance

- Build + tests pass. No behavioural change expected.

---

## Task F3 — TSL `.d.ts` tightening (BUILD-05, BUILD-06)

**Priority:** 🟡
**Files to read:**

1. [src/types/three-webgpu.d.ts](src/types/three-webgpu.d.ts) — full (182 lines).

### Instructions

1. For each TSL function stub, add an explicit return type (probably
   `ShaderNodeObject<any>` or `ShaderNodeObject<Node>` depending on Three's export).
2. Tighten `ShaderNodeObject` beyond `[key: string]: any` **only** if the installed
   Three version exposes usable types; otherwise leave a comment and skip.

### Acceptance

- `npm run build` passes. Ideally fewer `any` types.

---

## Task F4 — Accessibility (A11Y-01, A11Y-02, A11Y-03)

**Priority:** 🟡
**Files to read:**

1. [src/ui/controls.ts](src/ui/controls.ts#L1230), #L1319.
2. [index.html](index.html).

### Instructions

1. **A11Y-01.** Replace `role="button"` divs with `<button type="button">`; copy
   existing classes; ensure default button styling is overridden (see existing CSS).
2. **A11Y-02.** On the tooltip overlay, add `role="tooltip"` and
   `aria-live="polite"`. Wire `aria-describedby` on the triggering element to the
   tooltip's id.
3. **A11Y-03.** Move inline body layout styles from `index.html` into `src/style.css`
   (or an equivalent imported CSS).

### Acceptance

- No visual regression. Keyboard: Tab focuses the former info divs; Enter/Space
  activates.

---

## Task F5 — CSS cleanup (CSS-01, CSS-02, CSS-03)

**Priority:** 🟡
**Files to read:**

1. [src/style.css](src/style.css) — full (177 lines).

### Instructions

1. **CSS-01.** Reduce specificity of mobile selectors — avoid chained tag+id+class;
   prefer single-class selectors or data attributes.
2. **CSS-02.** Remove `-webkit-overflow-scrolling: touch` (iOS 13+ has native
   momentum scroll).
3. **CSS-03.** Scope `safe-area-insets` usage to mobile media queries only.

### Acceptance

- Visual test on desktop + mobile simulator. No regressions.

---

## Task F6 — Repo hygiene (REPO-01, REPO-02, REPO-03)

**Priority:** 🟡 **Not gated on any code task.** Safe to skip indefinitely.
**Files to read:**

1. `source-processing/*.py` — REPO-01/02 (gitignored, cosmetic).
2. `double click to start.bat`, `simplified-3d-illustration/double click to start.bat` —
   REPO-03.

### Instructions

1. **REPO-01.** Replace hardcoded Windows paths with
   `Path(__file__).resolve().parent / ...`.
2. **REPO-02.** Wrap file I/O in `try/except FileNotFoundError:` and log a clear
   message. Validate input directories exist before iterating.
3. **REPO-03.** Append `pause` (or `cmd /k`) to both `.bat` files so errors remain
   visible.

### Acceptance

- Manually run each script with a missing input path — it prints a useful error and
  exits non-zero rather than stack-tracing.

---

## Appendix — Task card template (for adding new tasks)

Copy when adding new tasks:

```markdown
## Task X — Short title (finding IDs)

**Priority:** 🔴/🟠/🟡 **Estimated diff:** ~N LOC in M files.
**Depends on:** (task IDs or "—").
**Files to read (in order):** (full paths + line ranges).

### Problem
(1–2 paragraphs of context, self-contained.)

### Instructions
1. ...
2. ...

### Testing
- ...

### Acceptance
- `npm test && npm run build` pass.
- (Additional criteria.)

### Risks
- **🔗 Parity note** if CPU/GPU.
- ...
```

---

## Document ownership

- **Finding IDs** live in [plan.md](plan.md) §2 and are frozen. New findings get new
  IDs appended; old IDs are never re-used.
- **Task IDs** live here. If a task is superseded, mark it `(withdrawn)` with a
  sentence explaining why, instead of deleting.
- When an agent completes a task, they append a one-line entry to a `CHANGELOG.md`
  (creating it on first use) with: date, task ID, PR/commit ref, any deviations.

End of implementation plan.
