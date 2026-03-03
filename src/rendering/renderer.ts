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
 */

import * as THREE from "three";
import { WebGPURenderer, RenderPipeline } from "three/webgpu";
import { pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface SensorRendererConfig {
  maxHits: number;
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

  private points!: THREE.Points;
  private posAttr!: THREE.BufferAttribute;
  private colorAttr!: THREE.BufferAttribute;
  private material!: THREE.PointsMaterial;
  private diskRing!: THREE.LineLoop;

  private pipeline: RenderPipeline | null = null;
  private useBloom = true;

  private readonly maxHits: number;
  private _ready = false;

  // ── Tunable parameters (set from controls each frame) ─────────────
  hitBaseSize = 3.0;
  brightnessMultiplier = 2.0;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;

  constructor(config: SensorRendererConfig) {
    this.maxHits = config.maxHits;
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

  get ready(): boolean {
    return this._ready;
  }

  /** Initialize WebGPU and build the scene. */
  async init(): Promise<void> {
    console.log("[sensor] Initializing WebGPU...");
    await this.renderer.init();
    console.log("[sensor] WebGPU ready");

    // ── Point cloud for hits ──────────────────────────────────────────
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(this.maxHits * 3);
    const colors = new Float32Array(this.maxHits * 3);

    this.posAttr = new THREE.BufferAttribute(positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);

    this.colorAttr = new THREE.BufferAttribute(colors, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("color", this.colorAttr);

    this.material = new THREE.PointsMaterial({
      size: this.hitBaseSize,
      vertexColors: true,
      sizeAttenuation: false, // pixel-sized (orthographic)
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    geo.setDrawRange(0, 0);

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
      const bloomPass = bloom(
        scenePassColor,
        this.bloomStrength,
        this.bloomRadius,
        this.bloomThreshold,
      );
      this.pipeline.outputNode = scenePassColor.add(bloomPass);
      this.useBloom = true;
      console.log("[sensor] Bloom enabled");
    } catch (e) {
      console.warn("[sensor] Bloom failed, falling back:", e);
      this.useBloom = false;
    }

    this._ready = true;
    console.log(`[sensor] Ready — max ${this.maxHits} hits`);
  }

  /**
   * Write visible hits into the GPU buffers for rendering.
   *
   * @param hits  Currently alive hits
   * @param now   Wall-clock seconds (performance.now() / 1000)
   * @param persistence  Fade time constant in seconds
   */
  updateHits(hits: Hit[], now: number, persistence: number): void {
    if (!this._ready) return;

    const pos = this.posAttr.array as Float32Array;
    const col = this.colorAttr.array as Float32Array;
    const n = Math.min(hits.length, this.maxHits);

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

      // HSL → RGB with physics encoding
      const lightness = Math.min(0.85, 0.35 + hit.brightness * 0.35);
      const saturation = 0.75 + (1 - hit.brightness) * 0.2;
      const [r, g, b] = hslToRGB(hit.hue, saturation, lightness);

      // Premultiply by fade × brightness × user brightness
      const alpha = fade * hit.brightness * this.brightnessMultiplier;
      col[j3]     = r * alpha;
      col[j3 + 1] = g * alpha;
      col[j3 + 2] = b * alpha;
    }

    this.posAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.points.geometry.setDrawRange(0, n);
    this.material.size = this.hitBaseSize;
  }

  /** Render one frame (with or without bloom). */
  render(): void {
    if (!this._ready) return;
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
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
