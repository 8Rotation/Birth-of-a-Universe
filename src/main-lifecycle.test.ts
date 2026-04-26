import { describe, expect, it } from "vitest";
import mainSource from "./main.ts?raw";
import controlsSource from "./ui/controls.ts?raw";
import hardwareSource from "./ui/hardware-info.ts?raw";

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
    expect(mainSource).toContain("setGpuComputeCallback((value) =>");
    expect(mainSource).toContain("gpuComputeReadySettled");
    expect(mainSource).toContain("GPU compute init failed");
    expect(controlsSource).toContain("setGpuComputeCallback");
    expect(controlsSource).toMatch(/flow\.add\(params, "gpuCompute"\)[\s\S]*\.onChange/);
  });

  it("guards stale async lifecycle work after dispose", () => {
    expect(mainSource).toContain("if (!animateRunning || abortSignal.aborted) return;");
    expect(mainSource).toContain("if (animateRunning && !abortSignal.aborted) requestAnimationFrame(animate);");
    expect(hardwareSource).toContain("if (this._aborted) return info;");
  });

  it("keeps GPU compute throughput caps in particles per second", () => {
    expect(mainSource).toContain("const gpuSliderMax = gpuComputeRate;");
    expect(mainSource).toContain("const maxByGpu = gpuComputeRate / totalMultiplier;");
    expect(mainSource).not.toContain("gpuComputeRate / 60");
    expect(mainSource).not.toMatch(/gpuComputeRate\s*\/\s*\(targetFps/);
  });

  it("keeps emission and buffer growth behind compound safety caps", () => {
    expect(mainSource).toContain("const safetyFloor = Math.min(100, requestedRate, safetyRateCeiling);");
    expect(mainSource).toContain("effectiveRate * totalMultiplier * params.persistence * CUTOFF_MARGIN");
    expect(mainSource).toContain("const maxGpuBaseCount = Math.max(1, Math.floor(");
    expect(mainSource).not.toContain("params.particleRate * params.persistence * CUTOFF_MARGIN");
  });

  it("keeps hidden auto-brightness gain neutral and clears peak-nits overrides", () => {
    expect(mainSource).toContain("const AUTO_BRIGHTNESS_NEUTRAL_GAIN = 5.0;");
    expect(mainSource).toMatch(/params\.autoBrightness\s*\?\s*AUTO_BRIGHTNESS_NEUTRAL_GAIN\s*:\s*params\.brightness/);
    expect(mainSource).toContain("renderer.peakNits = overrides.peakNits;");
  });

  it("refreshes particle-rate slider limits after manual hardware budget overrides", () => {
    expect(mainSource).toContain("updateParticleRateMax(params.gpuCompute && gpuComputeRate > 0");
    expect(mainSource).toContain("Math.max(budget.sliderLimits.particleRateMax, gpuComputeRate)");
  });
});