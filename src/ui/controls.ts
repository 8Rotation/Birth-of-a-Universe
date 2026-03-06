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
  timeDilation: number;  // stretches arrival time spread

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
  softHdrExposure: number;  // tone-mapping exposure for soft-HDR path
  particleSoftEdge: number; // particle edge softness (0=hard, 0.5=very soft)

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
  ppStrength: string;
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

// ── Tooltip descriptors ──────────────────────────────────────────────────
// Each entry has a short "simple" line and a longer "detail" block.
// Attached as custom hover tooltips on every controller row.

interface Tooltip {
  simple: string;
  detail: string;
}

const TOOLTIPS: Record<string, Tooltip> = {
  // ── Override Mode ─────────────────────────────────────────
  overrideMode: {
    simple: "Unlocks all slider limits so you can type any value.",
    detail:
      "Normally every slider is clamped to a physically sensible range. " +
      "Override Mode removes those clamps and lets you enter extreme values " +
      "directly.  Useful for stress-testing or artistic exploration but can " +
      "produce unphysical results or crash the GPU. Sliders turn red to warn you.",
  },

  // ── Collapse Physics ──────────────────────────────────────
  kCurvature: {
    simple: "Shape of space: open, flat, or closed universe.",
    detail:
      "Sets the spatial curvature parameter k in the Friedmann equation. " +
      "k = +1 (closed) is standard for torsion-bounce cosmology — the universe " +
      "reaches a maximum size then recollapses.  k = 0 (flat) matches ΛCDM. " +
      "k = −1 (open) gives a hyperbolic geometry. " +
      "Only k = +1 supports the double-bounce feature.\n" +
      "Physically accurate: k = +1 (Popławski 2010–2025). " +
      "Changing this resets the physics engine.",
  },
  doubleBounce: {
    simple: "Adds a rhythmic pulsation of the bounce (closed universe only).",
    detail:
      "In a closed (k = +1) universe with torsion, the scale factor can undergo " +
      "multiple bounce-and-recollapse cycles before final expansion — like a ball " +
      "bouncing on a trampoline.  This toggle enables the second-bounce modulation " +
      "from Cubero & Popławski 2019.  Only available when Curvature k = +1. " +
      "Unlocks the Double-Bounce Tuning folder below for hue/brightness of " +
      "the second-bounce particles.",
  },
  beta: {
    simple: "Spin–torsion coupling strength. Higher = stronger bounce.",
    detail:
      "The dimensionless spin parameter β controls how strongly fermion spin " +
      "couples to spacetime torsion.  It sets the minimum scale factor a_min " +
      "at the bounce and the effective equation of state w_eff. " +
      "Physically accurate range: 0.01–0.20. Default 0.10 is a " +
      "representative mid-range value (Popławski 2010b eq. 27). " +
      "Very low β (~0.005) gives an extremely dense bounce; very high β " +
      "(~0.249) gives a gentle bounce approaching de Sitter.\n" +
      "Affects: bounce density, colour mapping (w_eff), time-dilation " +
      "slider range, and perturbation sensitivity.",
  },
  perturbAmplitude: {
    simple: "How lumpy the bounce surface is — more = more colour variation.",
    detail:
      "Sets the RMS amplitude of the spherical-harmonic perturbation field δ " +
      "over the S² bounce hypersurface.  Each region gets β_eff = β(1 + δ), " +
      "which shifts its colour (via w_eff) and arrival time. " +
      "Typical: 0.05–0.20.  Default 0.12 gives moderate structure. " +
      "High values (> 0.3) create dramatic colour contrasts but become " +
      "increasingly unphysical.  Interacts with β and time dilation: " +
      "higher amplitude widens the arrival-time spread.",
  },
  lMax: {
    simple: "Detail level of the lumpy pattern — more = finer structure.",
    detail:
      "Maximum spherical-harmonic degree l in the perturbation field. " +
      "l = 1–2 gives large-scale blobs; l = 8–16 gives fine filamentary " +
      "structure; l > 32 approaches a Jackson-Pollock look. " +
      "Physically accurate for CMB-like spectrum: l = 6–12. Default 8. " +
      "Higher values use significantly more CPU — the number of harmonic " +
      "coefficients grows as (l+1)².  Interacts with spectral index n_s " +
      "and Silk damping.",
  },
  nS: {
    simple: "Tilts the power spectrum — below 1 boosts large blobs, above 1 boosts fine detail.",
    detail:
      "Spectral index of the primordial perturbation power spectrum. " +
      "n_s = 1.0 (Harrison–Zel'dovich) gives equal power per log scale. " +
      "Planck 2018 best fit: n_s ≈ 0.965 (slightly red, favouring large scales). " +
      "Default: 0.965. Range 0.5–1.5 covers red-to-blue tilts. " +
      "Works with l_max and Silk damping to shape the overall pattern: " +
      "red tilt (< 1) + high Silk damping smooths fine detail; " +
      "blue tilt (> 1) + low damping makes everything speckly.",
  },
  silkDamping: {
    simple: "Smooths out fine details in the pattern, like a blur filter.",
    detail:
      "Applies exponential suppression to high-l harmonic modes, mimicking " +
      "Silk (photon diffusion) damping of primordial perturbations. " +
      "At 0 there's no suppression — all scales contribute equally (given n_s). " +
      "At 0.6 (default, physically motivated) high-l modes are " +
      "suppressed, giving smoother large-scale structure. " +
      "At 1.0 only the lowest modes survive. " +
      "Interacts with l_max (no effect if l_max is already low) " +
      "and n_s (both shape the power distribution).",
  },
  betaPP: {
    simple: "Turns on particle production — matter being created at the bounce.",
    detail:
      "Particle production rate β_pp from Popławski 2014 eq. 40–46; 2021 eq. 8. " +
      "When > 0, a fraction of geometric particles are tagged as 'produced' " +
      "matter (shown with shifted colour and size). " +
      "The critical threshold β_cr ≈ 1/929 ≈ 0.00108. Below this: subtle effect; " +
      "above: vigorous production. Default: 0 (off). " +
      "Typical range: 0.0001–0.005. " +
      "When active, unlocks the Production Tuning folder with visual controls. " +
      "Affects the Readout panel β_pp/β_cr ratio.",
  },

  // ── Double-Bounce Tuning ──────────────────────────────────
  dbSecondHueShift: {
    simple: "Shifts the colour of second-bounce particles to distinguish them.",
    detail:
      "Hue offset in degrees applied to particles from the second bounce cycle. " +
      "Default: +15° (slightly warmer). " +
      "Set to 0 for no visual distinction; large values (±60–180°) " +
      "make the two bounces dramatically different colours. " +
      "Only active when double bounce is enabled (k = +1).",
  },
  dbSecondBriScale: {
    simple: "Makes second-bounce particles dimmer or brighter.",
    detail:
      "Brightness multiplier for second-bounce particles relative to first-bounce. " +
      "Default: 0.82 (slightly dimmer, physically motivated by energy loss). " +
      "Range: 0.1 (barely visible) to 2.0 (brighter than first bounce). " +
      "Only active when double bounce is enabled.",
  },

  // ── Production Tuning ─────────────────────────────────────
  ppHueShift: {
    simple: "Shifts the colour of produced particles to distinguish them.",
    detail:
      "Hue offset in degrees applied to particle-production events. " +
      "Default: +60° (shifted toward green/blue from the base ramp). " +
      "Helps visually separate newly produced matter from geometric " +
      "(torsion-bounce) particles. " +
      "Only visible when β_pp > 0.",
  },
  ppBriBoost: {
    simple: "Makes produced particles brighter or dimmer.",
    detail:
      "Brightness multiplier for particle-production events. " +
      "Default: 1.3 (slightly brighter than normal particles). " +
      "Higher values make production events stand out; lower values " +
      "blend them into the background. " +
      "Only visible when β_pp > 0.",
  },
  ppSizeScale: {
    simple: "Makes produced particles larger or smaller.",
    detail:
      "Size multiplier for produced particles relative to normal hits. " +
      "Default: 0.7 (slightly smaller — distinguishes them from torsion hits). " +
      "Range: 0.1 (tiny dots) to 3.0 (prominent blobs). " +
      "Only visible when β_pp > 0.",
  },
  ppBaseDelay: {
    simple: "How long after the bounce before produced particles appear.",
    detail:
      "Base delay fraction for production timing. Shifts production-particle " +
      "arrival times relative to the geometric bounce. " +
      "Default: 1.5 (particles appear somewhat after normal hits). " +
      "Higher values push production later, lower brings them closer " +
      "to the main bounce wavefront. " +
      "Interacts with PP scatter range and time dilation. " +
      "Only visible when β_pp > 0.",
  },
  ppScatterRange: {
    simple: "Spreads production particles over a wider time window.",
    detail:
      "Scatter range fraction for production timing. Adds random spread " +
      "to when produced particles appear. " +
      "Default: 1.0. Higher values scatter them over a wider interval; " +
      "0 makes them all appear at exactly the base delay. " +
      "Interacts with PP base delay and time dilation. " +
      "Only visible when β_pp > 0.",
  },

  // ── Flow ──────────────────────────────────────────────────
  frozen: {
    simple: "Pauses time — particles stop aging and no new ones appear.",
    detail:
      "Freezes the simulation clock. Already-visible particles stay at " +
      "their current brightness (no fading).  No new particles are emitted " +
      "and the worker is paused. Unfreeze to resume from exactly where you left off.",
  },
  reset: {
    simple: "Clears all visible particles and resets the timer.",
    detail:
      "Wipes every particle currently on screen and resets the arrival counter. " +
      "The physics engine and worker keep running, so new particles fill in " +
      "immediately at the current settings. Useful after changing physics " +
      "parameters to start fresh.",
  },
  particleRate: {
    simple: "How many new particles appear per second. More = denser image.",
    detail:
      "Target emission rate in particles per second (Poisson stream). " +
      "The visible count at equilibrium is roughly rate × persistence. " +
      "Default: 2000/s (hardware-dependent). " +
      "Range: 100 (sparse) to 100,000+ (GPU-limited). " +
      "Higher rates need more GPU memory and CPU for physics. " +
      "Interacts strongly with persistence (together they set particle count) " +
      "and hit size (dense particle fields look better with smaller hits).",
  },
  fieldEvolution: {
    simple: "How fast the lumpy pattern drifts over time. 0 = frozen pattern.",
    detail:
      "Ornstein–Uhlenbeck mean-reversion rate for the perturbation field. " +
      "At 0 the pattern is frozen in time — the bounce surface never changes. " +
      "At 0.1 (default) it evolves slowly, giving a gentle drifting effect. " +
      "At 2+ the pattern changes rapidly between frames. " +
      "Interacts with l_max (more modes = richer drift) and persistence " +
      "(long persistence smooths rapid evolution into a blend).",
  },
  timeDilation: {
    simple: "Stretches out when particles arrive — higher = wider time spread.",
    detail:
      "Multiplier on the arrival-time spread of particles. Each particle's " +
      "bounce time maps to a spread proportional to its δ (perturbation " +
      "amplitude × β sensitivity). Time dilation scales this further. " +
      "Default: 120. Range: 1 (all arrive together) to ~100,000 " +
      "(extremely stretched). " +
      "The slider max auto-adjusts based on β and amplitude so the visible " +
      "range always stays useful. " +
      "Interacts with β (more sensitive = needs less TD), amplitude, " +
      "and persistence (particles spread wider than persistence fade out " +
      "before arriving).",
  },

  // ── Hue Ramp ──────────────────────────────────────────────
  hueMin: {
    simple: "Starting colour of the physics-to-colour mapping.",
    detail:
      "Hue angle in degrees where the colour ramp begins. " +
      "Default: 25° (warm red/orange). The largest w_eff (stiffest " +
      "equation of state) maps here. " +
      "Range: 0–360°. 0° = red, 120° = green, 240° = blue. " +
      "Works with hue range to define the full colour palette.",
  },
  hueRange: {
    simple: "Width of the colour palette in degrees.",
    detail:
      "How many degrees the colour ramp spans from hue start. " +
      "Default: 245° (covers most of the spectrum from red through blue). " +
      "Smaller values compress the palette (subtle gradients); " +
      "larger values use more of the rainbow. " +
      "The softest w_eff maps to hue_start + hue_range. " +
      "Works with hue start. Both are purely visual — they don't " +
      "affect physics.",
  },
  brightnessFloor: {
    simple: "Minimum brightness any particle can have.",
    detail:
      "Lower limit of the brightness normalisation (0–1). " +
      "Default: 0.15. Particles at the dimmest end of the physics range " +
      "map to this value. Higher floor = more uniformly bright; lower = " +
      "more contrast between bright and dim regions. " +
      "Works with brightness ceiling. Both feed into the HSL encoding " +
      "before the display brightness multiplier is applied.",
  },
  brightnessCeil: {
    simple: "Maximum brightness any particle can have.",
    detail:
      "Upper limit of the brightness normalisation (0–1). " +
      "Default: 1.0. Particles at the brightest end of the physics range " +
      "map to this value. Lowering it compresses the bright end. " +
      "Works with brightness floor.",
  },

  // ── Display ───────────────────────────────────────────────
  roundParticles: {
    simple: "Circular particles vs square particles.",
    detail:
      "When on, each particle is a soft-edged circle (via fragment shader " +
      "soft-edge clipping). When off, particles are square sprites. " +
      "Circles look more natural; squares are slightly cheaper to render. " +
      "The softness of the circle edge is controlled by the Particle edge slider.",
  },
  bloomEnabled: {
    simple: "Adds a glow effect around bright particles.",
    detail:
      "Enables a multi-pass bloom post-processing effect. " +
      "Bright particles bleed light outward, simulating camera sensor bloom " +
      "or the HDR halo of a real high-energy event. " +
      "Performance cost: moderate (3–5 extra render passes). " +
      "Bloom strength, radius, and threshold fine-tune the effect. " +
      "Auto-disabled on low-tier hardware.",
  },
  ringColor: {
    simple: "Colour of the circular boundary ring around the projection disk.",
    detail:
      "The thin circle visible around the particle display area is the " +
      "boundary of the Lambert equal-area projection of the S² sphere. " +
      "This picker sets its colour. Default: dark brown (#502008). " +
      "The ring is quite subtle by design — increase Ring opacity to " +
      "make colour changes more visible. " +
      "Purely cosmetic — no effect on physics.",
  },
  hitSize: {
    simple: "Makes particles bigger or smaller.",
    detail:
      "Base size of each particle sprite in pixels (before screen-density " +
      "scaling).  Default: 1.0 px. " +
      "Range: 1 (dots) to 30 (large blobs). " +
      "Interacts with particle rate: high rate + large hits = solid fill; " +
      "high rate + small hits = fine-grained texture. " +
      "Automatically scaled by screen density (retina displays get " +
      "proportionally smaller physical pixels).",
  },
  brightness: {
    simple: "Overall brightness multiplier — makes everything brighter or dimmer.",
    detail:
      "Multiplies the final colour of every particle after all other " +
      "colour processing (HSL encoding, fade, HDR mapping). " +
      "Default: 5.0 (calibrated so default β fills the visible range). " +
      "Range: 0.1 (barely visible) to 5.0+. " +
      "In HDR mode, brightness is normalised so the default position " +
      "approximates nits-accurate display. " +
      "Interacts with bloom (bright particles trigger more bloom) " +
      "and HDR exposure (in soft-HDR mode).",
  },
  persistence: {
    simple: "How long particles remain visible before fading away.",
    detail:
      "Weibull fade time constant in seconds. A particle born at time t " +
      "has brightness ∝ exp(−((now−t)/persistence)^k) where k = fade sharpness. " +
      "Default: 1.0 s. " +
      "Range: 0.1 (instant flash) to 12+ (long streamer trails). " +
      "Visible particle count ≈ rate × persistence, so doubling persistence " +
      "doubles the number of particles on screen (and GPU memory). " +
      "Interacts with fade sharpness (shape of the decay curve) " +
      "and particle rate.",
  },
  bloomStrength: {
    simple: "How intense the glow effect is.",
    detail:
      "Multiplier on the bloom pass output. " +
      "Default: 1.2. Range: 0 (no bloom visible) to 3+ (heavy glow). " +
      "Only active when Bloom is enabled. " +
      "Interacts with bloom threshold (brighter threshold = fewer " +
      "particles trigger bloom) and brightness multiplier.",
  },
  bloomRadius: {
    simple: "How far the glow spreads from bright particles.",
    detail:
      "Controls the spatial extent of the bloom halo. " +
      "0 = tight halo (sits on top of the particle, reads as blur). " +
      "1 = wide spread (large diffuse glow). Default: 0.3. " +
      "Only active when Bloom is enabled. " +
      "Internally controls mip-level weight distribution in the bloom " +
      "shader, so the effect is logarithmic rather than linear.",
  },
  bloomThreshold: {
    simple: "How bright a particle must be to trigger the glow.",
    detail:
      "Minimum colour brightness that contributes to the bloom pass. " +
      "Default: 0.05 (almost all particles bloom a little). " +
      "Higher values (0.3–0.5) limit bloom to only the very brightest " +
      "particles, creating a more selective highlight effect. " +
      "Only active when Bloom is enabled.",
  },
  fadeSharpness: {
    simple: "Shape of the fade curve — gradual tail vs sharp cutoff.",
    detail:
      "Weibull shape parameter k for the particle fade function. " +
      "k = 1: standard exponential decay (gradual fade, default). " +
      "k < 1: long tail — particles linger at low brightness for a long time. " +
      "k > 1: sharp cutoff — particles stay bright then vanish abruptly. " +
      "k = 2: Gaussian-style bell curve. k = 4: nearly binary on/off. " +
      "Default: 1.0. Interacts with persistence (the time constant).",
  },
  ringOpacity: {
    simple: "How visible the projection boundary circle is.",
    detail:
      "Opacity of the Lambert disk boundary ring — the thin circle " +
      "surrounding the particle display area. " +
      "Default: 0.3 (subtle). Range: 0 (invisible) to 1 (fully opaque). " +
      "The ring marks the edge of the equal-area projection from " +
      "the S² bounce surface to the 2D display. " +
      "Increase this to see the Ring colour changes more clearly.",
  },
  softHdrExposure: {
    simple: "Brightness of the display in soft-HDR mode.",
    detail:
      "Tone-mapping exposure for the soft-HDR rendering path (linear " +
      "tone mapping on a standard canvas). Default: 1.6. " +
      "Only active when your display does NOT support full hardware HDR — " +
      "the renderer falls back to 'soft HDR' which simulates extended " +
      "brightness range through linear tone mapping. " +
      "Higher values brighten the overall image; lower compresses it. " +
      "Has NO effect in full HDR mode (the display handles mapping) " +
      "or on SDR-only displays. Check the Readout → HDR field to see " +
      "which mode you're in.",
  },
  particleSoftEdge: {
    simple: "How soft or hard the edges of round particles are.",
    detail:
      "Controls the smoothstep transition width at the edge of circular " +
      "particles.  0 = perfectly hard circle edge (aliased). " +
      "0.05 (default) = subtle anti-aliased softness. " +
      "0.2+ = prominent soft glow around each particle. " +
      "Only visible when Round particles is enabled. " +
      "Purely visual — no physics effect.",
  },

  // ── Color Tuning ──────────────────────────────────────────
  lightnessFloor: {
    simple: "Minimum lightness in the HSL colour output.",
    detail:
      "All particles have their HSL lightness clamped to at least this value. " +
      "Default: 0.20. Higher values make the darkest particles brighter; " +
      "0 allows fully black particles. " +
      "Interacts with lightness range (floor + range must not exceed 1.0 " +
      "for well-behaved colours).",
  },
  lightnessRange: {
    simple: "How much lightness can vary across particles.",
    detail:
      "HSL lightness span above the lightness floor. " +
      "Default: 0.65. Total max lightness = floor + range. " +
      "Smaller range = more uniform brightness; larger = more contrast " +
      "between bright and dim regions.",
  },
  saturationFloor: {
    simple: "Minimum colour saturation — higher means no grey/pale particles.",
    detail:
      "All particles have their HSL saturation at least this value. " +
      "Default: 0.70. Higher values ensure vivid colours everywhere; " +
      "0 allows grey/desaturated particles. " +
      "Interacts with saturation range.",
  },
  saturationRange: {
    simple: "How much saturation can vary across particles.",
    detail:
      "HSL saturation span above the saturation floor. " +
      "Default: 0.25. Most particles end up in the 0.70–0.95 band. " +
      "Increase for more variation between vivid and muted particles.",
  },
};

// Readout tooltips (attached to the left panel)
const READOUT_TOOLTIPS: Record<string, Tooltip> = {
  beta: {
    simple: "Current β spin parameter value.",
    detail: "The spin–torsion coupling β set by the slider. " +
      "Determines the bounce scale factor a_min and all derived quantities.",
  },
  aMin: {
    simple: "Minimum scale factor at the bounce.",
    detail: "a_min = √([1 − √(1−4β)] / 2). The smaller a_min, the denser " +
      "the bounce (more compressed). Approaches 0 as β→0 (singular) and " +
      "~0.707 as β→0.25 (gentle).",
  },
  wEff: {
    simple: "Effective equation of state at the bounce.",
    detail: "w_eff characterises the dominant 'fluid' at the bounce. " +
      "w = 1/3 = radiation; w = 1 = stiff matter; w > 1 = torsion-dominated. " +
      "Lower β → higher w_eff (stiffer).",
  },
  torsionRatio: {
    simple: "Torsion-to-curvature ratio S at the bounce.",
    detail: "Ratio of the spin-torsion contribution to the total energy density " +
      "at maximum compression. S ≈ 1 means torsion dominates the bounce.",
  },
  ppStrength: {
    simple: "Particle production rate relative to the critical threshold.",
    detail: "β_pp / β_cr where β_cr ≈ 1/929. Below 1 = subcritical " +
      "(subtle production); above 1 = supercritical (vigorous). " +
      "'off' when β_pp = 0.",
  },
  flux: {
    simple: "Particles arriving per second (smoothed).",
    detail: "Exponentially-smoothed arrival rate. Should roughly match " +
      "the particle rate slider at steady state.",
  },
  visible: {
    simple: "Number of particles currently drawn on screen.",
    detail: "Approximate equilibrium: rate × persistence. " +
      "Capped by the emergency hit ceiling to prevent GPU memory exhaustion.",
  },
  fps: {
    simple: "Frames per second.",
    detail: "Rendering frame rate. 60 FPS = optimal. Below 30 = consider " +
      "reducing particle rate, l_max, or disabling bloom.",
  },
  screen: {
    simple: "Detected screen resolution.",
    detail: "Physical display resolution from the Screen Detector. " +
      "Higher resolution increases GPU load.",
  },
  hz: {
    simple: "Display refresh rate.",
    detail: "Detected monitor refresh rate. VRR = Variable Refresh Rate " +
      "(G-Sync, FreeSync) detected.",
  },
  hdr: {
    simple: "HDR rendering mode.",
    detail: "FULL = hardware HDR with extended-range canvas (best). " +
      "SOFT = standard canvas with linear tone mapping (fallback). " +
      "No = SDR only. The HDR exposure slider only works in SOFT mode.",
  },
  gamut: {
    simple: "Detected colour gamut of your display.",
    detail: "SRGB = standard. P3 = wide gamut (richer reds and greens). " +
      "REC2020 = ultra-wide (rare). Wider gamut = more vivid particle colours.",
  },
  cpuCores: {
    simple: "Number of logical CPU threads available.",
    detail: "navigator.hardwareConcurrency. The physics worker uses one " +
      "dedicated thread.",
  },
  cpuBench: {
    simple: "Relative CPU benchmark score.",
    detail: "Quick micro-benchmark comparing your CPU to a baseline. " +
      "1.0× = average. Used to auto-tune particle rate and l_max.",
  },
  gpu: {
    simple: "Detected GPU name.",
    detail: "From WebGPU adapter info. Used for capability scoring and " +
      "particle budget calculations.",
  },
  capability: {
    simple: "Hardware capability score (raw and effective).",
    detail: "Raw = CPU+GPU combined score before screen penalty. " +
      "Effective = after accounting for display resolution. " +
      "Drives automatic defaults for particle rate, l_max, bloom, etc.",
  },
  tier: {
    simple: "Hardware tier classification.",
    detail: "LOW / MID / HIGH / ULTRA. Determines default slider ranges " +
      "and whether bloom is enabled by default.",
  },
};

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
  opacity: 0.12;
}
.ecsk-panel.lil-gui.closed:hover {
  opacity: 0.85;
}
.ecsk-panel.lil-gui:not(.closed) {
  opacity: 0.92;
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
  max-width: 340px;
  padding: 8px 10px;
  border-radius: 4px;
  background: #111;
  border: 1px solid #333;
  color: #ccc;
  font: 11px/1.45 'Segoe UI', system-ui, sans-serif;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s ease;
  box-shadow: 0 2px 12px rgba(0,0,0,0.7);
}
.ecsk-tooltip.visible { opacity: 1; }
.ecsk-tooltip .tt-simple {
  color: #eee;
  font-weight: 600;
  margin-bottom: 4px;
}
.ecsk-tooltip .tt-detail {
  color: #999;
  font-size: 10px;
  line-height: 1.4;
  white-space: pre-wrap;
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
export function createSensorControls(onReset: () => void, budget?: ComputeBudget) {
  // ── Inject OLED theme CSS ─────────────────────────────────────────
  const styleEl = document.createElement("style");
  styleEl.textContent = OLED_CSS;
  document.head.appendChild(styleEl);

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
    timeDilation: 120,

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
    fadeSharpness: 1.0,
    lightnessFloor: 0.20,
    lightnessRange: 0.65,
    saturationFloor: 0.70,
    saturationRange: 0.25,
    ringOpacity: 0.3,
    ringColor: "#502008",
    softHdrExposure: 1.6,
    particleSoftEdge: 0.05,
    frozen: false,
    reset: onReset,
  };

  // ── Right panel: Controls ─────────────────────────────────────────
  const gui = new GUI({ title: "ECSK Bounce Sensor" });
  gui.domElement.classList.add("ecsk-panel", "ecsk-controls");
  gui.domElement.style.zIndex = "1000";

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
  physics.add(params, "kCurvature", { "Open (k=\u22121)": -1, "Flat (k=0)": 0, "Closed (k=+1)": 1 })
    .name("Curvature k")
    .onChange(() => {
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
  flow.add(params, "frozen").name("Freeze");
  flow.add(params, "reset").name("⟳ Clear");

  // ── Hue Ramp (physics→colour mapping, under Flow) ─────────────────
  const hueRamp = flow.addFolder("Hue Ramp");
  hueRamp.close();

  // ── Sensor Display ────────────────────────────────────────────────
  const display = gui.addFolder("Sensor Display");
  display.add(params, "roundParticles").name("Round particles");
  display.add(params, "bloomEnabled").name("Bloom");

  // Ring colour picker (hex string)
  display.addColor(params, "ringColor").name("Ring colour");

  // ── Color Tuning (nested under Display) ───────────────────────────
  const colorTuning = display.addFolder("Color Tuning");
  colorTuning.close();  // collapsed by default

  // ── Numeric controller descriptors ────────────────────────────────
  // Normal-mode max values adapt to hardware tier via `sl`.
  // overrideMax: slider range used in Override Mode (greatly expanded).
  const numericDefs: NumCtrl[] = [
    // Collapse Physics
    { folder: physics,  prop: "beta",             label: "β spin param",        min: 0.005, max: 0.249,              step: 0.001, overrideMax: 10        },
    { folder: physics,  prop: "perturbAmplitude", label: "Inhomogeneity",       min: 0.001, max: 0.6,                step: 0.001, overrideMax: 100       },
    { folder: physics,  prop: "lMax",             label: "Turbulence (l_max)",  min: 1,     max: sl.lMaxMax,          step: 1,     overrideMax: 512       },
    { folder: physics,  prop: "nS",               label: "Spectral index n_s", min: 0.5,   max: 1.5,                step: 0.005, overrideMax: 3         },
    { folder: physics,  prop: "silkDamping",      label: "Silk damping",        min: 0,     max: 1,                  step: 0.01,  overrideMax: 5         },
    { folder: physics,  prop: "betaPP",           label: "β_pp production",     min: 0,     max: 0.005,              step: 0.0001, overrideMax: 1        },
    // Double-Bounce Tuning
    { folder: dbTuning, prop: "dbSecondHueShift", label: "2nd hue shift (°)",   min: -180,  max: 180,                step: 1,     overrideMax: 360       },
    { folder: dbTuning, prop: "dbSecondBriScale", label: "2nd brightness",      min: 0.1,   max: 2.0,                step: 0.01,  overrideMax: 10        },
    // Production Tuning
    { folder: ppTuning, prop: "ppHueShift",       label: "PP hue shift (°)",    min: -180,  max: 180,                step: 1,     overrideMax: 360       },
    { folder: ppTuning, prop: "ppBriBoost",       label: "PP brightness",       min: 0.1,   max: 3.0,                step: 0.01,  overrideMax: 10        },
    { folder: ppTuning, prop: "ppSizeScale",      label: "PP size scale",       min: 0.1,   max: 3.0,                step: 0.01,  overrideMax: 10        },
    { folder: ppTuning, prop: "ppBaseDelay",      label: "PP base delay",       min: 0,     max: 5.0,                step: 0.1,   overrideMax: 50        },
    { folder: ppTuning, prop: "ppScatterRange",   label: "PP scatter range",    min: 0,     max: 5.0,                step: 0.1,   overrideMax: 50        },
    // Flow
    { folder: flow,    prop: "particleRate",     label: "Particle rate (/s)",  min: 100,   max: sl.particleRateMax,  step: 100,   overrideMax: 10000000, overrideStep: 1000 },
    { folder: flow,    prop: "fieldEvolution",   label: "Field evolution (/s)", min: 0,    max: 2,                  step: 0.01,  overrideMax: 1000      },
    { folder: flow,    prop: "timeDilation",     label: "Time dilation",       min: 1,     max: sl.timeDilationMax,  step: 1,     overrideMax: 100000000 },
    // Hue Ramp
    { folder: hueRamp, prop: "hueMin",           label: "Hue start (°)",       min: 0,     max: 360,                step: 1,     overrideMax: 720       },
    { folder: hueRamp, prop: "hueRange",         label: "Hue range (°)",       min: 0,     max: 360,                step: 1,     overrideMax: 720       },
    { folder: hueRamp, prop: "brightnessFloor",  label: "Brightness floor",    min: 0,     max: 1,                  step: 0.01,  overrideMax: 5         },
    { folder: hueRamp, prop: "brightnessCeil",   label: "Brightness ceil",     min: 0,     max: 1,                  step: 0.01,  overrideMax: 5         },
    // Sensor Display
    { folder: display, prop: "hitSize",          label: "Hit size (px)",       min: 1,     max: 30,                 step: 0.5,   overrideMax: 10000     },
    { folder: display, prop: "brightness",       label: "Brightness",          min: 0.1,   max: 5,                  step: 0.1,   overrideMax: 10000     },
    { folder: display, prop: "persistence",      label: "Persistence (s)",     min: 0.1,   max: sl.persistenceMax,   step: 0.1,   overrideMax: 100000    },
    { folder: display, prop: "bloomStrength",    label: "Bloom strength",      min: 0,     max: sl.bloomStrengthMax, step: 0.1,   overrideMax: 10000     },
    { folder: display, prop: "bloomRadius",      label: "Bloom radius",        min: 0,     max: 1,                  step: 0.05,  overrideMax: 1000      },
    { folder: display, prop: "bloomThreshold",   label: "Bloom threshold",     min: 0,     max: 1,                  step: 0.01,  overrideMax: 100       },
    { folder: display, prop: "fadeSharpness",    label: "Fade sharpness",      min: 0.3,   max: 4,                  step: 0.1,   overrideMax: 100       },
    { folder: display, prop: "ringOpacity",      label: "Ring opacity",        min: 0,     max: 1,                  step: 0.05,  overrideMax: 10        },
    { folder: display, prop: "softHdrExposure",  label: "HDR exposure",        min: 0.5,   max: 4,                  step: 0.1,   overrideMax: 20        },
    { folder: display, prop: "particleSoftEdge", label: "Particle edge",       min: 0,     max: 0.3,                step: 0.005, overrideMax: 0.5       },
    // Color Tuning
    { folder: colorTuning, prop: "lightnessFloor",   label: "Lightness floor",   min: 0,   max: 0.5,  step: 0.01,  overrideMax: 1   },
    { folder: colorTuning, prop: "lightnessRange",   label: "Lightness range",   min: 0.1, max: 0.8,  step: 0.01,  overrideMax: 1   },
    { folder: colorTuning, prop: "saturationFloor",  label: "Saturation floor",  min: 0,   max: 1,    step: 0.01,  overrideMax: 1   },
    { folder: colorTuning, prop: "saturationRange",  label: "Saturation range",  min: 0,   max: 0.5,  step: 0.01,  overrideMax: 1   },
  ];

  // Track live controllers so we can destroy & recreate on mode switch
  let activeNumericControllers: Controller[] = [];

  let rebuildNumericControllers = (override: boolean) => {
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
  };

  // Build initial bounded sliders
  rebuildNumericControllers(false);

  // ── Conditional folder visibility ─────────────────────────────────
  function updateConditionalFolders(): void {
    const showDb = params.doubleBounce && Number(params.kCurvature) === 1;
    dbTuning.domElement.style.display = showDb ? "" : "none";

    const showPp = params.betaPP > 0;
    ppTuning.domElement.style.display = showPp ? "" : "none";
  }

  // Monitor betaPP changes to show/hide production tuning
  // Find the betaPP controller and attach onChange
  const betaPPIdx = numericDefs.findIndex(d => d.prop === "betaPP");
  function attachBetaPPWatcher() {
    if (betaPPIdx >= 0 && activeNumericControllers[betaPPIdx]) {
      activeNumericControllers[betaPPIdx].onChange(() => updateConditionalFolders());
    }
  }

  // Patch rebuildNumericControllers to re-attach watchers after rebuild
  const _origRebuild = rebuildNumericControllers;
  rebuildNumericControllers = (override: boolean) => {
    _origRebuild(override);
    attachBetaPPWatcher();
    updateConditionalFolders();
  };
  // Re-run to attach on initial build
  attachBetaPPWatcher();
  updateConditionalFolders();

  // ── Dynamic time-dilation max ─────────────────────────────────────
  // TD beyond 200 / (|sens| × β × amp) does nothing visible because
  // MAX_DELAY (300s) saturates.  We update the slider max whenever β or
  // amplitude change so the slider range always tracks the useful range.
  const tdDefIdx = numericDefs.findIndex(d => d.prop === "timeDilation");

  /**
   * Recompute time-dilation slider max from current physics.
   * @param sensitivity  |dT_half/dβ| from ECSKPhysics.sensitivity()
   * @param beta         Current β spin parameter
   * @param amplitude    Current perturbation amplitude
   */
  function updateTimeDilationMax(sensitivity: number, beta: number, amplitude: number): void {
    if (overrideState.overrideMode) return;  // don't touch in override mode
    const denom = Math.abs(sensitivity) * Math.max(beta, 0.005) * Math.max(amplitude, 0.001);
    // Usable ceiling: spread fills MAX_DELAY (300s) at naturalSpread×1.5
    const newMax = Math.max(10, Math.min(100_000, Math.round(200 / denom)));
    if (tdDefIdx >= 0) {
      numericDefs[tdDefIdx].max = newMax;
      const ctrl = activeNumericControllers[tdDefIdx];
      if (ctrl) {
        ctrl.max(newMax);
        // Clamp current value if it exceeds the new ceiling
        if (params.timeDilation > newMax) {
          params.timeDilation = newMax;
          ctrl.updateDisplay();
        }
      }
    }
  }

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
    physicsReadout.add(hud, "beta").name("β").listen().disable(),
    physicsReadout.add(hud, "aMin").name("a_min").listen().disable(),
    physicsReadout.add(hud, "wEff").name("w_eff").listen().disable(),
    physicsReadout.add(hud, "torsionRatio").name("S (torsion)").listen().disable(),
    physicsReadout.add(hud, "ppStrength").name("β_pp/β_cr").listen().disable(),
  ];

  const perfReadout = readoutGui.addFolder("Performance");
  controllers.push(
    perfReadout.add(hud, "flux").name("Flux (/s)").listen().disable(),
    perfReadout.add(hud, "visible").name("Visible").listen().disable(),
    perfReadout.add(hud, "fps").name("FPS").listen().disable(),
  );

  const hwReadout = readoutGui.addFolder("Hardware");
  hwReadout.close();  // collapsed by default
  controllers.push(
    hwReadout.add(hud, "screen").name("Screen").listen().disable(),
    hwReadout.add(hud, "hz").name("Refresh (Hz)").listen().disable(),
    hwReadout.add(hud, "hdr").name("HDR").listen().disable(),
    hwReadout.add(hud, "gamut").name("Gamut").listen().disable(),
    hwReadout.add(hud, "cpuCores").name("CPU threads").listen().disable(),
    hwReadout.add(hud, "cpuBench").name("CPU bench").listen().disable(),
    hwReadout.add(hud, "gpu").name("GPU").listen().disable(),
    hwReadout.add(hud, "capability").name("Capability").listen().disable(),
    hwReadout.add(hud, "tier").name("HW tier").listen().disable(),
  );

  function updateHUD() {
    for (const c of controllers) c.updateDisplay();
  }

  // ── Tooltip system ──────────────────────────────────────────────────
  const tooltipEl = document.createElement("div");
  tooltipEl.className = "ecsk-tooltip";
  tooltipEl.innerHTML = '<div class="tt-simple"></div><div class="tt-detail"></div>';
  document.body.appendChild(tooltipEl);
  const ttSimple = tooltipEl.querySelector(".tt-simple") as HTMLElement;
  const ttDetail = tooltipEl.querySelector(".tt-detail") as HTMLElement;

  let tooltipTimer: ReturnType<typeof setTimeout> | null = null;

  function showTooltip(el: HTMLElement, tip: Tooltip): void {
    ttSimple.textContent = tip.simple;
    ttDetail.textContent = tip.detail;
    // Position: to the left of the control element (or right for left-panel)
    const rect = el.getBoundingClientRect();
    const ttWidth = 340; // max-width from CSS
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
  }
  // Round particles, bloom, ring colour
  for (const ctrl of display.controllersRecursive()) {
    const prop = (ctrl as unknown as { property: string }).property;
    if (prop === "roundParticles") attachTooltip(ctrl.domElement, "roundParticles");
    if (prop === "bloomEnabled") attachTooltip(ctrl.domElement, "bloomEnabled");
    if (prop === "ringColor") attachTooltip(ctrl.domElement, "ringColor");
  }

  // ── Attach tooltips to numeric controllers (re-run after rebuild) ──
  function attachNumericTooltips(): void {
    for (let i = 0; i < numericDefs.length; i++) {
      const ctrl = activeNumericControllers[i];
      if (ctrl) attachTooltip(ctrl.domElement, numericDefs[i].prop);
    }
  }
  attachNumericTooltips();

  // ── Attach tooltips to readout controllers ────────────────────────
  // Match by property name from the HUD data object
  const readoutHudKeys: string[] = [
    "beta", "aMin", "wEff", "torsionRatio", "ppStrength",
    "flux", "visible", "fps",
    "screen", "hz", "hdr", "gamut",
    "cpuCores", "cpuBench", "gpu", "capability", "tier",
  ];
  for (let i = 0; i < controllers.length && i < readoutHudKeys.length; i++) {
    attachTooltip(controllers[i].domElement, readoutHudKeys[i], READOUT_TOOLTIPS);
  }

  // Patch rebuild to re-attach tooltips after slider reconstruction
  const _origRebuild2 = rebuildNumericControllers;
  rebuildNumericControllers = (override: boolean) => {
    _origRebuild2(override);
    attachNumericTooltips();
  };
  // Run once to set up initial state
  attachNumericTooltips();

  return { gui, readoutGui, params, hud, updateHUD, updateTimeDilationMax };
}
