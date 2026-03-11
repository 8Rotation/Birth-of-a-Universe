/**
 * controls.ts — ECSK Bounce Sensor controls and HUD.
 *
 * Two-panel layout:
 *   Left  — Readout (physics state, performance, hardware)
 *   Right — Controls (Collapse Physics, Flow, Sensor Display, Tuning)
 *
 * OLED-friendly dark theme (pure-black background, low-contrast borders).
 * Panels fade to near-invisible when collapsed; hover to reveal.
 *
 * Override Mode: toggle to remove slider bounds and type any value directly.
 */

import GUI from "lil-gui";
import type { Controller } from "lil-gui";
import type { ComputeBudget } from "./hardware-info.js";
import { TOOLTIPS, READOUT_TOOLTIPS } from "./tooltips.js";
import type { Tooltip } from "./tooltips.js";

// ── Simulation parameters exposed to UI ───────────────────────────────────

export interface SensorParams {
  // Physics
  beta: number;
  perturbAmplitude: number;
  lMax: number;
  nS: number;          // spectral index (power-spectrum tilt)
  kCurvature: number;  // spatial curvature: -1 (open), 0 (flat), +1 (closed)
  doubleBounce: boolean; // double-bounce pulsation (k=+1 only, Cubero & Popławski 2019)
  betaPP: number;        // particle production rate β_pp (Popławski 2014 eq. 40–46; 2021 eq. 8)
  silkDamping: number;   // Silk damping ratio for perturbation spectrum

  // Double-bounce visual tuning (only active when doubleBounce=true && k=+1)
  dbSecondHueShift: number;  // hue offset for second-bounce particles
  dbSecondBriScale: number;  // brightness scale for second-bounce particles

  // Particle production visual tuning (only active when betaPP > 0)
  ppHueShift: number;     // hue offset for produced particles
  ppBriBoost: number;     // brightness multiplier for produced particles
  ppSizeScale: number;    // size multiplier for produced particles
  ppBaseDelay: number;    // base delay fraction for production timing
  ppScatterRange: number; // scatter range fraction for production timing

  // Flow
  particleRate: number;  // particles per second (continuous Poisson stream)
  fieldEvolution: number; // O-U mean-reversion rate (1/s): 0 = frozen, higher = faster drift
  arrivalSpread: number;  // temporal spread of arrivals in seconds

  // Hue ramp (physics → color mapping)
  hueMin: number;        // start of hue ramp (degrees)
  hueRange: number;      // span of hue ramp (degrees)
  brightnessFloor: number; // minimum brightness (0–1)
  brightnessCeil: number;  // maximum brightness (0–1)

  // Display
  hitSize: number;       // base point size in pixels
  brightness: number;    // brightness multiplier
  persistence: number;   // fade time constant (seconds)
  roundParticles: boolean; // circular vs square particles

  // Bloom
  bloomEnabled: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  bloomQuality: 'auto' | 'high' | 'low';

  // Fade
  fadeSharpness: number;    // Weibull shape: 1=exponential, >1=sharp cutoff, <1=long tail

  // Color tuning (renderer-side HSL mapping)
  lightnessFloor: number;   // minimum lightness (0–1)
  lightnessRange: number;   // lightness span above floor (0–1)
  saturationFloor: number;  // minimum saturation (0–1)
  saturationRange: number;  // saturation span above floor (0–1)

  // Ring / projection
  ringOpacity: number;      // Lambert disk boundary ring opacity
  ringColor: string;        // ring colour (hex string for color picker)
  ringWidthPx: number;       // ring thickness in CSS pixels
  ringBloomStrength: number;  // ring-only bloom intensity
  ringBloomRadius: number;    // ring-only bloom spread
  ringAutoColor: boolean;   // auto-match ring colour to dominant particle hue
  softHdrExposure: number;  // tone-mapping exposure for soft-HDR path
  particleSoftEdge: number; // particle edge softness (0=hard, 0.5=very soft)
  autoBrightness: boolean;  // auto-exposure: brightest particle → peak luminance

  // Scene
  backgroundColor: string;  // background colour (hex string)
  zoom: number;             // orthographic camera zoom multiplier

  // Playback
  frozen: boolean;
  targetFps: number;  // 0 = VSync (render every rAF), >0 = cap framerate

  // Actions
  reset: () => void;
  resetSettings: () => void;
  randomSettings: () => void;
}

// ── HUD data (read-only display) ─────────────────────────────────────────

export interface HUDData {
  beta: string;
  aMin: string;
  wEff: string;
  torsionRatio: string;
  ppStrength: string;
  flux: string;
  visible: string;
  fps: string;
  cpuUsage: string;
  cpuLoad: string;
  gpuLoad: string;
  bufferFill: string;
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

// ── OLED-friendly dark-theme CSS ─────────────────────────────────────────

const OLED_CSS = `
/* ── OLED dark theme — pure-black base, compact rows ───────────── */
.lil-gui {
  --background-color: #000000;
  --widget-color: #1a1a1a;
  --text-color: #999;
  --title-background-color: #0a0a0a;
  --title-text-color: #bbb;
  --focus-color: #333;
  --number-color: #6cf;
  --string-color: #6f6;
  --font-size: 11px;
  --input-font-size: 11px;
  --font-family: 'Segoe UI', system-ui, sans-serif;
  --padding: 4px;
  --spacing: 4px;
  --slider-knob-width: 3px;
  --name-width: 42%;
  font-variant-numeric: tabular-nums;
  border: 1px solid #1a1a1a !important;
}
.lil-gui .title {
  font-size: 11px;
  line-height: 20px;
  padding: 2px 8px;
}
.lil-gui .controller {
  min-height: 20px;
  padding: 1px 0;
}
.lil-gui input, .lil-gui select {
  font-size: 11px;
}

/* ── Collapsed / hover opacity ─────────────────────────────────── */
.ecsk-panel {
  transition: opacity 0.3s ease;
}
.ecsk-panel.lil-gui.closed {
  opacity: 0.05;
}
.ecsk-panel.lil-gui.closed:hover {
  opacity: 0.85;
}
.ecsk-panel.lil-gui:not(.closed) {
  opacity: 0.88;
}
.ecsk-panel.lil-gui:not(.closed):hover {
  opacity: 1;
}

/* ── Override mode (red numerics) ──────────────────────────────── */
.ecsk-override .lil-controller.lil-number:not(.lil-disabled) {
  --number-color: red !important;
}
.ecsk-override .lil-controller.lil-number:not(.lil-disabled) input {
  color: red !important;
}

/* ── Readout panel (left side) ─────────────────────────────────── */
.ecsk-readout {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: auto !important;
  width: 245px !important;
}
.ecsk-readout .controller {
  min-height: 18px;
  padding: 0;
}
.ecsk-readout .controller .name {
  font-size: 10px;
}
.ecsk-readout .controller .widget {
  font-size: 10px;
}

/* ── Controls panel (right side) ───────────────────────────────── */
.ecsk-controls {
  position: fixed !important;
  top: 0 !important;
  right: 0 !important;
  width: 295px !important;
  max-height: 100vh !important;
  overflow-y: auto !important;
}
/* Thin scrollbar for the controls panel */
.ecsk-controls::-webkit-scrollbar { width: 4px; }
.ecsk-controls::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
.ecsk-controls::-webkit-scrollbar-track { background: transparent; }

/* ── Hover tooltips ────────────────────────────────────────────── */
.ecsk-tooltip {
  position: fixed;
  z-index: 10000;
  max-width: 420px;
  min-width: 280px;
  padding: 10px 14px 12px;
  border-radius: 6px;
  background: #0d0d0d;
  border: 1px solid #2a2a2a;
  color: #ccc;
  font: 11px/1.5 'Segoe UI', system-ui, sans-serif;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s ease;
  box-shadow: 0 4px 24px rgba(0,0,0,0.8);
  max-height: 80vh;
  overflow-y: auto;
}
.ecsk-tooltip::-webkit-scrollbar { width: 3px; }
.ecsk-tooltip::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
.ecsk-tooltip.visible { opacity: 1; }
.ecsk-tooltip .tt-simple {
  color: #eee;
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 6px;
  line-height: 1.4;
}
.ecsk-tooltip .tt-section {
  margin-top: 6px;
  padding-top: 5px;
  border-top: 1px solid #1e1e1e;
}
.ecsk-tooltip .tt-label {
  color: #777;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 2px;
}
.ecsk-tooltip .tt-body {
  color: #aaa;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
}
.ecsk-tooltip .tt-section.tt-perf .tt-label { color: #b87333; }
.ecsk-tooltip .tt-section.tt-science .tt-label { color: #7799bb; }
.ecsk-tooltip .tt-section.tt-range .tt-label { color: #88aa66; }
.ecsk-tooltip .tt-section.tt-visual .tt-label { color: #aa88cc; }
.ecsk-tooltip .tt-section.tt-notes .tt-label { color: #888; }
/* Legacy detail fallback (readout tooltips) */
.ecsk-tooltip .tt-detail {
  color: #999;
  font-size: 10.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  margin-top: 6px;
  padding-top: 5px;
  border-top: 1px solid #1e1e1e;
}

/* ── Mobile adaptations ────────────────────────────────────────── */
.ecsk-mobile .ecsk-readout {
  position: fixed !important;
  top: auto !important;
  bottom: 0 !important;
  left: 0 !important;
  right: 0 !important;
  width: 100% !important;
  max-height: 40vh !important;
  overflow-y: auto !important;
  z-index: 1001 !important;
}
.ecsk-mobile .ecsk-controls {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  width: 100% !important;
  max-height: 60vh !important;
  overflow-y: auto !important;
}
/* On mobile: collapsed panels are semi-visible (no hover needed) */
.ecsk-mobile .ecsk-panel.lil-gui.closed {
  opacity: 0.35;
}
/* Tap opens to full opacity — no hover dependency */
.ecsk-mobile .ecsk-panel.lil-gui:not(.closed) {
  opacity: 0.95;
}
/* Larger touch targets */
.ecsk-mobile .lil-gui .title {
  font-size: 13px;
  line-height: 32px;
  padding: 4px 12px;
}
.ecsk-mobile .lil-gui .controller {
  min-height: 32px;
  padding: 3px 0;
}
.ecsk-mobile .lil-gui input, .ecsk-mobile .lil-gui select {
  font-size: 13px;
  min-height: 28px;
}
.ecsk-mobile .lil-gui {
  --slider-knob-width: 8px;
  --font-size: 13px;
  --input-font-size: 13px;
}
`;

// ── Create controls ───────────────────────────────────────────────────────

/**
 * Create the sensor controls panel.
 *
 * @param onReset  Callback for the Clear button.
 * @param budget   Hardware-derived compute budget — drives both default
 *                 values and normal-mode slider ranges.  If omitted,
 *                 falls back to mid-tier defaults.
 */
export function createSensorControls(onReset: () => void, budget?: ComputeBudget, refreshRate = 60, isMobile = false) {
  // ── Inject OLED theme CSS ─────────────────────────────────────────
  const styleEl = document.createElement("style");
  styleEl.textContent = OLED_CSS;
  document.head.appendChild(styleEl);

  // ── Mobile mode: add class to body for CSS targeting ──────────────
  if (isMobile) {
    document.body.classList.add("ecsk-mobile");
    console.log("[controls] Mobile layout active");
  }

  // ── Slider limits from hardware detection (or sensible mid-tier fallback)
  const sl = budget?.sliderLimits ?? {
    particleRateMax: 8_000,
    lMaxMax: 16,
    persistenceMax: 12,
    arrivalSpreadMax: 60,
    bloomStrengthMax: 3,
  };

  const params: SensorParams = {
    beta: 0.10,
    perturbAmplitude: 0.12,
    lMax: budget?.recommendedLMax ?? 8,
    nS: 0.965,
    kCurvature: 1,  // closed universe (default, matches original hardcoded k=+1)
    doubleBounce: false,  // double-bounce pulsation off by default
    betaPP: 0,            // particle production off by default (β_cr ≈ 1/929)
    silkDamping: 0.6,     // Silk damping ratio (perturbation spectrum high-ℓ suppression)

    // Double-bounce visual tuning
    dbSecondHueShift: 15,    // degrees
    dbSecondBriScale: 0.82,

    // Particle production visual tuning
    ppHueShift: 60,          // degrees
    ppBriBoost: 1.3,
    ppSizeScale: 0.7,
    ppBaseDelay: 1.5,
    ppScatterRange: 1.0,

    // Flow
    particleRate: budget?.particleRate ?? 2000,
    fieldEvolution: 0.1,
    arrivalSpread: 1.0,

    // Hue ramp (physics → color)
    hueMin: 25,
    hueRange: 245,
    brightnessFloor: 0.15,
    brightnessCeil: 1.0,

    // Display
    hitSize: 1.0,
    brightness: 5.0,
    persistence: 1.0,
    roundParticles: true,
    bloomEnabled: budget?.bloomDefault ?? false,
    bloomStrength: 1.2,
    bloomRadius: 0.3,
    bloomThreshold: 0.05,
    bloomQuality: 'auto',
    fadeSharpness: 1.0,
    lightnessFloor: 0.20,
    lightnessRange: 0.65,
    saturationFloor: 0.70,
    saturationRange: 0.25,
    ringOpacity: 0.50,
    ringColor: '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0'),
    ringWidthPx: 2,
    ringBloomStrength: 0.8,
    ringBloomRadius: 0.4,
    ringAutoColor: true,
    softHdrExposure: 1.6,
    particleSoftEdge: 0.05,
    autoBrightness: true,
    backgroundColor: "#000000",
    zoom: 1.0,
    frozen: false,
    targetFps: 0,  // VSync by default
    reset: onReset,
    resetSettings: () => {},  // placeholder, wired below
    randomSettings: () => {},  // placeholder, wired below
  };

  // ── Mobile-specific default overrides ─────────────────────────────
  if (isMobile) {
    params.bloomEnabled = false;
    params.particleRate = Math.min(params.particleRate, 1000);
    params.lMax = Math.min(params.lMax, 6);
    params.persistence = Math.min(params.persistence, 2);
    params.hitSize = Math.max(params.hitSize, 2);  // larger dots for small screens
  }

  // Snapshot of initial param values for "Reset Settings"
  const defaults: Record<string, unknown> = {};
  for (const key of Object.keys(params) as (keyof SensorParams)[]) {
    if (typeof params[key] !== "function") defaults[key] = params[key];
  }
  // Randomise ringColor fresh each reset (matches initial behaviour)
  params.resetSettings = () => {
    for (const key of Object.keys(defaults)) {
      (params as unknown as Record<string, unknown>)[key] = key === "ringColor"
        ? '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0')
        : defaults[key];
    }
    gui.controllersRecursive().forEach(c => c.updateDisplay());
    updateDbState();
    updateConditionalFolders();
    // Full reset: clear hits, restart workers with restored defaults.
    // Prevents stale worker state from causing freezes.
    params.reset();
  };

  // Randomize all settings within their normal slider ranges
  params.randomSettings = () => {
    // Will be wired after numericDefs is created — see below
  };

  // ── Right panel: Controls ─────────────────────────────────────────
  const gui = new GUI({ title: "ECSK Bounce Sensor" });
  gui.domElement.classList.add("ecsk-panel", "ecsk-controls");
  gui.domElement.style.zIndex = "1000";
  if (isMobile) gui.close();  // start collapsed on mobile — maximise canvas

  // ── "What is a bounce?" link ──────────────────────────────────────
  {
    const link = document.createElement("a");
    link.textContent = "What is a bounce?  ↗";
    link.href = "simplified-3d-illustration/index.html";
    link.target = "_blank";
    link.rel = "noopener";
    Object.assign(link.style, {
      display: "block",
      padding: "4px 12px 6px",
      fontSize: "11px",
      color: "#8cf",
      textDecoration: "none",
      borderBottom: "1px solid #333",
      cursor: "pointer",
    });
    link.addEventListener("mouseenter", () => { link.style.color = "#bef"; });
    link.addEventListener("mouseleave", () => { link.style.color = "#8cf"; });
    if (isMobile) {
      Object.assign(link.style, { padding: "8px 12px 10px", fontSize: "13px" });
    }
    // Insert right after the title bar
    const titleBar = gui.domElement.querySelector(".title");
    if (titleBar && titleBar.nextSibling) {
      titleBar.parentNode!.insertBefore(link, titleBar.nextSibling);
    } else {
      gui.domElement.querySelector(".children")?.prepend(link);
    }
  }

  // ── Override Mode toggle ──────────────────────────────────────────
  const overrideState = { overrideMode: false };
  const overrideCtrl = gui.add(overrideState, "overrideMode").name("⚙ Override Mode").onChange((v: boolean) => {
    rebuildNumericControllers(v);
    gui.domElement.classList.toggle("ecsk-override", v);
    (overrideCtrl.domElement as HTMLElement).style.color = v ? "red" : "";
  });

  // ── Collapse Physics ──────────────────────────────────────────────
  const physics = gui.addFolder("Collapse Physics");

  // k curvature dropdown — non-numeric, added directly (not in numericDefs)
  // NOTE: lil-gui dropdowns coerce values to strings at runtime.
  // We coerce back to number in onChange to keep the type correct.
  physics.add(params, "kCurvature", { "Open (k=\u22121)": -1, "Flat (k=0)": 0, "Closed (k=+1)": 1 })
    .name("Curvature k")
    .onChange(() => {
      params.kCurvature = Number(params.kCurvature);
      updateDbState();
      updateConditionalFolders();
    });

  // Double bounce toggle — rhythmic pulsation for k=+1 (Cubero & Popławski 2019)
  const dbCtrl = physics.add(params, "doubleBounce").name("Double bounce").onChange(() => {
    updateConditionalFolders();
  });
  // Auto-disable when k ≠ +1 (double bounce requires closed topology)
  const updateDbState = () => {
    const closed = Number(params.kCurvature) === 1;
    if (!closed) params.doubleBounce = false;
    dbCtrl.enable(closed);
    dbCtrl.updateDisplay();
  };
  updateDbState();

  // ── Double-Bounce Tuning (conditional: shown when doubleBounce=true && k=+1) ──
  const dbTuning = physics.addFolder("Double-Bounce Tuning");
  dbTuning.close();

  // ── Production Tuning (conditional: shown when betaPP > 0) ────────
  const ppTuning = physics.addFolder("Production Tuning");
  ppTuning.close();

  // ── Flow ──────────────────────────────────────────────────────────
  const flow = gui.addFolder("Flow");
  flow.add(params, "frozen").name("Freeze").listen();
  flow.add(params, "reset").name("⟳ Reset");
  flow.add(params, "resetSettings").name("⟳ Reset Settings");
  flow.add(params, "randomSettings").name("🎲 Random");

  // Target framerate dropdown — always shows all common rates so a wrong Hz
  // detection never hides valid choices.  Detected rate shown on VSync label.
  {
    const COMMON_FPS = [240, 165, 144, 120, 90, 60, 30];
    const fpsOptions: Record<string, number> = {};
    fpsOptions[`VSync (${refreshRate} Hz)`] = 0;
    for (const fps of COMMON_FPS) {
      fpsOptions[`${fps} fps`] = fps;
    }
    const fpsCtrl = flow.add(params, "targetFps", fpsOptions).name("Target framerate");
    attachTooltip(fpsCtrl.domElement, "targetFps");
  }

  // ── Hue Ramp (physics→colour mapping, under Flow) ─────────────────
  const hueRamp = flow.addFolder("Hue Ramp");
  hueRamp.close();

  // ── Sensor Display → split into Particles / Ring / Bloom / Camera ──
  const particles = gui.addFolder("Particles");
  particles.add(params, "roundParticles").name("Round particles").onChange(() => {
    updateConditionalFolders();
  });
  particles.add(params, "autoBrightness").name("Auto brightness").onChange(() => {
    updateConditionalFolders();
  });

  const ring = gui.addFolder("Ring");
  ring.addColor(params, "ringColor").name("Ring colour").listen();
  ring.add(params, "ringAutoColor").name("Auto-colour");

  const bloomFolder = gui.addFolder("Bloom");
  bloomFolder.add(params, "bloomEnabled").name("Bloom").onChange(() => {
    updateConditionalFolders();
  });
  const bloomQualityCtrl = bloomFolder.add(params, "bloomQuality", ['auto', 'high', 'low']).name("Bloom quality");

  const camera = gui.addFolder("Camera");
  camera.addColor(params, "backgroundColor").name("Background colour");

  // ── Color Tuning (top-level folder) ───────────────────────────────
  const colorTuning = gui.addFolder("Color Tuning");
  colorTuning.close();  // collapsed by default

  // ── Numeric controller descriptors ────────────────────────────────
  // Normal-mode max values adapt to hardware tier via `sl`.
  // overrideMax: slider range used in Override Mode (greatly expanded).
  const numericDefs: NumCtrl[] = [
    // Collapse Physics
    { folder: physics,  prop: "beta",             label: "Spin parameter β",           min: 0.005, max: 0.249,              step: 0.001, overrideMax: 10        },
    { folder: physics,  prop: "perturbAmplitude", label: "Perturbation strength",      min: 0.001, max: 0.6,                step: 0.001, overrideMax: 100       },
    { folder: physics,  prop: "lMax",             label: "Ripple detail (ℓmax)",       min: 1,     max: sl.lMaxMax,          step: 1,     overrideMax: 512       },
    { folder: physics,  prop: "nS",               label: "Spectral tilt (nₛ)",        min: 0.5,   max: 1.5,                step: 0.005, overrideMax: 3         },
    { folder: physics,  prop: "silkDamping",      label: "Small-scale damping",        min: 0,     max: 1,                  step: 0.01,  overrideMax: 5         },
    { folder: physics,  prop: "betaPP",           label: "Pair production (βpp)",      min: 0,     max: 0.005,              step: 0.0001, overrideMax: 1        },
    // Double-Bounce Tuning
    { folder: dbTuning, prop: "dbSecondHueShift", label: "2nd hue shift (°)",   min: -180,  max: 180,                step: 1,     overrideMax: 360       },
    { folder: dbTuning, prop: "dbSecondBriScale", label: "2nd brightness",      min: 0.1,   max: 2.0,                step: 0.01,  overrideMax: 10        },
    // Production Tuning
    { folder: ppTuning, prop: "ppHueShift",       label: "Prod. hue shift (°)",    min: -180,  max: 180,                step: 1,     overrideMax: 360       },
    { folder: ppTuning, prop: "ppBriBoost",       label: "Prod. brightness",       min: 0.1,   max: 3.0,                step: 0.01,  overrideMax: 10        },
    { folder: ppTuning, prop: "ppSizeScale",      label: "Prod. size",       min: 0.1,   max: 3.0,                step: 0.01,  overrideMax: 10        },
    { folder: ppTuning, prop: "ppBaseDelay",      label: "Prod. delay",       min: 0,     max: 5.0,                step: 0.1,   overrideMax: 50        },
    { folder: ppTuning, prop: "ppScatterRange",   label: "Prod. scatter",    min: 0,     max: 5.0,                step: 0.1,   overrideMax: 50        },
    // Flow
    { folder: flow,    prop: "particleRate",     label: "Birth rate (per sec)",  min: 100,   max: sl.particleRateMax,  step: 100,   overrideMax: 10000000, overrideStep: 1000 },
    { folder: flow,    prop: "fieldEvolution",   label: "Pattern drift",         min: 0,    max: 2,                  step: 0.01,  overrideMax: 1000      },
    { folder: flow,    prop: "arrivalSpread",    label: "Arrival spread (s)",    min: 0.01,  max: sl.arrivalSpreadMax, step: 0.01,  overrideMax: 600       },
    // Hue Ramp
    { folder: hueRamp, prop: "hueMin",           label: "Hue start (°)",       min: 0,     max: 360,                step: 1,     overrideMax: 720       },
    { folder: hueRamp, prop: "hueRange",         label: "Hue range (°)",       min: 0,     max: 360,                step: 1,     overrideMax: 720       },
    { folder: hueRamp, prop: "brightnessFloor",  label: "Brightness floor",    min: 0,     max: 1,                  step: 0.01,  overrideMax: 5         },
    { folder: hueRamp, prop: "brightnessCeil",   label: "Brightness ceil",     min: 0,     max: 1,                  step: 0.01,  overrideMax: 5         },
    // Particles
    { folder: particles, prop: "hitSize",          label: "Dot size (px)",             min: 1,     max: 30,                 step: 0.5,   overrideMax: 10000     },
    { folder: particles, prop: "brightness",       label: "Brightness gain",           min: 0.1,   max: 5,                  step: 0.1,   overrideMax: 10000     },
    { folder: particles, prop: "persistence",      label: "Fade duration (s)",         min: 0.2,   max: sl.persistenceMax,   step: 0.1,   overrideMax: 100000    },
    { folder: particles, prop: "fadeSharpness",    label: "Fade sharpness",            min: 0.3,   max: 4,                  step: 0.1,   overrideMax: 100       },
    { folder: particles, prop: "particleSoftEdge", label: "Edge softness",             min: 0,     max: 0.3,                step: 0.005, overrideMax: 0.5       },
    // Ring
    { folder: ring,    prop: "ringOpacity",       label: "Ring opacity",              min: 0,     max: 1,                  step: 0.05,  overrideMax: 10        },
    { folder: ring,    prop: "ringWidthPx",       label: "Ring width (px)",           min: 0.5,   max: 10,                 step: 0.5,   overrideMax: 100       },
    { folder: ring,    prop: "ringBloomStrength", label: "Ring bloom intensity",      min: 0,     max: 3,                  step: 0.1,   overrideMax: 50        },
    { folder: ring,    prop: "ringBloomRadius",   label: "Ring bloom spread",         min: 0,     max: 1,                  step: 0.05,  overrideMax: 10        },
    // Bloom
    { folder: bloomFolder, prop: "bloomStrength",    label: "Bloom intensity",            min: 0,     max: sl.bloomStrengthMax, step: 0.1,   overrideMax: 10000     },
    { folder: bloomFolder, prop: "bloomRadius",      label: "Bloom spread",              min: 0,     max: 1,                  step: 0.05,  overrideMax: 1000      },
    { folder: bloomFolder, prop: "bloomThreshold",   label: "Bloom threshold",           min: 0,     max: 1,                  step: 0.01,  overrideMax: 100       },
    { folder: bloomFolder, prop: "softHdrExposure",  label: "HDR exposure",              min: 0.5,   max: 4,                  step: 0.1,   overrideMax: 20        },
    // Camera
    { folder: camera, prop: "zoom",             label: "Zoom",                      min: 0.2,   max: 5,                  step: 0.1,   overrideMax: 50        },
    // Color Tuning
    { folder: colorTuning, prop: "lightnessFloor",   label: "Lightness floor",   min: 0,   max: 0.5,  step: 0.01,  overrideMax: 1   },
    { folder: colorTuning, prop: "lightnessRange",   label: "Lightness range",   min: 0.1, max: 0.8,  step: 0.01,  overrideMax: 1   },
    { folder: colorTuning, prop: "saturationFloor",  label: "Saturation floor",  min: 0,   max: 1,    step: 0.01,  overrideMax: 1   },
    { folder: colorTuning, prop: "saturationRange",  label: "Saturation range",  min: 0,   max: 0.5,  step: 0.01,  overrideMax: 1   },
  ];

  // Wire up randomSettings now that numericDefs is available
  // Excluded from randomisation: background colour, zoom, target framerate
  const randomExclude = new Set(["backgroundColor", "zoom", "targetFps"]);
  // Budget-derived compound limits (used to clamp random combos)
  const _maxVisibleHits     = budget?.maxVisibleHits     ?? 200_000;
  const _maxPhysicsCost     = budget?.maxPhysicsCostPerSec ?? 2_000_000;

  // Per-param random-range caps for expensive params.
  // The full slider range is available for manual tweaking; random uses
  // a tighter range to avoid combinatorial budget blow-ups.
  const randomMaxOverride: Record<string, number> = {
    persistence:   3,     // full slider up to 120s — extremely dangerous
    arrivalSpread: 3,     // full slider up to 120s — blows up future buffer
    lMax:          8,     // full slider up to 96 — cubic physics cost
    particleRate:  3000,  // full slider up to 200K — compound cost driver
    bloomStrength: 2.5,   // high bloom + many particles = GPU overload
    bloomRadius:   0.5,   // large radius at high particle count is expensive
  };

  params.randomSettings = () => {
    const rand = Math.random;
    // Randomise numeric params within their safe random ranges
    for (const def of numericDefs) {
      if (randomExclude.has(def.prop)) continue;
      const effectiveMax = Math.min(def.max, randomMaxOverride[def.prop] ?? def.max);
      const v = def.min + rand() * (effectiveMax - def.min);
      // Snap to step grid
      const stepped = def.step
        ? Math.round(v / def.step) * def.step
        : v;
      (params as unknown as Record<string, unknown>)[def.prop] = Math.min(Math.max(stepped, def.min), effectiveMax);
    }
    // Randomise boolean toggles (frozen excluded)
    params.roundParticles = rand() > 0.3;    // bias toward round
    params.bloomEnabled = rand() > 0.5;
    params.ringAutoColor = rand() > 0.5;
    params.autoBrightness = rand() > 0.6;
    // kCurvature: pick -1, 0, or 1 uniformly
    params.kCurvature = ([-1, 0, 1] as const)[Math.floor(rand() * 3)];
    params.doubleBounce = Number(params.kCurvature) === 1 && rand() > 0.5;
    // Random ring colour (background colour excluded)
    params.ringColor = '#' + Math.floor(rand() * 0xFFFFFF).toString(16).padStart(6, '0');

    // ── Compound-cost safety clamp ─────────────────────────────
    // After independent randomisation, enforce three budget axes by
    // scaling down particleRate (the cheapest param to reduce).
    {
      const numCoeffs = params.lMax * params.lMax + 2 * params.lMax;

      // (a) Renderer: rate × persistence ≤ maxVisibleHits
      const maxByRenderer = _maxVisibleHits / Math.max(params.persistence, 0.2);

      // (b) Physics: rate × numCoeffs ≤ maxPhysicsCost
      const maxByPhysics  = numCoeffs > 0
        ? _maxPhysicsCost / numCoeffs
        : Infinity;

      // (c) Total buffer: rate × (persistence + arrivalSpread × 1.5 + 2) ≤ maxTotalBuffer
      //     Each hit is iterated every frame for fade-expire — cap total iteration count.
      const maxTotalBuffer = _maxVisibleHits * 2;
      const totalWindow = params.persistence + params.arrivalSpread * 1.5 + 2;
      const maxByBuffer = maxTotalBuffer / Math.max(totalWindow, 0.5);

      const safeRate = Math.max(100, Math.min(params.particleRate, maxByRenderer, maxByPhysics, maxByBuffer));
      params.particleRate = Math.round(safeRate / 100) * 100;  // snap to step=100
    }

    // Update all UI
    gui.controllersRecursive().forEach(c => c.updateDisplay());
    updateDbState();
    updateConditionalFolders();
    // Full reset: clear hits, restart workers with new params.
    // Without this, stale worker batches and hit buffers from the
    // previous settings cause compute spikes that freeze the tab.
    params.reset();
  };

  // Track live controllers so we can destroy & recreate on mode switch
  let activeNumericControllers: Controller[] = [];

  function rebuildNumericControllers(override: boolean): void {
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

    // Post-rebuild hooks: re-attach watchers, update visibility, apply tooltips
    attachBetaPPWatcher();
    updateConditionalFolders();
    attachNumericTooltips();
  }

  // ── Conditional folder & controller visibility ─────────────────────
  // Tracks which HDR rendering mode is active (set by main.ts after init)
  let currentHDRMode: 'full' | 'soft' | 'none' = 'none';

  /** Properties that are only visible under certain conditions. */
  const conditionalProps: Record<string, () => boolean> = {
    bloomStrength:    () => params.bloomEnabled,
    bloomRadius:      () => params.bloomEnabled,
    bloomThreshold:   () => params.bloomEnabled,
    softHdrExposure:  () => currentHDRMode === 'soft',
    particleSoftEdge: () => params.roundParticles,
    brightness:       () => !params.autoBrightness,
  };

  function updateConditionalFolders(): void {
    const showDb = params.doubleBounce && Number(params.kCurvature) === 1;
    dbTuning.domElement.style.display = showDb ? "" : "none";

    const showPp = params.betaPP > 0;
    ppTuning.domElement.style.display = showPp ? "" : "none";

    // Show/hide individual controllers based on conditional logic
    for (let i = 0; i < numericDefs.length; i++) {
      const def = numericDefs[i];
      const condition = conditionalProps[def.prop];
      if (condition !== undefined) {
        const ctrl = activeNumericControllers[i];
        if (ctrl) {
          ctrl.domElement.style.display = condition() ? "" : "none";
        }
      }
    }

    // Show/hide bloom quality dropdown (non-numeric, separate from numericDefs)
    bloomQualityCtrl.domElement.style.display = params.bloomEnabled ? "" : "none";
  }

  // Monitor betaPP changes to show/hide production tuning
  // Find the betaPP controller and attach onChange
  const betaPPIdx = numericDefs.findIndex(d => d.prop === "betaPP");
  function attachBetaPPWatcher() {
    if (betaPPIdx >= 0 && activeNumericControllers[betaPPIdx]) {
      activeNumericControllers[betaPPIdx].onChange(() => updateConditionalFolders());
    }
  }

  // Build initial bounded sliders (must follow betaPPIdx so post-hooks work)
  rebuildNumericControllers(false);

  // ── Dynamic slider limits removed (arrivalSpread is absolute) ──────
  // The old updateTimeDilationMax is no longer needed since the slider
  // value is in seconds — no physics-dependent max calculation required.

  // ── Left panel: Readout (read-only) ───────────────────────────────
  const hud: HUDData = {
    beta: "0.100",
    aMin: "0",
    wEff: "0",
    torsionRatio: "0",
    ppStrength: "0",
    flux: "0",
    visible: "0",
    fps: "0",
    cpuUsage: "1 / ? threads",
    cpuLoad: "0%",
    gpuLoad: "0%",
    bufferFill: "0",
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

  const readoutGui = new GUI({ title: "Readout" });
  readoutGui.domElement.classList.add("ecsk-panel", "ecsk-readout");
  readoutGui.domElement.style.zIndex = "999";
  readoutGui.close();  // start collapsed (nearly invisible)

  const physicsReadout = readoutGui.addFolder("Physics");
  const controllers = [
    physicsReadout.add(hud, "beta").name("Spin coupling (β)").listen().disable(),
    physicsReadout.add(hud, "aMin").name("Bounce scale (a_min)").listen().disable(),
    physicsReadout.add(hud, "wEff").name("Bounce stiffness (w)").listen().disable(),
    physicsReadout.add(hud, "torsionRatio").name("Torsion dominance (S)").listen().disable(),
    physicsReadout.add(hud, "ppStrength").name("Pair creation rate").listen().disable(),
  ];

  const perfReadout = readoutGui.addFolder("Performance");
  controllers.push(
    perfReadout.add(hud, "flux").name("Particles / sec").listen().disable(),
    perfReadout.add(hud, "visible").name("On screen").listen().disable(),
    perfReadout.add(hud, "fps").name("Frame rate").listen().disable(),
    perfReadout.add(hud, "cpuUsage").name("CPU threads used").listen().disable(),
    perfReadout.add(hud, "cpuLoad").name("CPU load").listen().disable(),
    perfReadout.add(hud, "gpuLoad").name("GPU load").listen().disable(),
    perfReadout.add(hud, "bufferFill").name("Buffer fill").listen().disable(),
  );

  const hwReadout = readoutGui.addFolder("Hardware");
  hwReadout.close();  // collapsed by default
  controllers.push(
    hwReadout.add(hud, "screen").name("Resolution").listen().disable(),
    hwReadout.add(hud, "hz").name("Refresh rate").listen().disable(),
    hwReadout.add(hud, "hdr").name("HDR mode").listen().disable(),
    hwReadout.add(hud, "gamut").name("Colour range").listen().disable(),
    hwReadout.add(hud, "cpuCores").name("CPU cores").listen().disable(),
    hwReadout.add(hud, "cpuBench").name("CPU speed").listen().disable(),
    hwReadout.add(hud, "gpu").name("Graphics chip").listen().disable(),
    hwReadout.add(hud, "capability").name("Overall score").listen().disable(),
    hwReadout.add(hud, "tier").name("Performance tier").listen().disable(),
  );

  function updateHUD() {
    for (const c of controllers) c.updateDisplay();
  }

  // ── Tooltip system ──────────────────────────────────────────────────
  const tooltipEl = document.createElement("div");
  tooltipEl.className = "ecsk-tooltip";
  if (!isMobile) document.body.appendChild(tooltipEl);  // skip on mobile (hover-only)

  /** Build structured tooltip HTML from a Tooltip object. */
  function buildTooltipHTML(tip: Tooltip): string {
    let html = `<div class="tt-simple">${escapeHTML(tip.simple)}</div>`;
    // Structured sections (control tooltips)
    const sections: Array<[string, string, string | undefined]> = [
      ["tt-visual",  "What changes",  tip.visual],
      ["tt-science", "Science",       tip.science],
      ["tt-range",   "Typical range", tip.range],
      ["tt-perf",    "Performance",   tip.performance],
      ["tt-notes",   "Notes",         tip.notes],
    ];
    let hasStructured = false;
    for (const [cls, label, content] of sections) {
      if (!content) continue;
      hasStructured = true;
      html += `<div class="tt-section ${cls}">` +
        `<div class="tt-label">${label}</div>` +
        `<div class="tt-body">${escapeHTML(content)}</div></div>`;
    }
    // Legacy fallback (readout tooltips with plain `detail`)
    if (!hasStructured && tip.detail) {
      html += `<div class="tt-detail">${escapeHTML(tip.detail)}</div>`;
    }
    return html;
  }

  function escapeHTML(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/\n/g, "<br>");
  }

  let tooltipTimer: ReturnType<typeof setTimeout> | null = null;

  function showTooltip(el: HTMLElement, tip: Tooltip): void {
    tooltipEl.innerHTML = buildTooltipHTML(tip);
    // Position: to the left of the control element (or right for left-panel)
    const rect = el.getBoundingClientRect();
    const ttWidth = 420; // max-width from CSS
    // Try placing to the left; if no room, place to the right
    let left = rect.left - ttWidth - 8;
    if (left < 4) left = rect.right + 8;
    // Vertical: align top with the element, clamp to viewport
    let top = rect.top;
    tooltipEl.classList.add("visible");
    // Measure actual height after content is set
    const ttHeight = tooltipEl.offsetHeight;
    if (top + ttHeight > window.innerHeight - 4) {
      top = window.innerHeight - ttHeight - 4;
    }
    if (top < 4) top = 4;
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
  }

  function hideTooltip(): void {
    if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
    tooltipEl.classList.remove("visible");
  }

  /**
   * Attach a hover tooltip to a controller's DOM row.
   * @param domElement  The controller's .domElement
   * @param key         Lookup key in TOOLTIPS or READOUT_TOOLTIPS
   * @param tooltipMap  Which map to look up (defaults to TOOLTIPS)
   */
  function attachTooltip(
    domElement: HTMLElement,
    key: string,
    tooltipMap: Record<string, Tooltip> = TOOLTIPS,
  ): void {
    if (isMobile) return;  // tooltips are hover-only — skip on touch devices
    const tip = tooltipMap[key];
    if (!tip) return;
    domElement.addEventListener("mouseenter", () => {
      tooltipTimer = setTimeout(() => showTooltip(domElement, tip), 380);
    });
    domElement.addEventListener("mouseleave", hideTooltip);
  }

  // ── Attach tooltips to non-numeric controllers ────────────────────
  // Override mode
  attachTooltip(overrideCtrl.domElement, "overrideMode");
  // Curvature dropdown — find the kCurvature controller in the physics folder
  for (const ctrl of physics.controllersRecursive()) {
    const prop = (ctrl as unknown as { property: string }).property;
    if (prop === "kCurvature") attachTooltip(ctrl.domElement, "kCurvature");
    if (prop === "doubleBounce") attachTooltip(ctrl.domElement, "doubleBounce");
  }
  // Frozen, reset
  for (const ctrl of flow.controllersRecursive()) {
    const prop = (ctrl as unknown as { property: string }).property;
    if (prop === "frozen") attachTooltip(ctrl.domElement, "frozen");
    if (prop === "reset") attachTooltip(ctrl.domElement, "reset");
    if (prop === "resetSettings") attachTooltip(ctrl.domElement, "resetSettings");
    if (prop === "randomSettings") attachTooltip(ctrl.domElement, "randomSettings");
    // targetFps tooltip is attached inline when the dropdown is created
  }
  // Round particles, bloom, ring colour, auto-colour, background
  for (const ctrl of particles.controllersRecursive()) {
    const prop = (ctrl as unknown as { property: string }).property;
    if (prop === "roundParticles") attachTooltip(ctrl.domElement, "roundParticles");
    if (prop === "autoBrightness") attachTooltip(ctrl.domElement, "autoBrightness");
  }
  for (const ctrl of ring.controllersRecursive()) {
    const prop = (ctrl as unknown as { property: string }).property;
    if (prop === "ringColor") attachTooltip(ctrl.domElement, "ringColor");
    if (prop === "ringAutoColor") attachTooltip(ctrl.domElement, "ringAutoColor");
  }
  for (const ctrl of bloomFolder.controllersRecursive()) {
    const prop = (ctrl as unknown as { property: string }).property;
    if (prop === "bloomEnabled") attachTooltip(ctrl.domElement, "bloomEnabled");
    if (prop === "bloomQuality") attachTooltip(ctrl.domElement, "bloomQuality");
  }
  for (const ctrl of camera.controllersRecursive()) {
    const prop = (ctrl as unknown as { property: string }).property;
    if (prop === "backgroundColor") attachTooltip(ctrl.domElement, "backgroundColor");
  }

  // ── Attach tooltips to numeric controllers (re-run after rebuild) ──
  function attachNumericTooltips(): void {
    for (let i = 0; i < numericDefs.length; i++) {
      const ctrl = activeNumericControllers[i];
      if (ctrl) attachTooltip(ctrl.domElement, numericDefs[i].prop);
    }
  }

  // ── Attach tooltips to readout controllers ────────────────────────
  // Match by property name from the HUD data object
  const readoutHudKeys: string[] = [
    "beta", "aMin", "wEff", "torsionRatio", "ppStrength",
    "flux", "visible", "fps", "cpuUsage", "cpuLoad", "gpuLoad", "bufferFill",
    "screen", "hz", "hdr", "gamut",
    "cpuCores", "cpuBench", "gpu", "capability", "tier",
  ];
  for (let i = 0; i < controllers.length && i < readoutHudKeys.length; i++) {
    attachTooltip(controllers[i].domElement, readoutHudKeys[i], READOUT_TOOLTIPS);
  }

  /**
   * Notify controls of the active HDR rendering mode.
   * Controls that are irrelevant for the current mode are hidden.
   */
  function setHDRMode(mode: 'full' | 'soft' | 'none'): void {
    currentHDRMode = mode;
    updateConditionalFolders();
  }

  // ── Fullscreen toggle button ───────────────────────────────────
  {
    const btn = document.createElement("button");
    btn.id = "fullscreen-btn";
    btn.title = "Toggle fullscreen";
    // SVG expand icon (4 outward arrows)
    const expandSVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
    const collapseSVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6m10-10h-6V4m0 16h6v-6M4 4h6v6"/></svg>`;
    btn.innerHTML = expandSVG;
    document.body.appendChild(btn);

    function updateIcon() {
      const isFS = !!document.fullscreenElement;
      btn.innerHTML = isFS ? collapseSVG : expandSVG;
      btn.title = isFS ? "Exit fullscreen" : "Enter fullscreen";
    }

    btn.addEventListener("click", () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    // Update icon when fullscreen changes (Esc on desktop, back on mobile)
    document.addEventListener("fullscreenchange", updateIcon);
    document.addEventListener("webkitfullscreenchange", updateIcon);
  }

  // ── Force HDR button (mobile-only) ─────────────────────────────
  let onForceHDR: ((enabled: boolean) => void) | null = null;
  if (isMobile && currentHDRMode === 'none') {
    const btn = document.createElement("button");
    btn.id = "force-hdr-btn";
    btn.textContent = "Force HDR";
    btn.title = "Enable enhanced brightness on compatible OLED screens";
    document.body.appendChild(btn);

    let forced = false;
    btn.addEventListener("click", () => {
      forced = !forced;
      btn.textContent = forced ? "HDR On" : "Force HDR";
      btn.classList.toggle("active", forced);
      onForceHDR?.(forced);
    });
  }

  function setForceHDRCallback(cb: (enabled: boolean) => void): void {
    onForceHDR = cb;
  }

  return { gui, readoutGui, params, hud, updateHUD, setHDRMode, setForceHDRCallback };
}
