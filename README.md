# Birth of a Universe

Real-time visualization of the bounce hypersurface inside a black hole, based on
Nikodem Poplawski's Einstein-Cartan-Sciama-Kibble (ECSK) torsion cosmology.

The app renders a 2D bounce sensor: a Lambert equal-area projection of the S²
hypersurface at the instant spin-torsion halts collapse and reverses it into
expansion. Each glowing point represents a comoving fluid element reaching its
local bounce. Structured perturbations in the spin parameter $\beta$ turn that
hypersurface into an evolving pattern of color, brightness, and timing.

## What the app does

- Simulates ECSK bounce physics with perturbations on the sphere.
- Renders the sensor in real time with Three.js on the WebGPU backend.
- Uses worker-based physics generation so emission and rendering stay decoupled.
- Adapts slider limits and visual defaults to detected hardware capability.
- Includes a mobile layout, HUD readouts, bloom controls, and an optional 3D bounce explainer.

## Requirements

- Node.js 18+
- A WebGPU-capable browser such as recent Chrome or Edge
- A GPU/driver stack with WebGPU enabled

There is no non-WebGPU fallback path. If renderer initialization fails, the app will stop at startup.

## Quick start

```bash
git clone https://github.com/8Rotation/Birth-of-a-Universe.git
cd Birth-of-a-Universe
npm install
npm run dev
```

Open the local Vite URL, usually `http://localhost:5173/`.

On Windows, you can also use `double click to start.bat` for a local launch flow.

## Scripts

```bash
npm run dev        # start Vite dev server
npm run build      # run TypeScript compilation and production build
npm run preview    # serve the production build locally
npm run test       # run the Vitest suite once
npm run test:watch # run tests in watch mode
```

## Controls and readouts

The UI is split into two panels:

- Left: read-only HUD for physics state, performance, and hardware detection
- Right: interactive controls for simulation, display, and tuning

Current control groups:

- Collapse Physics: $\beta$, perturbation strength, $\ell_{\max}$, spectral tilt, Silk damping, spatial curvature, double-bounce, pair production
- Double-Bounce Tuning: secondary hue and brightness shaping when closed-universe double bounce is enabled
- Production Tuning: visual timing and appearance of pair-produced particles
- Flow: freeze, reset, reset settings, display sync override, target frame rate, birth rate, drift, arrival spread
- Hue Ramp: hue start/range and brightness floor/ceiling
- Particles: size, brightness, persistence, fade sharpness, edge softness, round particles, auto-brightness
- Ring: ring color, opacity, width, auto-color, ring bloom
- Particle Bloom: bloom enable, quality, strength, radius, threshold, soft-HDR exposure
- Camera: background color and zoom
- Color Tuning: lightness and saturation floor/range

The bottom bar also provides fullscreen, UI hide/show, and randomize actions. On mobile, it also exposes a force-HDR toggle.

## Physics model

The implementation centers on the dimensionless ECSK Friedmann equation:

$$
\left(\frac{d\bar{a}}{d\bar{\tau}}\right)^2 = \frac{1}{\bar{a}^2} - \frac{\beta}{\bar{a}^4} - 1
$$

with bounce condition:

$$
\bar{a}_{\min}^2 = \frac{1 - \sqrt{1 - 4\beta}}{2}
$$

The visualization maps local perturbations on S² into changes in bounce timing and appearance. The project also includes extensions for closed-universe double-bounce behavior and particle-production-inspired visual modes.

Primary references include:

- Poplawski 2010b, 2012, 2014, 2020, 2020b, 2021, 2025
- Unger and Poplawski 2019
- Cubero and Poplawski 2019
- Hehl and Datta 1971
- Hehl et al. 1976

For the fuller derivation and audit trail, see [PROJECT_SCOPE.md](PROJECT_SCOPE.md) and [EQUATION_CATALOG.md](EQUATION_CATALOG.md).

## Project structure

```text
src/
  main.ts                  app startup, orchestration, animation loop
  physics/
    ecsk-physics.ts        ECSK bounce equations and derived quantities
    perturbation.ts        spherical-harmonic perturbation field
    shell.ts               shell sampling and Lambert projection
    physics-bridge.ts      worker bridge and batch scheduling
    physics-worker.ts      worker-side particle generation
  rendering/
    renderer.ts            WebGPU renderer, particles, ring, bloom
  ui/
    controls.ts            GUI panels and HUD
    hardware-info.ts       hardware capability detection and budgets
    screen-info.ts         display and refresh-rate detection
    tooltips.ts            tooltip content
  types/
    three-webgpu.d.ts      local typing support for Three/WebGPU APIs

simplified-3d-illustration/
  index.html               standalone bounce explainer

source-processing/
  extract_*.py             research-source extraction utilities

sources_extracted/
  *.txt                    extracted paper text corpus

sources_marker/
  *.md                     extracted/converted research notes
```

## Tests

The repository includes targeted unit tests for physics, perturbation, shell sampling, and screen detection via Vitest.

## Research assets

This repository carries both the visualization code and a working research corpus:

- [PROJECT_SCOPE.md](PROJECT_SCOPE.md): project framing, theory notes, and architecture summary
- [EQUATION_CATALOG.md](EQUATION_CATALOG.md): curated equation index across the source set
- `sources_extracted/`: extracted plain text from papers
- `sources_marker/`: markdown conversions where available
- `source-processing/`: scripts used to build those derived artifacts

## License

ISC
