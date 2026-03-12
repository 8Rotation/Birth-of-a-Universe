import { describe, expect, it } from "vitest";

import { resolveMeasuredRefreshRate, resolveNativeRefreshRate, resolveScreenMetrics } from "./screen-info.js";

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