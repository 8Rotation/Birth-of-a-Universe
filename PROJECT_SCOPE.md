# Project Scope

Birth of a Universe is a WebGPU ECSK torsion-bounce cosmology visualizer. It renders a Lambert-projected bounce hypersurface with CPU worker emission and an optional GPU compute emission path, both feeding a packed particle ring buffer used by the Three.js renderer.

## Current State

- Particle storage keeps the shared stride-8 layout: `[lx, ly, arrivalTime, hue, brightness, eps, hitSize, tail]`.
- The ring buffer treats slot 2 as `arrivalTime`, validates runtime writes in development, tracks CPU/GPU batch history for stable alive ranges, and scans only populated slots when invalidating future arrivals.
- Ring-buffer growth preserves data, updates attribute counts, invalidates/rebinds renderer geometry through resize versions, and destroys stale uploaded GPU buffers when available.
- Three.js WebGPU private backend access is isolated in `src/rendering/three-backend.ts`, with renderer init probing the expected private paths before compute or direct-upload paths rely on them.
- Worker communication uses a typed protocol, central coefficients remain coherent across importable worker runtime steps, crashed workers stop restarting after five failed attempts, and surviving workers inherit the rate share.
- Build/test infrastructure targets ES2022, keeps the GitHub Pages base path configurable through `VITE_BASE`, and runs Vitest in jsdom with browser API setup.
- Mobile control tooltips use native buttons, tooltip ARIA, and class-based bottom-bar layout states; source-processing scripts derive input/output folders from the repo root.

## Direction

- Keep CPU and GPU emission numerically aligned when physics or particle layout changes.
- Keep private Three.js backend assumptions localized and covered by focused tests.
- Keep ring-buffer changes conservative because it is shared by workers, GPU compute, and renderer draw-window logic.
