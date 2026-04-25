import { describe, expect, it } from "vitest";
import mainSource from "./main.ts?raw";

describe("main lifecycle", () => {
  it("exports dispose() for teardown callers", () => {
    expect(mainSource).toMatch(/export\s+function\s+dispose\s*\(/);
  });

  it("subscribes to screen changes only after renderer initialization", () => {
    const rendererInit = mainSource.indexOf("await renderer.init(screenInfo)");
    const screenSubscription = mainSource.indexOf("screenDetector.onChange");
    expect(rendererInit).toBeGreaterThan(-1);
    expect(screenSubscription).toBeGreaterThan(rendererInit);
  });

  it("gates deferred GPU compute initialization through a ready promise", () => {
    expect(mainSource).toContain("let gpuComputeReady: Promise<boolean>");
    expect(mainSource).toContain("queueGpuComputePreference");
    expect(mainSource).toContain("observeGpuComputePreference();");
    expect(mainSource).toContain("gpuComputeReadySettled");
    expect(mainSource).toContain("GPU compute init failed");
  });
});