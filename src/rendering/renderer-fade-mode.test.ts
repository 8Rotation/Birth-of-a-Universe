import { describe, expect, it } from "vitest";
import rendererSource from "./renderer.ts?raw";
import controlsSource from "../ui/controls.ts?raw";
import tooltipSource from "../ui/tooltips.ts?raw";

describe("particle fade modes", () => {
  it("keeps transparent fade additive and makes background fade source-over", () => {
    expect(rendererSource).toContain("this.fadeToBackground ? THREE.NormalBlending : THREE.AdditiveBlending");
    expect(rendererSource).toContain("const backgroundFadeRgb = mix(uBackgroundColor, litRgb, fade)");
    expect(rendererSource).toContain("const alphaFade = mix(fade, float(1.0), uFadeToBackground)");
  });

  it("defaults the UI to transparent fade and names the opt-in background mode", () => {
    expect(controlsSource).toContain("fadeToBackground: false");
    expect(controlsSource).toContain('.name("Fade to background")');
    expect(tooltipSource).toContain("Off (default): Particles fade out through alpha");
  });
});

describe("SDR color mapping", () => {
  it("keeps brightness out of HSL lightness so SDR highlights stay chromatic", () => {
    expect(rendererSource).toContain("const sdrIntensity = uLFloor.add(aBrightness.mul(uLRange));");
    expect(rendererSource).toContain("const sdrSaturation = min(float(1.0), uSFloor.add(aBrightness.mul(uSRange)));");
    expect(rendererSource).toContain("const sdrRgb = tslHslToRgb(aHue, sdrSaturation, float(0.5));");
    expect(rendererSource).not.toContain("aBrightness.oneMinus().mul(uSRange)");
  });
});

describe("HDR auto-brightness", () => {
  it("uses the deterministic physics ceiling instead of sampling CPU-side particle data", () => {
    expect(rendererSource).toContain("const effectiveMaxEps = Math.max(this.minEps + 1, this.maxEps);");
    expect(rendererSource).not.toContain("sampleMaxEps(start, count)");
    expect(rendererSource).not.toContain("_observedMaxEps");
  });
});

describe("ring glow", () => {
  it("uses a WebGPU-compatible NodeMaterial instead of ShaderMaterial", () => {
    expect(rendererSource).toContain("const glowMat = new NodeMaterial");
    expect(rendererSource).not.toContain("new THREE.ShaderMaterial");
    expect(rendererSource).toContain("glowMat.opacityNode = glowAlpha");
  });
});

describe("renderer disposal", () => {
  it("disposes bloom and scene pass resources exactly through the owned handles", () => {
    expect(rendererSource).toContain("private _bloomPass");
    expect(rendererSource).toContain("private _scenePass");
    expect(rendererSource).toContain("this._bloomPass?.dispose?.()");
    expect(rendererSource).toContain("this._scenePass?.dispose?.()");
    expect(rendererSource).toContain("if (this._disposed) return;");
  });
});

describe("ring buffer growth", () => {
  it("rebinds particle geometry after packed attribute capacity changes", () => {
    expect(rendererSource).toContain("private _ringBufferResizeVersion");
    expect(rendererSource).toContain("this._syncParticleGeometryCapacity();");
    expect(rendererSource).toContain("oldGeometry.dispose();");
    expect(rendererSource).toContain("this.particleMesh.geometry = nextGeometry");
  });
});
