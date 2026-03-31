# Performance Tasks — Birth of a Universe

> Each task below is **self-contained**: a fresh chat instance with no prior
> context can pick up any single task and implement it. File paths, current
> code, the exact change required, and acceptance criteria are all included.
>
> **Context:** This is a WebGPU particle simulation. Physics runs in Web
> Workers (`shell.ts` emitter → `physics-worker.ts` packer → main thread
> ring buffer → GPU instanced draw). The bottleneck at high particle counts
> is CPU time in the workers, not the GPU.
>
> **Build:** `npm run build` &nbsp;|&nbsp; **Test:** `npx vitest run`

---

## Task 1 of 2 — Eliminate PendingParticle object allocations

### Why this matters
At high particle rates (50K+/s), the emitter in `shell.ts` creates one
`PendingParticle` JS object per particle, pushes it into an array, and
returns it. The worker in `physics-worker.ts` then immediately destructures
each object field-by-field into a flat `Float32Array` for transfer. This
double-copy through an object layer creates tens of thousands of short-lived
objects per tick per worker, generating GC pressure that causes intermittent
frame stutters on the main thread.

### Safety notes
- **Simulation accuracy:** UNAFFECTED. The same physics math runs, producing
  the same float values. Only the container changes (flat array vs object).
- **Visual quality:** UNAFFECTED. Bit-identical output.
- **Existing tests:** `shell.test.ts` currently accesses `result[i].lx`,
  `result[i].hue`, etc. Tests must be updated to use stride offsets or you
  must provide a thin accessor. Either approach is fine.

### Files involved
| File | Role |
|------|------|
| `src/physics/shell.ts` | `StreamEmitter.tick()` — produces particles |
| `src/physics/shell.test.ts` | Tests for StreamEmitter |
| `src/physics/physics-worker.ts` | Packs `PendingParticle[]` into `Float32Array` for transfer |

### Current data flow (the problem)

**Step 1 — shell.ts `tick()` already computes into flat buffers:**
```typescript
const lxBuf = new Float32Array(count);
const lyBuf = new Float32Array(count);
const tBuf  = new Float32Array(count);
const hueBuf = new Float32Array(count);
const briBuf = new Float32Array(count);
const epsBuf = new Float32Array(count);
const accBuf = new Float32Array(count);
const tailBuf = new Float32Array(count);
// ... physics loop fills these buffers ...
```

**Step 2 — shell.ts then copies them into objects (wasteful):**
```typescript
result.push({
  lx:          lxBuf[i],
  ly:          lyBuf[i],
  arrivalTime: tBuf[i],
  hue:         hueBuf[i],
  brightness:  bri,
  eps:         epsBuf[i] * dbBriScale,
  hitSize:     /* ... */,
  tailAngle:   tailBuf[i],
});
```

**Step 3 — physics-worker.ts copies them back into a flat array:**
```typescript
const buf = new Float32Array(count * STRIDE);
for (let i = 0; i < count; i++) {
  const p = particles[i];
  const off = i * STRIDE;
  buf[off]     = p.lx;
  buf[off + 1] = p.ly;
  buf[off + 2] = p.arrivalTime;
  buf[off + 3] = p.hue;
  buf[off + 4] = p.brightness;
  buf[off + 5] = p.eps;
  buf[off + 6] = p.hitSize;
  buf[off + 7] = p.tailAngle;
}
```

Steps 2 and 3 are pure waste. The data starts flat and ends flat, with
50K object allocations in between.

### What to implement

**Change `tick()` to return `{ data: Float32Array, count: number }` instead
of `PendingParticle[]`.** Write directly into a single stride-8 `Float32Array`.

The stride layout (8 floats per particle) already exists and is defined in
both `physics-worker.ts` and `physics-bridge.ts`:
```
[0] lx   [1] ly   [2] arrivalTime   [3] hue
[4] brightness   [5] eps   [6] hitSize   [7] tailAngle
```

#### 1. shell.ts — Change the `tick()` return type and body

The `PendingParticle` interface and `result` array should no longer be the
return value of `tick()`. Add a new return type:

```typescript
export interface ParticleBatch {
  data: Float32Array;
  count: number;
}
```

Change `tick()` signature from:
```typescript
tick(dt: number, now: number, particleRate: number): PendingParticle[]
```
to:
```typescript
tick(dt: number, now: number, particleRate: number): ParticleBatch
```

Inside the function body:

- Remove the 8 separate temporary `Float32Array` buffers (`lxBuf`, `lyBuf`,
  `tBuf`, `hueBuf`, `briBuf`, `epsBuf`, `accBuf`, `tailBuf`).
- Remove the `wBuf` and `result` arrays.
- Instead, allocate a single output buffer. The total particle count is
  `count` (bounce particles) plus `ppCount` (production particles, if
  `betaPP > 0`). Compute `ppCount` before allocating:

```typescript
const ppFraction = c.betaPP > 0
  ? Math.min(PP_FRACTION_CAP, c.betaPP / ECSKPhysics.BETA_CR)
  : 0;
const ppCount = c.betaPP > 0 ? Math.max(0, Math.floor(count * ppFraction)) : 0;
const totalCount = count + ppCount;
const STRIDE = 8;
const out = new Float32Array(totalCount * STRIDE);
```

- The first physics loop (bounce particles, `i = 0..count-1`) writes to
  `out[i * STRIDE + 0..7]` instead of into separate buffers.
- You still need the two-pass approach for hue (first pass computes
  `wEff` min/max, second pass maps to hue). Use local variables or
  small scratch arrays for `wEff` and `acc` values that need post-processing.
  These scratch arrays are fine — they hold intermediate physics values,
  not the output. The key win is eliminating the `PendingParticle` objects.
- The production-particle loop (if active) writes starting at offset
  `count * STRIDE` in the same `out` buffer.
- Return `{ data: out, count: totalCount }` (or `{ data: out, count: 0 }`
  when `totalCount === 0` — you can use a shared empty buffer for that case).

**Important:** The `wEff → hue` mapping requires a min/max pass over all
bounce particles (and separately over production particles). You need to
keep small scratch storage for `wEff` and `acc` per particle since these
aren't part of the output stride but are needed to compute `hue` and
`hitSize` in the second pass. Use typed arrays for these:

```typescript
const wScratch   = new Float32Array(count);  // wEff values
const accScratch = new Float32Array(count);  // acc values
const briScratch = new Float32Array(count);  // brightness before dbBriScale
const epsScratch = new Float32Array(count);  // eps before dbBriScale
```

These are 4 small arrays vs the previous 8, and — critically — no object
allocations. The same pattern applies to the production particle section.

#### 2. physics-worker.ts — Remove the repacking loop

The worker currently calls `emitter.tick()` and then repacks the result.
After the change, `tick()` already returns the transfer-ready buffer:

Replace:
```typescript
const particles = emitter.tick(msg.dt, msg.simTime, cappedRate);
const count = particles.length;
// ... tickElapsedMs ...
if (count === 0) { /* post empty */ break; }
const buf = new Float32Array(count * STRIDE);
for (let i = 0; i < count; i++) {
  const p = particles[i];
  const off = i * STRIDE;
  buf[off]     = p.lx;
  // ... 7 more fields ...
}
_self.postMessage(
  { type: "particles", count, data: buf, generation, tickMs: tickElapsedMs },
  [buf.buffer],
);
```

With:
```typescript
const batch = emitter.tick(msg.dt, msg.simTime, cappedRate);
const tickElapsedMs = performance.now() - tickStart;
if (batch.count === 0) {
  _self.postMessage({ type: "particles", count: 0, data: null, generation, tickMs: tickElapsedMs });
  break;
}
_self.postMessage(
  { type: "particles", count: batch.count, data: batch.data, generation, tickMs: tickElapsedMs },
  [batch.data.buffer],
);
```

#### 3. shell.test.ts — Update test accessors

Tests currently do things like `result[0].hue`. Update them to read from
the flat buffer using stride offsets, or add a small test helper:

```typescript
function readParticle(data: Float32Array, index: number) {
  const o = index * 8;
  return {
    lx: data[o], ly: data[o+1], arrivalTime: data[o+2], hue: data[o+3],
    brightness: data[o+4], eps: data[o+5], hitSize: data[o+6], tailAngle: data[o+7],
  };
}
```

#### 4. Keep the `PendingParticle` interface

Don't delete the `PendingParticle` interface — it documents the stride
layout and may be used by other code or comments. Just mark it as
documentation-only or leave it. The type is no longer the return value
of `tick()` but removing it is unnecessary churn.

### Acceptance criteria
- `tick()` returns `{ data: Float32Array, count: number }`.
- Zero `PendingParticle` objects are created at runtime.
- The worker's packing loop is gone — `tick()` output goes directly to
  `postMessage` transfer.
- All existing tests pass after updating accessors (`npx vitest run`).
- Build succeeds (`npm run build`).
- **Verification:** The visual output is identical — same particle positions,
  colors, sizes, and timing. No physics or visual regression.

---

## Task 2 of 2 — Optimize spherical harmonic evaluation with single-pass Legendre recurrence

### Why this matters
`evaluatePerturbation()` in `perturbation.ts` is the single most expensive
function in the physics workers. For each particle, it loops over all
`(lMax² + 2·lMax)` coefficient modes and calls `ylmReal(l, m, cosT, sinT, phi)`
for each one. At `lMax=32` that's 1088 calls per particle.

The problem: `ylmReal` recomputes the Associated Legendre Polynomial `P_l^m`
from scratch for every `(l, m)` pair. It starts from `P_m^m` (a loop of
length `m`) and recurs upward to `P_l^m` (a loop of length `l - m`). Most
of this work is redundant — `P_3^2` recomputes `P_2^2` which was already
computed when evaluating `P_2^2` directly.

A single-pass approach that walks `m = 0..lMax`, then `l = m..lMax` at each
`m`, reuses intermediate Legendre values and eliminates all redundant work.
This is 5-10× faster for `lMax ≥ 16`.

### Safety notes
- **Simulation accuracy:** The mathematical output must be identical.
  The Associated Legendre recurrence is the same; only the traversal
  order changes to avoid redundant computation. The recurrence used
  (upward in `l` for fixed `m`) is numerically stable and standard.
- **Visual quality:** Bit-for-bit identical perturbation field values →
  identical particle positions, colors, timing.
- **Existing tests:** `perturbation.test.ts` should continue to pass
  unchanged since the function signatures and outputs don't change.

### Files involved
| File | Role |
|------|------|
| `src/physics/perturbation.ts` | `ylmReal()` and `evaluatePerturbation()` |
| `src/physics/perturbation.test.ts` | Unit tests for perturbation evaluation |

### Current code (perturbation.ts)

**`ylmReal` — called once per (l, m) per particle:**
```typescript
function ylmReal(
  l: number, m: number,
  cosTheta: number, sinTheta: number, phi: number,
): number {
  const am = Math.abs(m);

  // P_m^m via starting recurrence
  let pmm = 1;
  for (let i = 1; i <= am; i++) pmm *= -(2 * i - 1) * sinTheta;

  let plm: number;
  if (l === am) {
    plm = pmm;
  } else {
    const pmm1 = cosTheta * (2 * am + 1) * pmm;
    if (l === am + 1) {
      plm = pmm1;
    } else {
      plm = 0;
      let a = pmm, b = pmm1;
      for (let ll = am + 2; ll <= l; ll++) {
        plm = ((2 * ll - 1) * cosTheta * b - (ll + am - 1) * a) / (ll - am);
        a = b;
        b = plm;
      }
    }
  }

  // Normalization factor
  let norm = (2 * l + 1) / (4 * Math.PI);
  let fac = 1;
  for (let i = l - am + 1; i <= l + am; i++) fac *= i;
  norm = Math.sqrt(norm / fac);

  if (m > 0) return norm * plm * Math.sqrt(2) * Math.cos(m * phi);
  if (m < 0) return norm * plm * Math.sqrt(2) * Math.sin(am * phi);
  return norm * plm;
}
```

**`evaluatePerturbation` — loops over all modes per particle:**
```typescript
export function evaluatePerturbation(
  coeffs: PerturbMode[],
  cosT: number, sinT: number, phi: number,
): number {
  let delta = 0;
  for (const { l, m, c } of coeffs) {
    delta += c * ylmReal(l, m, cosT, sinT, phi);
  }
  return delta;
}
```

### What to implement

Replace `evaluatePerturbation` with a single-pass version that walks the
Legendre recurrence once for all modes at a given `(cosT, sinT, phi)`.
Keep `ylmReal` as-is (it's still useful for tests and one-off evaluations).

The key insight: coefficients in the `PerturbMode[]` array are ordered by
`(l, m)` with `l` from 1 to `lMax` and `m` from `-l` to `+l` (this is how
`generatePerturbCoeffs` creates them). But for Legendre efficiency we need
to walk by `m` first (outer loop), then `l` upward (inner loop).

#### Step 1: Pre-build a coefficient lookup

Add a function that reorganizes coefficients into a structure indexed by
`(m, l)` for fast access. This should be called once when coefficients are
generated or when `lMax` changes — NOT per particle. Add it to the
`StreamEmitter` class or as a cached structure on the coefficients.

A simple approach: build a 2D lookup `coeffsByM: Map<number, {l: number, c_ref: PerturbMode}[]>`
or, better, a flat `Float64Array` indexed by `(m, l)` offset. The simplest
version that avoids object allocation:

```typescript
/**
 * Build a lookup table for fast single-pass evaluation.
 * Returns an array of {mAbs, mSign, lStart, coeffSlice} groups.
 * coeffSlice[i] is the coefficient index for l = lStart + i.
 */
```

Alternatively (and simpler): since the coefficients array is already ordered
by `(l, m)`, you can build an index that maps `m → list of (l, coeffIndex)`
pairs. This is a one-time cost per coefficient regeneration.

#### Step 2: Replace the evaluation hot path

```typescript
export function evaluatePerturbationFast(
  coeffs: PerturbMode[],
  lMax: number,
  cosT: number,
  sinT: number,
  phi: number,
): number {
  let delta = 0;

  // Precompute cos(m·φ) and sin(m·φ) for m = 0..lMax
  // using recurrence: cos((m+1)φ) = 2·cos(φ)·cos(mφ) − cos((m−1)φ)
  const cosPhiArr = new Array(lMax + 1);
  const sinPhiArr = new Array(lMax + 1);
  cosPhiArr[0] = 1;
  sinPhiArr[0] = 0;
  if (lMax >= 1) {
    cosPhiArr[1] = Math.cos(phi);
    sinPhiArr[1] = Math.sin(phi);
  }
  for (let m = 2; m <= lMax; m++) {
    cosPhiArr[m] = 2 * cosPhiArr[1] * cosPhiArr[m-1] - cosPhiArr[m-2];
    sinPhiArr[m] = 2 * cosPhiArr[1] * sinPhiArr[m-1] - sinPhiArr[m-2];
  }

  // Walk m = 0..lMax. For each m, compute P_m^m via the sectoral
  // starting value, then recur upward in l from m to lMax.
  // This visits every (l, m) exactly once with zero redundant work.
  //
  // The coefficients array is indexed as:
  //   For l=1..lMax, m=-l..+l  →  index = (l-1)*(l-1) + (l-1) + (m + l - 1)
  //                                      = l² - 1 + m
  // (since l=1: indices 0,1,2; l=2: indices 3..7; etc.)
  // More precisely: index = sum_{k=1}^{l-1} (2k+1) + (m + l)
  //                       = (l-1)² + 2(l-1) + (m + l)  [can simplify]
  // Verify: l=1,m=-1 → idx=0; l=1,m=0 → idx=1; l=1,m=1 → idx=2;
  //         l=2,m=-2 → idx=3; ... l=2,m=2 → idx=7.
  // Formula: idx = (l-1)^2 + 2(l-1) + (m + l) = l² - 1 + m + l ... no.
  // Let's just compute: baseIndex(l) = sum(2k+1, k=1..l-1) = l² - 1
  // Then for a given l, m ranges -l..+l, so offset = m + l.
  // idx(l, m) = l² - 1 + m + l = l² + l + m - 1

  const SQRT2 = Math.SQRT2;
  let pmm_m = 1.0;  // P_0^0 = 1; will become P_m^m as m increments

  for (let m = 0; m <= lMax; m++) {
    // Sectoral value P_m^m
    // For m=0: pmm = 1
    // For m>0: pmm *= -(2m-1) * sinT  (standard recurrence)
    if (m > 0) {
      pmm_m *= -(2 * m - 1) * sinT;
    }

    // Normalization for (l=m, m):
    // N_l^m = sqrt((2l+1)/(4π) · (l-m)!/(l+m)!)
    // For l=m: (l-m)! = 0! = 1, (l+m)! = (2m)!
    let norm_mm = (2 * m + 1) / (4 * Math.PI);
    { let f = 1; for (let i = 1; i <= 2 * m; i++) f *= i; norm_mm = Math.sqrt(norm_mm / f); }

    // We need to handle l = m..lMax.
    // l < m modes don't exist.  l must be >= 1 per coefficient generation.
    // Skip m values that exceed lMax or have no coefficients (l starts at 1).
    if (m > lMax) break;

    // Upward recurrence in l: P_{l+1}^m from P_l^m and P_{l-1}^m
    let plm_prev = 0;        // P_{m-1}^m (doesn't exist, set to 0)
    let plm_curr = pmm_m;    // P_m^m
    let norm_prev = 0;
    let norm_curr = norm_mm;

    for (let l = m; l <= lMax; l++) {
      // Skip l=0 (no l=0 modes in the coefficient array)
      if (l >= 1) {
        const idx = l * l + l + m - 1;  // index for (l, +m)
        const idxNeg = l * l + l - m - 1;  // index for (l, -m)

        // Positive m contribution (or m=0)
        if (m === 0) {
          // m=0: Y_l^0 = N · P_l^0
          if (idx >= 0 && idx < coeffs.length) {
            delta += coeffs[idx].c * norm_curr * plm_curr;
          }
        } else {
          // m > 0: Y_l^{+m} = N · P_l^m · √2 · cos(mφ)
          if (idx >= 0 && idx < coeffs.length) {
            delta += coeffs[idx].c * norm_curr * plm_curr * SQRT2 * cosPhiArr[m];
          }
          // m < 0 (stored as -m): Y_l^{-m} = N · P_l^m · √2 · sin(mφ)
          if (idxNeg >= 0 && idxNeg < coeffs.length) {
            delta += coeffs[idxNeg].c * norm_curr * plm_curr * SQRT2 * sinPhiArr[m];
          }
        }
      }

      // Recurrence: advance l → l+1
      if (l < lMax) {
        const l1 = l + 1;
        const plm_next = ((2 * l1 - 1) * cosT * plm_curr - (l1 + m - 1) * plm_prev) / (l1 - m);
        plm_prev = plm_curr;
        plm_curr = plm_next;

        // Normalization for (l+1, m)
        let norm_next = (2 * l1 + 1) / (4 * Math.PI);
        { let f = 1; for (let i = l1 - m + 1; i <= l1 + m; i++) f *= i; norm_next = Math.sqrt(norm_next / f); }
        norm_prev = norm_curr;
        norm_curr = norm_next;
      }
    }
  }

  return delta;
}
```

**IMPORTANT: The index formula above is pseudocode.** The coefficient array
is built by `generatePerturbCoeffs` which iterates `l=1..lMax`, `m=-l..+l`.
You MUST verify the exact index mapping by reading `generatePerturbCoeffs`
and confirming that `coeffs[idx]` has the expected `(l, m)` values. Add an
assertion in dev mode if needed. Getting the index wrong silently corrupts
the perturbation field.

The safest approach: **build a 2D index map once** after coefficients are
generated (a `Map<string, number>` keyed by `"l,m"` → array index, or better,
a flat array `coeffIndex[l][m+l]`). Use this to look up coefficient indices
during evaluation. This adds a tiny one-time cost but eliminates any risk of
index formula bugs.

#### Step 3: Wire it into `evaluatePerturbation`

Either:
- (a) Replace the body of `evaluatePerturbation` with the fast version, or
- (b) Add `evaluatePerturbationFast` as a new export and call it from
  `shell.ts` instead of the old one. Keep the old one for tests/reference.

Option (b) is safer during development — you can compare both outputs in
tests.

The fast version needs `lMax` as a parameter (the current version infers it
from the coefficients array length). You can compute it as:
```typescript
// coeffs has (lMax² + 2·lMax) entries → lMax = (√(len+1)) - 1
const lMax = Math.round(Math.sqrt(coeffs.length + 1)) - 1;
```
Or pass it explicitly from the emitter (it already knows `cfg.lMax`).

#### Step 4: Precompute normalization factors

The normalization factor `N_l^m = √((2l+1)/(4π) · (l-m)!/(l+m)!)` involves
a factorial loop that runs `2m` iterations per mode. This can be precomputed
once per coefficient generation (not per particle). Add a `norm` field to
`PerturbMode` or build a parallel `Float64Array` of normalization values.

This is optional but gives an additional ~2× speedup on top of the Legendre
optimization. If you do it, compute norms in `generatePerturbCoeffs` and
store alongside the coefficients.

### Acceptance criteria
- `evaluatePerturbation` (or its replacement) produces identical output for
  all `(l, m, cosT, sinT, phi)` inputs. **Write a comparison test** that
  evaluates both old and new versions on 1000+ random points and asserts
  they match within `1e-12` relative tolerance.
- At `lMax=32`, the new version is measurably faster (benchmark in test or
  manual console timing). Target: ≥3× speedup.
- All existing tests pass (`npx vitest run`).
- Build succeeds (`npm run build`).
- The coefficient array structure (`PerturbMode[]`) is unchanged for
  `generatePerturbCoeffs`, `evolveCoeffs`, `rescaleCoeffSigmas`, and
  `applyCoeffs`. Only the evaluation function changes.
- **No changes** to `generatePerturbCoeffs`, `evolveCoeffs`,
  `rescaleCoeffSigmas`, `splitmix32`, or any code outside the evaluation
  path.
