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
import type { ComputeBudget } from "./hardware-info.js";

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
  roundParticles: boolean; // circular vs square particles

  // Bloom
  bloomEnabled: boolean;
  bloomStrength: number;
  bloomRadius: number;

  // Playback
  frozen: boolean;

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
  screen: string;
  hz: string;
  hdr: string;
  gamut: string;
  // Hardware
  cpuCores: string;
  cpuBench: string;
  gpu: string;
  capability: string;
  tier: string;
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

/**
 * Create the sensor controls panel.
 *
 * @param onReset  Callback for the Clear button.
 * @param budget   Hardware-derived compute budget — drives both default
 *                 values and normal-mode slider ranges.  If omitted,
 *                 falls back to mid-tier defaults.
 */
export function createSensorControls(onReset: () => void, budget?: ComputeBudget) {
  // ── Slider limits from hardware detection (or sensible mid-tier fallback)
  const sl = budget?.sliderLimits ?? {
    particleRateMax: 8_000,
    lMaxMax: 16,
    persistenceMax: 12,
    timeDilationMax: 8_000,
    bloomStrengthMax: 3,
  };

  const params: SensorParams = {
    beta: 0.10,
    perturbAmplitude: 0.12,
    lMax: budget?.recommendedLMax ?? 8,
    particleRate: budget?.particleRate ?? 2000,
    fieldEvolution: 0.1,
    timeDilation: 120,
    hitSize: 1.0,
    brightness: 5.0,
    persistence: 1.0,
    roundParticles: true,
    bloomEnabled: budget?.bloomDefault ?? false,
    bloomStrength: 1.2,
    bloomRadius: 0.3,
    frozen: false,
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
  flow.add(params, "frozen").name("Freeze");
  flow.add(params, "reset").name("⟳ Clear");

  // ── Sensor Display ────────────────────────────────────────────────
  const display = gui.addFolder("Sensor Display");
  display.add(params, "roundParticles").name("Round particles");
  display.add(params, "bloomEnabled").name("Bloom");

  // ── Numeric controller descriptors ────────────────────────────────
  // Normal-mode max values adapt to hardware tier via `sl`.
  // overrideMax: slider range used in Override Mode (greatly expanded).
  const numericDefs: NumCtrl[] = [
    // Collapse Physics
    { folder: physics, prop: "beta",             label: "β spin param",        min: 0.005, max: 0.249,              step: 0.001, overrideMax: 10        },
    { folder: physics, prop: "perturbAmplitude", label: "Inhomogeneity",       min: 0.001, max: 0.6,                step: 0.001, overrideMax: 100       },
    { folder: physics, prop: "lMax",             label: "Turbulence (l_max)",  min: 1,     max: sl.lMaxMax,          step: 1,     overrideMax: 512       },
    // Flow
    { folder: flow,    prop: "particleRate",     label: "Particle rate (/s)",  min: 100,   max: sl.particleRateMax,  step: 100,   overrideMax: 10000000, overrideStep: 1000 },
    { folder: flow,    prop: "fieldEvolution",   label: "Field evolution (/s)", min: 0,    max: 2,                  step: 0.01,  overrideMax: 1000      },
    { folder: flow,    prop: "timeDilation",     label: "Time dilation",       min: 1,     max: sl.timeDilationMax,  step: 1,     overrideMax: 100000000 },
    // Sensor Display
    { folder: display, prop: "hitSize",          label: "Hit size (px)",       min: 1,     max: 30,                 step: 0.5,   overrideMax: 10000     },
    { folder: display, prop: "brightness",       label: "Brightness",          min: 0.1,   max: 5,                  step: 0.1,   overrideMax: 10000     },
    { folder: display, prop: "persistence",      label: "Persistence (s)",     min: 0.1,   max: sl.persistenceMax,   step: 0.1,   overrideMax: 100000    },
    { folder: display, prop: "bloomStrength",    label: "Bloom strength",      min: 0,     max: sl.bloomStrengthMax, step: 0.1,   overrideMax: 10000     },
    { folder: display, prop: "bloomRadius",      label: "Bloom radius",        min: 0,     max: 1,                  step: 0.05,  overrideMax: 1000      },
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
    screen: "detecting...",
    hz: "--",
    hdr: "--",
    gamut: "--",
    cpuCores: "--",
    cpuBench: "--",
    gpu: "detecting...",
    capability: "--",
    tier: "--",
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
    hudFolder.add(hud, "screen").name("Screen").listen().disable(),
    hudFolder.add(hud, "hz").name("Refresh (Hz)").listen().disable(),
    hudFolder.add(hud, "hdr").name("HDR").listen().disable(),
    hudFolder.add(hud, "gamut").name("Gamut").listen().disable(),
    hudFolder.add(hud, "cpuCores").name("CPU threads").listen().disable(),
    hudFolder.add(hud, "cpuBench").name("CPU bench").listen().disable(),
    hudFolder.add(hud, "gpu").name("GPU").listen().disable(),
    hudFolder.add(hud, "capability").name("Capability").listen().disable(),
    hudFolder.add(hud, "tier").name("HW tier").listen().disable(),
  ];

  function updateHUD() {
    for (const c of controllers) c.updateDisplay();
  }

  return { gui, params, hud, updateHUD };
}
