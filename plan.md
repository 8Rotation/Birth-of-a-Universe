# Birth-of-a-Universe — Audit Findings & Remediation Plan

> **Purpose of this document.** This file consolidates the complete results of a full
> codebase audit (two independent passes) of the Birth-of-a-Universe workspace. It is
> intended as input to a separate planning chat whose job is to break these findings
> into discrete, self-contained tasks that further chats can execute one by one.
>
> **Do not treat this as a task list.** It is the raw finding set plus the context a
> planner needs to split the work. Every finding has a file path, a line reference
> (1-based), a severity, a short description of the problem, and enough context on
> how the code is structured to make a scoping decision.
>
> **Audit methodology.**
> - Pass 1 — three parallel read-only subagents covered physics/compute, rendering/UI,
>   repo hygiene. Findings were then de-duplicated and triaged.
> - Pass 2 — direct re-read of every source file from scratch, without relying on the
>   pass-1 summaries. New findings were added; pass-1 findings were re-verified or
>   downgraded when evidence showed them to be overstated.
> - Documentation files (`README.md`, `copilot-instructions.md`, `EQUATION_CATALOG.md`)
>   were deliberately ignored so code was judged on its own merits.
>
> **Severity legend.**
> - 🔴 High — correctness bug, user-visible impact, or security-relevant.
> - 🟠 Medium — fragile code, latent bug, or easy-to-hit footgun.
> - 🟡 Low — style, hygiene, comment accuracy, micro-perf.

---

## 1. Workspace overview (context for the planner)

- **Stack:** TypeScript 5.9, Vite 7, Vitest 4, Three.js 0.183 (WebGPU renderer + TSL),
  lil-gui 0.21, `@webgpu/types`. No bundler beyond Vite.
- **Entry:** `src/main.ts` orchestrates: hardware detect → screen detect → renderer init →
  physics bridge (N Web Workers) → optional GPU compute emitter → controls → animate loop.
- **Physics:** Einstein-Cartan-Sciama-Kibble bounce cosmology. CPU path runs in workers;
  GPU path runs the same physics in a WGSL compute shader.
- **Two emission paths that must stay numerically in sync:**
  1. CPU: [src/physics/shell.ts](src/physics/shell.ts), evaluated inside
     [src/physics/physics-worker.ts](src/physics/physics-worker.ts), coordinated by
     [src/physics/physics-bridge.ts](src/physics/physics-bridge.ts).
  2. GPU: [src/compute/particle-emit.wgsl](src/compute/particle-emit.wgsl), driven by
     [src/compute/compute-emitter.ts](src/compute/compute-emitter.ts), dispatched from
     `main.ts` animate loop.
- **Ring buffer:** [src/rendering/particle-ring-buffer.ts](src/rendering/particle-ring-buffer.ts)
  is shared storage. CPU path writes via `writeBatch`; GPU path writes via
  `copyBufferToBuffer` plus `advanceWriteHead`/`recordGpuWrite`.
- **Renderer:** [src/rendering/renderer.ts](src/rendering/renderer.ts) — Three.js TSL
  with an instanced quad mesh, bloom post-process, HDR mode support.
- **UI:** [src/ui/controls.ts](src/ui/controls.ts) (lil-gui), [src/ui/hardware-info.ts](src/ui/hardware-info.ts),
  [src/ui/screen-info.ts](src/ui/screen-info.ts), [src/ui/tooltips.ts](src/ui/tooltips.ts).
- **Build:** [vite.config.ts](vite.config.ts), [tsconfig.json](tsconfig.json),
  [vitest.config.ts](vitest.config.ts).
- **Deploy:** [.github/workflows/deploy.yml](.github/workflows/deploy.yml) → GitHub Pages.
- **Excluded from git (via .gitignore):** `sources/`, `sources_extracted/`, `sources_marker/`,
  `source-processing/`, `copilot-instructions.md`, `dist/`, `.venv/`, `node_modules/`.

### Cross-cutting constraints the planner must respect

1. **CPU and GPU emission paths must remain numerically equivalent.** Any fix to one
   must usually be mirrored in the other, or the GPU-vs-CPU validation test becomes
   meaningless.
2. **The params struct layout is shared between TypeScript (hand-packed `DataView`)
   and WGSL (declared struct).** Changes to fields must be reflected on both sides at
   identical offsets.
3. **The `PARTICLE_STRIDE = 8` float layout is shared** between workers, main thread,
   and renderer. It is 8 floats per particle on the wire but 2×vec4 = 8 floats on GPU.
4. **There are multiple Web Workers** created by `PhysicsBridge`; centralised state
   (perturbation coefficients) lives on the main thread and is broadcast each tick.
5. **Tests currently don't use jsdom** — several tests touch `window` anyway. Any test
   infrastructure fix must not break the existing passing suite.

---

## 2. Findings, grouped by area

Every finding is ID'd so the planner can reference it. Format: `AREA-NN`.

### 2.1 Physics / emission correctness

#### PHYS-01 🔴 GPU compute path drops the fractional emission remainder each frame
- **Where:** [src/main.ts](src/main.ts#L858-L865)
- **What:** On the GPU path, `bounceCount = Math.floor(gpuEffectiveRate * dt)` throws
  away the sub-1 remainder every frame. The CPU equivalent in
  [src/physics/shell.ts](src/physics/shell.ts#L380-L382) carries an accumulator:
  `this.accumulator += dt * effectiveRate; count = floor(accumulator); accumulator -= count;`.
- **Impact:** At 60 Hz and `particleRate = 100/s`, each frame accumulates 1.67 → floors
  to 1 → ~60/s observed (40% loss). At 144 Hz with the same rate, 0.69 → 0 every frame
  → **zero particles emitted** until rate × dt ≥ 1.
- **Fix shape:** Add a module-scope or renderer-scope `gpuEmitAccumulator` updated
  exactly like the CPU accumulator; reset on `bridge.restart()` / physics reset.
- **Risk:** Changing emitted count breaks any test that pins a specific count; none
  observed but check [src/compute/compute-emitter.test.ts](src/compute/compute-emitter.test.ts).

#### PHYS-02 🔴 WGSL factorial `(2m)!` computed in f32 loses precision / overflows at moderate lMax
- **Where:** [src/compute/particle-emit.wgsl](src/compute/particle-emit.wgsl#L200-L203);
  mirrored in [src/physics/perturbation.ts](src/physics/perturbation.ts#L239).
- **What:** `var fac: f32 = 1.0; for i in 1..=2m { fac *= f32(i); }`. At `m = 8`,
  `16! ≈ 2.09e13` — representable but losing ≥7 bits of mantissa precision. Beyond
  `m ≈ 13` (`26! ≈ 4e26`) f32 precision is gone; the CPU version in JS number is safe
  to `m ≤ 85` but will then diverge from GPU silently.
- **Impact:** As UI `lMax` slider is raised, CPU and GPU perturbation fields diverge.
  Currently `lMax` default is 8 and max is not visible in this read; planner should
  confirm the slider cap. Latent bug if the cap is ever raised.
- **Fix shape:** Maintain the normalisation factor recursively across the `l` loop
  (`fac(l) = fac(l-1) × (l+m)/(l-m)` is already done — compute it directly without
  ever materialising `(2m)!`) or keep `log(fac)` and exponentiate only inside
  `sqrt(... / fac)`.
- **Risk:** Numerical rewrite of shared CPU/GPU code. Needs a precision-diff test
  before and after.

#### PHYS-03 🟠 Alive-range binary search assumes bornTime is monotonic; it is not
- **Where:** [src/rendering/particle-ring-buffer.ts](src/rendering/particle-ring-buffer.ts#L385)
  and [src/rendering/particle-ring-buffer.ts](src/rendering/particle-ring-buffer.ts#L404)
  ("bornTime is monotonically increasing in write order").
- **What:** The value stored in slot `[i*4+2]` is actually `arrivalTime = now + rawDelay`,
  where `rawDelay ∈ [-1.5·arrivalSpread, +1.5·arrivalSpread]`. Two particles born the
  same frame can differ in `arrivalTime` by up to 3·arrivalSpread.
- **Impact:** Currently masked because `main.ts` pads the alive-range cutoff with
  `arrivalSpread × 1.5`. If anyone tightens that padding, alive particles can vanish
  intermittently. Also the "binary search" is not correct in the mathematical sense
  it claims to be.
- **Fix shape:** Either (a) store true `bornTime = now` alongside `arrivalTime` so the
  binary search operates on a monotonic quantity, or (b) formalise the padding
  requirement in code with an assertion and correct the comment.

#### PHYS-04 🟠 Coefficient RNG re-seed on `lMax` change does not mix in session seed
- **Where:** [src/physics/physics-bridge.ts](src/physics/physics-bridge.ts#L283)
  `this.coeffRng = splitmix32(((this._lastLMax * 6271) ^ lMax) >>> 0);`
- **What:** A given `(oldLMax, newLMax)` pair always produces the identical RNG stream
  for the O-U noise that follows, because `config.seed` is not included.
- **Impact:** O-U evolution after an lMax change is deterministic across sessions for
  that transition. Not reproducible in a controlled way either — just accidentally
  deterministic.
- **Fix shape:** XOR in `config.seed` (or the bridge's stored session seed) on re-seed.

#### PHYS-05 🟡 Box-Muller discards the sine term
- **Where:** [src/physics/perturbation.ts](src/physics/perturbation.ts#L171-L174)
- **What:** Generates two uniforms, produces one Gaussian (cos branch), throws away
  the sin branch. Wasted work, not a correctness bug.
- **Fix shape:** Cache the sin sample for the next call (standard two-at-a-time pattern).

#### PHYS-06 🟡 `generatePerturbCoeffs` does not validate `lMax > 0` / `amplitude ≥ 0`
- **Where:** [src/physics/perturbation.ts](src/physics/perturbation.ts#L135-L150)
- **Impact:** Negative or zero inputs silently produce degenerate fields.

#### PHYS-07 🟡 `shell.ts` uses `minW = 0, maxW = -Infinity` (round 1 flagged; now withdrawn)
- **Where:** [src/physics/shell.ts](src/physics/shell.ts#L417)
- **Status:** Not a bug — ECSK `wEff < −1/3` always, so `minW = 0` is a correct ceiling.
  Listed here so the planner does **not** schedule a fix for it.

#### PHYS-08 🟡 `evaluatePerturbation` (naive Legendre) is unused in production
- **Where:** [src/physics/perturbation.ts](src/physics/perturbation.ts#L216-L230)
- **Status:** Kept for reference; only `evaluatePerturbationFast` is called in the hot
  path. Decide: keep as testing oracle, or delete.

#### PHYS-09 🟡 `PendingParticle` interface exported but never imported
- **Where:** [src/physics/shell.ts](src/physics/shell.ts#L133)
- **Status:** Dead export.

---

### 2.2 GPU compute infrastructure

#### GPU-01 🟠 Hand-packed 144-byte params struct has no layout assertion
- **Where:** Packing in [src/compute/compute-emitter.ts](src/compute/compute-emitter.ts#L355-L395);
  WGSL declaration in [src/compute/particle-emit.wgsl](src/compute/particle-emit.wgsl#L15-L62).
- **What:** TypeScript writes fields one at a time via a `DataView`; offsets are
  maintained by hand. WGSL struct is a string. Any field rename or reorder on one side
  silently corrupts the uniform.
- **Fix shape:** Add a unit test that
  1. Constructs a canonical `ComputeParams` with sentinel values per field, packs it;
  2. Uses `@group(1)` WGSL reflection constants or a parser on the shader source to
     assert each field's byte offset matches the TypeScript writer.
- **Alternative:** Generate both sides from a single source-of-truth JSON/TS schema.

#### GPU-02 🔴 GPU-vs-CPU validation test is `test.skip()`
- **Where:** [src/compute/gpu-cpu-validation.test.ts](src/compute/gpu-cpu-validation.test.ts#L169-L188)
- **What:** The comparison that would actually catch CPU/GPU divergence is skipped
  because Node+Vitest has no WebGPU. All other tests in that file validate only
  f32/f64 arithmetic or shader string syntax.
- **Fix shape:** Playwright + headless Chromium run; wire into CI via a separate job.
- **Risk:** New CI dependency, new test runtime.

#### GPU-03 🟠 `_frameSeed` wraps to 0 every 2³² dispatches with no test
- **Where:** [src/compute/compute-emitter.ts](src/compute/compute-emitter.ts#L80),
  incremented on L263 (`(this._frameSeed + 1) >>> 0`).
- **Impact:** Every 2^32 frames (~828 days at 60 Hz — practically never, but) seeds
  loop and produce identical sequences. Not an actionable bug, call out only.

#### GPU-04 🟡 `_uploadParams` allocates a new `ArrayBuffer(144)` every dispatch
- **Where:** [src/compute/compute-emitter.ts](src/compute/compute-emitter.ts#L347-L395)
- **Impact:** Minor GC pressure at 60–144 Hz.
- **Fix shape:** Reuse a module-scope scratch buffer.

---

### 2.3 Multi-worker coordination

#### WORK-01 🟠 Worker crash auto-restart has no attempt ceiling
- **Where:** [src/physics/physics-bridge.ts](src/physics/physics-bridge.ts#L195-L205)
- **What:** `onerror` schedules `_restartWorker` with exponential backoff capped at 5 s.
  `consecutiveErrors` is preserved across restarts — but there is no "give up" limit.
  A deterministically-broken worker retries every 5 s forever.
- **Fix shape:** Cap at N attempts (e.g., 5), then mark worker permanently dead; log
  error once; rebalance rate to surviving workers.

#### WORK-02 🟠 No test for multi-worker coherence
- **What:** The bridge broadcasts central perturbation coefficients to N workers each
  tick. Given the same seed, all workers should produce identical particle sequences.
  There is no test verifying this.
- **Fix shape:** Node-side test that spawns two workers with identical seeds and
  asserts that their packed Float32Array outputs are bitwise identical for K ticks.

#### WORK-03 🟡 `configFromMsg(msg: any)` in worker
- **Where:** [src/physics/physics-worker.ts](src/physics/physics-worker.ts#L51)
- **What:** Worker boundary uses `any`. Mitigated in practice because every field is
  read via `??` with a safe default, but the type is unsound.
- **Fix shape:** Share a typed message union with the bridge.

#### WORK-04 🟡 `maxParticlesPerTick` is a module-level mutable global in the worker
- **Where:** [src/physics/physics-worker.ts](src/physics/physics-worker.ts#L33)
- **Impact:** Any tick can mutate it; coherence depends on all ticks carrying the same
  value, which the bridge currently does. Risk only if this invariant is ever broken.

---

### 2.4 Ring buffer / renderer integration

#### RING-01 🟡 Out-of-range getters return `undefined` cast to `number`
- **Where:** [src/rendering/particle-ring-buffer.ts](src/rendering/particle-ring-buffer.ts#L89-L122)
  (`getHue`, `getBrightness`, `getBornTime`, `getLx`, `getLy`, `getEps`, `getHitSize`)
- **What:** No bounds check. `Float32Array[i]` with `i ≥ length` returns `undefined`;
  TypeScript's `number` return type lies. Callers that arithmetic-combine the result
  will NaN-propagate.
- **Note:** Round 1 called this "memory safety"; downgraded — in JS this is a
  robustness issue, not an OOB read.
- **Fix shape:** Either `Math.min(index, capacity - 1)` clamp or throw.

#### RING-02 🟡 `grow()` relies on Three.js backend to release old GPUBuffers
- **Where:** [src/rendering/particle-ring-buffer.ts](src/rendering/particle-ring-buffer.ts#L640-L700)
- **What:** Invalidates the backend cache and sets `needsUpdate = true`. Three.js
  WebGPURenderer is expected to release the old `GPUBuffer` when re-creating the
  attribute. No explicit `destroy()` call. Not a guaranteed leak; depends on Three
  internals.
- **Fix shape:** If feasible, retrieve the old `GPUBuffer` via the backend (same
  `_gpuBackend.get(...)` channel used for uploads) and call `.destroy()` before
  replacing the attribute. Test under sustained slider drags to confirm steady-state
  VRAM.

#### RING-03 🟠 `BORN_SENTINEL = -1e9` is a magic-number "dead" marker in the same
        Float32Array as live times
- **Where:** [src/rendering/particle-ring-buffer.ts](src/rendering/particle-ring-buffer.ts#L21)
- **Impact:** Any legitimate negative `arrivalTime` below -1e9 would be misclassified.
  Given `arrivalTime = now + rawDelay` with `now` monotonic from `performance.now()/1000`
  and `rawDelay` bounded, this can't realistically happen. But nothing enforces it.
- **Fix shape:** Use a separate `Uint8Array` alive-flag array, OR assert at write time
  that `bornTime > BORN_SENTINEL + 1e6`.

#### RING-04 🟡 `ringBuffer.invalidateFuture()` is O(capacity) on every slider settle
- **Where:** [src/rendering/particle-ring-buffer.ts](src/rendering/particle-ring-buffer.ts#L586-L600);
  called from [src/main.ts](src/main.ts#L594-L600)
- **Impact:** At 5M-particle capacity this is a 20 MB linear scan. Debounced to 200 ms
  so practical cost is bounded, but still noticeable on a one-off pause.
- **Fix shape:** Iterate only the populated range (`[writeHead-totalWritten, writeHead)`
  modulo capacity), or only above the last known `cutoffTime` via binary search.

#### RING-05 🟡 Private-Three.js access via `as any` backend for both GPU compute and ring buffer
- **Where:** [src/main.ts](src/main.ts#L354), [src/rendering/renderer.ts](src/rendering/renderer.ts#L330-L395),
  [src/rendering/particle-ring-buffer.ts](src/rendering/particle-ring-buffer.ts#L47)
- **What:** Reaches into `renderer.renderer.backend.device` / `backend.get(attr).buffer`
  to grab GPU resources. Breaks on Three.js version bumps. Version mismatch only `console.warn`s.
- **Fix shape:** Centralise in a single helper that runs a compatibility probe at init
  and throws early if private fields have moved.

---

### 2.5 Main-thread lifecycle / leaks

#### LIFE-01 🟠 `visibilitychange` listener never removed; also calls `bridge.flushPipeline()`
        without guarding that `bridge` exists
- **Where:** [src/main.ts](src/main.ts#L376-L399)
- **Impact:** If init fails before `bridge` is set, the event can crash. If `main()`
  is ever re-run (e.g., HMR), duplicate listeners attach.

#### LIFE-02 🟠 Mobile `blur` / `focus` listeners never removed
- **Where:** [src/main.ts](src/main.ts#L401-L404)

#### LIFE-03 🟠 Animate loop has no stop flag
- **Where:** [src/main.ts](src/main.ts#L446) `requestAnimationFrame(animate)` runs
  unconditionally at the top of `animate`.
- **Impact:** No way to shut down the renderer cleanly (tests, HMR, or unmount).

#### LIFE-04 🟠 OLED theme `<style>` element leak on controls re-construction
- **Where:** [src/ui/controls.ts](src/ui/controls.ts#L63) (appended to `<head>`, never
  removed)

#### LIFE-05 🟠 Mobile panel overlay, `orientationchange`, and media-query listeners
        never removed
- **Where:** [src/ui/controls.ts](src/ui/controls.ts#L1173-L1205)

#### LIFE-06 🟠 DPR `matchMedia` listeners accumulate on screen-info re-registration
- **Where:** [src/ui/screen-info.ts](src/ui/screen-info.ts#L606-L610)

#### LIFE-07 🟠 Bloom node never disposed
- **Where:** [src/rendering/renderer.ts](src/rendering/renderer.ts#L555)

#### LIFE-08 🟡 CPU and GPU benchmarks have no wall-clock cap
- **Where:** [src/ui/hardware-info.ts](src/ui/hardware-info.ts#L164) (CPU bench tight
  loop); [src/ui/screen-info.ts](src/ui/screen-info.ts#L427) (`singleMeasurementPass()`)
- **Impact:** Throttled tabs may hang these for much longer than advertised.

#### LIFE-09 🟡 `setOverridesCallback` invokes user callbacks without try/catch
- **Where:** [src/main.ts](src/main.ts#L305)

---

### 2.6 Race conditions on initialization

#### INIT-01 🟠 `screenDetector.onChange` may fire before renderer is ready
- **Where:** [src/main.ts](src/main.ts#L85-L146)
- **What:** `hwDetector.startBenchmarks()` and `screenDetector.init()` run in parallel;
  `onChange` handler calls `renderer.applyScreenInfo()` assuming renderer exists.

#### INIT-02 🟠 GPU compute init deferred across two rAFs
- **Where:** [src/main.ts](src/main.ts#L355-L365)
- **What:** User flipping `gpuCompute` toggle during this window leaves stale state in
  flight. Currently masked because the toggle is hidden until init succeeds, but the
  ordering is not robust.

---

### 2.7 Build, tooling, and tests

#### BUILD-01 🟠 `vite.config.ts` hardcodes `base: "/Birth-of-a-Universe/"`
- **Where:** [vite.config.ts](vite.config.ts#L5)
- **Impact:** Any deploy to a different path (custom domain, different repo name)
  silently 404s all assets.
- **Fix shape:** Read from env (`process.env.BASE_URL` or `import.meta.env`) and
  default to `./` or `/`.

#### BUILD-02 🟠 `vite.config.ts` `build.target: "esnext"`
- **Where:** [vite.config.ts](vite.config.ts#L8)
- **What:** Ships untranspiled modern syntax; older mobile Safari / in-app browsers
  may break. Note: `tsconfig.json` target is `ES2022`, which is only for type-check.
- **Fix shape:** `target: "es2022"` or a browserslist-driven value.

#### BUILD-03 🟠 `vitest.config.ts` has no `environment`
- **Where:** [vitest.config.ts](vitest.config.ts)
- **What:** Defaults to `node`. But
  [src/ui/screen-info.test.ts](src/ui/screen-info.test.ts) and
  [src/rendering/particle-ring-buffer.test.ts](src/rendering/particle-ring-buffer.test.ts)
  touch DOM / `window`.
- **Fix shape:** Set `environment: "jsdom"` (install `jsdom` dep) or `"happy-dom"`.
- **Check first:** Run the current test suite to confirm it passes today — some tests
  may already work by accident in Node because they only use limited DOM surface, and
  adding jsdom could surface *new* failures. Plan for that.

#### BUILD-04 🟡 `tsconfig.json` is fine as-is
- **Where:** [tsconfig.json](tsconfig.json)
- **Status:** Round 1 criticised it; it's correct. `strict: true`, `target: ES2022`,
  `moduleResolution: bundler` matches Vite 7. No action.

#### BUILD-05 🟡 `types/three-webgpu.d.ts` `ShaderNodeObject` is `[key: string]: any`
- **Where:** [src/types/three-webgpu.d.ts](src/types/three-webgpu.d.ts#L8)
- **What:** Disables type checking on all TSL chains. Likely unavoidable given Three's
  own TSL typings, but worth re-checking against the installed version.

#### BUILD-06 🟡 TSL function stubs omit return types in the `.d.ts`
- **Where:** [src/types/three-webgpu.d.ts](src/types/three-webgpu.d.ts#L46)

---

### 2.8 Test coverage gaps

#### TEST-01 🔴 No real GPU execution test at all
- **See GPU-02.** Everything in [src/compute/](src/compute/) is tested against mocks
  or pure TypeScript ports.

#### TEST-02 🟠 No multi-worker coherence test (see WORK-02)

#### TEST-03 🟠 `shell.test.ts` weak assertion
- **Where:** [src/physics/shell.test.ts](src/physics/shell.test.ts#L57-L63)
- **What:** Runs 60 ticks at 500 req/s for dt = 1/60 and only asserts `total > 0`.
  Should assert `total ≈ 500` within a tolerance.

#### TEST-04 🟠 `ecsk-physics.test.ts` sensitivity test
- **Where:** [src/physics/ecsk-physics.test.ts](src/physics/ecsk-physics.test.ts#L87)
- **What:** Asserts non-zero and caching only. Doesn't pin sign (physics: `dT/dβ < 0`
  for closed bounce) or magnitude.

#### TEST-05 🟠 Ring buffer wrap-around only tested against mocks
- **Where:** [src/compute/compute-emitter.test.ts](src/compute/compute-emitter.test.ts#L109-L142)

#### TEST-06 🟡 No layout-assertion test for the 144-byte params struct (see GPU-01)

---

### 2.9 Accessibility & DOM

#### A11Y-01 🟡 Mobile info buttons use `role="button"` div
- **Where:** [src/ui/controls.ts](src/ui/controls.ts#L1230)
- **Fix shape:** Use `<button>` semantic element.

#### A11Y-02 🟡 Tooltip overlay has no `aria-live` / `aria-describedby`
- **Where:** [src/ui/controls.ts](src/ui/controls.ts#L1319)

#### A11Y-03 🟡 Critical body layout lives in inline style in `index.html`
- **Where:** [index.html](index.html#L10)

---

### 2.10 CSS

#### CSS-01 🟡 Very high-specificity mobile selectors
- **Where:** [src/style.css](src/style.css#L85)

#### CSS-02 🟡 Deprecated `-webkit-overflow-scrolling: touch`
- **Where:** [src/style.css](src/style.css#L191)

#### CSS-03 🟡 Global safe-area-insets unused on desktop
- **Where:** [src/style.css](src/style.css#L10)

---

### 2.11 Repo hygiene

#### REPO-01 🟡 `source-processing/*.py` hardcodes absolute Windows paths
- **Where:** [source-processing/extract_arxiv.py](source-processing/extract_arxiv.py#L10),
  [source-processing/extract_claude.py](source-processing/extract_claude.py#L21-L22),
  [source-processing/extract_marker.py](source-processing/extract_marker.py#L10-L15),
  [source-processing/extract_pdfs.py](source-processing/extract_pdfs.py#L6-L7)
- **Status:** These files are `.gitignore`d (`source-processing/` is excluded), so they
  affect only the author. Cosmetic.
- **Fix shape:** If touched, replace with `pathlib.Path(__file__).parent / ...`.

#### REPO-02 🟡 Python scripts have no `FileNotFoundError` / corrupt-input guards
- **Where:** Same files as REPO-01, plus lack of error handling in
  [source-processing/extract_pdfs.py](source-processing/extract_pdfs.py#L10-L36) and
  [source-processing/extract_marker.py](source-processing/extract_marker.py#L30).

#### REPO-03 🟡 Batch files lack a trailing `pause` for visible error output
- **Where:** [double click to start.bat](double%20click%20to%20start.bat),
  [simplified-3d-illustration/double click to start.bat](simplified-3d-illustration/double%20click%20to%20start.bat)
- **Impact:** On `npx` failure the console window vanishes without the user seeing
  the error.

#### REPO-04 🟡 CI is clean — no action
- **Where:** [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
- **Status:** Uses pinned `@v4`/`@v3` actions, minimal `permissions:`, Node 22, cache.
  Good.

#### REPO-05 🟡 `simplified-3d-illustration/` is intentional — no action
- **Status:** Small boot-template demo deployed alongside main app.

---

### 2.12 Findings withdrawn after re-verification

Do **not** schedule tasks for these; they were flagged in round 1 but the evidence in
round 2 showed the code is correct or the concern was overstated.

- **Hue init `minW = 0, maxW = -Infinity` "wrong"** — actually correct; ECSK `wEff < -1/3`
  always. (PHYS-07 above.)
- **`packCoeffs` Int32/Uint32 view aliasing "confusion"** — offsets are non-overlapping;
  layout is correct as verified against
  [src/compute/particle-emit.wgsl](src/compute/particle-emit.wgsl#L7-L13).
- **Ring-buffer getter OOB "memory safety"** — JS `Float32Array[i]` returns `undefined`,
  not a buffer-overrun. Downgraded to RING-01 robustness.
- **Ring-buffer `grow()` definite leak** — softened; depends on Three.js behavior
  (RING-02).
- **`simplified-3d-illustration/` stale duplication** — intentional demo.

---

## 3. Cross-cutting themes the planner should weigh

### Theme A — CPU/GPU parity
Bugs that exist in **both** paths or that create divergence:
- PHYS-01 (GPU under-emits)
- PHYS-02 (factorial precision, both paths)
- GPU-01 (layout drift risk between TS and WGSL)
- GPU-02 / TEST-01 (no real validation today)

A sensible task ordering is: (1) fix PHYS-01 so the two paths agree on emission count;
(2) add the layout assertion (GPU-01); (3) enable a real GPU test (GPU-02/TEST-01);
(4) fix PHYS-02 with the test now in place to catch drift.

### Theme B — Teardown hygiene
LIFE-01 through LIFE-07 form one logical unit: give every `main.ts`-level subsystem a
`dispose()`, route everything through it, and add a test that re-initialisation (or
at least one dispose+re-init cycle) does not duplicate listeners or leak DOM.

### Theme C — Build robustness
BUILD-01 and BUILD-02 together affect deployability. BUILD-03 affects test reliability.
Small, independent tasks — can be done in any order.

### Theme D — Test coverage
TEST-01..TEST-06 all increase confidence in subsequent refactors. Ordering:
- Add jsdom environment first (BUILD-03).
- Strengthen assertions in existing unit tests (TEST-03, TEST-04).
- Add multi-worker coherence test (WORK-02 / TEST-02).
- Add layout-assertion test (GPU-01 / TEST-06).
- Add real GPU test (GPU-02 / TEST-01) — largest effort, may need its own epic.

### Theme E — Private Three.js API coupling
RING-05 touches two files. Because Three.js major releases frequently move internals,
a single helper with a detection-and-fail path is a pre-requisite for safer upgrades.

---

## 4. Proposed task-splitting heuristics (for the planner)

Suggestions only — the planner chat should decide:

- **Bundle by subsystem**, not by severity, when the files overlap:
  LIFE-01..LIFE-07 touches two files repeatedly → one task.
- **Separate hot-path numerics** into their own tasks (PHYS-01, PHYS-02) — each needs a
  targeted test.
- **Do not bundle CPU and GPU changes** in the same task even when they mirror each
  other; do CPU first, commit, then port. The CPU path has tests, the GPU path mostly
  doesn't.
- **Config tasks are tiny** (BUILD-01, BUILD-02, BUILD-03) — may be grouped into one
  "tooling" PR but each should be an individual commit.
- **Do not schedule withdrawn findings** (section 2.12).
- **Repo hygiene (REPO-01..03)** is cosmetic; schedule last or punt indefinitely.

---

## 5. Ordered list of ALL actionable finding IDs

For quick task-planner consumption:

Priority 1 (🔴): PHYS-01, PHYS-02, GPU-02 / TEST-01.

Priority 2 (🟠):
GPU-01, GPU-03, PHYS-03, PHYS-04, WORK-01, WORK-02, RING-03,
LIFE-01, LIFE-02, LIFE-03, LIFE-04, LIFE-05, LIFE-06, LIFE-07,
INIT-01, INIT-02, BUILD-01, BUILD-02, BUILD-03,
TEST-03, TEST-04, TEST-05.

Priority 3 (🟡):
PHYS-05, PHYS-06, PHYS-08, PHYS-09, GPU-04,
WORK-03, WORK-04, RING-01, RING-02, RING-04, RING-05,
LIFE-08, LIFE-09, BUILD-05, BUILD-06,
A11Y-01, A11Y-02, A11Y-03, CSS-01, CSS-02, CSS-03,
REPO-01, REPO-02, REPO-03.

Withdrawn (do not schedule): PHYS-07, REPO-04, REPO-05, and the bullets in
section 2.12.

---

## 6. Files-touched matrix (helps the planner see natural task boundaries)

| Finding ID | Primary files |
|---|---|
| PHYS-01 | `src/main.ts` |
| PHYS-02 | `src/compute/particle-emit.wgsl`, `src/physics/perturbation.ts` |
| PHYS-03 | `src/rendering/particle-ring-buffer.ts` |
| PHYS-04 | `src/physics/physics-bridge.ts` |
| PHYS-05, 06, 08 | `src/physics/perturbation.ts` |
| PHYS-09 | `src/physics/shell.ts` |
| GPU-01 | `src/compute/compute-emitter.ts`, `src/compute/particle-emit.wgsl`, new test |
| GPU-02 / TEST-01 | `src/compute/gpu-cpu-validation.test.ts`, new Playwright config |
| GPU-03, GPU-04 | `src/compute/compute-emitter.ts` |
| WORK-01 | `src/physics/physics-bridge.ts` |
| WORK-02 / TEST-02 | new test, `src/physics/physics-worker.ts` |
| WORK-03 | `src/physics/physics-worker.ts`, `src/physics/physics-bridge.ts` |
| WORK-04 | `src/physics/physics-worker.ts` |
| RING-01..04 | `src/rendering/particle-ring-buffer.ts` |
| RING-05 | `src/rendering/renderer.ts`, `src/rendering/particle-ring-buffer.ts`, `src/main.ts` |
| LIFE-01..03, 09 | `src/main.ts` |
| LIFE-04, 05 | `src/ui/controls.ts` |
| LIFE-06, 08 | `src/ui/screen-info.ts`, `src/ui/hardware-info.ts` |
| LIFE-07 | `src/rendering/renderer.ts` |
| INIT-01, 02 | `src/main.ts` |
| BUILD-01, 02 | `vite.config.ts` |
| BUILD-03 | `vitest.config.ts`, `package.json` (jsdom dep) |
| BUILD-05, 06 | `src/types/three-webgpu.d.ts` |
| TEST-03 | `src/physics/shell.test.ts` |
| TEST-04 | `src/physics/ecsk-physics.test.ts` |
| TEST-05 | `src/compute/compute-emitter.test.ts` |
| A11Y-01..03 | `src/ui/controls.ts`, `index.html` |
| CSS-01..03 | `src/style.css` |
| REPO-01, 02 | `source-processing/*.py` (gitignored) |
| REPO-03 | `*.bat` |

---

## 7. What the planner should produce

For each finding ID, produce a task card with:

1. **Scope** — files, functions, expected diff size.
2. **Preconditions** — what tests must already be passing / what env must be set up.
3. **Acceptance criteria** — usually a new or strengthened test.
4. **Risk** — cross-path parity concerns (mark 🔗 if changing CPU must also change GPU).
5. **Ordering dependency** — list of other task IDs that must complete first (e.g.,
   BUILD-03 before any test task that needs DOM; GPU-02 before PHYS-02).

Suggested epics:
- **Epic A — Emission correctness** (PHYS-01, PHYS-02, GPU-01, GPU-02).
- **Epic B — Teardown & lifecycle** (LIFE-01..09, INIT-01, INIT-02).
- **Epic C — Ring-buffer hardening** (RING-01..05, PHYS-03).
- **Epic D — Worker robustness** (WORK-01..04, PHYS-04).
- **Epic E — Build & test infra** (BUILD-01..03, TEST-01..06).
- **Epic F — Polish** (A11Y, CSS, REPO, remaining 🟡).

End of plan.
