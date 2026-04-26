import { describe, expect, it } from "vitest";
import controlsSource from "./controls.ts?raw";
import mainSource from "../main.ts?raw";
import rendererSource from "../rendering/renderer.ts?raw";

describe("UI control wiring", () => {
  it("lets override mode preserve negative ranges for signed hue controls", () => {
    expect(controlsSource).toContain("overrideMin?: number");
    expect(controlsSource).toContain('prop: "dbSecondHueShift"');
    expect(controlsSource).toContain('prop: "ppHueShift"');
    expect(controlsSource).toContain("overrideMin: -360");
    expect(controlsSource).toContain("def.overrideMin ?? 0");
  });

  it("wires bloom quality into renderer-side bloom resolution", () => {
    expect(mainSource).toContain("renderer.bloomQuality = params.bloomQuality");
    expect(rendererSource).toContain("private _resolvedBloomQuality()");
    expect(rendererSource).toContain("this.bloomQuality === 'auto' ? this.bloomAutoResolvedQuality : this.bloomQuality");
    expect(rendererSource).toContain("1280 * 720");
    expect(rendererSource).toContain("1920 * 1080");
    expect(rendererSource).toContain("this._syncBloomQuality();");
  });

  it("supports clearing manual peak nits back to detected display values", () => {
    expect(rendererSource).toContain("private _detectedPeakNits: number | null = null");
    expect(rendererSource).toContain("private _manualPeakNits: number | null = null");
    expect(rendererSource).toContain("this._manualPeakNits = nits > 0 ? nits : null");
    expect(rendererSource).toContain("this._detectedPeakNits ?? DEFAULT_HDR_PEAK_NITS");
  });

  it("uses accessible tooltip buttons and lower-specificity bottom-bar classes", () => {
    expect(controlsSource).toContain('tooltipEl.setAttribute("role", "tooltip")');
    expect(controlsSource).toContain('tooltipEl.setAttribute("aria-live", "polite")');
    expect(controlsSource).toContain('document.createElement("button")');
    expect(controlsSource).toContain('infoBtn.type = "button"');
    expect(controlsSource).toContain('infoBtn.setAttribute("aria-expanded", "false")');
    expect(controlsSource).not.toContain('infoBtn.setAttribute("role", "button")');
    expect(controlsSource).toContain('bar.className = "ecsk-bottom-bar"');
    expect(controlsSource).toContain('ecsk-bottom-bar--controls-open');
  });
});