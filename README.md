# Birth of a Universe

Real-time visualization of the **torsion-bounce** inside a black hole, based on
Nikodem Poplawski's Einstein-Cartan-Sciama-Kibble (ECSK) cosmology.

The screen shows a 2D "bounce sensor" — a Lambert equal-area projection of the
S² hypersurface at the moment spin-torsion halts gravitational collapse and
reverses it into expansion. Each glowing point is a comoving fluid element
reaching its local bounce. Perturbations in the spin parameter β create
structured patterns that encode the physics of the inhomogeneous bounce.

## Requirements

- A browser with **WebGPU** support (Chrome 121+, Edge 121+, or Firefox Nightly with `dom.webgpu.enabled`)
- Node.js 18+ (for the dev server)

## Quick Start

```bash
git clone https://github.com/8Rotation/Birth-of-a-Universe.git
cd Birth-of-a-Universe
npm install
npm run dev
```

Open the URL shown by Vite (typically `http://localhost:5173/`).

## Build

```bash
npm run build     # TypeScript check + Vite production build → dist/
npm run preview   # Serve the built output locally
```

## Controls

| Group | Parameter | What it does |
|-------|-----------|--------------|
| **Collapse Physics** | β | Spin parameter — torsion-to-radiation energy ratio |
| | Inhomogeneity | Perturbation amplitude across the S² sphere |
| | Turbulence | Maximum spherical harmonic multipole (l_max) |
| **Flow** | Shell rate | How many shells spawn per second |
| | Particles/shell | Points sampled on S² per shell |
| | Time dilation | Stretches arrival time spread for visual clarity |
| **Sensor Display** | Hit size / Brightness / Persistence / Bloom | Visual tuning |
| **Readout** | β, a_min, w_eff, S, flux, visible, FPS | Live physics state |

## Project Structure

```
src/
  physics/
    ecsk-physics.ts     — Bounce physics (Friedmann + torsion)
    perturbation.ts     — Spherical harmonic perturbation field
    shell.ts            — S² sampling, Lambert projection, arrival sorting
  rendering/
    renderer.ts         — 2D sensor: orthographic camera, additive blend, bloom
  ui/
    controls.ts         — lil-gui panels
  main.ts               — Orchestration
sources_extracted/      — Extracted text from source papers (committed)
sources/                — Original PDFs (gitignored)
```

## Physics

All equations are verified against the source papers:

- **Poplawski 2010b** — Friedmann equation with torsion
- **Poplawski 2014** — Bounce condition, time evolution
- **Poplawski 2020, 2020b** — Kantowski-Sachs extension, collapse dynamics
- **Hehl & Datta 1971, Hehl et al. 1976** — ECSK theory foundations

See [PROJECT_SCOPE.md](PROJECT_SCOPE.md) for full equation list and audit details.

## License

ISC
