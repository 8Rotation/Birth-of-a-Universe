import { defineConfig, devices } from "@playwright/test";

// Playwright config for the GPU/CPU validation harness (Task A3 / GPU-02).
//
// We launch chromium with WebGPU enabled. SwiftShader gives a software
// adapter that works in headless Linux/Windows CI without a real GPU.
// If the test fails to acquire a device, fall back to the angle/vulkan
// flags listed in plan-implementation.md.

const VITE_BASE = "/Birth-of-a-Universe/";
const PORT = 5179;

export default defineConfig({
  testDir: "./tests-e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  projects: [
    {
      name: "chromium-webgpu",
      use: {
        ...devices["Desktop Chrome"],
        // The default Playwright headless mode runs the chrome-headless-shell
        // build, which currently lacks a WebGPU adapter. Forcing the new
        // headless mode runs full Chromium and exposes WebGPU when paired
        // with the SwiftShader flags below.
        channel: "chromium",
        baseURL: `http://localhost:${PORT}${VITE_BASE}`,
        // Default to headed because chromium-headless-shell currently
        // does not expose a WebGPU adapter even with SwiftShader flags.
        // Override with `--headed=false` once that lands upstream.
        headless: false,
        launchOptions: {
          args: [
            "--enable-unsafe-webgpu",
            "--enable-features=Vulkan,UseSkiaRenderer",
            "--disable-gpu-sandbox",
            "--no-sandbox",
          ],
        },
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}${VITE_BASE}tests-e2e/harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
