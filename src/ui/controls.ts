/**
 * controls.ts — ECSK Bounce Sensor controls and HUD.
 *
 * Provides lil-gui panels for:
 *   - Collapse Physics: β, perturbation amplitude, turbulence (l_max)
 *   - Flow: shell spawning rate, particles per shell, time dilation
 *   - Sensor Display: hit size, brightness, persistence, bloom
 *   - Readout: physics state + performance metrics
 *
 * Override Mode: toggle to remove slider bounds and type any value directly.
 */

import GUI from "lil-gui";
import type { Controller } from "lil-gui";

// ── Simulation parameters exposed to UI ───────────────────────────────────

export interface SensorParams {
  // Physics
  beta: number;
  perturbAmplitude: number;
  lMax: number;

  // Flow
  particleRate: number;  // particles per second (continuous Poisson stream)
  fieldEvolution: number; // O-U mean-reversion rate (1/s): 0 = frozen, higher = faster drift
  timeDilation: number;  // stretches arrival time spread

  // Display
  hitSize: number;       // base point size in pixels
  brightness: number;    // brightness multiplier
  persistence: number;   // fade time constant (seconds)

  // Bloom
  bloomEnabled: boolean;
  bloomStrength: number;
  bloomRadius: number;

  // Playback
  paused: boolean;

  // Actions
  reset: () => void;
}

// ── HUD data (read-only display) ─────────────────────────────────────────

export interface HUDData {
  beta: string;
  aMin: string;
  wEff: string;
  torsionRatio: string;
  flux: string;
  visible: string;
  fps: string;
}

// ── Numeric controller descriptor ────────────────────────────────────────

interface NumCtrl {
  folder: GUI;
  prop: keyof SensorParams;
  label: string;
  min: number;
  max: number;
  step: number;
  overrideMax: number;
  overrideStep?: number;
}

// ── Create controls ───────────────────────────────────────────────────────

export function createSensorControls(onReset: () => void) {
  const params: SensorParams = {
    beta: 0.10,
    perturbAmplitude: 0.12,
    lMax: 8,
    particleRate: 2000,
    fieldEvolution: 0.1,
    timeDilation: 120,
    hitSize: 3.0,
    brightness: 1.0,
    persistence: 1.0,
    bloomEnabled: true,
    bloomStrength: 1.2,
    bloomRadius: 0.3,
    paused: false,
    reset: onReset,
  };

  const gui = new GUI({ title: "ECSK Bounce Sensor" });
  gui.domElement.style.zIndex = "1000";

  // ── Inject override-mode stylesheet ──────────────────────────────
  const overrideStyle = document.createElement("style");
  overrideStyle.textContent = `
    .ecsk-override .lil-controller.lil-number:not(.lil-disabled) { --number-color: red !important; }
    .ecsk-override .lil-controller.lil-number:not(.lil-disabled) input { color: red !important; }
  `;
  document.head.appendChild(overrideStyle);

  // ── Override Mode toggle ──────────────────────────────────────────
  const overrideState = { overrideMode: false };
  const overrideCtrl = gui.add(overrideState, "overrideMode").name("⚙ Override Mode").onChange((v: boolean) => {
    rebuildNumericControllers(v);
    gui.domElement.classList.toggle("ecsk-override", v);
    (overrideCtrl.domElement as HTMLElement).style.color = v ? "red" : "";
  });

  // ── Collapse Physics ──────────────────────────────────────────────
  const physics = gui.addFolder("Collapse Physics");

  // ── Flow ──────────────────────────────────────────────────────────
  const flow = gui.addFolder("Flow");
  flow.add(params, "paused").name("Paused");
  flow.add(params, "reset").name("⟳ Clear");

  // ── Sensor Display ────────────────────────────────────────────────
  const display = gui.addFolder("Sensor Display");
  display.add(params, "bloomEnabled").name("Bloom");

  // ── Numeric controller descriptors ────────────────────────────────
  // overrideMax: slider range used in Override Mode (greatly expanded)
  const numericDefs: NumCtrl[] = [
    // Collapse Physics
    { folder: physics, prop: "beta",             label: "β spin param",        min: 0.005, max: 0.249,  step: 0.001, overrideMax: 10        },
    { folder: physics, prop: "perturbAmplitude", label: "Inhomogeneity",       min: 0.001, max: 0.6,    step: 0.001, overrideMax: 100       },
    { folder: physics, prop: "lMax",             label: "Turbulence (l_max)",  min: 1,     max: 24,     step: 1,     overrideMax: 512       },
    // Flow
    { folder: flow,    prop: "particleRate",     label: "Particle rate (/s)",  min: 100,   max: 20000,  step: 100,   overrideMax: 10000000, overrideStep: 1000 },
    { folder: flow,    prop: "fieldEvolution",   label: "Field evolution (/s)", min: 0,    max: 2,      step: 0.01,  overrideMax: 1000      },
    { folder: flow,    prop: "timeDilation",     label: "Time dilation",       min: 1,     max: 10000,  step: 1,     overrideMax: 100000000 },
    // Sensor Display
    { folder: display, prop: "hitSize",          label: "Hit size (px)",       min: 1,     max: 30,     step: 0.5,   overrideMax: 10000     },
    { folder: display, prop: "brightness",       label: "Brightness",          min: 0.1,   max: 5,      step: 0.1,   overrideMax: 10000     },
    { folder: display, prop: "persistence",      label: "Persistence (s)",     min: 0.1,   max: 20,     step: 0.1,   overrideMax: 100000    },
    { folder: display, prop: "bloomStrength",    label: "Bloom strength",      min: 0,     max: 3,      step: 0.1,   overrideMax: 10000     },
    { folder: display, prop: "bloomRadius",      label: "Bloom radius",        min: 0,     max: 1,      step: 0.05,  overrideMax: 1000      },
  ];

  // Track live controllers so we can destroy & recreate on mode switch
  let activeNumericControllers: Controller[] = [];

  function rebuildNumericControllers(override: boolean) {
    // Destroy existing numeric controllers
    for (const c of activeNumericControllers) c.destroy();
    activeNumericControllers = [];

    if (override) {
      // Override: sliders with greatly expanded range (CSS class handles red colouring)
      for (const def of numericDefs) {
        const step = def.overrideStep ?? def.step;
        const c = def.folder.add(params, def.prop, 0, def.overrideMax, step)
          .name(def.label);
        activeNumericControllers.push(c);
      }
    } else {
      // Normal: original bounded sliders
      for (const def of numericDefs) {
        const c = def.folder.add(params, def.prop, def.min, def.max, def.step)
          .name(def.label);
        activeNumericControllers.push(c);
      }
    }
  }

  // Build initial bounded sliders
  rebuildNumericControllers(false);

  // ── Readout (read-only) ───────────────────────────────────────────
  const hud: HUDData = {
    beta: "0.100",
    aMin: "0",
    wEff: "0",
    torsionRatio: "0",
    flux: "0",
    visible: "0",
    fps: "0",
  };

  const hudFolder = gui.addFolder("Readout");
  const controllers = [
    hudFolder.add(hud, "beta").name("β").listen().disable(),
    hudFolder.add(hud, "aMin").name("a_min").listen().disable(),
    hudFolder.add(hud, "wEff").name("w_eff").listen().disable(),
    hudFolder.add(hud, "torsionRatio").name("S (torsion)").listen().disable(),
    hudFolder.add(hud, "flux").name("Flux (/s)").listen().disable(),
    hudFolder.add(hud, "visible").name("Visible").listen().disable(),
    hudFolder.add(hud, "fps").name("FPS").listen().disable(),
  ];

  function updateHUD() {
    for (const c of controllers) c.updateDisplay();
  }

  return { gui, params, hud, updateHUD };
}
