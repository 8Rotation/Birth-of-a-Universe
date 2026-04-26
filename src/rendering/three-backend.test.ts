import { describe, expect, it, vi } from "vitest";
import { getAttributeBuffer, getWebGPUDevice, probeThreeBackend } from "./three-backend";

describe("three-backend helpers", () => {
  it("probes the expected WebGPU backend shape", () => {
    const attr = {};
    const device = {} as GPUDevice;
    const buffer = { size: 64, destroy: vi.fn() } as unknown as GPUBuffer;
    const renderer = {
      backend: {
        device,
        get: vi.fn().mockReturnValue({ buffer }),
      },
    };

    expect(probeThreeBackend(renderer)).toMatchObject({ compatible: true, missing: [] });
    expect(getWebGPUDevice(renderer)).toBe(device);
    expect(getAttributeBuffer(renderer, attr)).toBe(buffer);
  });

  it("reports missing private backend paths", () => {
    const renderer = { backend: { get: vi.fn() } };

    const probe = probeThreeBackend(renderer);

    expect(probe.compatible).toBe(false);
    expect(probe.missing).toContain("renderer.backend.device");
    expect(() => getWebGPUDevice(renderer)).toThrow(/renderer\.backend\.device/);
  });
});
