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
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import type { ScreenInfo } from "../ui/screen-info.js";
import { recommendedPixelRatioCap, hitSizeScale, recommendedExposure } from "../ui/screen-info.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface SensorRendererConfig {
  initialCapacity?: number;  // initial GPU buffer size; doubles automatically as needed
  bloomStrength?: number;
  bloomRadius?: number;
  bloomThreshold?: number;
}

export interface Hit {
  x: number;         // Lambert x  (−2 .. 2)
  y: number;         // Lambert y  (−2 .. 2)
  hue: number;       // 0-360  (w_eff mapping)
  brightness: number; // 0-1   (energy density)
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
  private diskRing!: THREE.LineLoop;

  // TSL uniform for hit size — drives sizeNode on the material so the
  // slider value propagates to the GPU every frame.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _sizeUniform!: any;
  // TSL uniform: 1.0 = round particles, 0.0 = square
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _roundUniform!: any;

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

  /** Current hit-size scale factor derived from screen density. */
  hitSizeScaleFactor = 1.0;
  /** Current pixel ratio cap from screen detection. */
  private _pixelRatioCap = 2;

  constructor(config: SensorRendererConfig) {
    this._capacity = config.initialCapacity ?? 65_536;
    this.bloomStrength = config.bloomStrength ?? 1.2;
    this.bloomRadius = config.bloomRadius ?? 0.3;
    this.bloomThreshold = config.bloomThreshold ?? 0.05;

    // ── WebGPU renderer ───────────────────────────────────────────────
    this.renderer = new WebGPURenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    document.body.appendChild(this.renderer.domElement);

    // ── Scene ─────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();

    // ── Orthographic camera (fits Lambert disk with padding) ──────────
    const aspect = window.innerWidth / window.innerHeight;
    const V = 2.5; // half-size in world units (disk radius = 2)
    this.camera = new THREE.OrthographicCamera(
      -V * aspect, V * aspect,
      V, -V,
      -1, 100,
    );
    this.camera.position.set(0, 0, 10);
    this.camera.lookAt(0, 0, 0);

    window.addEventListener("resize", () => this.onResize());
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

    // Adjust tone mapping exposure for HDR displays
    this.renderer.toneMappingExposure = recommendedExposure(info);

    // Update camera aspect
    const aspect = info.viewportWidth / info.viewportHeight;
    const V = 2.5;
    this.camera.left   = -V * aspect;
    this.camera.right  =  V * aspect;
    this.camera.top    =  V;
    this.camera.bottom = -V;
    this.camera.updateProjectionMatrix();
    try { this.pipeline?.setSize?.(info.viewportWidth, info.viewportHeight); } catch { /* noop */ }

    console.log(
      `[sensor] Screen adapted: DPR ${effectiveDpr.toFixed(2)} (cap ${this._pixelRatioCap}), ` +
      `hitScale ${this.hitSizeScaleFactor.toFixed(2)}, render ${info.renderWidth}×${info.renderHeight}` +
      `${info.hdrCapable ? `, HDR/${info.colorGamut} exposure=${this.renderer.toneMappingExposure}` : ", SDR"}`
    );
  }

  get ready(): boolean {
    return this._ready;
  }

  /** Initialize WebGPU and build the scene. */
  async init(): Promise<void> {
    console.log("[sensor] Initializing WebGPU...");
    await this.renderer.init();
    console.log("[sensor] WebGPU ready");

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
    const circleOpacity = Fn(() => {
      const coord = uv().sub(float(0.5));        // centre at origin
      const dist  = length(coord);                // distance from centre
      // Soft edge: fully opaque inside r=0.45, fades to 0 at r=0.50
      const circle = smoothstep(float(0.50), float(0.45), dist);
      // mix(1.0, circle, round): square when round=0, circle when round=1
      return mix(float(1.0), circle, roundU);
    });
    this.material.opacityNode = circleOpacity();
    this.material.alphaTest = 0.01;

    this.sprite = new THREE.Sprite(this.material);
    this.sprite.count = 0;  // no visible instances yet
    this.sprite.frustumCulled = false;
    this.scene.add(this.sprite);

    // ── Lambert disk boundary ring ────────────────────────────────────
    const ringGeo = new THREE.BufferGeometry();
    const ringPts: number[] = [];
    const SEGS = 128;
    for (let i = 0; i <= SEGS; i++) {
      const a = (i / SEGS) * Math.PI * 2;
      ringPts.push(2 * Math.cos(a), 2 * Math.sin(a), 0);
    }
    ringGeo.setAttribute("position", new THREE.Float32BufferAttribute(ringPts, 3));
    this.diskRing = new THREE.LineLoop(
      ringGeo,
      new THREE.LineBasicMaterial({
        color: 0x502008,
        transparent: true,
        opacity: 0.3,
      }),
    );
    this.scene.add(this.diskRing);

    // ── Bloom post-processing ─────────────────────────────────────────
    try {
      this.pipeline = new RenderPipeline(this.renderer);
      const scenePass = pass(this.scene, this.camera);
      const scenePassColor = scenePass.getTextureNode("output");

      // BloomNode internally wraps each of these as uniform() nodes, so
      // we pass plain numbers here and drive changes via _bloomNode.*.
      const bloomPass = bloom(
        scenePassColor,
        this.bloomStrength,
        this.bloomRadius,
        this.bloomThreshold,
      );
      // Keep a reference so render() can push slider values each frame.
      this._bloomNode = bloomPass;
      this.pipeline.outputNode = scenePassColor.add(bloomPass);
      this.useBloom = true;
      console.log("[sensor] Bloom enabled");
    } catch (e) {
      console.warn("[sensor] Bloom failed, falling back:", e);
      this.useBloom = false;
    }

    this._ready = true;
    console.log(`[sensor] Ready — initial GPU buffer ${this._capacity} hits (grows as needed)`);
  }

  /**
   * Write visible hits into the GPU buffers for rendering.
   * Automatically grows the GPU buffer (doubling) if hits.length exceeds
   * current capacity — no fixed upper limit.
   */
  updateHits(hits: Hit[], now: number, persistence: number): void {
    if (!this._ready) return;

    const n = hits.length;

    // Grow GPU buffers if needed (doubles capacity each time)
    if (n > this._capacity) {
      this._growBuffers(n);
    }

    const pos = this.posAttr.array as Float32Array;
    const col = this.colorAttr.array as Float32Array;

    for (let i = 0; i < n; i++) {
      const hit = hits[i];
      const j3 = i * 3;

      // Position on the Lambert disk (z = 0)
      pos[j3]     = hit.x;
      pos[j3 + 1] = hit.y;
      pos[j3 + 2] = 0;

      // Compute fade alpha from age
      const age = now - hit.born;
      const fade = Math.exp((-age / persistence) * 3);

      // HSL → RGB with physics encoding.
      // brightness drives lightness [0.20 → 0.85] and saturation — not alpha.
      // Alpha is purely fade × user brightness multiplier so brightness is
      // applied exactly once (preventing channel saturation at mid-range β).
      const lightness = 0.20 + hit.brightness * 0.65;
      const saturation = 0.70 + (1 - hit.brightness) * 0.25;
      const [r, g, b] = hslToRGB(hit.hue, saturation, lightness);

      const alpha = fade * this.brightnessMultiplier;
      col[j3]     = r * alpha;
      col[j3 + 1] = g * alpha;
      col[j3 + 2] = b * alpha;
    }

    this.posAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.sprite.count = n;

    // Push current values into TSL uniforms (WebGPU-reactive)
    // Apply screen-density scaling so particles stay proportional across displays
    this._sizeUniform.value = this.hitBaseSize * this.hitSizeScaleFactor;
    this._roundUniform.value = this.roundParticles ? 1.0 : 0.0;
  }

  /**
   * Grow GPU position + color buffers to accommodate at least `needed` hits.
   * Doubles capacity repeatedly until sufficient, then replaces the
   * InstancedBufferAttributes and re-wires the TSL nodes on the material.
   */
  private _growBuffers(needed: number): void {
    while (this._capacity < needed) this._capacity *= 2;

    this.posAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(this._capacity * 3), 3,
    );
    this.posAttr.setUsage(THREE.DynamicDrawUsage);

    this.colorAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(this._capacity * 3), 3,
    );
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);

    // Re-wire TSL instanced-attribute nodes to point at the new buffers
    this.material.positionNode = instancedDynamicBufferAttribute(this.posAttr, "vec3");
    this.material.colorNode    = instancedDynamicBufferAttribute(this.colorAttr, "vec3");
    this.material.needsUpdate  = true;

    console.log(`[sensor] GPU buffer grown → ${this._capacity} hits (${(this._capacity * 24 / 1024 / 1024).toFixed(1)} MB)`);
  }

  /** Render one frame (with or without bloom). */
  render(): void {
    if (!this._ready) return;

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

    if (this.useBloom && this.pipeline) {
      try {
        this.pipeline.render();
      } catch {
        this.pipeline.renderAsync();
      }
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const aspect = w / h;
    const V = 2.5;
    this.camera.left   = -V * aspect;
    this.camera.right  =  V * aspect;
    this.camera.top    =  V;
    this.camera.bottom = -V;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    try { this.pipeline?.setSize?.(w, h); } catch { /* noop */ }
  }

  dispose(): void {
    this.renderer.dispose();
    this.sprite.geometry.dispose();
    this.material.dispose();
  }
}
