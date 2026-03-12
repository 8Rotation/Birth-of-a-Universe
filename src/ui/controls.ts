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
  forceHDR: boolean;       // force soft-HDR on mobile (bypasses detection)

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
  ringBloomEnabled: boolean;  // ring bloom on/off (independent of particle bloom)
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
  displaySyncHz: number; // 0 = auto-detect, >0 = force auto-sync pacing to this refresh rate
  targetFps: number;  // 0 = adaptive display sync, >0 = manual framerate cap

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

function getStepPrecision(step: number): number {
  const stepText = step.toString().toLowerCase();
  const exponentMatch = stepText.match(/e-(\d+)$/);
  if (exponentMatch) {
    return Number(exponentMatch[1]);
  }

  const decimalPart = stepText.split(".")[1];
  return decimalPart ? decimalPart.length : 0;
}

function snapValueToStep(value: number, step: number, origin = 0): number {
  if (!Number.isFinite(step) || step <= 0) {
    return value;
  }

  const precision = getStepPrecision(step);
  const snapped = origin + Math.round((value - origin) / step) * step;
  return Number(snapped.toFixed(precision));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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
.lil-gui .lil-title,
.lil-gui .title {
  font-size: 11px;
  line-height: 20px;
  padding: 2px 8px;
}
.lil-gui .lil-controller,
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
.ecsk-panel.lil-gui.lil-closed,
.ecsk-panel.lil-gui.closed {
  opacity: 0.05;
}
.ecsk-panel.lil-gui.lil-closed:hover,
.ecsk-panel.lil-gui.closed:hover {
  opacity: 0.85;
}
.ecsk-panel.lil-gui:not(.lil-closed):not(.closed) {
  opacity: 0.88;
}
.ecsk-panel.lil-gui:not(.lil-closed):not(.closed):hover {
  opacity: 1;
}
.ecsk-readout.lil-gui.lil-closed,
.ecsk-readout.lil-gui.closed {
  opacity: 0.12;
}
.ecsk-readout.lil-gui.lil-closed:hover,
.ecsk-readout.lil-gui.closed:hover {
  opacity: 0.92;
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
.ecsk-readout > .lil-title,
.ecsk-readout > .title {
  font-size: 13px;
  line-height: 24px;
  font-weight: 700;
  letter-spacing: 0.015em;
  color: #dedede;
}
.ecsk-readout .lil-controller,
.ecsk-readout .controller {
  min-height: 18px;
  padding: 0;
}
.ecsk-readout .lil-controller .lil-name,
.ecsk-readout .controller .name {
  font-size: 10px;
}
.ecsk-readout .lil-controller .lil-widget,
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
.ecsk-controls > .lil-title,
.ecsk-controls > .title {
  display: flex;
  align-items: center;
  font-size: 13px;
  line-height: 24px;
  padding: 3px 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: #e7e7e7;
  text-shadow: 0 0 10px rgba(120, 180, 255, 0.08);
}
.ecsk-controls .ecsk-brand-title {
  display: inline-block;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: #f0f0f0;
  text-shadow: 0 0 14px rgba(150, 185, 235, 0.08);
}
.ecsk-mobile-brand-card {
  margin: 10px 10px 4px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  background: linear-gradient(180deg, rgba(22, 22, 22, 0.92), rgba(8, 8, 8, 0.88));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}
.ecsk-mobile-brand-title {
  display: inline-block;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.025em;
  color: #f0f0f0;
  text-shadow: 0 0 14px rgba(150, 185, 235, 0.08);
}
.ecsk-mobile-brand-subtitle {
  margin-top: 4px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #8d8d8d;
}
@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .ecsk-controls .ecsk-brand-title {
    background-image: linear-gradient(100deg, rgba(255, 241, 214, 0.98) 0%, rgba(212, 191, 142, 0.96) 32%, rgba(154, 181, 212, 0.96) 68%, rgba(205, 226, 255, 0.98) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    -webkit-text-fill-color: transparent;
  }

  .ecsk-mobile-brand-title {
    background-image: linear-gradient(100deg, rgba(255, 241, 214, 0.98) 0%, rgba(212, 191, 142, 0.96) 32%, rgba(154, 181, 212, 0.96) 68%, rgba(205, 226, 255, 0.98) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    -webkit-text-fill-color: transparent;
  }
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
  top: 0 !important;
  bottom: auto !important;
  left: 0 !important;
  right: 0 !important;
  width: 100% !important;
  max-height: 40vh !important;
  overflow-y: auto !important;
  z-index: 1001 !important;
}
.ecsk-mobile .ecsk-controls {
  position: fixed !important;
  top: auto !important;
  bottom: 0 !important;
  left: 0 !important;
  right: 0 !important;
  width: 100% !important;
  max-height: 60vh !important;
  overflow-y: auto !important;
}
/* On mobile: collapsed panels are semi-visible (no hover needed) */
.ecsk-mobile .ecsk-panel.lil-gui.lil-closed,
.ecsk-mobile .ecsk-panel.lil-gui.closed {
  opacity: 0.25;
}
.ecsk-mobile .ecsk-readout.lil-gui.lil-closed,
.ecsk-mobile .ecsk-readout.lil-gui.closed {
  opacity: 0.38;
}
/* Tap opens — keep translucent so simulation stays visible */
.ecsk-mobile .ecsk-panel.lil-gui:not(.lil-closed):not(.closed) {
  opacity: 0.72;
}
/* Larger touch targets */
.ecsk-mobile .lil-gui .lil-title,
.ecsk-mobile .lil-gui .title {
  font-size: 14px;
  line-height: 38px;
  padding: 6px 14px;
}
.ecsk-mobile .lil-gui .lil-controller,
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
  --background-color: rgba(0, 0, 0, 0.55);
  --title-background-color: rgba(5, 5, 5, 0.5);
  --widget-color: rgba(26, 26, 26, 0.5);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.ecsk-mobile .ecsk-readout > .lil-title,
.ecsk-mobile .ecsk-readout > .title,
.ecsk-mobile .ecsk-controls > .lil-title,
.ecsk-mobile .ecsk-controls > .title {
  font-size: 16px;
  line-height: 42px;
  padding: 7px 14px;
}
.ecsk-mobile .ecsk-readout.lil-gui:not(.lil-closed):not(.closed) {
  overflow: hidden !important;
}
.ecsk-mobile .ecsk-readout.lil-gui:not(.lil-closed):not(.closed) > .lil-title,
.ecsk-mobile .ecsk-readout.lil-gui:not(.lil-closed):not(.closed) > .title {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  top: auto;
  z-index: 2;
}
.ecsk-mobile .ecsk-readout.lil-gui:not(.lil-closed):not(.closed) > .lil-children,
.ecsk-mobile .ecsk-readout.lil-gui:not(.lil-closed):not(.closed) > .children {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 48px;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
@media (orientation: landscape) {
  .ecsk-mobile .ecsk-panel.lil-gui {
    top: 0 !important;
    bottom: 0 !important;
    width: min(46vw, 340px) !important;
    height: 100vh !important;
    max-height: 100vh !important;
    overflow: hidden !important;
    clip-path: inset(0 0 0 0);
    transition: opacity 0.3s ease, clip-path 0.3s ease;
  }

  .ecsk-mobile .ecsk-readout {
    left: 0 !important;
    right: auto !important;
    bottom: 0 !important;
    width: min(42vw, 320px) !important;
    max-height: 100vh !important;
    overflow: hidden !important;
  }

  .ecsk-mobile .ecsk-controls {
    left: auto !important;
    right: 0 !important;
    bottom: 0 !important;
    width: min(48vw, 360px) !important;
    max-height: 100vh !important;
  }

  .ecsk-mobile .ecsk-panel.lil-gui > .lil-title,
  .ecsk-mobile .ecsk-panel.lil-gui > .title {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 38px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px 4px;
    font-size: 12px;
    line-height: 1.1;
    text-align: center;
    white-space: normal;
    writing-mode: vertical-rl;
    text-orientation: mixed;
    z-index: 2;
  }

  .ecsk-mobile .ecsk-readout > .lil-title,
  .ecsk-mobile .ecsk-readout > .title {
    left: 0;
    border-right: 1px solid #222;
  }

  .ecsk-mobile .ecsk-controls > .lil-title,
  .ecsk-mobile .ecsk-controls > .title {
    right: 0;
    border-left: 1px solid #222;
    writing-mode: vertical-lr;
  }

  .ecsk-mobile .ecsk-controls > .lil-title,
  .ecsk-mobile .ecsk-controls > .title {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .ecsk-mobile .ecsk-readout > .lil-children,
  .ecsk-mobile .ecsk-readout > .children,
  .ecsk-mobile .ecsk-controls > .lil-children,
  .ecsk-mobile .ecsk-controls > .children {
    position: absolute;
    top: 0;
    bottom: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  .ecsk-mobile .ecsk-readout > .lil-children,
  .ecsk-mobile .ecsk-readout > .children {
    left: 38px;
    right: 0;
    bottom: 0;
  }

  .ecsk-mobile .ecsk-controls > .lil-children,
  .ecsk-mobile .ecsk-controls > .children {
    top: 34px;
    left: 0;
    right: 38px;
  }

  .ecsk-mobile .ecsk-panel.lil-gui.lil-closed,
  .ecsk-mobile .ecsk-panel.lil-gui.closed {
    opacity: 0.34;
  }

  .ecsk-mobile .ecsk-readout.lil-gui.lil-closed,
  .ecsk-mobile .ecsk-readout.lil-gui.closed {
    clip-path: inset(0 calc(100% - 38px) 0 0);
  }

  .ecsk-mobile .ecsk-controls.lil-gui.lil-closed,
  .ecsk-mobile .ecsk-controls.lil-gui.closed {
    clip-path: inset(0 0 0 calc(100% - 38px));
  }

  .ecsk-mobile .ecsk-panel.lil-gui:not(.lil-closed):not(.closed) {
    opacity: 0.82;
    clip-path: inset(0 0 0 0);
  }

  .ecsk-mobile .ecsk-panel.lil-gui.lil-closed > .lil-children,
  .ecsk-mobile .ecsk-panel.lil-gui.closed > .children {
    pointer-events: none;
  }
}

/* ── Mobile tooltip info icons ─────────────────────────────────── */
.ecsk-mobile .lil-gui .lil-controller .lil-name,
.ecsk-mobile .lil-gui .controller .name,
.ecsk-mobile .lil-gui .controller .lil-name {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: visible;
}
.ecsk-mobile .lil-gui .lil-controller .lil-name.ecsk-name-with-info,
.ecsk-mobile .lil-gui .controller .name.ecsk-name-with-info,
.ecsk-mobile .lil-gui .controller .lil-name.ecsk-name-with-info {
  min-width: var(--name-width);
}
.ecsk-label-text {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ecsk-info-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 19px;
  height: 19px;
  min-width: 19px;
  border-radius: 50%;
  border: 1px solid #888;
  color: #ddd;
  font-size: 11px;
  font-style: italic;
  font-family: Georgia, 'Times New Roman', serif;
  line-height: 1;
  flex-shrink: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  background: rgba(255, 255, 255, 0.08);
  padding: 0;
  box-sizing: border-box;
}
.ecsk-info-btn.active {
  color: #fff;
  border-color: #b8d8ff;
  background: rgba(108, 204, 255, 0.18);
}
.ecsk-info-btn:active {
  background: #333;
  color: #fff;
  border-color: #aaa;
}

/* ── Mobile tooltip overlay (blocks interaction while tooltip is open) ── */
.ecsk-tooltip-overlay {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 9999;
  background: transparent;
  -webkit-tap-highlight-color: transparent;
  touch-action: none;
}
.ecsk-tooltip-overlay.visible {
  display: block;
}

/* ── Mobile panel overlay (dismisses open control/readout panels) ── */
.ecsk-panel-overlay {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 998;
  background: transparent;
  -webkit-tap-highlight-color: transparent;
  touch-action: none;
}
.ecsk-panel-overlay.visible {
  display: block;
}

/* ── Mobile tooltip positioning ────────────────────────────────── */
.ecsk-mobile .ecsk-tooltip {
  left: 6vw !important;
  right: 6vw !important;
  top: auto !important;
  bottom: 4vh !important;
  max-width: min(88vw, 420px) !important;
  min-width: auto !important;
  width: min(88vw, 420px) !important;
  max-height: 52vh;
  padding: 12px 14px 14px;
  background: rgba(8, 8, 8, 0.96);
  border-color: #343434;
  box-shadow: 0 10px 36px rgba(0,0,0,0.82);
  pointer-events: none;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
.ecsk-mobile .ecsk-tooltip.visible {
  pointer-events: auto;
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
    ringBloomEnabled: true,
    ringBloomStrength: 0.8,
    ringBloomRadius: 0.4,
    ringAutoColor: true,
    forceHDR: false,
    softHdrExposure: 1.6,
    particleSoftEdge: 0.05,
    autoBrightness: true,
    backgroundColor: "#000000",
    zoom: 1.0,
    frozen: false,
    displaySyncHz: 0,
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
  const gui = new GUI({ title: "Birth of a Universe" });
  gui.domElement.classList.add("ecsk-panel", "ecsk-controls");
  gui.domElement.style.zIndex = "1000";
  if (isMobile) gui.close();  // start collapsed on mobile — maximise canvas

  const controlsTitle = gui.domElement.querySelector(".lil-title, .title") as HTMLElement | null;
  const controlsChildren = gui.domElement.querySelector(".lil-children, .children") as HTMLElement | null;
  if (controlsTitle) {
    if (isMobile) {
      controlsTitle.textContent = "Settings";
      controlsTitle.setAttribute("aria-label", "Birth of a Universe settings");
    } else {
      controlsTitle.textContent = "";
      const brandTitle = document.createElement("span");
      brandTitle.className = "ecsk-brand-title";
      brandTitle.textContent = "Birth of a Universe";
      controlsTitle.appendChild(brandTitle);
      controlsTitle.setAttribute("aria-label", "Birth of a Universe");
    }
  }

  if (isMobile && controlsChildren) {
    const mobileBrandCard = document.createElement("div");
    mobileBrandCard.className = "ecsk-mobile-brand-card";

    const mobileBrandTitle = document.createElement("div");
    mobileBrandTitle.className = "ecsk-mobile-brand-title";
    mobileBrandTitle.textContent = "Birth of a Universe";

    const mobileBrandSubtitle = document.createElement("div");
    mobileBrandSubtitle.className = "ecsk-mobile-brand-subtitle";
    mobileBrandSubtitle.textContent = "Settings";

    mobileBrandCard.appendChild(mobileBrandTitle);
    mobileBrandCard.appendChild(mobileBrandSubtitle);
    controlsChildren.prepend(mobileBrandCard);
  }

  // ── Override Mode toggle ──────────────────────────────────────────
  const overrideState = { overrideMode: false };
  let overrideCtrl: Controller;

  const openActions = {
    openBounceExplainer: () => {
      window.open("simplified-3d-illustration/index.html", "_blank", "noopener");
    },
  };
  gui.add(openActions, "openBounceExplainer").name("What am I looking at? ↗");

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
  // Random button moved to bottom bar as quick-setting

  const COMMON_FPS = [240, 165, 144, 120, 90, 60, 30];
  const COMMON_SYNC_RATES = [240, 165, 144, 120, 90, 75, 60, 50, 48, 30];
  let fpsCtrl: Controller | null = null;

  function updateTargetFpsLabel(nextRefreshRate: number): void {
    const selectEl = fpsCtrl?.domElement.querySelector("select") as HTMLSelectElement | null;
    const vsyncOption = selectEl?.querySelector('option[value="0"]');
    if (vsyncOption) {
      const effectiveRefreshRate = params.displaySyncHz > 0 ? params.displaySyncHz : nextRefreshRate;
      const suffix = params.displaySyncHz > 0 ? " override" : "";
      vsyncOption.textContent = `Auto (display sync: ${Math.round(effectiveRefreshRate)} Hz${suffix})`;
    }
  }

  const displaySyncOptions: Record<string, number> = {
    "Auto-detect": 0,
  };
  for (const hz of COMMON_SYNC_RATES) {
    displaySyncOptions[`${hz} Hz`] = hz;
  }
  const displaySyncCtrl = flow.add(params, "displaySyncHz", displaySyncOptions).name("Display sync").onChange(() => {
    params.displaySyncHz = Number(params.displaySyncHz);
    updateTargetFpsLabel(refreshRate);
  });

  // Target framerate dropdown — always shows all common rates so a wrong Hz
  // detection never hides valid choices.  Detected rate shown on the auto-sync label.
  {
    const fpsOptions: Record<string, number> = {};
    fpsOptions[`Auto (display sync: ${refreshRate} Hz)`] = 0;
    for (const fps of COMMON_FPS) {
      fpsOptions[`${fps} fps`] = fps;
    }
    fpsCtrl = flow.add(params, "targetFps", fpsOptions).name("Target framerate");
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
  ring.add(params, "ringBloomEnabled").name("Ring bloom").onChange(() => {
    updateConditionalFolders();
  });

  const bloomFolder = gui.addFolder("Particle Bloom");
  bloomFolder.add(params, "bloomEnabled").name("Particle bloom").onChange(() => {
    updateConditionalFolders();
  });
  const bloomQualityCtrl = bloomFolder.add(params, "bloomQuality", ['auto', 'high', 'low']).name("Bloom quality");

  let onForceHDR: ((enabled: boolean) => void) | null = null;
  let forceHDRBtn: HTMLButtonElement | null = null;

  const camera = gui.addFolder("Camera");
  camera.addColor(params, "backgroundColor").name("Background colour");

  // ── Color Tuning (top-level folder) ───────────────────────────────
  const colorTuning = gui.addFolder("Color Tuning");
  colorTuning.close();  // collapsed by default

  overrideCtrl = gui.add(overrideState, "overrideMode").name("⚙ Override Mode").onChange((v: boolean) => {
    rebuildNumericControllers(v);
    gui.domElement.classList.toggle("ecsk-override", v);
    (overrideCtrl.domElement as HTMLElement).style.color = v ? "red" : "";
  });

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
        ? snapValueToStep(v, def.step, def.min)
        : v;
      (params as unknown as Record<string, unknown>)[def.prop] = clampNumber(stepped, def.min, effectiveMax);
    }
    // Randomise boolean toggles (frozen excluded)
    params.roundParticles = rand() > 0.3;    // bias toward round
    params.bloomEnabled = rand() > 0.5;
    params.ringBloomEnabled = rand() > 0.5;
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
      params.particleRate = snapValueToStep(safeRate, 100);  // snap to step=100
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
    ringBloomStrength: () => params.ringBloomEnabled,
    ringBloomRadius:   () => params.ringBloomEnabled,
    softHdrExposure:  () => currentHDRMode === 'soft' || params.forceHDR,
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

    // Show/hide Force HDR button in bottom bar (mobile only)
    if (forceHDRBtn) {
      forceHDRBtn.style.display = currentHDRMode === 'none' || params.forceHDR ? "" : "none";
    }
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

  let panelOverlayEl: HTMLDivElement | null = null;

  function isGuiClosed(guiInstance: GUI): boolean {
    return guiInstance.domElement.classList.contains("lil-closed") || guiInstance.domElement.classList.contains("closed");
  }

  function syncMobilePanelState(): void {
    if (!isMobile) return;

    const controlsOpen = !isGuiClosed(gui);
    const readoutOpen = !isGuiClosed(readoutGui);
    const body = document.body;

    body.classList.toggle("ecsk-mobile-controls-open", controlsOpen);
    body.classList.toggle("ecsk-mobile-readout-open", readoutOpen);
    body.classList.toggle("ecsk-mobile-both-open", controlsOpen && readoutOpen);

    if (controlsOpen) {
      const controlsHeight = Math.ceil(gui.domElement.getBoundingClientRect().height);
      body.style.setProperty("--ecsk-mobile-controls-height", `${controlsHeight}px`);
    } else {
      body.style.removeProperty("--ecsk-mobile-controls-height");
    }

    if (panelOverlayEl) {
      panelOverlayEl.classList.toggle("visible", controlsOpen || readoutOpen);
    }
  }

  function syncMobilePanelOverlay(): void {
    syncMobilePanelState();
  }

  function attachMobilePanelDismiss(guiInstance: GUI): void {
    if (!isMobile) return;
    const titleEl = guiInstance.domElement.querySelector(".lil-title, .title") as HTMLElement | null;
    if (!titleEl) return;
    titleEl.addEventListener("click", () => {
      requestAnimationFrame(syncMobilePanelOverlay);
    });
  }

  if (isMobile) {
    panelOverlayEl = document.createElement("div");
    panelOverlayEl.className = "ecsk-panel-overlay";
    const dismissPanels = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      gui.close();
      readoutGui.close();
      syncMobilePanelOverlay();
    };
    panelOverlayEl.addEventListener("touchstart", dismissPanels, { capture: true, passive: false });
    panelOverlayEl.addEventListener("click", dismissPanels, { capture: true });
    document.body.appendChild(panelOverlayEl);
    attachMobilePanelDismiss(gui);
    attachMobilePanelDismiss(readoutGui);
    window.addEventListener("resize", syncMobilePanelState);
    syncMobilePanelState();
  }

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
  document.body.appendChild(tooltipEl);

  // Mobile: overlay blocks all interaction behind the tooltip
  let overlayEl: HTMLDivElement | null = null;
  let activeMobileTooltipKey: string | null = null;
  let activeMobileTooltipButton: HTMLElement | null = null;
  if (isMobile) {
    overlayEl = document.createElement("div");
    overlayEl.className = "ecsk-tooltip-overlay";
    document.body.appendChild(overlayEl);
    const dismissMobileTooltip = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      hideMobileTooltip();
    };
    overlayEl.addEventListener("touchstart", dismissMobileTooltip, { capture: true });
    overlayEl.addEventListener("click", dismissMobileTooltip, { capture: true });
  }

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

  // Mobile tooltip: show with overlay, positioned via CSS
  function showMobileTooltip(key: string, tip: Tooltip, triggerEl: HTMLElement): void {
    if (activeMobileTooltipButton) activeMobileTooltipButton.classList.remove("active");
    tooltipEl.innerHTML = buildTooltipHTML(tip);
    tooltipEl.classList.add("visible");
    overlayEl?.classList.add("visible");
    activeMobileTooltipKey = key;
    activeMobileTooltipButton = triggerEl;
    activeMobileTooltipButton.classList.add("active");
  }

  function hideMobileTooltip(): void {
    tooltipEl.classList.remove("visible");
    overlayEl?.classList.remove("visible");
    if (activeMobileTooltipButton) activeMobileTooltipButton.classList.remove("active");
    activeMobileTooltipButton = null;
    activeMobileTooltipKey = null;
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
    const tip = tooltipMap[key];
    if (!tip) return;

    if (isMobile) {
      // Mobile: add a leading (i) icon that toggles the tooltip via a blocking overlay.
      const nameEl = domElement.querySelector(".name, .lil-name") as HTMLElement | null;
      if (!nameEl) return;
      // Don't add duplicate icons (e.g. after rebuild)
      if (nameEl.querySelector(".ecsk-info-btn")) return;

      nameEl.classList.add("ecsk-name-with-info");

      const labelText = document.createElement("span");
      labelText.className = "ecsk-label-text";
      while (nameEl.firstChild) {
        labelText.appendChild(nameEl.firstChild);
      }

      const infoBtn = document.createElement("button");
      infoBtn.className = "ecsk-info-btn";
      infoBtn.textContent = "i";
      infoBtn.type = "button";
      infoBtn.setAttribute("aria-label", `Show info for ${key}`);
      const toggleMobileTooltip = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
        if (activeMobileTooltipKey === key) {
          hideMobileTooltip();
          return;
        }
        showMobileTooltip(key, tip, infoBtn);
      };
      infoBtn.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });
      infoBtn.addEventListener("click", toggleMobileTooltip);
      nameEl.append(infoBtn, labelText);
      return;
    }

    // Desktop: hover tooltip with delay
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
    if (prop === "displaySyncHz") attachTooltip(ctrl.domElement, "displaySyncHz");
    if (prop === "frozen") attachTooltip(ctrl.domElement, "frozen");
    if (prop === "reset") attachTooltip(ctrl.domElement, "reset");
    if (prop === "resetSettings") attachTooltip(ctrl.domElement, "resetSettings");
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

  // ── Bottom bar: Fullscreen + Toggle UI buttons ─────────────────
  {
    const bar = document.createElement("div");
    bar.id = "bottom-bar";

    // — Fullscreen button —
    const fsBtn = document.createElement("button");
    fsBtn.className = "bar-btn";
    fsBtn.title = "Toggle fullscreen";
    const expandSVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
    const collapseSVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6m10-10h-6V4m0 16h6v-6M4 4h6v6"/></svg>`;
    fsBtn.innerHTML = expandSVG;

    function updateFsIcon() {
      const isFS = !!document.fullscreenElement;
      fsBtn.innerHTML = isFS ? collapseSVG : expandSVG;
      fsBtn.title = isFS ? "Exit fullscreen" : "Enter fullscreen";
    }
    fsBtn.addEventListener("click", () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });
    document.addEventListener("fullscreenchange", updateFsIcon);
    document.addEventListener("webkitfullscreenchange", updateFsIcon);

    // — Toggle UI button —
    const uiBtn = document.createElement("button");
    uiBtn.className = "bar-btn";
    uiBtn.title = "Hide UI";
    const eyeOpenSVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const eyeClosedSVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    uiBtn.innerHTML = eyeOpenSVG;

    let uiHidden = false;
    let peekTimeout: ReturnType<typeof setTimeout> | null = null;

    function hideUI() {
      uiHidden = true;
      document.body.classList.add("ui-hidden");
      uiBtn.innerHTML = eyeClosedSVG;
      uiBtn.title = "Show UI";
    }

    function showUI() {
      uiHidden = false;
      document.body.classList.remove("ui-hidden", "ui-peek");
      uiBtn.innerHTML = eyeOpenSVG;
      uiBtn.title = "Hide UI";
      if (peekTimeout) { clearTimeout(peekTimeout); peekTimeout = null; }
    }

    function peekBar() {
      if (!uiHidden) return;
      document.body.classList.add("ui-peek");
      if (peekTimeout) clearTimeout(peekTimeout);
      peekTimeout = setTimeout(() => {
        document.body.classList.remove("ui-peek");
        peekTimeout = null;
      }, 3000);
    }

    uiBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (uiHidden) showUI(); else hideUI();
    });

    // Desktop: mouse movement reveals the bar when UI is hidden
    if (!isMobile) {
      document.addEventListener("mousemove", peekBar);
    }
    // Mobile: tap anywhere reveals the bar when UI is hidden
    if (isMobile) {
      document.addEventListener("touchstart", (e) => {
        if (!uiHidden) return;
        if (bar.contains(e.target as Node)) return;
        peekBar();
      }, { passive: true });
    }

    // — Random (dice) button —
    const diceBtn = document.createElement("button");
    diceBtn.className = "bar-btn";
    diceBtn.title = "Randomize settings";
    diceBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>`;
    diceBtn.addEventListener("click", () => { params.randomSettings(); });

    // — Force HDR button (mobile only) —
    if (isMobile) {
      forceHDRBtn = document.createElement("button");
      forceHDRBtn.className = "bar-btn";
      forceHDRBtn.title = "Force HDR (OLED)";
      const hdrOffSVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><text x="12" y="14" text-anchor="middle" font-size="7" font-weight="bold" fill="currentColor" stroke="none">HDR</text></svg>`;
      const hdrOnSVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6cf" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><text x="12" y="14" text-anchor="middle" font-size="7" font-weight="bold" fill="#6cf" stroke="none">HDR</text></svg>`;
      forceHDRBtn.innerHTML = hdrOffSVG;
      forceHDRBtn.addEventListener("click", () => {
        params.forceHDR = !params.forceHDR;
        forceHDRBtn!.innerHTML = params.forceHDR ? hdrOnSVG : hdrOffSVG;
        onForceHDR?.(params.forceHDR);
        updateConditionalFolders();
      });
      bar.appendChild(forceHDRBtn);
    }

    bar.appendChild(diceBtn);
    bar.appendChild(fsBtn);
    bar.appendChild(uiBtn);
    document.body.appendChild(bar);
  }

  function setForceHDRCallback(cb: (enabled: boolean) => void): void {
    onForceHDR = cb;
  }

  return { gui, readoutGui, params, hud, updateHUD, setHDRMode, setForceHDRCallback, updateTargetFpsLabel };
}
