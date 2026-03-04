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
                    CPU (per shell)                    GPU (every frame)
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
    4. Arrival times   │ → sorted by time                   │
    5. Cursor ─────────┼──── main.ts processes arrivals ────┘
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

## Future Work (ranked by urgency)

### P0 — Physics accuracy & hardware utilization
- [x] Full physics review against all 27 source texts (re-audit every equation) — completed, all equations verified correct
- [x] Second full physics review (2025-03-04) against all 29 sources incl. newly added — all equations verified correct; see review notes below
- [ ] Review individual feature implementations against physical expectations
- [ ] Unit tests for physics modules (ecsk-physics, perturbation, shell — pure math, very testable)
- [ ] Performance review and profiling (identify CPU/GPU bottlenecks)
- [ ] WebGPU compute shader for shell initialization (currently CPU — underutilizes GPU)
- [ ] Automatic screen size and refresh rate detection
- [ ] Smooth mode — auto-maximize resolution and refresh rate based on hardware
  (caps particle count, persistence, and bloom to sustain native refresh)
- [ ] Frame budget system — auto-throttle shell rate to maintain target FPS

### P1 — Visual quality (first impression)
- [ ] Review color assignment — current hue mapping (amber→violet via HSL) skews green;
  investigate perceptual color spaces (Oklch), wider hue sweep, or direct blackbody ramp
- [ ] Review all default slider values for best out-of-the-box visual impact
- [ ] Review shell rate and particles-per-shell defaults (balance density vs. performance)
- [ ] Review and rework bloom pipeline (tune thresholds for HDR/SDR)
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
- [ ] HDR implementation with automatic HDR display detection
- [ ] Parameter presets — save/load named configs ("gentle bounce", "critical β", "high turbulence")
- [ ] Screenshot / high-res image export
- [ ] Share state via URL query parameters
- [ ] Colorblind-safe alternate palettes
- [ ] Touch / mobile support (pinch-zoom, swipe, responsive layout)

### P4 — Stretch (nice-to-have / experimental)
- [ ] Anisotropic extension (Kantowski-Sachs with two scale factors X, Y)
- [ ] Particle production modeling (β·H⁴ term from Poplawski 2020 eq.33)
- [ ] Time-lapse accumulation — long-exposure composite of all arrivals (static image)
- [ ] A/B split view — compare two β values side-by-side on same perturbation seed
- [ ] Parameter animation — auto-sweep β or amplitude for cinematic sequences
- [ ] Physics info overlay — toggleable annotations explaining colors/patterns
- [ ] Video recording (WebCodecs or MediaRecorder)
- [ ] Data export — CSV/JSON of bounce statistics (a_min distribution, w_eff histogram)
- [ ] Audio sonification of arrival rate
- [ ] WebXR / VR mode — immersive stereoscopic viewing
- [ ] Versioning & changelog strategy
