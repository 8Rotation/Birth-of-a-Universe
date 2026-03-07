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
 * To get variable-sized particles we use instanced Sprites with
 * PointsNodeMaterial, which expands a quad per instance in the vertex
 * shader and fully supports sizeNode.
 */

import * as THREE from "three";
import {
  WebGPURenderer,
  RenderPipeline,
  PointsNodeMaterial,
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
  screenUV,
  vec2,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import type { ScreenInfo } from "../ui/screen-info.js";
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

export interface Hit {
  x: number;         // Lambert x  (−2 .. 2)
  y: number;         // Lambert y  (−2 .. 2)
  hue: number;       // 0-360  (w_eff mapping)
  brightness: number; // 0-1   (log-compressed energy density, for SDR)
  eps: number;       // raw energy density at bounce (1/a_min⁴, for HDR)
  size: number;      // 0-1   (bounce kick)
  tailAngle: number; // 0-2π  (unused for now, reserved for flow tails)
  born: number;      // wall-clock second when this hit appeared
}

// ── HSL → RGB ─────────────────────────────────────────────────────────────

function hslToRGB(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r: number, g: number, b: number;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return [r + m, g + m, b + m];
}
// ── Renderer constants ──────────────────────────────────────────────────────

/** Orthographic camera half-extent in world units (disk radius = 2).
 *  Sized so the disk fills 90% of viewport height (5% margin each side). */
const CAMERA_HALF_SIZE = 2.0 / 0.90;
/** Number of line segments for the Lambert disk boundary ring. */
const RING_SEGMENTS = 128;
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

  // Instanced sprite for particle hits (replaces THREE.Points which is
  // limited to 1px in WebGPU).
  private sprite!: THREE.Sprite;
  private posAttr!: THREE.InstancedBufferAttribute;
  private colorAttr!: THREE.InstancedBufferAttribute;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private material!: any; // PointsNodeMaterial
  private diskRing!: THREE.Mesh;
  private _ringMaterial!: THREE.MeshBasicMaterial;
  private _ringScene!: THREE.Scene;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _ringBloomNode: any = null;

  // TSL uniforms for ring bloom inward-mask (frustum extents in world units)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _frustumHalfW: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _frustumHalfH: any = null;

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

  private pipeline: RenderPipeline | null = null;
  useBloom = true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _bloomNode: any = null;

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
    const aspect = window.innerWidth / window.innerHeight;
    const V = CAMERA_HALF_SIZE;
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

    // Update camera aspect
    const aspect = info.viewportWidth / info.viewportHeight;
    const V = CAMERA_HALF_SIZE;
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

    // ── Instanced sprite for particle hits ────────────────────────────
    // WebGPU point primitives are always 1px.  PointsNodeMaterial on a
    // Sprite expands a screen-aligned quad per instance, honouring
    // sizeNode for arbitrary pixel sizes.

    const positions = new Float32Array(this._capacity * 3);
    const colors    = new Float32Array(this._capacity * 3);

    this.posAttr = new THREE.InstancedBufferAttribute(positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);

    this.colorAttr = new THREE.InstancedBufferAttribute(colors, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);

    // TSL uniforms (reactive every frame)
    this._sizeUniform = uniform(this.hitBaseSize);
    this._roundUniform = uniform(1.0);
    this._softEdgeUniform = uniform(this.particleSoftEdge);

    this.material = new PointsNodeMaterial({
      sizeAttenuation: false,  // pixel-sized (orthographic)
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    // Wire instanced attributes through TSL nodes
    this.material.positionNode = instancedDynamicBufferAttribute(this.posAttr, "vec3");
    this.material.colorNode    = instancedDynamicBufferAttribute(this.colorAttr, "vec3");
    this.material.sizeNode     = this._sizeUniform;

    // ── Circular particle clipping (toggleable via _roundUniform) ─────
    // The sprite quad has UV (0,0)→(1,1).  When round=1, discard fragments
    // outside a soft circle; when round=0, all fragments pass (square).
    // Uses mix() so the shader is compiled once — switching is just a
    // uniform change, zero recompilation cost.
    const roundU = this._roundUniform;
    const softEdgeU = this._softEdgeUniform;
    const circleOpacity = Fn(() => {
      const coord = uv().sub(float(0.5));        // centre at origin
      const dist  = length(coord);                // distance from centre
      // Soft edge: fully opaque inside r=(OUTER_R - softEdge), fades to 0 at r=OUTER_R
      const innerR = float(CIRCLE_OUTER_R).sub(softEdgeU);
      const circle = smoothstep(float(CIRCLE_OUTER_R), innerR, dist);
      // mix(1.0, circle, round): square when round=0, circle when round=1
      return mix(float(1.0), circle, roundU);
    });
    this.material.opacityNode = circleOpacity();
    this.material.alphaTest = 0.01;

    this.sprite = new THREE.Sprite(this.material);
    this.sprite.count = 0;  // no visible instances yet
    this.sprite.frustumCulled = false;
    this.scene.add(this.sprite);

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

    // ── Separate ring scene for independent ring bloom ───────────────
    // The ring lives in its own scene so it gets its own bloom pass,
    // completely independent of particle bloom settings.
    this._ringScene = new THREE.Scene();
    this._ringScene.add(this.diskRing);

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
   * Compile the two-pass bloom pipeline in the background.
   * Called from init() without await so the first frame renders immediately
   * via the lightweight no-bloom path. Once compilation succeeds,
   * `this.useBloom` is set to true and subsequent frames use bloom.
   */
  private _initBloom(): void {
    // ── Two-pass bloom pipeline ───────────────────────────────────────
    // Pass 1: particles (main scene) + particle bloom
    // Pass 2: ring scene + ring bloom
    // Final composite: pass1Color + pass1Bloom + pass2Color + pass2Bloom
    try {
      this.pipeline = new RenderPipeline(this.renderer);

      // Particle pass + particle bloom
      const scenePass = pass(this.scene, this.camera);
      const scenePassColor = scenePass.getTextureNode("output");
      const particleBloom = bloom(
        scenePassColor,
        this.bloomStrength,
        this.bloomRadius,
        this.bloomThreshold,
      );
      this._bloomNode = particleBloom;

      // Ring pass + ring bloom
      const ringPass = pass(this._ringScene, this.camera);
      const ringPassColor = ringPass.getTextureNode("output");
      const ringBloom = bloom(
        ringPassColor,
        this.ringBloomStrength,
        this.ringBloomRadius,
        0.0,
      );
      this._ringBloomNode = ringBloom;

      // ── Bloom quality: patch setSize for resolution scaling ─────────
      // BloomNode.updateBefore calls setSize(drawWidth, drawHeight) every
      // frame. Intercepting it lets us halve the bloom resolution for
      // 'low' quality (~4x fewer pixels) without recreating the pipeline.
      const renderer = this;
      for (const node of [particleBloom, ringBloom]) {
        const origSetSize = node.setSize.bind(node);
        node.setSize = (w: number, h: number) => {
          const q = renderer.bloomQuality === 'auto'
            ? renderer.bloomAutoResolvedQuality
            : renderer.bloomQuality;
          if (q === 'low') {
            origSetSize(Math.round(w / 2), Math.round(h / 2));
          } else {
            origSetSize(w, h);
          }
        };
      }

      // ── Outward-only ring bloom mask ─────────────────────────────────
      // Map screen UV → world-space distance from disk centre.
      // Zero the ring bloom for any pixel whose world distance < ring
      // inner radius (2.0) so glow only extends outward.
      const initAspect = window.innerWidth / window.innerHeight;
      this._frustumHalfW = uniform(CAMERA_HALF_SIZE * initAspect);
      this._frustumHalfH = uniform(CAMERA_HALF_SIZE);

      const centreUV = screenUV.sub(vec2(0.5, 0.5));
      const worldX   = centreUV.x.mul(float(2.0)).mul(this._frustumHalfW);
      const worldY   = centreUV.y.mul(float(2.0)).mul(this._frustumHalfH);
      const worldDist = length(vec2(worldX, worldY));
      // smoothstep: 0 inside ring, ramps to 1 across a thin band at the edge
      const ringMask  = smoothstep(float(1.95), float(2.05), worldDist);
      const maskedRingBloom = ringBloom.mul(ringMask);

      // Composite: particles + particle bloom + ring + ring bloom (outward only)
      this.pipeline.outputNode = scenePassColor
        .add(particleBloom)
        .add(ringPassColor)
        .add(maskedRingBloom);

      this.useBloom = true;
      console.log("[sensor] Two-pass bloom enabled (particles + ring)");
    } catch (e) {
      // Fallback: add ring to main scene, no separate bloom
      console.warn("[sensor] Two-pass bloom failed, falling back:", e);
      this.scene.add(this.diskRing);
      this.useBloom = false;
    }
  }

  /**
   * Write visible hits into the GPU buffers for rendering.
   * Automatically grows the GPU buffer (doubling) if hits.length exceeds
   * current capacity — no fixed upper limit.
   */
  updateHits(hits: Hit[], count: number, now: number, persistence: number): void {
    if (!this._ready) return;

    const n = count;

    // Grow GPU buffers if needed (doubles capacity each time)
    if (n > this._capacity) {
      this._growBuffers(n);
    }

    const pos = this.posAttr.array as Float32Array;
    const col = this.colorAttr.array as Float32Array;

    // ── Auto-brightness: physics-based ceiling + size correction ─────
    // Deterministic — no EMA, no flicker.  Computes the theoretical peak
    // RGB channel for the brightest *possible* particle at the current
    // physics settings (maxEps, fade = 1) and normalises against a fixed
    // reference level.  A size-overlap correction dampens large-particle
    // whiteout (additive blending area ∝ size²) while boosting small-
    // particle visibility.
    let autoGain = 1;
    if (this.autoBrightness) {
      if (this._hdrMode !== 'none') {
        // HDR: base color is at fixed L=0.5 — peak channel ≈ satMax.
        // Normalise so the brightest possible particle fills the display
        // HDR range (peak nits).  All chroma is preserved; brightness
        // differentiation comes entirely from the eps→nits RGB scale.
        const sMax = Math.min(1.0, this.saturationFloor + this.saturationRange);
        const maxNits = epsToNits(this.maxEps, this._peakNits, 20, this.minEps, this.maxEps);
        const maxLinear = maxNits / SDR_REFERENCE_WHITE_NITS;
        const maxScale = maxLinear * (this.brightnessMultiplier / SensorRenderer.SDR_BRIGHTNESS_REF);
        const target = this._peakNits / SDR_REFERENCE_WHITE_NITS;
        if (sMax * maxScale > 0.001) {
          autoGain = target / (sMax * maxScale);
        }
      } else {
        // SDR: brightness baked into HSL — normalise against theoretical
        // peak lightness/saturation so ACES keeps colours visible.
        const maxBri = Math.min(
          this.brightnessCeil,
          Math.max(this.brightnessFloor, Math.log(this.maxEps + 1) / EPS_LOG_REF),
        );
        const maxL   = this.lightnessFloor + maxBri * this.lightnessRange;
        const maxSat = this.saturationFloor + (1 - maxBri) * this.saturationRange;
        const maxC   = (1 - Math.abs(2 * maxL - 1)) * maxSat;
        const peakRGB = Math.min(1.0, maxL + maxC * 0.5);

        const refL   = this.lightnessFloor + AUTO_BRI_REF * this.lightnessRange;
        const refSat = this.saturationFloor + (1 - AUTO_BRI_REF) * this.saturationRange;
        const refC   = (1 - Math.abs(2 * refL - 1)) * refSat;
        const refRGB = Math.min(1.0, refL + refC * 0.5);

        if (peakRGB > 0.001) {
          autoGain = refRGB / peakRGB;
        }
      }

      // Size-overlap correction: larger particles overlap more under
      // additive blending.  √(ref / size) dampens large sizes and
      // boosts small sizes so bright dots stay vivid without whiteout.
      const sz = Math.max(0.1, this.hitBaseSize);
      autoGain *= Math.pow(AUTO_BRI_SIZE_REF / sz, AUTO_BRI_SIZE_POW);

      // Clamp to sane range
      autoGain = Math.max(0.05, Math.min(autoGain, 20));
    }

    // ── HDR base-color: fixed L=0.5 + max saturation for full chroma ──
    // Pre-compute outside the loop for efficiency.
    const hdrSatMax = Math.min(1.0, this.saturationFloor + this.saturationRange);

    for (let i = 0; i < n; i++) {
      const hit = hits[i];
      const j3 = i * 3;

      // Position on the Lambert disk (z = 0)
      pos[j3]     = hit.x;
      pos[j3 + 1] = hit.y;
      pos[j3 + 2] = 0;

      // Compute fade alpha from age.
      // Future particles (born > now, age < 0) are clamped to age = 0 so
      // they appear at full brightness until their bounce moment arrives,
      // then fade normally.  These represent not-yet-bounced regions of S²
      // approaching peak density — physically correct to show as bright.
      const age = Math.max(0, now - hit.born);
      // Weibull stretched exponential: sharpness controls curve *shape*
      // independently of persistence (time scale).
      //   k=1: standard exponential (gradual tail)
      //   k>1: stays bright then drops sharply (Gaussian-like at k=2)
      //   k<1: fast initial dim, very long tail
      const fade = Math.exp(-Math.pow(age / persistence, this.fadeSharpness));

      // HSL → RGB with physics encoding.
      //
      // SDR: brightness drives lightness AND saturation (tunable ranges).
      //      ACES compresses the result to display range.
      // HDR: fixed L=0.5 and max saturation preserves full chroma at all
      //      energy levels.  A bright blue stays blue — all brightness
      //      differentiation comes from the eps→nits RGB scale below.
      let r: number, g: number, b: number;
      if (this._hdrMode !== 'none') {
        [r, g, b] = hslToRGB(hit.hue, hdrSatMax, 0.5);
      } else {
        const lightness = this.lightnessFloor + hit.brightness * this.lightnessRange;
        const saturation = this.saturationFloor + (1 - hit.brightness) * this.saturationRange;
        [r, g, b] = hslToRGB(hit.hue, saturation, lightness);
      }

      // ── Brightness scaling ───────────────────────────────────────────
      // Same structure (fade × scale × multiplier), different scale.
      //
      // SDR:  scale = brightnessMultiplier (user controls perceived brightness;
      //        brightness [0–1] is already baked into HSL lightness;
      //        ACES compresses the result)
      // HDR:  scale = epsToNits(eps, peakNits, minNits, epsDim, epsBright) / SDR_WHITE
      //        Uses dynamic eps bounds from the physics so the full display
      //        range is utilised at any β setting.
      //
      // In HDR the eps→nits mapping is LINEAR, so particles whose physics
      // energy density is 2× will appear 2× as bright on the display.
      let scale: number;
      if (this._hdrMode !== 'none') {
        const nits = epsToNits(hit.eps, this._peakNits, 20, this.minEps, this.maxEps);
        const linearRelSDR = nits / SDR_REFERENCE_WHITE_NITS;
        scale = fade * linearRelSDR
              * (this.brightnessMultiplier / SensorRenderer.SDR_BRIGHTNESS_REF);
      } else {
        scale = fade * this.brightnessMultiplier;
      }

      // Track pre-gain maximum (no longer used for EMA — kept for debug)
      // if (scale > maxScale) maxScale = scale;

      // Apply auto-exposure gain
      if (this.autoBrightness) scale *= autoGain;

      // Peak brightness limiter: clamp per-particle scale to prevent
      // blow-out in HDR and precision issues in SDR.
      // HDR: display can't show more than peak nits (allow 2× for bloom headroom).
      // SDR: ACES compresses but extreme values cause banding.
      const peakScale = this._hdrMode !== 'none'
        ? (this._peakNits / SDR_REFERENCE_WHITE_NITS) * 2
        : 20;
      if (scale > peakScale) scale = peakScale;

      col[j3]     = r * scale;
      col[j3 + 1] = g * scale;
      col[j3 + 2] = b * scale;
    }

    this.posAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.sprite.count = n;

    // ── Auto-color: brightness-weighted circular mean of particle hues ──
    this.effectiveRingColor = this.ringColor;
    if (this.ringAutoColor && n > 0) {
      let cosSum = 0, sinSum = 0, totalW = 0;
      const step = Math.max(1, Math.floor(n / 5000));  // sample ≤5K for perf
      for (let i = 0; i < n; i += step) {
        const w = hits[i].brightness;
        const hRad = hits[i].hue * (Math.PI / 180);
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

    // Push current values into TSL uniforms (WebGPU-reactive)
    // Apply screen-density scaling so particles stay proportional across displays
    // Update ring colour + opacity
    if (this._ringMaterial) {
      this._ringMaterial.opacity = this.ringOpacity;
      this._ringMaterial.color.set(this.effectiveRingColor);
    }

    // ── Ring width: convert CSS pixels → world units ─────────────────
    // world_width = ringWidthPx × (2 × CAMERA_HALF_SIZE / zoom) / viewportHeight
    const viewportH = window.innerHeight;
    const frustumH = (2 * CAMERA_HALF_SIZE) / Math.max(this.zoom, 0.01);
    const ringWidthWorld = Math.max(0.001, this.ringWidthPx * (frustumH / viewportH));
    if (Math.abs(ringWidthWorld - this._lastRingWidthWorld) > 1e-6) {
      this._lastRingWidthWorld = ringWidthWorld;
      // Rebuild ring geometry (inner edge flush at r=2.0, grows outward only)
      const oldGeo = this.diskRing.geometry;
      this.diskRing.geometry = new THREE.RingGeometry(2.0, 2.0 + ringWidthWorld, RING_SEGMENTS);
      oldGeo.dispose();
    }

    this._sizeUniform.value = this.hitBaseSize * this.hitSizeScaleFactor;
    this._roundUniform.value = this.roundParticles ? 1.0 : 0.0;
    this._softEdgeUniform.value = this.particleSoftEdge;
  }

  /**
   * Grow GPU position + color buffers to accommodate at least `needed` hits.
   * Doubles capacity repeatedly until sufficient, then replaces the
   * backing typed arrays on the existing InstancedBufferAttributes.
   *
   * CRITICAL: We must NOT recreate the attribute objects or TSL nodes,
   * and must NOT set material.needsUpdate.  Doing so triggers a WebGPU
   * shader recompilation that causes a blank frame (flicker).  Instead,
   * replacing the .array property on the existing attributes lets the
   * WebGPU backend detect the size change and reallocate the GPU buffer
   * transparently during the next needsUpdate upload — no shader rebuild.
   */
  private _growBuffers(needed: number): void {
    while (this._capacity < needed) this._capacity *= 2;

    // Replace backing arrays in-place — same attribute objects, same TSL
    // nodes, no material.needsUpdate, no shader recompile.
    // The read-only `count` getter (array.length / itemSize) auto-updates.
    this.posAttr.array = new Float32Array(this._capacity * 3);
    this.posAttr.needsUpdate = true;

    this.colorAttr.array = new Float32Array(this._capacity * 3);
    this.colorAttr.needsUpdate = true;

    console.log(`[sensor] GPU buffer grown → ${this._capacity} hits (${(this._capacity * 24 / 1024 / 1024).toFixed(1)} MB)`);
  }

  /** Render one frame (with or without bloom). */
  render(): void {
    if (!this._ready) return;

    // ── Scene-level updates ──────────────────────────────────────────
    this.renderer.setClearColor(this.backgroundColor, 1);

    // Zoom: scale the orthographic frustum inversely (zoom > 1 = magnify)
    const aspect = window.innerWidth / window.innerHeight;
    const V = CAMERA_HALF_SIZE / Math.max(this.zoom, 0.01);
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

    // Push latest UI values into BloomNode's own internal uniform nodes.
    //
    // NOTE: BloomNode's "radius" controls mip weight distribution, not spread
    // distance directly.  At radius=0 the fine (tight) mips dominate, which
    // seats the bloom halo on top of the particle and reads as blur.
    // At radius=1 the coarse mips dominate, spreading the glow outward.
    // This is the opposite of user-intuition ("0 = sharp, 1 = wide"), so we
    // invert the value before passing it through.
    if (this._bloomNode) {
      this._bloomNode.strength.value  = this.bloomStrength;
      this._bloomNode.radius.value    = 1 - this.bloomRadius;   // inverted ↔ intuitive
      this._bloomNode.threshold.value = this.bloomThreshold;
    }

    // Push ring bloom uniforms (same inversion convention for radius)
    if (this._ringBloomNode) {
      this._ringBloomNode.strength.value  = this.ringBloomStrength;
      this._ringBloomNode.radius.value    = 1 - this.ringBloomRadius;
    }

    // Keep ring-bloom mask in sync with current zoom / aspect
    if (this._frustumHalfW && this._frustumHalfH) {
      const aspect = window.innerWidth / window.innerHeight;
      this._frustumHalfW.value = V * aspect;
      this._frustumHalfH.value = V;
    }

    // ── Render path selection ────────────────────────────────────────
    // When bloom is enabled and the pipeline is available, use the full
    // multi-pass bloom pipeline.  Otherwise fall back to a lightweight
    // two-pass render (particles + ring scene) with no bloom.
    // Skip bloom entirely when there are no visible particles — the
    // full-screen gaussian blur passes would just process black textures.
    // Also skip when both bloom strengths are zero — the blur produces
    // no visible output so the multi-pass pipeline is pure waste.
    const needsBloom = this.useBloom && this.pipeline
      && this.sprite.count > 0
      && (this.bloomStrength > 0 || this.ringBloomStrength > 0);
    if (needsBloom) {
      try {
        this.pipeline!.render();
      } catch (e) {
        console.warn("[sensor] Sync render failed, trying async:", e);
        this.pipeline!.renderAsync().catch((e2: unknown) => {
          console.error("[sensor] Both render paths failed:", e2);
        });
      }
    } else {
      // Lightweight no-bloom path: render particles, then overlay ring
      const r = this.renderer as any;
      r.autoClear = true;
      this.renderer.render(this.scene, this.camera);
      // Overlay the ring scene on top (additive, no clear)
      if (this._ringScene && this.ringOpacity > 0) {
        r.autoClear = false;
        this.renderer.render(this._ringScene, this.camera);
        r.autoClear = true;
      }
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

    // Sprite + material
    this.sprite.geometry.dispose();
    this.material.dispose();

    // Release large backing buffers
    this.posAttr.array = new Float32Array(0);
    this.colorAttr.array = new Float32Array(0);

    // Renderer last (invalidates the GL/WebGPU context)
    this.renderer.dispose();
  }
}
