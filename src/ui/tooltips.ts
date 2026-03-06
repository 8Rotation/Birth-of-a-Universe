/**
 * tooltips.ts — All tooltip text for the ECSK Bounce Sensor UI.
 *
 * Each entry has a short `simple` line (shown on hover) and a longer
 * `detail` block (shown on click / expanded hover).
 *
 * Extracted from controls.ts so the layout code stays focused on logic.
 */

export interface Tooltip {
  simple: string;
  detail: string;
}

// ── Control-panel tooltips ──────────────────────────────────────────────

export const TOOLTIPS: Record<string, Tooltip> = {
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
  resetSettings: {
    simple: "Restores all sliders and toggles to their default values.",
    detail:
      "Resets every parameter (physics, flow, display, bloom, etc.) back to " +
      "the initial defaults determined at startup. Does not clear existing " +
      "particles — combine with Reset to start completely fresh.",
  },
  randomSettings: {
    simple: "Randomises all settings within their normal slider ranges.",
    detail:
      "Picks random values for every numeric parameter (within its normal min/max), " +
      "randomises boolean toggles, curvature, and colours. Great for exploring " +
      "unexpected visual combinations. Use Reset Settings to return to defaults.",
  },
  targetFps: {
    simple: "Limits how often the simulation updates and renders.",
    detail:
      "VSync = render at your monitor's native refresh rate (best quality). " +
      "Lower values (e.g. 60, 30) reduce GPU and main-thread load by " +
      "skipping frames. Useful if high refresh rates cause stuttering " +
      "at extreme particle counts. Physics workers still run continuously " +
      "between rendered frames, so particles accumulate normally.",
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
  arrivalSpread: {
    simple: "How many seconds the perturbation pattern takes to sweep across the sphere.",
    detail:
      "Controls the temporal spread of particle arrivals in seconds. " +
      "Each particle's bounce time is shifted by its local perturbation δ — " +
      "this slider sets how many wall-clock seconds that shift spans. " +
      "Default: 1.0 s. Range: 0.01 s (10 ms) to ~120 s. " +
      "\n\nAt very low values (< 0.1 s) all particles arrive almost simultaneously " +
      "\u2014 you see the full birth rate on screen but no spatial structure. " +
      "This is 'flooding': every particle born this frame is instantly visible. " +
      "Visually dense but no sense of the bounce wavefront sweeping across. " +
      "\n\nAt moderate values (0.5\u20135 s) the perturbation pattern becomes " +
      "visible as a rolling wavefront of colour and brightness. " +
      "This is the sweet spot for seeing the physics. " +
      "\n\nAt high values (> 10 s) particles trickle in slowly, revealing " +
      "the finest angular detail but most particles are queued in the future " +
      "buffer (not yet visible). " +
      "\n\nFor best efficiency, keep this roughly equal to or less than Fade duration " +
      "(persistence) \u2014 otherwise many particles fade before arriving. " +
      "Interacts with perturbation amplitude, β, and persistence.",
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
  autoBrightness: {
    simple: "Auto-exposure: brightest particle → peak display luminance.",
    detail:
      "When enabled, the renderer dynamically scales brightness so the " +
      "brightest visible particle always uses the full luminance range " +
      "of the display.  Prevents scenarios where everything looks dim " +
      "(e.g. all particles heavily faded or low energy density). " +
      "Uses an asymmetric EMA: instant ramp-up for new bright particles, " +
      "smooth ≈ 0.5 s decay on fade-out. " +
      "Hides the manual Brightness slider (they conflict). " +
      "Works in both SDR and HDR modes.",
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
  backgroundColor: {
    simple: "Background colour behind the particle display.",
    detail:
      "The overall scene background colour. Default: pure black (#000000). " +
      "Can be changed for contrast, screenshots, or aesthetic reasons. " +
      "Purely cosmetic — no effect on physics or particle colours.",
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
      "Total visible duration of each particle in seconds. Internally " +
      "converted to a Weibull fade time constant τ so that brightness " +
      "drops below the visibility threshold at exactly this time. " +
      "Default: 1.0 s. " +
      "Range: 0.1 (instant flash) to 12+ (long streamer trails). " +
      "Visible particle count ≈ rate × persistence, so doubling persistence " +
      "doubles the number of particles on screen (and GPU memory). " +
      "Interacts with fade curve (shape of the decay) " +
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
      "Default: 1.0. Interacts with fade duration (the time scale).",
  },
  ringOpacity: {
    simple: "How visible the projection boundary circle is.",
    detail:
      "Opacity of the Lambert disk boundary ring — the thin circle " +
      "surrounding the particle display area. " +
      "Default: 0.5. Range: 0 (invisible) to 1 (fully opaque). " +
      "The ring marks the edge of the equal-area projection from " +
      "the S² bounce surface to the 2D display.",
  },
  ringWidthPx: {
    simple: "Thickness of the boundary ring in pixels.",
    detail:
      "Width of the solid boundary ring in CSS pixels. " +
      "Inner edge is always flush at the projection boundary (r=2.0); " +
      "the ring grows outward only. Converted to world units each frame " +
      "based on zoom and viewport size. Default: 2 px. " +
      "0.5 = hairline, 5+ = bold.",
  },
  ringBloomStrength: {
    simple: "How bright the ring's bloom glow is.",
    detail:
      "Controls the intensity of the ring's own bloom post-processing " +
      "effect, completely independent of particle bloom. " +
      "0 = no bloom (ring is crisp). Higher values produce a stronger " +
      "light-bleed halo. Default: 0.8.",
  },
  ringBloomRadius: {
    simple: "How far the ring's bloom spreads outward.",
    detail:
      "Controls how far the ring bloom extends from the ring edge. " +
      "0 = tight glow hugging the ring, 1 = wide diffuse glow. " +
      "This is the ring's own bloom radius, independent of particle bloom. " +
      "Default: 0.4.",
  },

  ringAutoColor: {
    simple: "Automatically match ring colour to the dominant particle hue.",
    detail:
      "When enabled, the ring colour tracks the brightness-weighted " +
      "average hue of all visible particles. This keeps the ring " +
      "colour harmonious with whatever physics settings you're using. " +
      "Disable to pick a fixed ring colour manually.",
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
  zoom: {
    simple: "Zoom level of the sensor display.",
    detail:
      "Controls the orthographic camera zoom. Default 1.0 shows the " +
      "full Lambert disk. Values > 1 zoom in (magnify detail); " +
      "values < 1 zoom out (more border visible). " +
      "Purely visual — does not affect physics or particle positions.",
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

// ── Readout panel tooltips ──────────────────────────────────────────────

export const READOUT_TOOLTIPS: Record<string, Tooltip> = {
  beta: {
    simple: "How strongly spin couples to spacetime torsion.",
    detail: "The spin–torsion coupling β set by the slider. " +
      "Higher β → gentler bounce. Lower β → more violent, denser bounce. " +
      "Controls the colour palette and time-dilation range.",
  },
  aMin: {
    simple: "How compressed the universe gets at the bounce.",
    detail: "The minimum scale factor a_min — think of it as the universe's " +
      "smallest possible size. Closer to 0 = extremely compressed. " +
      "Closer to 0.707 = barely compressed (gentle bounce).",
  },
  wEff: {
    simple: "How 'stiff' the matter is at peak compression.",
    detail: "w = 1/3 means radiation (normal). w = 1 means extremely stiff " +
      "(like the early universe). w > 1 means torsion is dominating. " +
      "Higher stiffness = faster, more violent bounce.",
  },
  torsionRatio: {
    simple: "How much torsion contributes to the total energy at the bounce.",
    detail: "S near 1.0 means torsion (from fermion spin) is the dominant " +
      "energy source at peak compression. S near 0 means gravity dominates. " +
      "The whole point of ECSK cosmology is that S ≈ 1 prevents the singularity.",
  },
  ppStrength: {
    simple: "Intensity of particle–antiparticle pair creation at the bounce.",
    detail: "Shown as a ratio of βpp to the critical threshold (~1/929). " +
      "Below 1 = subcritical (subtle). Above 1 = supercritical (vigorous). " +
      "'off' when pair-production is disabled.",
  },
  flux: {
    simple: "Smoothed count of particles arriving each second.",
    detail: "Exponentially-smoothed arrival rate. Should roughly match " +
      "your Birth Rate slider when the simulation is in steady state. " +
      "If much lower, the buffer may be full or CPU can't keep up.",
  },
  visible: {
    simple: "How many particles are currently drawn on screen.",
    detail: "Roughly equals birth rate × fade duration at steady state. " +
      "Capped by the emergency buffer ceiling to prevent memory exhaustion.",
  },
  fps: {
    simple: "How smoothly the animation is running.",
    detail: "Frames per second. 60 = ideal. 30–60 = fine. Below 30 = " +
      "try reducing birth rate, ripple detail (ℓmax), or disabling bloom.",
  },
  cpuUsage: {
    simple: "Physics threads actively generating particles.",
    detail: "Shows workers in use vs. total CPU cores. More workers = " +
      "higher particle throughput using multiple CPU cores. " +
      "Count is set automatically based on your hardware score.",
  },
  computeLoad: {
    simple: "Compound compute cost of your current settings.",
    detail: "Estimates the combined cost of particle rate × persistence " +
      "(renderer CPU) and particle rate × ripple detail (physics CPU). " +
      "Above 100% the particle rate is automatically throttled to keep " +
      "the simulation responsive. Reduce birth rate, fade duration, or " +
      "ripple detail to lower the load.",
  },
  bufferFill: {
    simple: "How full the particle buffer is.",
    detail: "Current particles stored vs. emergency ceiling. " +
      "When this hits 100%, oldest particles are dropped to free memory. " +
      "Reduce birth rate or fade duration if the buffer fills up.",
  },
  screen: {
    simple: "Your display resolution.",
    detail: "Physical screen resolution detected from the display. " +
      "Higher resolution uses more GPU power for rendering.",
  },
  hz: {
    simple: "Your monitor's refresh rate.",
    detail: "Detected refresh rate in Hz. VRR = Variable Refresh Rate " +
      "(G-Sync / FreeSync) detected. Higher refresh rates need more GPU work.",
  },
  hdr: {
    simple: "Whether high-dynamic-range rendering is active.",
    detail: "FULL = true HDR with extended-range canvas (best quality). " +
      "SOFT = standard canvas with linear tone mapping (decent fallback). " +
      "No = SDR only. The HDR exposure slider only works in SOFT mode.",
  },
  gamut: {
    simple: "How wide a colour range your display supports.",
    detail: "sRGB = standard. P3 = wide gamut (richer reds and greens). " +
      "Rec.2020 = ultra-wide (rare). Wider gamut = more vivid particles.",
  },
  cpuCores: {
    simple: "Total CPU threads available for the browser.",
    detail: "From navigator.hardwareConcurrency. The physics engine uses " +
      "some of these as dedicated particle-generation threads.",
  },
  cpuBench: {
    simple: "Relative speed of your CPU (1.0× = average).",
    detail: "Quick micro-benchmark measuring transcendental-math throughput. " +
      "Used to auto-tune default particle rate and ripple detail.",
  },
  gpu: {
    simple: "Your graphics card or integrated GPU.",
    detail: "Detected from WebGPU adapter info. Used to set the capability " +
      "score and particle buffer size. Discrete GPUs score higher.",
  },
  capability: {
    simple: "Combined hardware performance score (0–100%).",
    detail: "Blends CPU speed, core count, GPU capability, and RAM, " +
      "then penalises for high screen resolution (more pixels = more load). " +
      "Drives all automatic defaults: birth rate, worker count, bloom, etc.",
  },
  tier: {
    simple: "Performance tier label (cosmetic only).",
    detail: "LOW / MID / HIGH / ULTRA. Just a label — all budget values " +
      "are smoothly interpolated from the continuous capability score.",
  },
};
