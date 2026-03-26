/**
 * tooltips.ts — Structured tooltip text for the ECSK Bounce Sensor UI.
 *
 * Each tooltip has a short header, plus optional structured sections:
 *   visual       — what changes on screen
 *   science      — the physics / math behind the parameter
 *   range        — typical values and what they mean
 *   performance  — CPU / GPU cost implications
 *   notes        — interactions with other controls, caveats
 *
 * Readout tooltips use simple + detail (read-only display, no performance
 * cost or range since the user doesn't set these directly).
 */

export interface Tooltip {
  simple: string;
  visual?: string;
  science?: string;
  range?: string;
  performance?: string;
  notes?: string;
  /** Legacy fallback — plain detail string (readout tooltips). */
  detail?: string;
}

// ── Control-panel tooltips ──────────────────────────────────────────────

export const TOOLTIPS: Record<string, Tooltip> = {

  // ═══════════════════════════════════════════════════════════════════
  //  Override Mode
  // ═══════════════════════════════════════════════════════════════════
  overrideMode: {
    simple: "Unlock all slider limits — type any value directly.",
    visual:
      "Slider rails turn red. All numeric controls accept values far beyond their normal range.",
    science:
      "Normal slider bounds are chosen for physical plausibility within ECSK theory. " +
      "Override removes those bounds for stress-testing, artistic exploration, " +
      "or probing extreme regimes. Results outside normal bounds are generally unphysical.",
    performance:
      "No direct cost from the toggle itself, but extreme values (e.g. ℓ_max = 512, " +
      "birth rate = 10 M/s) can saturate your GPU or freeze the tab.",
    notes:
      "Override mode does NOT change step size for most sliders (except birth rate → 1000). " +
      "Parameters remain valid — the physics engine clamps β < 0.25 internally regardless.",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  Collapse Physics
  // ═══════════════════════════════════════════════════════════════════
  kCurvature: {
    simple: "Spatial curvature of the baby universe: open, flat, or closed.",
    visual:
      "Changes the overall density and timing of the bounce pattern. k = +1 produces " +
      "a bounded, recollapsing cosmos; k = 0 and k = −1 expand indefinitely after the bounce.",
    science:
      "Sets the curvature parameter k in the dimensionless Friedmann equation:\n" +
      "  (dā/dτ̄)² = 1/ā² − β/ā⁴ − k\n\n" +
      "k = +1 (closed): the universe reaches a maximum size then recollapses. " +
      "Bounce turning points: ā²_min = [1 − √(1−4β)] / 2.\n" +
      "k = 0 (flat): matches standard ΛCDM spatial geometry. ā²_min = β.\n" +
      "k = −1 (open): hyperbolic geometry. ā²_min = [−1 + √(1+4β)] / 2.\n\n" +
      "ECSK theory strongly favours k = +1 for universes born inside black holes " +
      "(Popławski 2010–2025; Unger & Popławski 2019; Cubero & Popławski 2019).",
    range:
      "k = +1 (closed) — physically preferred, supports double bounce.\n" +
      "k = 0 (flat) — matches ΛCDM observations.\n" +
      "k = −1 (open) — hyperbolic, allowed but less motivated by ECSK.",
    performance:
      "Negligible. Changes the bounce-point formula but the computation is O(1).",
    notes:
      "Only k = +1 supports the double-bounce toggle. " +
      "Changing k resets the physics engine and clears particles.",
  },

  doubleBounce: {
    simple: "Rhythmic double-bounce pulsation (closed universe only).",
    visual:
      "Particles arrive in two distinct waves per cycle, with the second wave " +
      "shifted in hue and brightness. Creates a rhythmic pulsation pattern " +
      "across the sensor disk.",
    science:
      "In a closed (k = +1) ECSK universe, the scale factor can undergo " +
      "multiple bounce-and-recollapse cycles before final expansion — analogous " +
      "to a ball bouncing on a trampoline. The collapse overshoots, bounces, " +
      "re-expands, reaches a local maximum, collapses again, and re-bounces. " +
      "From Cubero & Popławski 2019 (§26): the closed-universe threshold " +
      "C > e^{−1/2} determines whether a second collapse occurs.",
    range:
      "On / Off only. Only available when Curvature k = +1.",
    performance:
      "Minimal. Adds a modulation function to the visual encoding — no extra " +
      "physics computation per particle.",
    notes:
      "Unlocks the Double-Bounce Tuning folder (hue shift, brightness scale for " +
      "the second bounce wave). Auto-disabled if k ≠ +1.",
  },

  beta: {
    simple: "Spin–torsion coupling strength — how strongly fermion spin resists collapse.",
    visual:
      "Higher β → gentler bounce with warmer colours (low w_eff). Lower β → violent, " +
      "dense bounce with cooler/bluer tones (high w_eff). Dramatically changes the " +
      "colour palette, brightness distribution, and timing structure of the pattern.",
    science:
      "The dimensionless spin parameter β = αn₀²/ε₀ is the ratio of torsion energy " +
      "to radiation energy at the bounce. It sets the minimum scale factor:\n" +
      "  ā²_min = [1 − √(1 − 4β)] / 2  (for k = +1)\n\n" +
      "At the bounce, the effective equation of state is:\n" +
      "  w_eff = (ā² − 3β) / (3(ā² − β))\n\n" +
      "β → 0: bounce at extreme density (a_min → 0), torsion barely prevents singularity.\n" +
      "β → 1/4: bounce at low density (a_min → 1/√2), nearly de Sitter inflation.\n\n" +
      "From Popławski 2010b eq. 27; Unger & Popławski 2019 eq. 2, 7.\n" +
      "The coupling constant: α = κ(ℏc)²/32, where κ = 8πG/c⁴.",
    range:
      "0.005 – 0.249 (must be < 1/4 for a finite bounce to exist).\n\n" +
      "0.005 – 0.02: Extremely dense, violent bounce. Hot colours, high energy density.\n" +
      "0.05 – 0.15: Mid-range (default 0.10). Rich colour variation, moderate density.\n" +
      "0.15 – 0.249: Gentle bounce approaching de Sitter. Narrow colour palette, low density.",
    performance:
      "Negligible. One-time O(1) calculation per particle.",
    notes:
      "Primary physics knob. Affects: colour mapping (w_eff), brightness (energy density), " +
      "arrival time spread (sensitivity dT/dβ), and perturbation response. " +
      "Interacts with perturbation amplitude — together they determine the visual richness.",
  },

  perturbAmplitude: {
    simple: "How lumpy the bounce surface is — regions bounce at different times and colours.",
    visual:
      "Low amplitude: uniform, nearly monochrome disk. " +
      "High amplitude: dramatic colour contrasts and structured arrival-time patterns. " +
      "The perturbation creates the angular structure (blobs, filaments, dipoles) visible on the sensor.",
    science:
      "Sets the RMS amplitude of the spherical-harmonic perturbation field δ(θ,φ) " +
      "on the S² bounce hypersurface. Each comoving fluid element gets a locally " +
      "perturbed spin parameter β_eff = β(1 + δ), which shifts its bounce properties:\n" +
      "  • Different equation of state → different hue\n" +
      "  • Different energy density → different brightness\n" +
      "  • Different bounce time → temporal structure\n\n" +
      "Uses the separate-universe approximation, validated by the algebraic (non-propagating) " +
      "nature of torsion in ECSK theory (Hehl et al. 1976 eq. 3.22).",
    range:
      "0.001 – 0.6 (normal slider).\n\n" +
      "0.001 – 0.05: Subtle perturbation — nearly homogeneous bounce.\n" +
      "0.05 – 0.20: Moderate structure (default 0.12). Visible colour gradients.\n" +
      "0.20 – 0.60: Strong perturbation — dramatic contrasts but increasingly unphysical\n" +
      "  (the linear separate-universe approximation breaks down).",
    performance:
      "Negligible. Scales the pre-computed perturbation coefficients — no extra computation.",
    notes:
      "Interacts with β (higher β × higher amplitude = wider arrival-time spread). " +
      "Interacts with ℓ_max and spectral tilt (together they shape the angular pattern). " +
      "At high amplitudes, some regions may have β_eff < 0.002 (clamped internally).",
  },

  lMax: {
    simple: "Angular detail of the perturbation pattern — more harmonics = finer structure.",
    visual:
      "ℓ = 1–2: large-scale blobs (dipole, quadrupole).\n" +
      "ℓ = 4–8: medium filamentary structure.\n" +
      "ℓ = 16–32: fine intricate patterns.\n" +
      "ℓ > 64: Jackson Pollock territory — nearly random speckle.",
    science:
      "Maximum spherical-harmonic degree ℓ in the perturbation expansion:\n" +
      "  δ(θ,φ) = Σ_{l=1}^{ℓ_max} Σ_{m=-l}^{l} c_lm Y_lm(θ,φ)\n\n" +
      "The power spectrum follows a nearly scale-invariant (Harrison–Zel'dovich) form:\n" +
      "  C_l ∝ l^(n_s − 1) × exp(−(l/l_silk)²)\n\n" +
      "where n_s is the spectral index and l_silk controls Silk damping. " +
      "The number of harmonic coefficients is (ℓ_max + 1)² − 1.",
    range:
      "1 – 16+ (hardware-dependent upper limit).\n\n" +
      "1 – 2: Dipole/quadrupole only. Very smooth, large-scale patterns.\n" +
      "4 – 8: Default range. Good balance of structure and performance.\n" +
      "8 – 16: Fine detail, physically motivated for CMB-like spectra.\n" +
      "16 – 96: Very fine detail, artistically interesting but computationally expensive.",
    performance:
      "HIGH IMPACT. Physics CPU cost scales as O(ℓ²) per particle.\n" +
      "ℓ = 8: ~80 coefficients. ℓ = 16: ~288 coefficients. ℓ = 64: ~4160 coefficients.\n" +
      "Combined cost: particle_rate × (ℓ+1)² per second.\n" +
      "The Compute Load readout reflects this — watch it when adjusting.",
    notes:
      "Interacts with spectral tilt n_s (shapes power distribution) and Silk damping " +
      "(suppresses high-ℓ modes). High ℓ_max with low Silk damping = maximum detail.\n" +
      "Hardware tier sets the default and slider maximum.",
  },

  nS: {
    simple: "Tilts the power spectrum — favours large blobs (red) or fine detail (blue).",
    visual:
      "n_s < 1 (red tilt): large-scale patterns dominate. Smooth, blob-like structures.\n" +
      "n_s = 1 (scale-invariant): equal power at every angular scale.\n" +
      "n_s > 1 (blue tilt): fine-scale speckle dominates. Noisy, detailed texture.",
    science:
      "Spectral index of the primordial perturbation power spectrum on the bounce S²:\n" +
      "  P(l) ∝ l^(n_s − 1)\n\n" +
      "n_s = 1.0: Harrison–Zel'dovich (exactly scale-invariant).\n" +
      "n_s = 0.965: Planck 2018 best-fit (slightly red, favouring large scales).\n\n" +
      "Sadatian & Hosseini 2025 derive n_s ≈ 0.965 from their torsion coupling " +
      "parameter ξ ≈ 0.4 (their eq. 37), consistent with standard inflationary predictions " +
      "and the Planck measurement.",
    range:
      "0.5 – 1.5.\n\n" +
      "0.5 – 0.9: Strongly red-tilted. Dominated by large-scale (low-ℓ) power.\n" +
      "0.96 – 0.97: Observationally preferred (Planck 2018). Default: 0.965.\n" +
      "1.0: Exactly scale-invariant (Harrison–Zel'dovich).\n" +
      "1.0 – 1.5: Blue-tilted. Boosted fine-scale power — not observed in CMB.",
    performance:
      "Negligible. Only changes the coefficient weights during generation — " +
      "no per-particle cost change.",
    notes:
      "Works with ℓ_max and Silk damping to shape the overall pattern:\n" +
      "  Red tilt + high Silk damping → smooth, large-scale blobs.\n" +
      "  Blue tilt + low Silk damping → fine-grained speckle.\n" +
      "  Scale-invariant + moderate damping → naturalistic CMB-like patterns.",
  },

  silkDamping: {
    simple: "Smooths out fine angular detail — mimics photon diffusion damping.",
    visual:
      "0: All angular scales contribute equally (given n_s). Sharp fine detail.\n" +
      "0.6 (default): High-ℓ modes suppressed. Smooth large-scale structure.\n" +
      "1.0: Only the lowest ℓ modes survive. Very smooth, blob-like pattern.",
    science:
      "Applies exponential damping to high-multipole modes:\n" +
      "  C_l → C_l × exp(−(l / l_silk)²)\n" +
      "  where l_silk = damping_ratio × ℓ_max\n\n" +
      "Models Silk damping (photon diffusion damping) from the early universe, " +
      "where photon random walks erase density perturbations below the diffusion " +
      "scale. In the real CMB, this suppresses modes above ℓ ≈ 1000. Here it's " +
      "applied to the bounce perturbation spectrum as a physically motivated filter.",
    range:
      "0 – 1.\n\n" +
      "0: No damping — all modes at full power (noisy if ℓ_max is high).\n" +
      "0.3 – 0.6: Moderate damping (default 0.6). Physically motivated.\n" +
      "0.8 – 1.0: Heavy damping — only very low ℓ modes survive.",
    performance:
      "Negligible. Only modifies coefficient weights during generation.",
    notes:
      "Has no visible effect if ℓ_max is already low (e.g. ℓ = 2). " +
      "Maximum effect when ℓ_max ≥ 8. " +
      "Interacts with n_s — both shape the power distribution across scales.",
  },

  betaPP: {
    simple: "Particle–antiparticle pair production rate at the bounce.",
    visual:
      "When > 0, a fraction of particles are tagged as 'produced' matter and " +
      "displayed with shifted colour, brightness, and size. Creates a visual " +
      "layering effect — geometric bounce particles plus production events.",
    science:
      "Models the creation of particle–antiparticle pairs from the extreme spacetime " +
      "curvature at the bounce (Schwinger-like mechanism in curved spacetime).\n\n" +
      "The particle production rate β_pp is from Popławski 2014 eq. 40–46; 2021 eq. 8.\n" +
      "The critical threshold: β_cr ≈ 1/929 ≈ 0.00108.\n" +
      "Below β_cr: subcritical — production is present but subtle.\n" +
      "Above β_cr: supercritical — vigorous production, significant matter creation.\n\n" +
      "The mechanism is analogous to the Schwinger effect (QED pair production in strong " +
      "electric fields) but driven by spacetime curvature rather than electric field strength.",
    range:
      "0 – 0.005 (normal slider).\n\n" +
      "0: Off (default). No particle production.\n" +
      "0.0001 – 0.001: Subcritical. Subtle production events.\n" +
      "0.00108: Critical threshold (β_cr = 1/929).\n" +
      "0.001 – 0.005: Supercritical. Vigorous production — many tagged particles.",
    performance:
      "Low. Adds a branch per particle for tagging — negligible CPU cost. " +
      "Slightly more GPU work if produced particles use different visual attributes.",
    notes:
      "Unlocks the Production Tuning folder (hue shift, brightness, size, timing). " +
      "Updates the β_pp/β_cr ratio in the Readout panel.",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  Double-Bounce Tuning
  // ═══════════════════════════════════════════════════════════════════
  dbSecondHueShift: {
    simple: "Colour shift for second-bounce particles (degrees on the hue wheel).",
    visual:
      "Offsets the hue of particles from the second bounce cycle. " +
      "+15° (default): slightly warmer. ±60–180°: dramatically different colours " +
      "between first and second bounces.",
    range: "−180° to +180°. Default: +15°. Set to 0 for no visual distinction.",
    performance: "None. Purely visual — a constant offset in the hue encoding.",
    notes: "Only active when double bounce is enabled and k = +1.",
  },

  dbSecondBriScale: {
    simple: "Brightness multiplier for second-bounce particles.",
    visual:
      "< 1: second bounce is dimmer (physically motivated — energy loss between bounces).\n" +
      "> 1: second bounce is brighter (artistic emphasis).",
    range:
      "0.1 – 2.0. Default: 0.82.\n" +
      "0.82 represents ~18% energy loss between bounces (physically motivated).",
    performance: "None. Single multiply per particle.",
    notes: "Only active when double bounce is enabled and k = +1.",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  Production Tuning
  // ═══════════════════════════════════════════════════════════════════
  ppHueShift: {
    simple: "Colour shift for newly produced particles (degrees).",
    visual:
      "Distinguishes pair-produced matter from geometric bounce particles. " +
      "+60° (default) shifts production events toward green/blue.",
    range: "−180° to +180°. Default: +60°.",
    performance: "None. Constant hue offset.",
    notes: "Only visible when β_pp > 0.",
  },

  ppBriBoost: {
    simple: "Brightness multiplier for produced particles.",
    visual:
      "Makes production events stand out (> 1) or blend in (< 1) relative " +
      "to normal bounce particles.",
    range: "0.1 – 3.0. Default: 1.3 (slightly brighter than normal).",
    performance: "None. Single multiply.",
    notes: "Only visible when β_pp > 0.",
  },

  ppSizeScale: {
    simple: "Size multiplier for produced particles.",
    visual:
      "< 1: produced particles are smaller (default 0.7 — subtle dots).\n" +
      "> 1: produced particles are larger (prominent blobs).",
    range: "0.1 – 3.0. Default: 0.7.",
    performance: "None. Scales the sprite size.",
    notes: "Only visible when β_pp > 0.",
  },

  ppBaseDelay: {
    simple: "Time delay before produced particles appear after the bounce.",
    visual:
      "Higher values push production events later than the geometric bounce wavefront, " +
      "creating a trailing layer of produced particles.",
    range: "0 – 5.0. Default: 1.5. Higher = later arrival.",
    performance: "None. Offsets the arrival time.",
    notes: "Interacts with PP scatter range and arrival spread. Only visible when β_pp > 0.",
  },

  ppScatterRange: {
    simple: "Temporal scatter of produced particles around the base delay.",
    visual:
      "0: all produced particles appear at exactly the base delay.\n" +
      "Higher: spreads them over a wider time window, creating a diffuse production layer.",
    range: "0 – 5.0. Default: 1.0.",
    performance: "None. Random offset per particle.",
    notes: "Interacts with PP base delay. Only visible when β_pp > 0.",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  Flow
  // ═══════════════════════════════════════════════════════════════════
  frozen: {
    simple: "Pause the simulation — particles stop ageing, no new ones appear.",
    visual: "Everything freezes in place. Existing particles hold their current brightness.",
    performance: "Reduces CPU to near zero while paused (workers are suspended).",
    notes: "Unfreeze to resume from exactly where you left off. Physics state is preserved.",
  },

  reset: {
    simple: "Clear all visible particles and restart the timer.",
    visual: "The sensor disk goes dark, then fills back in as new particles arrive.",
    performance: "Momentary spike as the buffer is cleared and workers restart.",
    notes:
      "Does not change any settings — only clears the particle buffer. " +
      "Combine with Reset Settings for a full restart.",
  },

  resetSettings: {
    simple: "Restore every slider and toggle to its startup default.",
    visual: "All controls snap back to their initial values. Particles are also cleared.",
    notes:
      "Defaults are determined by your hardware tier at startup. " +
      "Also triggers a full Reset (particle clear + worker restart).",
  },

  randomSettings: {
    simple: "Randomise all settings within safe ranges — explore unexpected combinations.",
    visual:
      "Every numeric parameter gets a random value. Most boolean toggles are randomised. " +
      "Curvature k is uniformly random among {−1, 0, +1}. The ring is randomised on/off, " +
      "and when on it always auto-matches the dominant particle hue.",
    performance:
      "A compound-cost safety clamp ensures the randomised combination stays within " +
      "your hardware budget. particle_rate is scaled down if the combination of " +
      "persistence, ℓ_max, and birth rate would exceed safe limits.",
    notes:
      "Background colour, zoom, and target framerate are excluded from randomisation. " +
      "Use Reset Settings to return to defaults.",
  },

  targetFps: {
    simple: "Limit the rendering frame rate to reduce GPU load.",
    visual:
      "Auto (display sync): render on each display refresh callback from the current monitor (smoothest).\n" +
      "Lower caps (60, 30): skip render frames, saving GPU. " +
      "Particles still accumulate normally between frames.",
    performance:
      "Directly reduces GPU work. At 30 fps you use roughly half the GPU of 60 fps. " +
      "Lower caps also relax the per-frame renderer budget, so denser scenes can survive a bit longer before runtime throttling. " +
      "Physics workers still target the same per-second throughput.",
    notes:
      "If you see stuttering at high particle counts, try capping to 60 fps. " +
      "The detected refresh rate is shown on the Auto label.",
  },

  displaySyncHz: {
    simple: "Override the display refresh rate used by Auto display sync.",
    visual:
      "Auto-detect uses the browser's reported display refresh rate. " +
      "If your browser confuses mixed-refresh monitors, force the correct rate here.\n" +
      "This only affects the Auto display-sync mode, not explicit 30/60/120 fps caps.",
    performance:
      "When Auto is selected in Target framerate, this value becomes the effective pacing rate. " +
      "Use it as a fallback when the browser reports the wrong refresh rate for an external screen.",
    notes:
      "Example: if a 60 Hz external monitor is misdetected as 120 Hz while a laptop panel is also active, set this to 60 Hz.",
  },

  particleRate: {
    simple: "How many new particles appear per second — the primary density control.",
    visual:
      "Higher = denser, more filled-in image. Lower = sparse, individual dots visible.\n" +
      "Visible particle count at equilibrium ≈ rate × fade duration.",
    science:
      "Particles are emitted as a continuous Poisson stream at this target rate. " +
      "Each particle's arrival time is offset by the perturbation field δ(θ,φ) " +
      "to create the angular structure of the bounce pattern.",
    range:
      "100 – 200,000+ (hardware-dependent slider max).\n\n" +
      "100 – 500: Very sparse. Individual particle trajectories visible.\n" +
      "1,000 – 3,000: Default range. Good balance of density and performance.\n" +
      "5,000 – 20,000: Dense. Patterns are richly filled in.\n" +
      "20,000+: Very dense — requires powerful GPU and short persistence.",
    performance:
      "HIGH IMPACT. Each particle requires:\n" +
      "  • CPU: (ℓ_max + 1)² harmonic evaluations (physics worker)\n" +
      "  • GPU: one instanced sprite per visible particle\n" +
      "  • RAM: ~48 bytes per live particle\n\n" +
      "Compound cost: rate × persistence = visible particles (GPU load).\n" +
      "Compound cost: rate × (ℓ+1)² = physics evaluations/sec (CPU load).\n" +
      "The Compute Load readout shows the combined effect.",
    notes:
      "This is the strongest performance lever. Halving the rate roughly halves " +
      "both CPU and GPU load. Interacts with persistence (together they set particle count) " +
      "and ℓ_max (together they set physics cost).",
  },

  fieldEvolution: {
    simple: "How fast the perturbation pattern drifts over time.",
    visual:
      "0: Frozen — the pattern never changes. The same blobs sit in the same places.\n" +
      "0.1 (default): Gentle drift — pattern evolves slowly, creating a living texture.\n" +
      "1+: Rapid evolution — the pattern changes dramatically between frames.",
    science:
      "Models the perturbation field as an Ornstein–Uhlenbeck process with this " +
      "mean-reversion rate (1/s). The harmonic coefficients c_lm evolve as:\n" +
      "  dc_lm = −rate × c_lm × dt + σ × dW\n\n" +
      "This gives a statistically stationary random field that preserves the " +
      "power spectrum while smoothly varying in time.",
    range:
      "0 – 2.\n\n" +
      "0: Frozen pattern (static bounce surface).\n" +
      "0.01 – 0.1: Slow drift. Patterns evolve over 10–100 seconds.\n" +
      "0.1 – 0.5: Moderate evolution (default 0.1). Noticeable changes over seconds.\n" +
      "0.5 – 2: Fast evolution. Patterns change visibly every frame.",
    performance:
      "Low. One multiply-add per coefficient per frame, regardless of particle count.\n" +
      "Cost ∝ (ℓ_max + 1)² per frame (not per particle).",
    notes:
      "Interacts with persistence — long persistence smooths rapid evolution into a blend. " +
      "Interacts with ℓ_max — more modes = richer, more detailed drift.",
  },

  arrivalSpread: {
    simple: "How many seconds the bounce wavefront takes to sweep across the sphere.",
    visual:
      "Controls how the perturbation pattern unfolds in time:\n\n" +
      "Very low (< 0.1 s): All particles arrive nearly simultaneously — the disk fills " +
      "uniformly with no visible spatial structure. Dense but structureless.\n\n" +
      "Moderate (0.5 – 5 s): The perturbation pattern becomes a rolling wavefront of " +
      "colour and brightness sweeping across the disk. This is the sweet spot for " +
      "seeing the physics.\n\n" +
      "High (> 10 s): Particles trickle in slowly, revealing the finest angular detail " +
      "but most are queued in the future buffer (not yet visible). Sparse at any given moment.",
    science:
      "Each particle's arrival time is offset by:\n" +
      "  τ_arrive = now + (arrivalSpread / |sens × β × amplitude|) × sens × β × δ(θ,φ)\n\n" +
      "where δ is the local perturbation at that point on S². The slider directly " +
      "sets the total time window in seconds over which the perturbation pattern unfolds.",
    range:
      "0.01 – 120 s (hardware-dependent max).\n\n" +
      "0.01 – 0.1: Near-simultaneous arrival ('flooding'). No spatial structure visible.\n" +
      "0.5 – 2.0: Default range (1.0 s). Best for viewing the bounce structure.\n" +
      "2 – 10: Slow unfold. Reveals fine angular detail over longer timescales.\n" +
      "10 – 120: Very slow. Most particles are in the future buffer.",
    performance:
      "Moderate indirect cost. High values mean many particles exist in the future buffer " +
      "(allocated but not yet visible). Each buffered particle uses ~48 bytes of RAM.\n" +
      "For best efficiency, keep arrival spread ≤ fade duration.",
    notes:
      "Key interaction: if arrival spread >> persistence, particles fade before some regions " +
      "even arrive — the disk is never fully lit. If arrival spread << persistence, the full " +
      "pattern is always visible simultaneously (no wavefront sweep).",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  Hue Ramp
  // ═══════════════════════════════════════════════════════════════════
  hueMin: {
    simple: "Starting colour of the physics-to-colour mapping (hue wheel degrees).",
    visual:
      "Sets where on the colour wheel the highest w_eff (stiffest matter) maps. " +
      "Default 25° = warm red/orange.",
    science:
      "The effective equation of state w_eff is mapped linearly to a hue range:\n" +
      "  hue = hueMin + (w_norm) × hueRange\n" +
      "where w_norm is the normalised w_eff (0 = stiffest, 1 = softest).\n\n" +
      "Reference: 0° = red, 60° = yellow, 120° = green, 180° = cyan, 240° = blue, 300° = magenta.",
    range: "0 – 360°. Default: 25°. Purely visual — does not affect physics.",
    performance: "None.",
  },

  hueRange: {
    simple: "Width of the colour palette in degrees — how much of the spectrum to use.",
    visual:
      "Small range (30–60°): subtle monochromatic gradients.\n" +
      "Large range (180–360°): full rainbow from stiffest to softest w_eff.",
    range: "0 – 360°. Default: 245° (warm spectrum from red through blue).",
    performance: "None.",
    notes: "Works with hue start. Both are purely visual.",
  },

  brightnessFloor: {
    simple: "Minimum physics brightness before display processing.",
    visual:
      "Higher floor = more uniformly bright particles (less contrast). " +
      "Lower floor = darker dim regions (more contrast).",
    range: "0 – 1. Default: 0.15.",
    performance: "None.",
    notes: "Applied before the display brightness multiplier and HSL encoding.",
  },

  brightnessCeil: {
    simple: "Maximum physics brightness before display processing.",
    visual:
      "Lowering this compresses the bright end — the brightest particles " +
      "become less distinct from mid-brightness ones.",
    range: "0 – 1. Default: 1.0.",
    performance: "None.",
    notes: "Works with brightness floor to define the physical brightness range.",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  Particles
  // ═══════════════════════════════════════════════════════════════════
  roundParticles: {
    simple: "Circular vs square particle sprites.",
    visual:
      "On (default): soft-edged circles. More natural, sensor-like appearance.\n" +
      "Off: square sprites. Slightly crisper at very small sizes.",
    performance:
      "Minimal difference. Round particles use a smoothstep discard in the fragment " +
      "shader — roughly 2–3 extra GPU instructions per particle.",
    notes: "Enables the Edge Softness slider (only relevant for round particles).",
  },

  autoBrightness: {
    simple: "Automatic exposure — normalises brightness to current physics settings.",
    visual:
      "On: brightness auto-adjusts so the display stays consistently visible as you " +
      "change β and perturbation settings. No manual tuning needed.\n" +
      "Off: brightness is on a raw physics scale — you control it manually.",
    science:
      "Computes the theoretical brightest and dimmest particles at the current β " +
      "and perturbation amplitude. Normalises the brightness range so the mapping " +
      "from energy density to display luminance stays perceptually consistent.\n" +
      "Includes a size-overlap correction: small particles get boosted brightness " +
      "while large overlapping particles are dampened (prevents whiteout under " +
      "additive blending).\n" +
      "Fully deterministic — no reactive tracking, no flicker.",
    performance: "Negligible. O(1) calculation per frame.",
    notes: "Hides the manual Brightness slider when enabled (they conflict).",
  },

  bloomEnabled: {
    simple: "Post-processing glow effect around bright particles.",
    visual:
      "Simulates camera sensor bloom / HDR halo. Bright particles bleed light " +
      "outward, creating a warm glow. Enhances the sense of luminous energy.",
    performance:
      "MODERATE. Adds 3–5 extra full-screen render passes per frame.\n" +
      "Cost scales with screen resolution, not particle count.\n" +
      "Auto-disabled on low-tier hardware at startup.",
    notes:
      "Unlocks Bloom Intensity, Bloom Spread, and Bloom Threshold sliders.",
  },

  hitSize: {
    simple: "Base size of each particle sprite in pixels.",
    visual:
      "1 px (default): fine dots. Good for high particle counts.\n" +
      "5–10 px: medium dots. Each particle is clearly visible.\n" +
      "10–30 px: large blobs. Creates an impressionistic, painterly look.",
    range: "1 – 30 px (normal). Auto-scaled by screen pixel density (retina).",
    performance:
      "Low-moderate. Larger particles = more pixel fill per sprite.\n" +
      "At very large sizes with high particle counts, GPU fill rate becomes the bottleneck.",
    notes:
      "Interacts with particle rate: high rate + small size = fine texture. " +
      "High rate + large size = solid-fill appearance.",
  },

  sizeVariation: {
    simple: "How much particle size varies based on bounce physics.",
    visual:
      "0: all particles are exactly the Dot Size value (uniform).\n" +
      "0.5 (default): moderate spread — particles range from 0.75× to 1.25× base size.\n" +
      "1.0: full physics range — particles range from 0.5× to 1.5× base size.\n" +
      "Higher-energy bounces (violet) produce larger particles.",
    range: "0 – 1.0. Default: 0.5.",
    performance: "None. Single per-particle multiply.",
    notes:
      "Uses stable global bounds from the physics, so sizes are consistent " +
      "regardless of frame rate or batch size.",
  },

  brightness: {
    simple: "Manual brightness multiplier (when auto-brightness is off).",
    visual:
      "Multiplies the final colour of every particle. Higher = brighter overall image.",
    range:
      "0.1 – 5.0. Default: 5.0 (calibrated for default β).\n" +
      "< 1: Very dim. > 5: Risk of whiteout with additive blending.",
    performance: "None. Single multiply in the shader.",
    notes:
      "Only visible when Auto Brightness is off. " +
      "Interacts with bloom (brighter particles trigger more bloom).",
  },

  persistence: {
    simple: "How long each particle remains visible before fading to black.",
    visual:
      "Short (0.2 s): particles flash and vanish. Only the newest wavefront is visible.\n" +
      "Medium (1–3 s): several seconds of history visible simultaneously.\n" +
      "Long (5+ s): dense buildup of overlapping layers, painterly trails.",
    science:
      "Internally converted to a Weibull fade time constant τ so that brightness " +
      "drops below the visibility threshold at exactly this time:\n" +
      "  B(t) = exp(−(t/τ)^k)\n" +
      "where k is the fade sharpness parameter.",
    range:
      "0.2 – 12+ s (hardware-dependent max). Default: 1.0 s.\n\n" +
      "0.2 – 0.5: Flash mode. Only instantaneous wavefront visible.\n" +
      "0.5 – 2.0: Balanced (default). Current + recent history.\n" +
      "2 – 5: Dense layers. Rich visual buildup.\n" +
      "5 – 120: Very dense. Millions of particles on screen — GPU-intensive.",
    performance:
      "HIGH IMPACT. Visible particles ≈ birth_rate × persistence.\n" +
      "Doubling persistence doubles the particle count on screen (and GPU memory).\n" +
      "Example: 2000/s × 3 s = 6,000 particles. 2000/s × 30 s = 60,000 particles.",
    notes:
      "Primary performance lever alongside birth rate. " +
      "Interacts with fade sharpness (shape of the decay curve). " +
      "Watch the Compute Load readout when adjusting.",
  },

  fadeSharpness: {
    simple: "Shape of the fade curve — gradual tail vs abrupt cutoff.",
    visual:
      "k = 0.5: Long tail — particles linger at low brightness for a long time.\n" +
      "k = 1.0 (default): Exponential decay. Natural falloff.\n" +
      "k = 2.0: Gaussian bell — stays bright then fades quickly.\n" +
      "k = 4.0: Nearly binary on/off — visible then suddenly gone.",
    science:
      "Weibull shape parameter k in the fade function:\n" +
      "  B(t) = exp(−(t/τ)^k)\n\n" +
      "k < 1: heavy-tailed (memoryless). k = 1: exponential (standard). " +
      "k > 1: light-tailed (sharp cutoff).",
    range: "0.3 – 4.0. Default: 1.0 (exponential).",
    performance: "None. Changes the shader fade computation only.",
    notes: "Interacts with fade duration (the time scale of the decay).",
  },

  fadeToBlack: {
    simple: "How particles disappear: fade to black or fade to transparent.",
    visual:
      "Off (default): Particles become transparent as they age — clean on any background.\n" +
      "On: Particles darken toward black — looks best on a black background, " +
      "but overlapping particles can create dark patches on coloured backgrounds.",
    performance: "None. Single branch in the shader.",
    notes: "Use 'fade to transparent' when using a non-black background colour.",
  },

  particleSoftEdge: {
    simple: "How soft the edges of round particles are.",
    visual:
      "0: Perfectly hard circle edge (may show aliasing).\n" +
      "0.05 (default): Subtle anti-aliased softness.\n" +
      "0.2+: Prominent soft glow halo around each particle.",
    range: "0 – 0.3. Default: 0.05.",
    performance: "None. Fixed-cost smoothstep in the fragment shader.",
    notes: "Only visible when Round Particles is enabled.",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  Ring
  // ═══════════════════════════════════════════════════════════════════
  ringEnabled: {
    simple: "Turn the projection boundary ring on or off.",
    visual:
      "When enabled, the ring is shown around the bounce projection and its colour " +
      "automatically tracks the dominant visible particle hue. When disabled, the ring " +
      "and its bloom are fully hidden.",
    performance: "Low. Disabling it skips ring rendering and any ring-only bloom work.",
    notes: "This toggle is included in Random settings.",
  },

  ringOpacity: {
    simple: "Visibility of the circular boundary ring around the projection disk.",
    visual:
      "The ring marks the edge of the Lambert equal-area projection of the S² " +
      "bounce surface onto the 2D display. 0 = invisible, 1 = fully opaque.",
    range: "0 – 1. Default: 0.5.",
    performance: "None.",
  },

  ringColor: {
    simple: "Colour of the projection boundary ring.",
    visual: "Click to open a colour picker. The ring is quite subtle at default opacity.",
    notes:
      "Overridden when Auto-Colour is enabled (ring tracks dominant particle hue).",
  },

  ringAutoColor: {
    simple: "Automatically match ring colour to the dominant particle hue.",
    visual:
      "When enabled, the ring colour continuously tracks the brightness-weighted " +
      "average hue of all visible particles. Keeps the ring harmonious with any " +
      "physics settings.",
    performance: "Negligible. Weighted average computed once per frame.",
    notes: "Disable to use a manually picked ring colour.",
  },

  ringWidthPx: {
    simple: "Thickness of the boundary ring in pixels.",
    visual:
      "0.5 = hairline. 2 (default) = subtle. 5+ = bold frame.\n" +
      "Ring grows outward from the projection boundary (never inward).",
    range: "0.5 – 10. Default: 2 px.",
    performance: "None.",
  },

  ringBloomEnabled: {
    simple: "Toggle the ring's own bloom glow on or off (independent of particle bloom).",
    visual:
      "When enabled, the ring gets its own dedicated bloom pass, creating a soft " +
      "luminous halo around the boundary ring. Completely independent of the " +
      "particle Bloom toggle.",
    performance: "Low. Enables/disables the ring's dedicated bloom pass.",
    notes: "Unlocks Ring Bloom Intensity and Ring Bloom Spread sliders.",
  },

  ringBloomStrength: {
    simple: "Intensity of the ring's own bloom glow (independent of particle bloom).",
    visual: "0 = crisp ring edge. Higher = soft light-bleed halo around the ring.",
    range: "0 – 3. Default: 0.8.",
    performance: "Low. Uses the ring's dedicated bloom pass (separate from particle bloom).",
  },

  ringBloomRadius: {
    simple: "How far the ring's bloom glow spreads.",
    visual: "0 = tight glow hugging the ring. 1 = wide diffuse halo.",
    range: "0 – 1. Default: 0.4.",
    performance: "Low. Part of the ring's bloom pass.",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  Bloom
  // ═══════════════════════════════════════════════════════════════════
  bloomStrength: {
    simple: "Intensity of the particle glow effect.",
    visual:
      "0: No visible bloom. 1.2 (default): Moderate glow. 3+: Heavy, dreamy glow.",
    range: "0 – 3+ (hardware-dependent max). Default: 1.2.",
    performance:
      "Part of the bloom pass cost (see Bloom toggle). The multiplier itself is free — " +
      "the cost is in having bloom enabled at all.",
    notes: "Only active when Bloom is enabled.",
  },

  bloomQuality: {
    simple: "Resolution of the bloom effect (GPU cost vs. visual quality).",
    detail:
      "High: Full-resolution bloom (current default). Best visual quality.\n" +
      "Low: Half-resolution bloom (~4× fewer pixels). Noticeably softer glow " +
      "but significantly cheaper — useful on integrated GPUs or high-res displays.\n" +
      "Auto: Selects High or Low based on your detected hardware capability score.",
    performance:
      "Low quality reduces bloom GPU cost by roughly 50–75%. " +
      "If bloom is the bottleneck (check GPU Load), switching to Low " +
      "may restore smooth frame rates without disabling bloom entirely.",
    notes: "Only active when Bloom is enabled.",
  },

  bloomRadius: {
    simple: "How far the glow spreads from bright particles.",
    visual:
      "0: Tight halo (reads as blur, not glow).\n" +
      "0.3 (default): Natural glow extent.\n" +
      "1.0: Wide, diffuse glow — entire disk takes on a warm haze.",
    science:
      "Controls the mip-level weight distribution in the multi-pass bloom shader. " +
      "The effect is logarithmic rather than linear — small changes near 0 have " +
      "more visual impact than equal changes near 1.",
    range: "0 – 1. Default: 0.3.",
    performance:
      "No additional cost beyond having bloom enabled. The radius changes weights " +
      "in the existing passes.",
    notes: "Only active when Bloom is enabled.",
  },

  bloomThreshold: {
    simple: "Minimum brightness for a particle to contribute to the glow.",
    visual:
      "Low threshold (0.05, default): Almost all particles glow at least a little.\n" +
      "High threshold (0.3–0.5): Only the very brightest particles produce halos — " +
      "creates a selective highlight effect.",
    range: "0 – 1. Default: 0.05.",
    performance:
      "Slightly reduces bloom cost at high thresholds (fewer pixels pass the bright filter).",
    notes: "Only active when Bloom is enabled.",
  },

  softHdrExposure: {
    simple: "Tone-mapping brightness for soft-HDR displays.",
    visual:
      "Higher = brighter overall image. Lower = compressed dynamic range.",
    science:
      "Linear tone-mapping exposure for the soft-HDR rendering path. Only active " +
      "when your display supports HDR but the browser can't create a full " +
      "rgba16float canvas — the renderer falls back to linear tone mapping " +
      "to simulate extended brightness range.",
    range: "0.5 – 4. Default: 1.6.",
    performance: "None. Single multiply in the final compositing pass.",
    notes:
      "Has NO effect in full HDR mode (display handles mapping) or on SDR-only displays. " +
      "Check Readout → HDR mode to see which path you're using. " +
      "Only visible when soft-HDR is active.",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  Camera
  // ═══════════════════════════════════════════════════════════════════
  zoom: {
    simple: "Orthographic camera zoom level.",
    visual:
      "1.0 (default): Full Lambert disk visible.\n" +
      "> 1: Zoom in — magnify detail at the centre.\n" +
      "< 1: Zoom out — more border visible around the disk.",
    range: "0.2 – 5. Default: 1.0.",
    performance: "None. Changes the camera projection matrix only.",
  },

  backgroundColor: {
    simple: "Scene background colour.",
    visual: "Click to open picker. Default: pure black (#000000).",
    performance: "None.",
    notes: "Purely cosmetic. Does not affect particle colours or physics.",
  },

  // ═══════════════════════════════════════════════════════════════════
  //  Color Tuning
  // ═══════════════════════════════════════════════════════════════════
  lightnessFloor: {
    simple: "Minimum HSL lightness for all particles.",
    visual:
      "Higher floor = no truly dark particles (everything is at least this bright).\n" +
      "0 = particles can be fully black.",
    range: "0 – 0.5. Default: 0.20.",
    performance: "None.",
    notes: "Total max lightness = floor + range (should not exceed ~0.85 for natural colours).",
  },

  lightnessRange: {
    simple: "How much lightness varies across particles.",
    visual:
      "Small range = more uniform brightness. Large range = more contrast " +
      "between bright and dim regions.",
    range: "0.1 – 0.8. Default: 0.65.",
    performance: "None.",
    notes: "Works with lightness floor.",
  },

  saturationFloor: {
    simple: "Minimum colour saturation — prevents grey/washed-out particles.",
    visual:
      "Higher = all particles are vivid. 0 = some particles may appear grey.",
    range: "0 – 1. Default: 0.70.",
    performance: "None.",
  },

  saturationRange: {
    simple: "How much saturation varies across particles.",
    visual:
      "Small range = uniformly vivid. Large range = some particles more muted than others.",
    range: "0 – 0.5. Default: 0.25 (most particles in the 0.70–0.95 saturation band).",
    performance: "None.",
  },
};

// ── Readout panel tooltips ──────────────────────────────────────────────

export const READOUT_TOOLTIPS: Record<string, Tooltip> = {
  beta: {
    simple: "Spin–torsion coupling β (from slider).",
    detail:
      "The current spin parameter β. Higher β → gentler bounce, warmer colours, " +
      "lower energy density. Lower β → violent, dense bounce, cooler/bluer tones.\n\n" +
      "This is the primary physics parameter. Range: 0.005 – 0.249.",
  },
  aMin: {
    simple: "Minimum scale factor at the bounce — how compressed the universe gets.",
    detail:
      "a_min is the smallest the universe can get before torsion halts the collapse.\n\n" +
      "For k = +1: ā²_min = [1 − √(1−4β)] / 2\n" +
      "For k = 0:  ā²_min = β\n" +
      "For k = −1: ā²_min = [−1 + √(1+4β)] / 2\n\n" +
      "Close to 0 = extremely compressed (high energy density).\n" +
      "Close to 0.707 = barely compressed (gentle bounce, low energy density).",
  },
  wEff: {
    simple: "Effective equation of state at the bounce point.",
    detail:
      "w_eff = (ā² − 3β) / (3(ā² − β))\n\n" +
      "Describes how 'stiff' the matter is at peak compression:\n" +
      "  w = 1/3: radiation (normal matter).\n" +
      "  w = 1: extremely stiff (maximally compressed).\n" +
      "  w > 1: torsion-dominated — superstiff. Faster, more violent bounce.\n" +
      "  w < −1/3: accelerating expansion (repulsive).\n\n" +
      "The hue mapping on screen directly encodes w_eff: " +
      "stiffest → warmest colour, softest → coolest colour.",
  },
  torsionRatio: {
    simple: "How much of the total energy at the bounce comes from torsion.",
    detail:
      "S = torsion energy / total energy at the bounce point.\n\n" +
      "S ≈ 1.0: torsion (from fermion spin) dominates — this is the core " +
      "mechanism of ECSK cosmology that prevents the singularity.\n" +
      "S ≈ 0: gravity dominates (approaching GR behaviour — singularity).\n\n" +
      "In standard ECSK with typical β, S is always close to 1 at the bounce. " +
      "The whole point of the theory is that torsion takes over at extreme densities.",
  },
  ppStrength: {
    simple: "Particle production intensity (β_pp / β_cr ratio).",
    detail:
      "Shown as the ratio of your β_pp setting to the critical threshold:\n" +
      "  β_cr ≈ 1/929 ≈ 0.00108 (Popławski 2014 eq. 40–46)\n\n" +
      "Below 1: subcritical. Pair production occurs but is subtle.\n" +
      "Above 1: supercritical. Vigorous particle–antiparticle creation.\n" +
      "'off' when the pair-production slider is at zero.",
  },
  flux: {
    simple: "Smoothed particle arrival rate (particles per second).",
    detail:
      "Exponentially-smoothed count of particles arriving each second.\n\n" +
      "Should roughly match your Birth Rate slider at steady state. " +
      "If significantly lower, either:\n" +
      "  • The CPU can't keep up (check Compute Load)\n" +
      "  • The buffer is full (check Buffer Fill)\n" +
      "  • Many particles are in the future buffer (high arrival spread)",
  },
  visible: {
    simple: "Number of particles currently on screen.",
    detail:
      "At steady state: ≈ birth_rate × fade_duration.\n\n" +
      "Example: 2000/s × 1.0 s = ~2000 visible particles.\n" +
      "Example: 5000/s × 3.0 s = ~15,000 visible particles.\n\n" +
      "Capped by an emergency buffer ceiling to prevent memory exhaustion. " +
      "If this number plateaus below the expected value, the buffer is full.",
  },
  fps: {
    simple: "Rendering frame rate (frames per second).",
    detail:
      "60 fps: ideal (smooth animation).\n" +
      "30–60 fps: acceptable.\n" +
      "Below 30 fps: visibly choppy. " +
      "Reduce birth rate, ℓ_max, persistence, or disable bloom to improve.\n\n" +
      "If you've capped framerate via Target Framerate, this will show that cap, not VSync.",
  },
  cpuUsage: {
    simple: "Physics worker threads currently active.",
    detail:
      "Shows active workers / total CPU cores (from navigator.hardwareConcurrency).\n\n" +
      "Each worker independently generates particles from the perturbation field. " +
      "More workers = higher sustained particle throughput on multi-core CPUs.\n" +
      "Worker count is set automatically based on your hardware capability score.",
  },
  cpuLoad: {
    simple: "Measured CPU physics utilization (% of available worker time).",
    detail:
      "Real-time measurement of how much worker thread time is spent on " +
      "physics computation (spherical harmonics, particle emission, packing).\n\n" +
      "Driven by: birth rate × (ℓ_max + 1)².\n" +
      "High values mean your CPU workers are near saturation — reduce " +
      "birth rate or ℓ_max to free headroom.",
  },
  bufferFill: {
    simple: "GPU particle buffer usage (current / ceiling).",
    detail:
      "Shows how many particles are stored vs. the emergency buffer ceiling.\n\n" +
      "When this hits 100%, the oldest particles are silently dropped to free memory. " +
      "You'll see the pattern lose its oldest layer.\n\n" +
      "If it stays at 100%: reduce birth rate, persistence, or arrival spread.",
  },
  screen: {
    simple: "Display resolution (physical pixels).",
    detail:
      "Your screen's physical resolution.\n" +
      "Higher resolution = more pixels to shade per frame = more GPU work.\n" +
      "The renderer caps pixel ratio on lower-tier hardware to maintain performance.",
  },
  hz: {
    simple: "Monitor refresh rate (Hz).",
    detail:
      "Detected refresh rate. VRR = Variable Refresh Rate (G-Sync / FreeSync).\n\n" +
      "Higher refresh rates mean more frames to render per second. " +
      "If performance is limited, the Target Framerate control can cap rendering " +
      "below your native rate.",
  },
  hdr: {
    simple: "High-dynamic-range rendering mode.",
    detail:
      "FULL: True HDR with rgba16float canvas — particle brightness maps to real nits.\n" +
      "SOFT: Standard canvas with linear tone mapping — simulates extended range.\n" +
      "No: SDR only — standard ACES Filmic tone mapping.\n\n" +
      "The HDR Exposure slider only works in SOFT mode. " +
      "In FULL mode, the display hardware handles luminance mapping.",
  },
  gamut: {
    simple: "Display colour gamut (how wide a range of colours your screen shows).",
    detail:
      "sRGB: Standard (covers ~35% of visible colours).\n" +
      "P3: Wide gamut (richer reds and greens — common on modern displays).\n" +
      "Rec.2020: Ultra-wide (very rare — professional HDR monitors).\n\n" +
      "Wider gamut = more vivid and saturated particle colours are possible.",
  },
  cpuCores: {
    simple: "Total CPU threads available to the browser.",
    detail:
      "From navigator.hardwareConcurrency.\n\n" +
      "The physics engine distributes work across dedicated Web Workers. " +
      "More cores → more workers → higher particle throughput.\n" +
      "Typical: 4 (low-end laptop) to 32+ (high-end desktop).",
  },
  cpuBench: {
    simple: "Relative CPU speed (1.0× = baseline).",
    detail:
      "Quick micro-benchmark measuring transcendental-math throughput " +
      "(the same operations used in spherical harmonic evaluation).\n\n" +
      "Used to auto-tune: default particle rate, worker count, ℓ_max.\n" +
      "> 1.0: Faster than baseline. < 1.0: Slower.",
  },
  gpu: {
    simple: "Detected graphics card or integrated GPU.",
    detail:
      "From WebGPU adapter info (or WebGL debug renderer name).\n\n" +
      "Used to set the capability score and particle buffer size.\n" +
      "Discrete GPUs (RTX, RX, Arc) score much higher than integrated (Intel UHD, etc.).",
  },
  ramGB: {
    simple: "System RAM in GB — enter your actual value.",
    detail:
      "Browsers cap navigator.deviceMemory at 8 GB for fingerprint protection, " +
      "so auto-detection is unreliable.\n\n" +
      "Enter your real RAM size to let the budget system account for it. " +
      "Higher RAM adds a small bonus to budget calculations. Leave at 0 for auto.",
  },
  vramGB: {
    simple: "Dedicated GPU VRAM in GB — enter your actual value.",
    detail:
      "Browsers expose no VRAM API at all, so auto-detection is impossible.\n\n" +
      "Enter your GPU's VRAM size to unlock VRAM-aware budget caps. " +
      "This directly controls the maximum particle buffer size and visible-hit limit. " +
      "Leave at 0 for conservative auto-scaling.",
  },
  peakNits: {
    simple: "Peak display brightness in nits — enter your actual value.",
    detail:
      "The Screen Details API is rarely available, so auto-detection usually returns '?'.\n\n" +
      "Enter your monitor's peak brightness (e.g. 400 for SDR, 1000+ for HDR) " +
      "to get an accurate readout in the HDR mode display. Leave at 0 for auto.",
  },
};
