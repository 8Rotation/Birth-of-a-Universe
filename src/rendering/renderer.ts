/**
 * renderer.ts — 2D Bounce Sensor renderer (Three.js WebGPU).
 *
 * Renders the S² cross-section of the bounce hypersurface as a
 * Lambert equal-area projection disk with glowing point hits.
 *
 * Visual encoding:
 *   - Position: Lambert projection of (θ,φ) on S²
 *   - Hue:  effective equation of state w_eff (amber → violet)
 *   - Brightness: energy density at bounce (ε = 1/a_min⁴)
 *   - Alpha: exponential decay (persistence)
 *   - Bloom: physically-motivated glow from additive blending
 *
 * The disk radius is 2 (matching the Lambert projection radius),
 * viewed with an orthographic camera looking down -Z.
 *
 * NOTE: WebGPU point primitives are hard-capped at 1×1 pixel by the spec.
 * To get variable-sized particles we use an InstancedBufferGeometry
 * with a 2-triangle quad template plus per-instance packed vec4
 * attributes, rendered via a Mesh with NodeMaterial. The vertex shader
 * scales each quad to the computed particle size in world units.
 */

import * as THREE from "three";
import {
  WebGPURenderer,
  RenderPipeline,
  NodeMaterial,
} from "three/webgpu";
import {
  pass,
  uniform,
  instancedDynamicBufferAttribute,
  uv,
  float,
  length,
  smoothstep,
  mix,
  Fn,
  vec3,
  step,
  max,
  exp,
  pow,
  mod,
  abs,
  min,
  clamp,
  select,
  log,
  positionLocal,
  instanceIndex,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import type { ScreenInfo } from "../ui/screen-info.js";
import { ParticleRingBuffer } from "./particle-ring-buffer.js";
import {
  recommendedPixelRatioCap,
  hitSizeScale,
  recommendedExposure,
  SDR_REFERENCE_WHITE_NITS,
  DEFAULT_HDR_PEAK_NITS,
  epsToNits,
} from "../ui/screen-info.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface SensorRendererConfig {
  initialCapacity?: number;  // initial GPU buffer size; doubles automatically as needed
  bloomStrength?: number;
  bloomRadius?: number;
  bloomThreshold?: number;
}

/**
 * HDR rendering mode.
 *   - 'full':  True HDR output (rgba16float canvas + extended tone mapping).
 *             Particle brightness maps to real nits on the display.
 *   - 'soft':  HDR-capable display but browser/GPU can't do extended canvas.
 *             Uses linear tone mapping + nits-based color encoding for wider
 *             perceptual range than ACES.
 *   - 'none':  Standard SDR (ACES Filmic tone mapping, proxy brightness).
 */
export type HDRMode = 'full' | 'soft' | 'none';

// ── GPU-side HSL→RGB (TSL, branchless via step/mix) ─────────────────────
/**
 * Convert HSL to RGB entirely on the GPU using TSL nodes.
 * Uses a branchless approach: for each of the 6 hue sectors, step() selects
 * the correct (c, x, 0) mapping, accumulated via mix.
 */
const tslHslToRgb = /*#__PURE__*/ Fn(([h_deg, s, l]: [any, any, any]) => {
  const h = mod(h_deg, float(360.0));
  const c = s.mul(abs(l.mul(2.0).sub(1.0)).oneMinus());
  const x = c.mul(abs(mod(h.div(60.0), float(2.0)).sub(1.0)).oneMinus());
  const m = l.sub(c.div(2.0));

  // Sector boundaries
  const h60  = step(float(60.0),  h);
  const h120 = step(float(120.0), h);
  const h180 = step(float(180.0), h);
  const h240 = step(float(240.0), h);
  const h300 = step(float(300.0), h);

  // Sector masks: s0 = [0,60), s1 = [60,120), etc.
  const s0 = h60.oneMinus();
  const s1 = h60.sub(h120);
  const s2 = h120.sub(h180);
  const s3 = h180.sub(h240);
  const s4 = h240.sub(h300);
  const s5 = h300;

  // Accumulate r, g, b contributions from each sector
  const r = s0.mul(c).add(s1.mul(x)).add(s4.mul(x)).add(s5.mul(c));
  const g = s0.mul(x).add(s1.mul(c)).add(s2.mul(c)).add(s3.mul(x));
  const b = s2.mul(x).add(s3.mul(c)).add(s4.mul(c)).add(s5.mul(x));

  return vec3(r.add(m), g.add(m), b.add(m));
});

// ── Renderer constants ──────────────────────────────────────────────────────

/** Fade threshold — discard particles below this fade level. */
const FADE_THRESHOLD = 0.003;

/** Orthographic camera half-extent in world units (disk radius = 2).
 *  Sized so the disk fills 90% of viewport height (5% margin each side). */
const CAMERA_HALF_SIZE = 2.0 / 0.90;
/** Number of line segments for the Lambert disk boundary ring. */
const RING_SEGMENTS = 256;
/** Default initial GPU buffer capacity when hardware budget is unavailable. */
const DEFAULT_INITIAL_CAPACITY = 65_536;
/** Fixed outer radius for circular particle clipping. */
const CIRCLE_OUTER_R = 0.50;

// ── Auto-brightness constants ─────────────────────────────────────────────
/** Log-scale reference for eps→brightness mapping (must match shell.ts). */
const EPS_LOG_REF = Math.log(10001);
/** Reference hit.brightness level for auto-gain normalisation (midrange). */
const AUTO_BRI_REF = 0.5;
/** Reference hitBaseSize for particle-size overlap correction. */
const AUTO_BRI_SIZE_REF = 1.0;
/** Exponent for size-overlap dampening: √(ref/size).  0.5 = square root. */
const AUTO_BRI_SIZE_POW = 0.5;
// ── Sensor Renderer ───────────────────────────────────────────────────────

export class SensorRenderer {
  readonly renderer: WebGPURenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;

  // Instanced particle mesh: InstancedBufferGeometry (2-triangle quad
  // template) + per-instance packed vec4 attributes, rendered as a Mesh.
  private particleMesh!: THREE.Mesh;
  private _particleGeometry!: THREE.InstancedBufferGeometry;

  // GPU ring buffer for write-once per-particle birth data
  private _ringBuf!: ParticleRingBuffer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private material!: any; // PointsNodeMaterial (GPU-side path)
  private diskRing!: THREE.Mesh;
  private _ringMaterial!: THREE.MeshBasicMaterial;

  // TSL uniform for hit size — drives sizeNode on the material so the
  // slider value propagates to the GPU every frame.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _sizeUniform!: any;
  // TSL uniform: 1.0 = round particles, 0.0 = square
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _roundUniform!: any;
  // TSL uniform: soft-edge width for circular particles
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _softEdgeUniform!: any;

  // ── GPU-side (Task 2) TSL uniforms ──────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uTime!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uTau!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uFadeSharpness!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uHitBaseSize!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uBrightnessMultiplier!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uLightnessFloor!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uLightnessRange!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uSaturationFloor!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uSaturationRange!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uAutoGain!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uPeakScale!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uHdrMode!: any;  // 0=none, 1=soft, 2=full
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uPeakNits!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uMinEps!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uMaxEps!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uPixelToWorld!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uFadeToBlack!: any;  // 0=transparent, 1=black

  // ── Alive-range uniforms (Task 4) ──────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uAliveStart!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uAliveCount!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _uCapacity!: any;

  private pipeline: RenderPipeline | null = null;
  useBloom = true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _bloomNode: any = null;

  // TSL uniform multiplier — gate bloom in the composite.
  // Setting the bloom node's strength to 0 alone is not enough because
  // the gaussian blur chain can still produce non-zero output.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _particleBloomMul: any = null;

  // ── Ring glow mesh (replaces bloom-scene-based ring bloom) ────────
  // A wider annular ring behind the main ring with gaussian alpha falloff,
  // rendered via additive blending. Controlled independently of particle bloom.
  private _glowRing: THREE.Mesh | null = null;
  private _glowRingMaterial: THREE.ShaderMaterial | null = null;
  private _lastGlowWidth = -1;  // track for geometry rebuild

  private _ready = false;

  // GPU buffer capacity — starts at initialCapacity and doubles when exceeded.
  // There is no fixed upper bound; the system adapts to however many hits
  // the simulation and persistence settings produce.
  private _capacity: number;

  // ── Tunable parameters (set from controls each frame) ─────────────
  hitBaseSize = 3.0;
  brightnessMultiplier = 2.0;
  roundParticles = true;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  bloomQuality: 'auto' | 'high' | 'low' = 'auto';
  /** Hardware-tier resolved quality for 'auto' mode (set by main.ts). */
  bloomAutoResolvedQuality: 'high' | 'low' = 'high';
  fadeSharpness = 1.0;
  fadeToBlack = false;

  // Color tuning
  lightnessFloor = 0.20;
  lightnessRange = 0.65;
  saturationFloor = 0.70;
  saturationRange = 0.25;

  // Ring — visible annular mesh (RingGeometry) not a 1px LineLoop.
  // Default warm orange at 50% opacity so it's clearly visible.
  ringOpacity = 0.50;
  ringColor = 0xff6633;

  // Ring geometry + bloom controls (independent of particle bloom)
  ringWidthPx = 2;           // ring thickness in CSS pixels
  particleBloomEnabled = true; // particle bloom on/off
  ringBloomEnabled = true;   // ring bloom on/off (independent of particle bloom)
  ringBloomStrength = 0.8;   // ring-only bloom intensity
  ringBloomRadius = 0.4;     // ring-only bloom spread
  ringAutoColor = false;     // match ring colour to dominant particle hue
  /** Last effective ring colour (hex int), whether manual or auto-computed. */
  effectiveRingColor = 0xff6633;
  private _lastRingWidthWorld = -1;  // track for geometry rebuild

  // HDR exposure (soft-HDR path)
  softHdrExposure = 1.6;

  // Particle edge softness (0 = hard, 0.5 = very soft)
  particleSoftEdge = 0.05;

  // ── Brightness-range encoding (must match shell.ts EmitterConfig) ───
  /** Brightness floor: minimum hit.brightness value for log-eps mapping. */
  brightnessFloor = 0.15;
  /** Brightness ceiling: maximum hit.brightness value for log-eps mapping. */
  brightnessCeil = 1.0;

  // ── Scene controls ─────────────────────────────────────────────────
  /** Background colour (CSS hex). Applied via setClearColor each frame. */
  backgroundColor = 0x000000;
  /** Orthographic zoom multiplier (1.0 = default framing). */
  zoom = 1.0;
  /** Arrival spread (seconds) — used to extend alive-range cutoff so the
   *  binary search handles non-monotonic bornTimes correctly. */
  arrivalSpread = 0;

  // ── Auto-brightness ────────────────────────────────────────────────
  /** When true, normalise brightness so the brightest *possible* particle
   *  at the current settings hits peak display luminance.  Uses a
   *  physics-based ceiling rather than reactive EMA to avoid flicker. */
  autoBrightness = false;
  /**
   * Maximum energy density (eps) achievable at the current physics
   * settings.  Set by the main loop each frame from `physics.bounceProps`.
   * Used to compute the auto-brightness ceiling deterministically so
   * there is no EMA lag or overshoot.
   * In HDR mode, also used as the bright end of the eps→nits mapping
   * so the full display range is utilised.
   */
  maxEps = 10_000;
  /**
   * Minimum energy density (eps) at the current settings — the dimmest
   * particle that can possibly appear. Used in HDR mode as the dim end
   * of the dynamic eps→nits mapping.
   */
  minEps = 10;

  /**
   * Smoothed observed max eps among alive particles. Fast-attack,
   * slow-decay so the display responds instantly to new bright
   * particles but doesn't flicker when they fade.
   */
  private _observedMaxEps = 0;

  /** Current hit-size scale factor derived from screen density. */
  hitSizeScaleFactor = 1.0;
  /** Current pixel ratio cap from screen detection. */
  private _pixelRatioCap = 2;
  // ── HDR state ─────────────────────────────────────────────────────────
  private _hdrMode: HDRMode = 'none';
  private _peakNits = SDR_REFERENCE_WHITE_NITS;   // 203 until overridden
  /**
   * Reference value for the brightness slider in SDR mode.
   * In HDR, the slider is normalised against this so that the default
   * slider position (≈5.0) maps to nits-accurate brightness, and moving
   * the slider still has the same perceptual feel.
   */
  private static readonly SDR_BRIGHTNESS_REF = 5.0;

  /** Active HDR rendering mode ('full' | 'soft' | 'none'). */
  get hdrMode(): HDRMode { return this._hdrMode; }

  /** Override peak display brightness (nits). 0 = use auto-detection. */
  set peakNits(nits: number) { if (nits > 0) this._peakNits = nits; }

  /** GPU ring buffer for write-once per-particle birth data. */
  get ringBuffer(): ParticleRingBuffer { return this._ringBuf; }

  /**
   * Force soft-HDR mode on devices where detection fails (e.g. Android Chrome).
   * Safe to call after init — only changes tone mapping, no canvas reconfiguration.
   */
  forceSoftHDR(peakNits = DEFAULT_HDR_PEAK_NITS): void {
    if (this._hdrMode === 'full') return; // already in a better mode
    this._peakNits = peakNits;
    this.renderer.toneMapping = THREE.LinearToneMapping;
    this.renderer.toneMappingExposure = this.softHdrExposure;
    this._hdrMode = 'soft';
    console.log(
      `[sensor] HDR SOFT (forced): standard canvas + linear TM, ` +
      `peak ~${this._peakNits} nits`
    );
  }

  /**
   * Revert from forced soft-HDR back to SDR (ACES Filmic).
   */
  disableSoftHDR(): void {
    if (this._hdrMode !== 'soft') return;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this._hdrMode = 'none';
    this._peakNits = SDR_REFERENCE_WHITE_NITS;
    console.log('[sensor] HDR disabled — back to SDR (ACES)');
  }

  constructor(config: SensorRendererConfig) {
    this._capacity = config.initialCapacity ?? DEFAULT_INITIAL_CAPACITY;
    this.bloomStrength = config.bloomStrength ?? 1.2;
    this.bloomRadius = config.bloomRadius ?? 0.3;
    this.bloomThreshold = config.bloomThreshold ?? 0.05;

    // ── WebGPU renderer ───────────────────────────────────────────────
    this.renderer = new WebGPURenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this._pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    document.body.appendChild(this.renderer.domElement);

    // ── Scene ─────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();

    // ── Orthographic camera (fits Lambert disk with padding) ──────────
    // V is scaled so the disk fills 90% of the *shorter* axis (5% margin each side).
    const aspect = window.innerWidth / window.innerHeight;
    const V = aspect < 1 ? CAMERA_HALF_SIZE / aspect : CAMERA_HALF_SIZE;
    this.camera = new THREE.OrthographicCamera(
      -V * aspect, V * aspect,
      V, -V,
      -1, 100,
    );
    this.camera.position.set(0, 0, 10);
    this.camera.lookAt(0, 0, 0);

    // Resize is handled by applyScreenInfo (via ScreenDetector.onChange)
    // to avoid duplicate/conflicting resize events.
  }

  /**
   * Update renderer to match detected screen characteristics.
   * Called once after init and whenever the screen changes (monitor switch).
   */
  applyScreenInfo(info: ScreenInfo): void {
    this._pixelRatioCap = recommendedPixelRatioCap(info);
    this.hitSizeScaleFactor = hitSizeScale(info);

    const effectiveDpr = Math.min(info.dpr, this._pixelRatioCap);
    this.renderer.setPixelRatio(effectiveDpr);
    this.renderer.setSize(info.viewportWidth, info.viewportHeight);

    // Tone mapping exposure: only relevant for SDR and soft-HDR paths.
    // Full HDR uses NoToneMapping (set in _setupHDR, preserved here).
    if (this._hdrMode === 'none') {
      this.renderer.toneMappingExposure = recommendedExposure(info);
    } else if (this._hdrMode === 'soft') {
      this.renderer.toneMappingExposure = recommendedExposure(info);
    }
    // 'full' → exposure stays at 1.0 (set by _setupHDR)

    // Update peak nits if the display changed and we’re in an HDR mode
    if (this._hdrMode !== 'none') {
      this._peakNits = info.peakBrightnessNits ?? DEFAULT_HDR_PEAK_NITS;
    }

    // Update camera aspect — size disk by the *shorter* axis
    const aspect = info.viewportWidth / info.viewportHeight;
    const V = aspect < 1 ? CAMERA_HALF_SIZE / aspect : CAMERA_HALF_SIZE;
    this.camera.left   = -V * aspect;
    this.camera.right  =  V * aspect;
    this.camera.top    =  V;
    this.camera.bottom = -V;
    this.camera.updateProjectionMatrix();
    try { this.pipeline?.setSize?.(info.viewportWidth, info.viewportHeight); } catch { /* noop */ }

    console.log(
      `[sensor] Screen adapted: DPR ${effectiveDpr.toFixed(2)} (cap ${this._pixelRatioCap}), ` +
      `hitScale ${this.hitSizeScaleFactor.toFixed(2)}, render ${info.renderWidth}×${info.renderHeight}, ` +
      `HDR mode: ${this._hdrMode}` +
      (this._hdrMode !== 'none' ? ` (~${this._peakNits} nits)` : '')
    );
  }

  get ready(): boolean {
    return this._ready;
  }

  /** Current GPU buffer capacity (number of hit slots). */
  get capacity(): number {
    return this._capacity;
  }

  // ── HDR canvas configuration ────────────────────────────────────────────

  /**
   * Attempt to configure the WebGPU canvas for true HDR output.
   * Falls back through: full → soft → none.
   *
   * Full HDR requires:
   *   - `rgba16float` canvas format
   *   - `toneMapping: { mode: 'extended' }` on the canvas context
   *   - Values > 1.0 in the framebuffer map to brightness above SDR white
   *
   * If the browser or GPU doesn’t support the extended canvas, we fall back
   * to “soft” HDR (linear tone mapping + nits-based color encoding) which
   * still looks wider-range than SDR ACES.
   */
  private _setupHDR(info: ScreenInfo): void {
    this._peakNits = info.peakBrightnessNits ?? DEFAULT_HDR_PEAK_NITS;

    // ── Tier 1: True HDR canvas (rgba16float + extended tone mapping) ──
    // FRAGILE: The monkey-patches below depend on Three.js WebGPU internals:
    //   • backend.utils.getPreferredCanvasFormat  (pipeline format override)
    //   • backend._configureContext              (resize HDR preservation)
    // These are private APIs that may change between Three.js releases.
    // Tested with Three.js r${183} (THREE.REVISION). Also requires
    // Chrome 131+ / GPUCanvasToneMappingMode "extended".
    try {
      const canvas = this.renderer.domElement;
      const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!ctx) throw new Error('No WebGPU context on canvas');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const backend = (this.renderer as any).backend;
      const device: GPUDevice | undefined = backend?.device;
      if (!device) throw new Error('WebGPU device not available on backend');

      // Warn if Three.js version has changed since these patches were verified
      if (THREE.REVISION !== '183') {
        console.warn(
          `[sensor] HDR patches were tested with Three.js r183; ` +
          `running r${THREE.REVISION} — verify backend internals still match.`
        );
      }

      // Reconfigure the swap chain for HDR output.
      // `rgba16float` gives 16-bit float per channel (supports values > 1.0).
      // `toneMapping: extended` tells the compositor to display values > 1.0
      // as brighter than SDR white, up to the display’s peak luminance.
      const hdrConfig: GPUCanvasConfiguration = {
        device,
        format: 'rgba16float' as GPUTextureFormat,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        colorSpace: 'srgb' as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toneMapping: { mode: 'extended' } as any,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        alphaMode: 'premultiplied',
      };

      ctx.configure(hdrConfig);

      // Patch Three.js internals so it uses the new format for pipeline
      // creation and future reconfigures (e.g. on resize).
      if (backend.utils?.getPreferredCanvasFormat) {
        backend.utils.getPreferredCanvasFormat = () => 'rgba16float';
      }

      // Override _configureContext so resizes preserve HDR settings.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      if (typeof backend._configureContext === 'function') {
        const origConfigure = backend._configureContext.bind(backend);
        backend._configureContext = function () {
          try {
            this.context.configure({
              device: this.device,
              format: 'rgba16float',
              colorSpace: 'srgb',
              toneMapping: { mode: 'extended' },
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
              alphaMode: 'premultiplied',
            });
          } catch {
            // If HDR reconfigure fails (e.g. device lost), fall back to SDR.
            origConfigure();
            self._hdrMode = 'soft';
          }
        };
      }

      // No Three.js tone mapping — we encode nits directly into the
      // framebuffer and let the extended canvas handle the display mapping.
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.toneMappingExposure = 1.0;

      this._hdrMode = 'full';
      console.log(
        `[sensor] HDR FULL: rgba16float / srgb / extended, ` +
        `peak ~${this._peakNits} nits`
      );
      return;
    } catch (e) {
      console.warn('[sensor] HDR canvas setup failed, trying soft HDR:', e);
    }

    // ── Tier 2: Soft HDR (standard canvas, linear tone mapping) ────────
    // Nits-based color encoding still spreads values wider than ACES,
    // and LinearToneMapping preserves more of the extended range before
    // the 8-bit canvas clips.  Bloom bleeds the clipped energy outward
    // for a wider perceived brightness range.
    this.renderer.toneMapping = THREE.LinearToneMapping;
    this.renderer.toneMappingExposure = this.softHdrExposure;
    this._hdrMode = 'soft';
    console.log(
      `[sensor] HDR SOFT: standard canvas + linear TM, ` +
      `peak ~${this._peakNits} nits`
    );
  }

  /**
   * Initialize WebGPU, optionally set up the HDR pipeline, and build the
   * scene.  If `screenInfo` indicates an HDR-capable display, attempts
   * to configure a true HDR canvas before any GPU pipelines are compiled.
   */
  async init(screenInfo?: ScreenInfo): Promise<void> {
    console.log("[sensor] Initializing WebGPU...");
    await this.renderer.init();
    console.log("[sensor] WebGPU ready");

    // ── HDR pipeline setup (must happen BEFORE scene/pipeline creation
    //    so that GPU pipelines are compiled against the correct canvas
    //    format from the start) ──────────────────────────────────
    if (screenInfo?.hdrCapable) {
      this._setupHDR(screenInfo);
    }

    // ── Instanced particle mesh ─────────────────────────────────────
    // WebGPU point primitives are always 1px.  An InstancedBufferGeometry
    // with a 2-triangle quad template + per-instance attributes renders
    // variable-sized screen-aligned particles with proper GPU instancing.

    // TSL uniforms (reactive every frame)
    this._sizeUniform = uniform(this.hitBaseSize);
    this._roundUniform = uniform(1.0);
    this._softEdgeUniform = uniform(this.particleSoftEdge);

    // ── Lambert disk boundary ring ─────────────────────────────────
    // Inner edge sits flush at r=2.0; ring grows outward only.
    // Width is specified in CSS pixels and converted to world units.
    const baseInner = 2.0;
    const initFrustumH = (2 * CAMERA_HALF_SIZE) / Math.max(this.zoom, 0.01);
    const initWidthWorld = Math.max(0.001, this.ringWidthPx * (initFrustumH / window.innerHeight));
    this._lastRingWidthWorld = initWidthWorld;
    const baseGeo = new THREE.RingGeometry(baseInner, baseInner + initWidthWorld, RING_SEGMENTS);
    this._ringMaterial = new THREE.MeshBasicMaterial({
      color: this.ringColor,
      transparent: true,
      opacity: this.ringOpacity,
      side: THREE.DoubleSide,
    });
    this.diskRing = new THREE.Mesh(baseGeo, this._ringMaterial);

    this.scene.add(this.diskRing);

    // ── GPU ring buffer (write-once particle birth data) ─────────────
    this._ringBuf = new ParticleRingBuffer(this._capacity);

    // ── GPU-side material ────────────────────────────────────────────
    // Reads immutable birth data from ring buffer attributes and computes
    // fade, color, and visibility entirely on the GPU.
    this._initGpuMaterial();

    // Create instanced particle mesh with GPU material
    this.particleMesh = new THREE.Mesh(this._particleGeometry, this.material);
    this.particleMesh.frustumCulled = false;
    this.scene.add(this.particleMesh);

    // Pass GPU device + backend to ring buffer for direct partial uploads.
    // GPUBuffers for the attributes are created lazily on first render,
    // so the initial writeBatch() will use the needsUpdate fallback.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backend = (this.renderer as any).backend;
    const gpuDevice: GPUDevice | undefined = backend?.device;
    if (gpuDevice && backend) {
      this._ringBuf.setGpuBackend(gpuDevice, backend);
    }

    // ── Ring glow mesh (shader-based gaussian falloff, additive blend) ──
    // Replaces the expensive bloom-scene-based ring bloom with a simple
    // annular mesh that has gaussian alpha falloff. Independently controlled.
    this._initGlowRing();

    // Show the first frame immediately (lightweight no-bloom path),
    // then compile bloom shaders in the background.
    this.useBloom = false;
    this._ready = true;
    console.log(`[sensor] Ready — initial GPU buffer ${this._capacity} hits (grows as needed)`);

    // Fire bloom compilation after the first frame renders.
    // requestAnimationFrame ensures the first paint happens without
    // bloom shader compilation blocking it.
    requestAnimationFrame(() => this._initBloom());
  }

  /**
   * Compile the bloom pipeline in the background.
   * Called from init() without await so the first frame renders immediately
   * via the lightweight no-bloom path. Once compilation succeeds,
   * `this.useBloom` is set to true and subsequent frames use bloom.
   *
   * Single scene pass: bloom is computed on the main scene directly.
   * Particle bloom is controlled via strength/radius/threshold + a gate uniform.
   * Ring glow is handled by a separate shader mesh (no bloom chain needed).
   */
  private _initBloom(): void {
    try {
      this.pipeline = new RenderPipeline(this.renderer);

      // Single scene pass — particles + disk ring + glow ring all in one
      const scenePass = pass(this.scene, this.camera);
      const scenePassColor = scenePass.getTextureNode("output");

      // Bloom computed from the single scene pass (particles dominate;
      // the disk ring is below bloom threshold at normal opacity)
      const bloomNode = bloom(
        scenePassColor,
        this.bloomStrength,
        this.bloomRadius,
        this.bloomThreshold,
      );
      this._bloomNode = bloomNode;

      // ── Bloom resolution cap: always cap at 1080p equivalent ─────────
      const origSetSize = bloomNode.setSize.bind(bloomNode);
      const MAX_BLOOM_PIXELS = 1920 * 1080;
      bloomNode.setSize = (w: number, h: number) => {
        const pixels = w * h;
        if (pixels > MAX_BLOOM_PIXELS) {
          const scale = Math.sqrt(MAX_BLOOM_PIXELS / pixels);
          origSetSize(Math.round(w * scale), Math.round(h * scale));
        } else {
          origSetSize(w, h);
        }
      };

      // TSL uniform multiplier: definitively zero bloom in the
      // composite when particle bloom is off.
      this._particleBloomMul = uniform(1.0);

      // Composite: scene + bloom (gated by particle bloom toggle)
      this.pipeline.outputNode = scenePassColor
        .add(bloomNode.mul(this._particleBloomMul));

      this.useBloom = true;
      console.log("[sensor] Bloom enabled (single scene pass + shader glow ring)");
    } catch (e) {
      console.warn("[sensor] Bloom compilation failed, falling back:", e);
      this.useBloom = false;
    }
  }

  /**
   * Create the ring glow mesh — a wider annular ring behind the main ring
   * with gaussian alpha falloff, rendered via additive blending.
   * Replaces the expensive bloom-scene-based ring bloom.
   */
  private _initGlowRing(): void {
    const glowMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: new THREE.Color(this.ringColor) },
        uOpacity: { value: this.ringBloomStrength },
        uInnerRadius: { value: 2.0 },
        uGlowWidth: { value: 0.15 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vWorldPos;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPos = worldPos.xy;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uInnerRadius;
        uniform float uGlowWidth;
        varying vec2 vWorldPos;
        void main() {
          float dist = length(vWorldPos);
          // Distance from the ring center line (r = innerRadius)
          float d = abs(dist - uInnerRadius);
          // Gaussian falloff: sigma = glowWidth / 3 so edges are ~0
          float sigma = uGlowWidth / 3.0;
          float glow = exp(-0.5 * (d * d) / (sigma * sigma));
          gl_FragColor = vec4(uColor * uOpacity * glow, uOpacity * glow);
        }
      `,
    });

    this._glowRingMaterial = glowMat;

    // Initial glow ring geometry: extends glowWidth beyond the ring center
    const glowWidth = this._ringBloomRadiusToGlowWidth(this.ringBloomRadius);
    const geo = new THREE.RingGeometry(
      Math.max(0.01, 2.0 - glowWidth), 2.0 + glowWidth, RING_SEGMENTS,
    );
    this._glowRing = new THREE.Mesh(geo, glowMat);
    this._glowRing.renderOrder = -1;  // behind the main ring and particles
    this._glowRing.visible = this.ringBloomEnabled;
    this._lastGlowWidth = glowWidth;
    this.scene.add(this._glowRing);
  }

  /**
   * Convert the user-facing ringBloomRadius [0..1+] to a world-unit glow width.
   * 0 = tight glow, 1 = wide glow (~0.4 world units).
   */
  private _ringBloomRadiusToGlowWidth(radius: number): number {
    return Math.max(0.02, radius * 0.4);
  }

  /**
   * Create the GPU-side NodeMaterial on an InstancedBufferGeometry
   * (2-triangle quad template + per-instance packed vec4 attributes).
   * Computes fade, color, size, and visibility entirely in TSL shaders.
   */
  private _initGpuMaterial(): void {
    // ── Quad template geometry (unit quad: ±0.5) ────────────────────
    const quadGeo = new THREE.InstancedBufferGeometry();
    const verts = new Float32Array([
      -0.5, -0.5, 0,   0.5, -0.5, 0,   0.5,  0.5, 0,
      -0.5, -0.5, 0,   0.5,  0.5, 0,  -0.5,  0.5, 0,
    ]);
    const uvs = new Float32Array([
      0, 0,  1, 0,  1, 1,
      0, 0,  1, 1,  0, 1,
    ]);
    quadGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    quadGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

    // Attach per-instance packed attributes to the geometry
    quadGeo.setAttribute('aPackedA', this._ringBuf.packedAttrA);
    quadGeo.setAttribute('aPackedB', this._ringBuf.packedAttrB);
    quadGeo.instanceCount = 0;  // no visible instances yet

    this._particleGeometry = quadGeo;

    // ── TSL uniforms ────────────────────────────────────────────────
    this._uTime = uniform(0.0);
    this._uTau = uniform(1.0);
    this._uFadeSharpness = uniform(1.0);
    this._uHitBaseSize = uniform(this.hitBaseSize * this.hitSizeScaleFactor);
    this._uBrightnessMultiplier = uniform(this.brightnessMultiplier);
    this._uLightnessFloor = uniform(this.lightnessFloor);
    this._uLightnessRange = uniform(this.lightnessRange);
    this._uSaturationFloor = uniform(this.saturationFloor);
    this._uSaturationRange = uniform(this.saturationRange);
    this._uAutoGain = uniform(1.0);
    this._uPeakScale = uniform(20.0);
    this._uHdrMode = uniform(0.0);     // 0=none, 1=soft, 2=full
    this._uPeakNits = uniform(SDR_REFERENCE_WHITE_NITS);
    this._uMinEps = uniform(10.0);
    this._uMaxEps = uniform(10000.0);
    this._uPixelToWorld = uniform(1.0); // updated each frame
    this._uFadeToBlack = uniform(0.0);   // 0 = fade to transparent, 1 = fade to black

    // Alive-range uniforms: skip dead particles early in the vertex shader
    this._uAliveStart = uniform(0.0);
    this._uAliveCount = uniform(0.0);
    this._uCapacity = uniform(float(this._capacity));

    // ── Read packed ring buffer attributes (2 vec4s instead of 6 attrs) ──
    const packedA = instancedDynamicBufferAttribute(this._ringBuf.packedAttrA, "vec4");
    const packedB = instancedDynamicBufferAttribute(this._ringBuf.packedAttrB, "vec4");

    // Unpack components
    const aLx       = packedA.x;
    const aLy       = packedA.y;
    const aBornTime = packedA.z;
    const aHue      = packedA.w;
    const aBrightness = packedB.x;
    const aEps      = packedB.y;
    const aSize     = packedB.z;

    // ── Alive-range pre-filter: skip dead particles before Weibull ──
    // Compute ring-distance from aliveStart; if >= aliveCount, particle is dead.
    // Since dead particles form contiguous blocks, entire GPU wavefronts
    // skip the expensive Weibull+HSL work via branch coherence.
    const ringDist = mod(instanceIndex.toFloat().sub(this._uAliveStart).add(this._uCapacity), this._uCapacity);
    const inRange = step(ringDist, this._uAliveCount.sub(float(0.5)));

    // ── Size + fade: Weibull fade + dead-particle culling ───────────
    const uTime = this._uTime;
    const uTau = this._uTau;
    const uFadeSharpness = this._uFadeSharpness;
    const uHitBaseSize = this._uHitBaseSize;
    const uPixelToWorld = this._uPixelToWorld;

    // ── Shared per-vertex fade (computed once, used by size + color) ──
    const rawAge = uTime.sub(aBornTime);
    const age = max(float(0.0), rawAge);
    const fade = exp(pow(age.div(uTau), uFadeSharpness).negate());
    const alive = inRange.mul(step(float(0.0), rawAge)).mul(step(float(FADE_THRESHOLD), fade));

    // Size in world units: pixel size × pixel-to-world conversion
    const sizeWorld = aSize.mul(uHitBaseSize).mul(alive).mul(uPixelToWorld);

    // ── Position: scale quad vertices by size, translate to instance pos ──
    // positionLocal is the quad template vertex (±0.5, ±0.5, 0).
    // Scale by sizeWorld and translate to the particle's (lx, ly, 0).
    const instancePos = vec3(aLx, aLy, float(0.0));
    const posNode = instancePos.add(positionLocal.mul(sizeWorld));

    // ── Color: HSL→RGB + SDR/HDR brightness scaling ─────────────────
    const uBri = this._uBrightnessMultiplier;
    const uLFloor = this._uLightnessFloor;
    const uLRange = this._uLightnessRange;
    const uSFloor = this._uSaturationFloor;
    const uSRange = this._uSaturationRange;
    const uAutoGain = this._uAutoGain;
    const uPeakScale = this._uPeakScale;
    const uHdrMode = this._uHdrMode;
    const uPeakNits = this._uPeakNits;
    const uMinEps = this._uMinEps;
    const uMaxEps = this._uMaxEps;
    const SDR_WHITE_F = float(SDR_REFERENCE_WHITE_NITS);
    const SDR_BRI_REF = float(SensorRenderer.SDR_BRIGHTNESS_REF);

    const uFadeToBlack = this._uFadeToBlack;

    const colorNode = Fn(() => {
      // ── SDR path ──────────────────────────────────────────────────
      const sdrLightness = uLFloor.add(aBrightness.mul(uLRange));
      const sdrSaturation = uSFloor.add(aBrightness.oneMinus().mul(uSRange));
      const sdrRgb = tslHslToRgb(aHue, sdrSaturation, sdrLightness);
      const sdrScale = uBri;

      // ── HDR path ──────────────────────────────────────────────────
      const hdrSat = min(float(1.0), uSFloor.add(uSRange));
      const hdrRgb = tslHslToRgb(aHue, hdrSat, float(0.5));
      // epsToNits: linear mapping from [minEps, maxEps] → [20, peakNits]
      const epsRange = uMaxEps.sub(uMinEps);
      const epsT = clamp(aEps.sub(uMinEps).div(max(epsRange, float(0.001))), 0.0, 1.0);
      const nits = float(20.0).add(epsT.mul(uPeakNits.sub(float(20.0))));
      const linearRelSDR = nits.div(SDR_WHITE_F);
      const hdrScale = linearRelSDR.mul(uBri.div(SDR_BRI_REF));

      // select SDR/HDR path (0=SDR, >0=HDR)
      const isHdr = step(float(0.5), uHdrMode);
      const rgb = mix(sdrRgb, hdrRgb, isHdr);
      const scale = mix(sdrScale, hdrScale, isHdr);

      // Apply auto-gain and peak clamp, gate by alive (dead → vec3(0))
      const finalScale = min(scale.mul(uAutoGain), uPeakScale);
      // fadeToBlack=1: fade baked into RGB (particles darken toward black).
      // fadeToBlack=0: fade handled in alpha (particles become transparent).
      const colorFade = mix(float(1.0), fade, uFadeToBlack);
      return rgb.mul(finalScale).mul(alive).mul(colorFade);
    })();

    // ── Circular clipping (same as old material) ────────────────────
    const roundU = this._roundUniform;
    const softEdgeU = this._softEdgeUniform;
    const gpuCircleOpacity = Fn(() => {
      const coord = uv().sub(float(0.5));
      const dist = length(coord);
      const innerR = float(CIRCLE_OUTER_R).sub(softEdgeU);
      const circle = smoothstep(float(CIRCLE_OUTER_R), innerR, dist);
      const shapeAlpha = mix(float(1.0), circle, roundU);
      // fadeToBlack=0: fade via alpha so particles become transparent.
      // fadeToBlack=1: alpha is shape-only (fade already in RGB).
      const alphaFade = mix(fade, float(1.0), uFadeToBlack);
      return shapeAlpha.mul(alphaFade).mul(alive);
    });

    // ── Assemble GPU material ───────────────────────────────────────
    this.material = new NodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.material.positionNode = posNode;
    this.material.colorNode = colorNode;
    this.material.opacityNode = gpuCircleOpacity();
    this.material.alphaTest = 0.01;
  }

  /**
   * Update GPU-side uniforms. Zero per-particle JS work — just scalar uniform writes.
   *
   * @param now  Current display time (seconds) — same time basis as particle arrivalTime
   * @param tau  Weibull scale parameter (from fadeDurationToTau)
   */
  updateUniforms(now: number, tau: number): void {
    if (!this._ready) return;

    // ── Push scalar uniforms ──────────────────────────────────────
    this._uTime.value = now;
    this._uTau.value = tau;
    this._uFadeSharpness.value = this.fadeSharpness;
    this._uHitBaseSize.value = this.hitBaseSize * this.hitSizeScaleFactor;
    this._uBrightnessMultiplier.value = this.brightnessMultiplier;
    this._uLightnessFloor.value = this.lightnessFloor;
    this._uLightnessRange.value = this.lightnessRange;
    this._uSaturationFloor.value = this.saturationFloor;
    this._uSaturationRange.value = this.saturationRange;
    this._uFadeToBlack.value = this.fadeToBlack ? 1.0 : 0.0;

    // HDR mode uniform
    const hdrModeNum = this._hdrMode === 'full' ? 2.0
      : this._hdrMode === 'soft' ? 1.0 : 0.0;
    this._uHdrMode.value = hdrModeNum;
    this._uPeakNits.value = this._peakNits;
    this._uMinEps.value = this.minEps;
    this._uMaxEps.value = this.maxEps;

    // Peak scale: HDR allows up to 2× peak nits, SDR caps at 20
    this._uPeakScale.value = this._hdrMode !== 'none'
      ? (this._peakNits / SDR_REFERENCE_WHITE_NITS) * 2
      : 20;

    // ── Alive-range optimization: skip dead particles ─────────────
    // Compute the Weibull cutoff duration (age beyond which fade < threshold)
    const k = Math.max(0.01, this.fadeSharpness);
    // Extend cutoff by 3× arrivalSpread to account for non-monotonic bornTimes.
    // arrivalSpread offsets each bornTime by up to ±1.5× spread, so adjacent
    // slots can differ by up to 3× spread. Without this margin the binary
    // search in computeAliveRange lands on random positions each frame,
    // producing visible flicker as chunks of alive particles are clipped.
    const cutoffDuration = tau * Math.pow(-Math.log(FADE_THRESHOLD), 1 / k) * 1.2
      + this.arrivalSpread * 3;
    const { start, count } = this._ringBuf.computeAliveRange(now, cutoffDuration);
    this._uAliveStart.value = start;
    this._uAliveCount.value = count;
    this._uCapacity.value = this._ringBuf.capacity;

    // ── Auto-brightness gain (scalar — no per-particle iteration) ───
    let autoGain = 1;
    if (this.autoBrightness) {
      if (this._hdrMode !== 'none') {
        // Sample alive particles for the actual max eps on screen.
        // Fast-attack / slow-decay smoothing avoids flicker while
        // ensuring the brightest visible particle reaches peak nits.
        const sampledMax = this._ringBuf.sampleMaxEps(start, count);
        if (sampledMax >= this._observedMaxEps) {
          this._observedMaxEps = sampledMax;           // instant jump up
        } else {
          this._observedMaxEps *= 0.97;                // slow decay
          if (this._observedMaxEps < sampledMax) this._observedMaxEps = sampledMax;
        }
        const effectiveMaxEps = Math.max(this.minEps + 1, this._observedMaxEps);

        const sMax = Math.min(1.0, this.saturationFloor + this.saturationRange);
        const maxNits = epsToNits(effectiveMaxEps, this._peakNits, 20, this.minEps, this.maxEps);
        const maxLinear = maxNits / SDR_REFERENCE_WHITE_NITS;
        const maxScale = maxLinear * (this.brightnessMultiplier / SensorRenderer.SDR_BRIGHTNESS_REF);
        const target = this._peakNits / SDR_REFERENCE_WHITE_NITS;
        if (sMax * maxScale > 0.001) {
          autoGain = target / (sMax * maxScale);
        }
      } else {
        const maxBri = Math.min(
          this.brightnessCeil,
          Math.max(this.brightnessFloor, Math.log(this.maxEps + 1) / EPS_LOG_REF),
        );
        const maxL = this.lightnessFloor + maxBri * this.lightnessRange;
        const maxSat = this.saturationFloor + (1 - maxBri) * this.saturationRange;
        const maxC = (1 - Math.abs(2 * maxL - 1)) * maxSat;
        const peakRGB = Math.min(1.0, maxL + maxC * 0.5);

        const refL = this.lightnessFloor + AUTO_BRI_REF * this.lightnessRange;
        const refSat = this.saturationFloor + (1 - AUTO_BRI_REF) * this.saturationRange;
        const refC = (1 - Math.abs(2 * refL - 1)) * refSat;
        const refRGB = Math.min(1.0, refL + refC * 0.5);

        if (peakRGB > 0.001) {
          autoGain = refRGB / peakRGB;
        }
      }
      const sz = Math.max(0.1, this.hitBaseSize);
      autoGain *= Math.pow(AUTO_BRI_SIZE_REF / sz, AUTO_BRI_SIZE_POW);
      autoGain = Math.max(0.05, Math.min(autoGain, 20));
    }
    this._uAutoGain.value = autoGain;

    // Set instanceCount: draw only up to the end of the alive range.
    // When the alive range doesn't wrap, we can skip trailing dead slots.
    const aliveEnd = start + count;
    if (aliveEnd <= this._ringBuf.capacity) {
      // Contiguous alive range — draw [0, aliveEnd), shader culls [0, start)
      this._particleGeometry.instanceCount = aliveEnd;
    } else {
      // Alive range wraps — must draw all active slots
      this._particleGeometry.instanceCount = this._ringBuf.activeCount;
    }

    // ── Pixel-to-world conversion for quad sizing ────────────────────
    const aspect = window.innerWidth / window.innerHeight;
    const baseV = aspect < 1 ? CAMERA_HALF_SIZE / aspect : CAMERA_HALF_SIZE;
    const V_update = baseV / Math.max(this.zoom, 0.01);
    const frustumH = 2 * V_update;
    const renderH = this.renderer.domElement.height;  // backing store px
    this._uPixelToWorld.value = frustumH / renderH;

    // ── Auto-ring-color (sample from ring buffer arrays) ─────────────
    this.effectiveRingColor = this.ringColor;
    const activeN = this._ringBuf.activeCount;
    if (this.ringAutoColor && activeN > 0) {
      let cosSum = 0, sinSum = 0, totalW = 0;
      const sampleStep = Math.max(1, Math.floor(activeN / 5000));
      for (let i = 0; i < activeN; i += sampleStep) {
        const w = this._ringBuf.getBrightness(i);
        const hRad = this._ringBuf.getHue(i) * (Math.PI / 180);
        cosSum += Math.cos(hRad) * w;
        sinSum += Math.sin(hRad) * w;
        totalW += w;
      }
      if (totalW > 0) {
        let avgHue = Math.atan2(sinSum / totalW, cosSum / totalW) * (180 / Math.PI);
        if (avgHue < 0) avgHue += 360;
        const autoC = new THREE.Color();
        autoC.setHSL(avgHue / 360, 0.8, 0.5);
        this.effectiveRingColor = autoC.getHex();
      }
    }

    // ── Push shared visual uniforms ─────────────────────────────────
    if (this._ringMaterial) {
      this._ringMaterial.opacity = this.ringOpacity;
      this._ringMaterial.color.set(this.effectiveRingColor);
    }

    // Ring width: convert CSS pixels → world units
    const viewportH = window.innerHeight;
    const ringFrustumH = (2 * CAMERA_HALF_SIZE) / Math.max(this.zoom, 0.01);
    const ringWidthWorld = Math.max(0.001, this.ringWidthPx * (ringFrustumH / viewportH));
    if (Math.abs(ringWidthWorld - this._lastRingWidthWorld) > 1e-6) {
      this._lastRingWidthWorld = ringWidthWorld;
      const oldGeo = this.diskRing.geometry;
      const newGeo = new THREE.RingGeometry(2.0, 2.0 + ringWidthWorld, RING_SEGMENTS);
      this.diskRing.geometry = newGeo;
      oldGeo.dispose();
    }

    // ── Glow ring (shader-based ring bloom replacement) ──────────────
    if (this._glowRing && this._glowRingMaterial) {
      this._glowRing.visible = this.ringBloomEnabled && this.ringOpacity > 0;
      const ringCol = new THREE.Color(this.effectiveRingColor);
      this._glowRingMaterial.uniforms.uColor.value.copy(ringCol);
      this._glowRingMaterial.uniforms.uOpacity.value = this.ringBloomStrength;
      const glowWidth = this._ringBloomRadiusToGlowWidth(this.ringBloomRadius);
      this._glowRingMaterial.uniforms.uGlowWidth.value = glowWidth;
      // Rebuild glow geometry when width changes significantly
      if (Math.abs(glowWidth - this._lastGlowWidth) > 0.005) {
        this._lastGlowWidth = glowWidth;
        const oldGlowGeo = this._glowRing.geometry;
        const newGlowGeo = new THREE.RingGeometry(
          Math.max(0.01, 2.0 - glowWidth), 2.0 + glowWidth, RING_SEGMENTS,
        );
        this._glowRing.geometry = newGlowGeo;
        oldGlowGeo.dispose();
      }
    }

    this._sizeUniform.value = this.hitBaseSize * this.hitSizeScaleFactor;
    this._roundUniform.value = this.roundParticles ? 1.0 : 0.0;
    this._softEdgeUniform.value = this.particleSoftEdge;
  }

  /** Render one frame (with or without bloom). */
  render(): void {
    if (!this._ready) return;

    // ── Scene-level updates ──────────────────────────────────────────
    this.renderer.setClearColor(this.backgroundColor, 1);

    // Zoom: scale the orthographic frustum inversely (zoom > 1 = magnify)
    // Size disk by the *shorter* axis so it always fits with 5% margin
    const aspect = window.innerWidth / window.innerHeight;
    const baseV = aspect < 1 ? CAMERA_HALF_SIZE / aspect : CAMERA_HALF_SIZE;
    const V = baseV / Math.max(this.zoom, 0.01);
    if (this.camera.left !== -V * aspect || this.camera.top !== V) {
      this.camera.left   = -V * aspect;
      this.camera.right  =  V * aspect;
      this.camera.top    =  V;
      this.camera.bottom = -V;
      this.camera.updateProjectionMatrix();
    }

    // Push soft-HDR exposure each frame so the UI slider takes effect live.
    // Full HDR uses NoToneMapping (exposure irrelevant); SDR uses
    // screen-detected exposure (set in applyScreenInfo, not overridden here).
    if (this._hdrMode === 'soft') {
      this.renderer.toneMappingExposure = this.softHdrExposure;
    }

    // ── Render path selection ────────────────────────────────────────
    // When particle bloom is active AND the pipeline is ready, use the
    // bloom pipeline (scene → bloom blur → composite).
    // When bloom is off, render the scene directly — this skips the
    // expensive render-to-texture + blur passes entirely, which can
    // halve GPU cost at high resolutions and eliminate GPU-overload
    // flicker that occurred when the pipeline ran even with bloom zeroed.
    // Ring glow is handled by the glow mesh (lives in scene), not bloom.
    // HDR works either way — the canvas config preserves values > 1.0.
    const particleBloomActive = this.particleBloomEnabled && this.bloomStrength > 0;

    if (particleBloomActive && this.useBloom && this.pipeline) {
      if (this._bloomNode) {
        this._bloomNode.strength.value  = this.bloomStrength;
        this._bloomNode.radius.value    = 1 - this.bloomRadius;
        this._bloomNode.threshold.value = this.bloomThreshold;
      }
      if (this._particleBloomMul) {
        this._particleBloomMul.value = 1.0;
      }

      try {
        this.pipeline!.render();
      } catch (e) {
        // Pipeline render failed — fall back to direct rendering and
        // disable bloom so subsequent frames don't repeatedly fail.
        console.warn('[sensor] Bloom pipeline render failed, disabling:', e);
        this.useBloom = false;
        this.renderer.render(this.scene, this.camera);
      }
    } else {
      // Bloom off or pipeline not yet compiled — direct scene render
      this.renderer.render(this.scene, this.camera);
    }
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const aspect = w / h;
    const V = CAMERA_HALF_SIZE;
    this.camera.left   = -V * aspect;
    this.camera.right  =  V * aspect;
    this.camera.top    =  V;
    this.camera.bottom = -V;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    try { this.pipeline?.setSize?.(w, h); } catch { /* noop */ }
  }

  dispose(): void {
    // Remove canvas from DOM
    this.renderer.domElement.remove();

    // Dispose GPU pipeline / bloom resources
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (this.pipeline && typeof (this.pipeline as any).dispose === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.pipeline as any).dispose();
    }

    // Dispose ring geometry + material
    this.diskRing?.geometry.dispose();
    this._ringMaterial?.dispose();

    // Dispose glow ring
    this._glowRing?.geometry.dispose();
    this._glowRingMaterial?.dispose();

    // Particle mesh + material
    this._particleGeometry.dispose();
    this.material.dispose();

    // Renderer last (invalidates the GL/WebGPU context)
    this.renderer.dispose();
  }
}
