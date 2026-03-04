/**
 * controls.ts — ECSK Bounce Sensor controls and HUD.
 *
 * Provides lil-gui panels for:
 *   - Collapse Physics: β, perturbation amplitude, turbulence (l_max)
 *   - Flow: shell spawning rate, particles per shell, time dilation
 *   - Sensor Display: hit size, brightness, persistence, bloom
 *   - Readout: physics state + performance metrics
 */

import GUI from "lil-gui";

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
    brightness: 1.0,   // lowered: brightness now only modulates HSL lightness, not alpha too
    persistence: 1.0,
    bloomEnabled: true,
    bloomStrength: 1.2,
    bloomRadius: 0.3,
    paused: false,
    reset: onReset,
  };

  const gui = new GUI({ title: "ECSK Bounce Sensor" });
  gui.domElement.style.zIndex = "1000";

  // ── Collapse Physics ──────────────────────────────────────────────
  const physics = gui.addFolder("Collapse Physics");
  physics.add(params, "beta", 0.005, 0.249, 0.001).name("β spin param");
  physics.add(params, "perturbAmplitude", 0.001, 0.6, 0.001).name("Inhomogeneity");
  physics.add(params, "lMax", 1, 24, 1).name("Turbulence (l_max)");

  // ── Flow ──────────────────────────────────────────────────────────
  const flow = gui.addFolder("Flow");
  flow.add(params, "particleRate", 100, 20000, 100).name("Particle rate (/s)");
  flow.add(params, "fieldEvolution", 0, 2, 0.01).name("Field evolution (/s)");
  flow.add(params, "timeDilation", 1, 10000).name("Time dilation");
  flow.add(params, "paused").name("Paused");
  flow.add(params, "reset").name("⟳ Clear");

  // ── Sensor Display ────────────────────────────────────────────────
  const display = gui.addFolder("Sensor Display");
  display.add(params, "hitSize", 1, 30, 0.5).name("Hit size (px)");
  display.add(params, "brightness", 0.1, 5, 0.1).name("Brightness");
  display.add(params, "persistence", 0.1, 20, 0.1).name("Persistence (s)");
  display.add(params, "bloomEnabled").name("Bloom");
  display.add(params, "bloomStrength", 0, 3, 0.1).name("Bloom strength");
  display.add(params, "bloomRadius", 0, 1, 0.05).name("Bloom radius");

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
