# Birth of a Universe — Project Scope & Context

## What This Project Is

A real-time visualization of the **bounce hypersurface** in Poplawski's
Einstein-Cartan-Sciama-Kibble (ECSK) torsion cosmology. The screen shows
a 2D "bounce sensor" — a Lambert equal-area projection of the S² sphere
at the moment when torsion halts the gravitational collapse inside a
black hole and reverses it into expansion: the birth of a new universe.

Each point of light on the sensor represents a comoving fluid element
reaching its local bounce. Perturbations in the spin parameter β across
the sphere cause different regions to bounce at different times, creating
structured patterns (dipole, quadrupole, higher multipoles) that reveal
the physics of the inhomogeneous bounce.

**Tech stack:** TypeScript, Three.js r183 (WebGPU backend), lil-gui, Vite.

The mobile UI now treats iPhone browser fullscreen as unsupported and instead exposes an iOS-specific Add to Home Screen helper for launching the app in standalone mode.

---

## The Physical Story

### What Poplawski's theory says

When a massive star collapses past its event horizon, the interior becomes
a closed universe. In standard GR, this universe collapses to a singularity.
In Einstein-Cartan theory, the quantum spin of fermions produces torsion —
a geometric property of spacetime that creates a repulsive contribution
to the effective energy density at extreme densities.

The dimensionless Friedmann equation for this closed universe is:

    (da̅/dτ̅)² = 1/a̅² − β/a̅⁴ − 1

where a̅ is the dimensionless scale factor and β is the spin parameter
(ratio of torsion energy to radiation energy). The −β/a̅⁴ term grows
faster than the gravitational 1/a̅² term as a̅ → 0, halting contraction
at a finite minimum scale factor:

    a̅²_min = [1 − √(1 − 4β)] / 2

This is the **bounce**. The contraction reverses into expansion, and
the interior of the black hole becomes an expanding baby universe.

### What the visualization shows

Rather than showing the time evolution of the collapse (which would
require choosing a camera position inside a 3D geometry that doesn't
map well to human intuition), the visualization shows a **cross-section
of the bounce hypersurface**.

The S² sphere at the bounce is the 2-sphere of spatial directions at the
moment of maximum compression. Each point on S² corresponds to a comoving
fluid element. If the collapse were perfectly homogeneous (uniform β),
all points would bounce simultaneously and the sensor would flash all at
once. But with perturbations δ(θ,φ), each element has a locally different
β_eff = β(1+δ), giving it a slightly different bounce time and different
physical properties at its bounce.

The visualization maps:
- **Position** on the 2D disk: Lambert equal-area projection of (θ,φ) on S²
- **Hue** (amber → violet): effective equation of state w_eff at bounce
- **Brightness**: energy density ε = 1/a_min⁴ at bounce
- **Size**: acceleration (bounce kick) ä = −1/a³ + 2β/a⁵
- **Arrival time**: when each element reaches its bounce (from sensitivity × δβ)

The result is a continuously evolving pattern of glowing points on a disk,
where the structure directly encodes the physics of the torsion bounce.

### What this is NOT

- It is NOT a 3D tunnel or funnel (there is no tube in the physics)
- It is NOT particles falling through a hole
- The bounce is a property of the metric, not particle trajectories
- The 2D disk is a projection of the S² hypersurface, not a flat plane

---

## Source Material

All source PDFs are in `sources/` (gitignored — copyrighted). All derived
text and equation files are also gitignored (`sources_extracted/`, `sources_marker/`).
The committed artifact is **`EQUATION_CATALOG.md`** — a curated equation
reference compiled from all 27 papers.

### Extraction pipeline

| Step | Tool | Output | Status |
|------|------|--------|--------|
| 1. Plain text | `source-processing/extract_pdfs.py` (PyMuPDF) | `sources_extracted/*.txt` | ✅ all 27 done |
| 2. LaTeX markdown | `source-processing/extract_arxiv.py` (arXiv API) | `sources_marker/*.md` | ✅ 20/27 done |
| 2b. Fallback | `sources_extracted/*.txt` + manual reconstruction | — | ✅ 7 journal-only recovered |

20 papers have arXiv LaTeX source (perfect equation fidelity). The remaining 7
are textbooks or journal-only papers extracted from plain text.

### Key Sources

| File | What it provides |
|------|------------------|
| Poplawski 2010 | Radial geodesics through Einstein-Rosen bridge (eq.5-6). |
| Poplawski 2010b | Friedmann equations with torsion (eq.10-11), ε̃ = ε − αn² (eq.1). |
| Poplawski 2014 | Bounce condition (eq.21-22), time evolution (eq.25), particle production (eq.42-48). **Core reference.** |
| Poplawski 2020 | Kantowski-Sachs field equations (eq.10), shear (eq.24-25), singularity avoidance (eq.32). |
| Poplawski 2020b | Tolman collapse with torsion, oscillatory bounces. |
| Unger & Poplawski 2019 | Closed universe threshold C ≥ 8/9; aT = const. |
| Poplawski 2012 | Spinor-torsion bounce at T_cr ≈ 0.78 m_P. |
| Poplawski 2021 | KS anisotropy, shear, particle production (journal version of 2020). |
| Poplawski 2025 | Black holes in expanding universe (McVittie-ECSK). |
| Tukhashvili 2024 | NJL condensate, sub-Planckian bounce. |

### Supporting Sources

| File | Role |
|------|------|
| Hehl et al. 1976 | Derives ECSK theory. Proves spin averaging gives s² > 0. |
| Hehl & Datta 1971 | Nonlinear spinor equations with torsion (foundational). |
| Böhmer & Bronowski 2006 | Weyssenhoff fluid under cosmological principle. |
| Brechet et al. 2007 | 1+3 covariant Weyssenhoff fluid dynamics. |
| Hashemi 2021 | Independent confirmation: torsion prevents singularity in OS collapse. |
| Alexander et al. 2014 | Gravi-weak unification via torsion. |
| Kranas et al. 2019 | FRW with vectorial torsion. |
| Elizalde et al. 2023 | GW amplitude modification in ECSK. |
| Kirsch et al. 2023 | CCGG quadratic gravity, torsion as dark energy. |
| Alam et al. 2025 | f(R) ECSK anisotropic bounce, Kalb-Ramond field. |
| Shah et al. 2025 | De Donder–Weyl ECSK cosmology. |
| Garcia de Andrade 2018 | Chiral torsion dynamo, primordial magnetic fields. |
| Sadatian & Hosseini 2025 | F(T) gravity + BCS condensate, exact bounce. |
| Gourgoulhon 2007 | 3+1 formalism reference (220 pages). |
| MTW (Misner et al. 2017) | Gravitation textbook. |
| Parker & Toms 2009 | QFT in curved spacetime. Particle creation. |
| Wald 1984 | General Relativity textbook. |

---

## Core Physics (verified against sources)

Every equation in the codebase was audited against the source papers.

### Dimensionless Friedmann equation (D1)
From Poplawski 2010b eq.10, 16; 2014 eq.10, 20; 2020b eq.27, 28:

    (da̅/dτ̅)² = 1/a̅² − β/a̅⁴ − 1

Valid range: 0 < β < 1/4 (finite bounce requires 4β < 1).

### Bounce condition (D3)
From Poplawski 2014 eq.20-22:

    a̅²_min = [1 − √(1 − 4β)] / 2

### Acceleration at bounce (D2)
From Poplawski 2010b eq.16, 2014 eq.10 (derived by differentiating D1):

    d²a̅/dτ̅² = −1/a̅³ + 2β/a̅⁵

### Effective equation of state (EOS)
Derived from ε̃ = 1/a⁴ − β/a⁶ and p̃ = 1/(3a⁴) − β/a⁶:

    w_eff = (a̅² − 3β) / (3(a̅² − β))

Not explicitly stated in the papers but correctly derived from
Poplawski 2014 eq.9 (ε̃ = ε − αn², p̃ = p − αn²) and radiation EOS p = ε/3.

### Coupling constant
From Hehl & Datta 1971, Hehl et al. 1976, Poplawski 2010b:

    α = κ(ℏc)²/32    where κ = 8πG/c⁴

### Perturbation model (extrapolation)
The perturbation field δ(θ,φ) is a **physically motivated extrapolation**,
not taken directly from the papers (which treat the homogeneous case).
It applies the separate-universe approximation: each fluid element
evolves with its own β_eff = β(1+δ).

Spectrum: C_l ∝ l^(n_s − 1) × exp(−(l/l_silk)²)
- n_s = 0.965 (Planck 2018 scalar spectral index)
- l_silk = 0.6 × l_max (Silk-type damping)
- Coefficients expanded in real spherical harmonics Y_l^m(θ,φ)

---

## Architecture

### How it works

```
                 Worker thread (per shell)              GPU (every frame)
              ┌─────────────────────────┐         ┌──────────────────┐
  ECSKPhysics │ β → a_min, w_eff, ε, ä │         │  Three.js WebGPU │
              └────────┬────────────────┘         │  OrthographicCam │
                       │                          │  Additive Points │
  Perturbation │ Y_lm coeffs for this shell │     │  + Bloom         │
              └────────┬────────────────┘         └─────────┬────────┘
                       │                                    │
  InfallingShell       │ N points on S²                     │
    1. Sample uniform  │ Lambert projection                 │
    2. Evaluate δ(θ,φ) │ → β_eff per point                 │
    3. Bounce props    │ → hue, brightness, size            │
    4. Arrival times   │ → MinHeap (priority queue)         │
                       │                                    │
  ── Web Worker boundary (physics-worker.ts) ──────────     │
                       │                                    │
  PhysicsBridge        │ batches arrive via postMessage     │
    main.ts drains ────┼──── processes arrivals ────────────┘
                       │         ↓
                   Hit[] array → renderer.updateHits()
```

Each frame:
1. Advance simulation time
2. Spawn new shells at configured rate (each = batch of S² samples)
3. Process arrivals: advance each shell's cursor, emit Hits
4. Fade old hits (exponential decay with persistence time constant)
5. Write positions + colors to GPU buffer attributes
6. Render via Three.js WebGPU with bloom post-processing

### File structure

```
src/
  physics/
    ecsk-physics.ts     — ECSK bounce physics (bounceProps, halfPeriod, sensitivity)
    perturbation.ts     — Spherical harmonics, spectrum, splitmix32 PRNG
    shell.ts            — Infalling shell: S² sampling, Lambert, arrival sorting
    physics-bridge.ts   — Main-thread ↔ Web Worker bridge (async particle batches)
    physics-worker.ts   — Off-main-thread physics: shell spawning + arrival computation
    min-heap.ts         — O(log N) binary min-heap for pending-particle priority queue
  rendering/
    renderer.ts         — 2D sensor: OrthographicCamera, additive Points, bloom
  ui/
    controls.ts         — lil-gui panels (physics, flow, display, readout)
  types/
    three-webgpu.d.ts   — Type declarations for Three.js WebGPU subpath exports
  main.ts               — Orchestration: shell spawning, arrival processing, HUD
index.html              — Entry point
vite.config.ts          — Vite dev server config
tsconfig.json           — TypeScript strict, ES2022
package.json            — three r183, lil-gui, vite 7.3.1
```

---

## Parameters (lil-gui controls)

### Collapse Physics
| Parameter | Meaning | Range |
|-----------|---------|-------|
| β | Spin parameter (torsion-to-radiation energy) | 0.005 – 0.249 |
| Inhomogeneity | Perturbation amplitude across S² | 0.001 – 0.6 |
| Turbulence (l_max) | Maximum spherical harmonic multipole | 1 – 24 |

### Flow
| Parameter | Meaning | Range |
|-----------|---------|-------|
| Shell rate | Shells spawned per second | 0.1 – 20 |
| Particles/shell | Points sampled on S² per shell | 50 – 10000 |
| Time dilation | Stretches arrival time spread | 1 – 10000 |

### Sensor Display
| Parameter | Meaning | Range |
|-----------|---------|-------|
| Hit size | Point size in pixels | 1 – 30 |
| Brightness | Color intensity multiplier | 0.1 – 5 |
| Persistence | Fade time constant (seconds) | 0.1 – 20 |
| Bloom | Enable/strength/radius | toggle + sliders |

### Readout (read-only HUD)
β, a_min, w_eff, S (torsion ratio), flux (/s), visible hits, FPS.

---

## What's Done

- [x] Physics audit: all equations verified against 27 source papers; full catalog in `EQUATION_CATALOG.md`
- [x] `ecsk-physics.ts`: bounce properties, half-period integral, sensitivity
- [x] `perturbation.ts`: real spherical harmonics, spectral synthesis, PRNG
- [x] `shell.ts`: S² sampling, Lambert projection, arrival time computation
- [x] `renderer.ts`: 2D orthographic sensor with additive blend + bloom
- [x] `main.ts`: shell spawning, cursor-based arrival processing, hit fading
- [x] `controls.ts`: full lil-gui panel with physics/flow/display/readout
- [x] Clean TypeScript compilation (zero errors)
- [x] `EQUATION_CATALOG.md` — 1 027-line equation reference, all 27 papers, §1–§25
- [x] Source processing pipeline: PyMuPDF plain text → arXiv LaTeX download → `sources_marker/`
- [x] Project cleanup: dead files removed, source-processing scripts quarantined to `source-processing/` (gitignored), all source material folders gitignored
- [x] Full physics review against all 27 source texts (re-audit every equation) — all equations verified correct
- [x] Second full physics review (2025-03-04) against all 29 sources incl. newly added — all equations verified correct
- [x] `physics-bridge.ts`: Web Worker bridge — off-main-thread physics computation (~16 ms latency at 60 fps)
- [x] `physics-worker.ts`: physics Web Worker — shell spawning + arrival computation runs in dedicated thread
- [x] `min-heap.ts`: O(log N) priority queue for pending-particle arrivals (replaced O(N) sorted-array + splice)

## Future Work (ranked by urgency)

### P0 — Physics accuracy & hardware utilization
- [ ] Review individual feature implementations against physical expectations
- [x] Unit tests for physics modules (ecsk-physics, perturbation, shell — pure math, very testable)
- [ ] Performance review and profiling (identify CPU/GPU bottlenecks)
- [ ] WebGPU compute shader for shell initialization (currently CPU — underutilizes GPU)
- [x] Automatic screen size and refresh rate detection
- [ ] Smooth mode — auto-maximize resolution and refresh rate based on hardware
  (caps particle count, persistence, and bloom to sustain native refresh)
- [x] Frame budget system — auto-throttle shell rate to maintain target FPS
- [x] **Spectral index n_s slider** — expose the currently hardcoded n_s = 0.965 in
  perturbation.ts as a UI slider. Controls power-spectrum tilt: lower n_s gives more
  large-scale structure (big blobs), higher gives scale-invariant texture. Connected
  to torsion-fermion coupling ξ via |ν|² = 1 − 8ξ (Sadatian & Hosseini 2025 eq. 37).
  Trivial to implement — pure constant extraction.
- [x] **Curvature k selector** — add k ∈ {−1, 0, +1} dropdown. Currently hardcoded
  to k=+1 (closed universe). Changes the "−1" in D1 to "−k". For k=0 and k=−1
  the bounce still occurs but the turnaround/recollapse behavior differs.
  (Cubero & Popławski 2019; Unger & Popławski 2019 eq. 7)
- [x] **Double bounce visualization** — for k=+1 near the Cubero & Popławski threshold
  (C > e^{−1/2}), the closed universe exhibits two local minima in the scale factor
  as temperature oscillates. Visually: a second wave of particles arriving after
  the first, creating a rhythmic pulsation. Requires coupling to k and C.
  (Cubero & Popławski 2019 §26)
- [ ] **Anisotropy / Shear σ²** — Kantowski-Sachs interior with two independent scale
  factors X(t), Y(t). Shear σ² = ⅓(Ẋ/X − Ẏ/Y)² competes against torsion; if shear
  wins, no bounce occurs (Popławski 2020 eq. 25, 32; 2021 eq. 5–7). As a slider, σ₀
  would deform the S² projection into an ellipse with axis ratio encoding X/Y. The
  core drama of the bounce is this torsion-vs-shear competition. Requires replacing
  single-a evolution with (X, Y) pair + modified Lambert projection.
- [x] **Particle production** — post-bounce fermion creation at rate ṅ_f + 3Hn_f = β_pp H⁴
  (Popławski 2014 eq. 40–46; 2020 eq. 33; 2021 eq. 8). Critical rate β_cr ≈ 1/929.
  Drives the transition from bounce to inflation. Visually: a second surge of
  particles with different colors (higher T/energy) after the initial bounce wave.
  Completes the narrative — currently the sim shows only the bounce, not the birth.

### P1 — Visual quality (first impression)
- [ ] Review color assignment — current hue mapping (amber→violet via HSL) skews green;
  investigate perceptual color spaces (Oklch), wider hue sweep, or direct blackbody ramp
- [ ] Review all default slider values for best out-of-the-box visual impact
- [ ] Review and rework bloom pipeline (tune thresholds for HDR/SDR)
- [x] Scale Hypersurface to screen
- [ ] Flow tails — short streaks showing arrival direction, with:
  - Length modifier (slider)
  - Toggle on/off

### P2 — Ship-ready (infrastructure for first commit/deploy)
- [ ] LICENSE file
- [ ] Add screenshot/GIF to README.md
- [ ] Graceful WebGPU fallback — detect missing support, show compatibility message
- [ ] Build & deploy story (GitHub Pages / Vercel via `vite build`)
- [ ] Rework UI: toggleable panel (hotkey to show/hide), dark OLED-friendly theme
- [ ] Keyboard shortcuts (space = pause, R = reset, H = hide UI, number keys for presets)

### P3 — Polish (display quality & platform support)
- [x] HDR implementation with automatic HDR display detection
- [ ] Parameter presets — save/load named configs ("gentle bounce", "critical β", "high turbulence")
- [ ] Screenshot / high-res image export
- [ ] Share state via URL query parameters
- [ ] Colorblind-safe alternate palettes and other accessibility parameters
- [ ] Touch / mobile support (pinch-zoom, swipe, responsive layout)
- [ ] **Performance-aware slider value coloring** — the numeric readout for each slider is
  tinted on a continuous green → orange → red gradient based on available performance
  headroom for that parameter. Green = ample headroom to push higher; orange = moderate
  load; red = near the performance ceiling. Requires (a) a lightweight ongoing measurement
  of frame-budget consumption (CPU + GPU), and (b) a per-parameter cost model that
  estimates how much increasing a given slider would affect frame time.
  ⚠️ *Lower priority. The monitoring and cost-estimation logic must be negligible in its
  own overhead — it must not consume CPU/GPU budget that would otherwise go to the
  simulation itself.*

### P4 — Stretch (nice-to-have / experimental)
- [ ] **ξ-coupling slider** — generalized torsion-pseudovector strength (Lucat & Prokopek
  2015 eq. 1): α₅ = 3πG_N ξ²/2. Standard EC is ξ=1; ξ=0 recovers GR (no bounce).
  Mathematically equivalent to rescaling β by ξ², so no new dynamics — but high
  educational value: the user can "turn off torsion" and watch the bounce vanish.
- [ ] **EOS convention toggle** — switch between spin-fluid (p̃ = p − αn²) and Dirac-
  spinor (p̃ = p + αn²) conventions for the w_eff color encoding. Both give identical
  D1 dynamics; only the hue mapping changes. Spin-fluid: w < −⅓ at bounce (violet);
  Dirac: w > 1 (amber-red). Already commented in ecsk-physics.ts lines 88–95.
  (EQUATION_CATALOG §11 cross-check 2, §14, §26)
- [ ] **Adiabatic invariant C threshold** — expose C = aT/(a_cr T_cr) as a dial.
  For k=+1, C ≥ 8/9 is necessary for a closed universe to exist at all
  (Unger & Popławski 2019 eq. 7–8). Below threshold, the solution vanishes —
  particles stop appearing. Dramatic on/off transition. Requires reparametrizing
  the Friedmann equation from β to (C, k).
- [ ] **Temperature color encoding** — alternative hue mode mapping temperature T ∝ 1/a̅
  instead of w_eff. High-T hits glow white-blue (Planck-scale), cooling hits shift
  to red. More intuitive "thermal" look for non-physicists. T_max = 1.15 × 10³² K
  (Popławski 2014 eq. 21). Offered as a dropdown toggle in Display panel.
- [ ] Time-lapse accumulation — long-exposure composite of all arrivals (static image)
- [ ] A/B split view — compare two β values side-by-side on same perturbation seed
- [ ] Parameter animation — auto-sweep β or amplitude for cinematic sequences
- [ ] Physics info overlay — toggleable annotations explaining colors/patterns
- [ ] Video recording (WebCodecs or MediaRecorder)
- [ ] Data export — CSV/JSON of bounce statistics (a_min distribution, w_eff histogram)
- [ ] Audio sonification of arrival rate
- [ ] WebXR / VR mode — immersive stereoscopic viewing
- [ ] Versioning & changelog strategy
