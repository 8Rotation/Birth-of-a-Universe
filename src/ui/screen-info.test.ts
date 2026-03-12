import { describe, expect, it } from "vitest";

import { hitSizeScale, resolveMeasuredRefreshRate, resolveNativeRefreshRate, resolveScreenMetrics } from "./screen-info.js";

describe("resolveNativeRefreshRate", () => {
  it("prefers current screen refresh over generic window.screen refresh", () => {
    const result = resolveNativeRefreshRate(
      { refreshRate: 60 },
      { refreshRate: 120 },
    );

    expect(result).toEqual({ rate: 60, source: "current-screen" });
  });

  it("falls back to window.screen refresh when current screen has none", () => {
    const result = resolveNativeRefreshRate(
      { refreshRate: undefined },
      { refreshRate: 144 },
    );

    expect(result).toEqual({ rate: 144, source: "window-screen" });
  });

  it("can suppress generic window.screen fallback on extended desktops", () => {
    const result = resolveNativeRefreshRate(
      { refreshRate: undefined },
      { refreshRate: 120 },
      false,
    );

    expect(result).toBeNull();
  });
});

describe("resolveMeasuredRefreshRate", () => {
  it("prefers the lower harmonic rate on extended desktops", () => {
    const result = resolveMeasuredRefreshRate(
      { hz: 120, intervalMs: 8.333, vrrDetected: false, vrrRange: null },
      { hz: 60, intervalMs: 16.667, vrrDetected: false, vrrRange: null },
      true,
    );

    expect(result).toBe(60);
  });

  it("keeps the higher rate when not in the ambiguous extended-desktop path", () => {
    const result = resolveMeasuredRefreshRate(
      { hz: 120, intervalMs: 8.333, vrrDetected: false, vrrRange: null },
      { hz: 60, intervalMs: 16.667, vrrDetected: false, vrrRange: null },
      false,
    );

    expect(result).toBe(120);
  });
});

describe("resolveScreenMetrics", () => {
  it("uses current screen geometry and DPR when available", () => {
    const metrics = resolveScreenMetrics(
      { width: 3840, height: 2160, devicePixelRatio: 1 },
      { width: 2560, height: 1440 },
      { width: 1920, height: 1080 },
      2,
    );

    expect(metrics).toEqual({
      screenWidth: 3840,
      screenHeight: 2160,
      dpr: 1,
      renderWidth: 1920,
      renderHeight: 1080,
    });
  });

  it("falls back to window.screen geometry and window DPR", () => {
    const metrics = resolveScreenMetrics(
      null,
      { width: 2560, height: 1440 },
      { width: 1280, height: 720 },
      1.5,
    );

    expect(metrics).toEqual({
      screenWidth: 3840,
      screenHeight: 2160,
      dpr: 1.5,
      renderWidth: 1920,
      renderHeight: 1080,
    });
  });
});

describe("hitSizeScale", () => {
  it("uses the limiting render axis so rotation does not change particle scale", () => {
    const portraitScale = hitSizeScale({
      screenWidth: 1080,
      screenHeight: 2400,
      viewportWidth: 540,
      viewportHeight: 1200,
      dpr: 2,
      renderWidth: 1080,
      renderHeight: 2400,
      refreshRate: 60,
      measuredFrameInterval: 16.667,
      vrrDetected: false,
      vrrRange: null,
      category: "Phone",
      orientation: "portrait",
      isMobile: true,
      hdrCapable: false,
      colorGamut: "srgb",
      peakBrightnessNits: null,
      colorDepth: 8,
      summary: "",
    });

    const landscapeScale = hitSizeScale({
      screenWidth: 2400,
      screenHeight: 1080,
      viewportWidth: 1200,
      viewportHeight: 540,
      dpr: 2,
      renderWidth: 2400,
      renderHeight: 1080,
      refreshRate: 60,
      measuredFrameInterval: 16.667,
      vrrDetected: false,
      vrrRange: null,
      category: "Phone",
      orientation: "landscape",
      isMobile: true,
      hdrCapable: false,
      colorGamut: "srgb",
      peakBrightnessNits: null,
      colorDepth: 8,
      summary: "",
    });

    expect(portraitScale).toBe(landscapeScale);
  });

  it("still scales up when the limiting render axis increases", () => {
    const baseScale = hitSizeScale({
      screenWidth: 1440,
      screenHeight: 1440,
      viewportWidth: 1440,
      viewportHeight: 1440,
      dpr: 1,
      renderWidth: 1440,
      renderHeight: 1440,
      refreshRate: 60,
      measuredFrameInterval: 16.667,
      vrrDetected: false,
      vrrRange: null,
      category: "1440p",
      orientation: "square",
      isMobile: false,
      hdrCapable: false,
      colorGamut: "srgb",
      peakBrightnessNits: null,
      colorDepth: 8,
      summary: "",
    });

    const largerScale = hitSizeScale({
      screenWidth: 2880,
      screenHeight: 1800,
      viewportWidth: 2880,
      viewportHeight: 1800,
      dpr: 1,
      renderWidth: 2880,
      renderHeight: 1800,
      refreshRate: 60,
      measuredFrameInterval: 16.667,
      vrrDetected: false,
      vrrRange: null,
      category: "High-res",
      orientation: "landscape",
      isMobile: false,
      hdrCapable: false,
      colorGamut: "srgb",
      peakBrightnessNits: null,
      colorDepth: 8,
      summary: "",
    });

    expect(baseScale).toBe(1);
    expect(largerScale).toBeGreaterThan(baseScale);
  });
});