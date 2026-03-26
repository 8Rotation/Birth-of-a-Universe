/**
 * hardware-info.ts — Continuous hardware + screen capability detection.
 *
 * Instead of discrete tiers, produces a **capability score t ∈ [0, 1]**
 * by combining continuous sub-scores for CPU, GPU, RAM, and screen
 * resolution.  Every budget parameter and slider limit is smoothly
 * interpolated along t, so a slightly better machine always gets
 * slightly higher limits — no arbitrary brackets.
 *
 * Sub-score design (each maps a raw measurement to 0 → 1 via a
 * clamped log or linear ramp):
 *
 *   CPU single-thread benchmark   (weight 0.35)
 *     Measured via 20 ms transcendental-math loop.
 *     0.0 at bench ≤ 0.3×  (very slow / throttled)
 *     1.0 at bench ≥ 4.0×  (current-gen high-end desktop)
 *
 *   CPU logical cores             (weight 0.25)
 *     0.0 at ≤ 2 threads
 *     1.0 at ≥ 32 threads
 *
 *   GPU class                     (weight 0.40)
 *     Software renderer → 0.05
 *     Integrated (Intel/AMD) → 0.25
 *     Apple integrated → 0.55
 *     Discrete GPU → 0.75
 *     WebGPU does not expose VRAM, shader cores, or clock speed.
 *     maxBufferSize and maxTextureDimension2D are API limits that
 *     are identical across vastly different GPUs — not used.
 *
 * Weighted sum → raw hardware capability h ∈ [0, 1].
 *
 * Screen resolution is logged for diagnostics but does NOT penalise the
 * capability score or any budget parameter.  Bloom and particle costs do
 * scale with pixel count, but the user has manual sliders for those —
 * the budget system should not pre-emptively throttle.
 *
 * All budget numbers and slider limits are then:
 *   value = floor + (ceiling − floor) × h^exponent
 * where h = raw hardware capability.
 *
 * A cosmetic tier label (low / mid / high / ultra) is still derived
 * for display but has no functional effect.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type HardwareTier = "low" | "mid" | "high" | "ultra";

export interface CpuInfo {
  /** Logical core count (navigator.hardwareConcurrency) */
  logicalCores: number;
  /** Single-thread benchmark score. ~1.0 on a mid-range 2020 CPU. */
  benchmarkScore: number;
  /** Continuous sub-score 0 → 1 for single-thread speed */
  benchSub: number;
  /** Continuous sub-score 0 → 1 for core count */
  coresSub: number;
}

export interface GpuInfo {
  /** Whether WebGPU is available */
  webgpuAvailable: boolean;
  /** GPU vendor string */
  vendor: string;
  /** GPU architecture string */
  architecture: string;
  /** GPU device/description string */
  device: string;
  /** Max storage/uniform buffer size in bytes */
  maxBufferSize: number;
  /** Max compute workgroup size (X dimension) */
  maxComputeWorkgroupSizeX: number;
  /** Max compute workgroups per dispatch (X dimension) */
  maxComputeWorkgroupsX: number;
  /** Max 2D texture dimension */
  maxTextureDimension2D: number;
  /** Whether this is likely an integrated GPU */
  isIntegrated: boolean;
  /** Continuous sub-score 0 → 1 for overall GPU capability */
  gpuSub: number;
}

/**
 * Slider limits for normal mode — scales continuously with capability.
 * Override Mode bypasses these entirely.
 */
export interface SliderLimits {
  particleRateMax: number;
  lMaxMax: number;
  persistenceMax: number;
  arrivalSpreadMax: number;
  bloomStrengthMax: number;
}

export interface ComputeBudget {
  /** Recommended default particle rate (/s) */
  particleRate: number;
  /** Emergency hit cap (absolute max hits in ring buffer VRAM) */
  emergencyHitCap: number;
  /** Max particles the worker should produce per tick */
  maxParticlesPerTick: number;
  /** Initial GPU buffer capacity (# of hits) */
  initialGpuCapacity: number;
  /** Whether bloom should default to on */
  bloomDefault: boolean;
  /** Default l_max for spherical harmonics */
  recommendedLMax: number;
  /** Recommended worker count (future: multi-worker) */
  recommendedWorkers: number;
  /** Normal-mode slider limits (continuously scaled) */
  sliderLimits: SliderLimits;

  // ── Compound budget limits ───────────────────────────────────
  // These cap the *product* of interacting settings to prevent
  // combinatorial explosion that individual slider limits miss.

  /**
   * Max particles in the ring buffer (VRAM budget cap).
   * Caps the effective `particleRate × persistence` product to prevent
   * unbounded VRAM growth. At 28 bytes/particle, 2M = 56 MB VRAM.
   */
  maxVisibleHits: number;

  /**
   * Max spherical-harmonic evaluations per second across all workers.
   * Caps the effective `particleRate × (lMax² + 2·lMax)` product.
   * A single worker thread can sustain ~5–10 M evals/s comfortably.
   */
  maxPhysicsCostPerSec: number;
}

/**
 * User-supplied hardware specs that the browser cannot measure.
 * A value of 0 means "not set / use auto-detection only".
 */
export interface ManualOverrides {
  /** System RAM in GB (navigator.deviceMemory is capped at 8 by browsers) */
  ramGB: number;
  /** Dedicated GPU VRAM in GB (browsers expose no VRAM API) */
  vramGB: number;
  /** Peak display brightness in nits (Screen Details API often unavailable) */
  peakNits: number;
}

export interface HardwareInfo {
  cpu: CpuInfo;
  gpu: GpuInfo;
  /** Cosmetic tier label derived from capability */
  tier: HardwareTier;
  /** Raw hardware capability h ∈ [0, 1] (before screen penalty) */
  rawCapability: number;
  /** Effective capability t ∈ [0, 1] (after screen penalty) */
  capability: number;
  /** Render pixels used for screen penalty */
  renderPixels: number;
  budget: ComputeBudget;
  /** Human-readable summary */
  summary: string;
  /** Active manual overrides (if any) */
  overrides: ManualOverrides;
}

// ── Math helpers ──────────────────────────────────────────────────────────

/** Clamp x to [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Linear ramp: 0 at x ≤ lo, 1 at x ≥ hi, linear between. */
function ramp(x: number, lo: number, hi: number): number {
  return clamp((x - lo) / (hi - lo), 0, 1);
}

/** Log-scale ramp: same as ramp but in log-space. */
function logRamp(x: number, lo: number, hi: number): number {
  if (x <= 0 || lo <= 0 || hi <= 0) return 0;
  return ramp(Math.log(x), Math.log(lo), Math.log(hi));
}

/** Interpolate between floor and ceiling with optional exponent curve. */
function lerp(floor: number, ceiling: number, t: number, exponent = 1): number {
  return floor + (ceiling - floor) * Math.pow(clamp(t, 0, 1), exponent);
}

/** Same as lerp but rounds to an integer. */
function lerpInt(floor: number, ceiling: number, t: number, exponent = 1): number {
  return Math.round(lerp(floor, ceiling, t, exponent));
}

/** Lerp between two power-of-2 exponents, return 2^result. */
function lerpPow2(floorExp: number, ceilingExp: number, t: number, exponent = 1): number {
  const exp = lerp(floorExp, ceilingExp, t, exponent);
  return Math.pow(2, Math.round(exp));
}

// ── CPU Detection ───────────────────────────────────────────────────────

/** Duration of the quick CPU benchmark loop (ms). */
const CPU_BENCH_DURATION_MS = 20;
/**
 * Baseline ops/ms calibrated to a mid-range 2020 CPU (i5-10400 / Ryzen 5 3600).
 * Score = measured ops/ms / BASELINE_OPS_PER_MS  (≈1.0 for that hardware).
 */
const BASELINE_OPS_PER_MS = 4500;

function detectCpuCores(): number {
  return navigator.hardwareConcurrency || 4;
}

/**
 * Quick single-thread benchmark: tight transcendental-math loop.
 * Calibrated so a mid-range 2020 CPU (i5-10400 / Ryzen 5 3600) ≈ 1.0×.
 * Runs for ~20 ms to avoid blocking the UI.
 */
function cpuBenchmark(): number {
  const start = performance.now();
  let iterations = 0;
  let x = 1.0;

  while (performance.now() - start < CPU_BENCH_DURATION_MS) {
    for (let i = 0; i < 1000; i++) {
      x = Math.sin(x) + Math.cos(x * 0.7) + Math.sqrt(Math.abs(x) + 1);
      iterations++;
    }
  }

  const elapsed = performance.now() - start;
  const opsPerMs = iterations / elapsed;
  const score = opsPerMs / BASELINE_OPS_PER_MS;

  // Prevent dead-code elimination
  if (x === -Infinity) console.log(x);

  return Math.round(score * 100) / 100;
}

// ── GPU Detection ─────────────────────────────────────────────────────────

function normalizeVendor(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("nvidia") || lower === "0x10de") return "nvidia";
  if (lower.includes("amd") || lower.includes("ati") || lower === "0x1002") return "amd";
  if (lower.includes("intel") || lower === "0x8086") return "intel";
  if (lower.includes("apple")) return "apple";
  if (lower.includes("qualcomm") || lower.includes("adreno")) return "qualcomm";
  if (lower.includes("arm") || lower.includes("mali")) return "arm";
  if (lower.includes("google") || lower.includes("swiftshader")) return "software";
  if (lower.includes("mesa") || lower.includes("llvmpipe")) return "software";
  return raw || "unknown";
}

function detectIntegratedGpu(vendor: string, device: string): boolean {
  const lower = device.toLowerCase();
  if (vendor === "intel" && !lower.includes("arc")) return true;
  if (vendor === "amd" && (lower.includes("vega") || lower.includes("integrated"))) return true;
  if (vendor === "apple") return false;
  if (vendor === "software") return true;
  return false;
}

/**
 * GPU sub-score ∈ [0, 1].
 *
 * WebGPU does not expose VRAM size, shader core count, or clock speed.
 * maxBufferSize and maxTextureDimension2D are API limits that are nearly
 * identical across all discrete GPUs (a 3060 and a 4090 report the same).
 *
 * The only reliable signal from the browser is the GPU class:
 *   - Software renderer (SwiftShader / llvmpipe): very slow
 *   - Integrated (Intel UHD, AMD Vega): limited
 *   - Apple integrated (M1+): strong for integrated
 *   - Discrete (NVIDIA, AMD, Intel Arc): capable
 *
 * We score conservatively within each class.  The user has sliders and
 * override mode for fine-tuning beyond what we can detect.
 */
function computeGpuSub(
  vendor: string,
  _maxBufferSize: number,
  _maxTexDim: number,
  isIntegrated: boolean,
): number {
  if (vendor === "software") return 0.05;
  if (isIntegrated && vendor === "apple") return 0.55;
  if (isIntegrated) return 0.25;
  // Discrete GPU — we know it's capable but can't distinguish tiers.
  // 0.75 is a conservative middle ground: strong enough to unlock high
  // budgets, but not maxed out (users with extreme hardware can override).
  return 0.75;
}

async function detectGpu(existingAdapter?: GPUAdapter | null): Promise<GpuInfo> {
  const fallback: GpuInfo = {
    webgpuAvailable: false,
    vendor: "unknown",
    architecture: "",
    device: "unknown",
    maxBufferSize: 256 * 1024 * 1024,
    maxComputeWorkgroupSizeX: 256,
    maxComputeWorkgroupsX: 65535,
    maxTextureDimension2D: 8192,
    isIntegrated: true,
    gpuSub: 0.15,
  };

  if (!navigator.gpu) return fallback;

  try {
    const adapter = existingAdapter ?? await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) return fallback;

    const adapterInfo = adapter.info;
    const vendor = normalizeVendor(adapterInfo.vendor ?? "");
    const architecture = adapterInfo.architecture ?? "";
    const device = adapterInfo.device ?? adapterInfo.description ?? "";

    const limits = adapter.limits;
    const maxBufferSize = limits.maxBufferSize ?? 256 * 1024 * 1024;
    const maxComputeWorkgroupSizeX = limits.maxComputeWorkgroupSizeX ?? 256;
    const maxComputeWorkgroupsX = limits.maxComputeWorkgroupsPerDimension ?? 65535;
    const maxTextureDimension2D = limits.maxTextureDimension2D ?? 8192;
    const isIntegrated = detectIntegratedGpu(vendor, device);

    const gpuSub = computeGpuSub(vendor, maxBufferSize, maxTextureDimension2D, isIntegrated);

    return {
      webgpuAvailable: true,
      vendor,
      architecture,
      device,
      maxBufferSize,
      maxComputeWorkgroupSizeX,
      maxComputeWorkgroupsX,
      maxTextureDimension2D,
      isIntegrated,
      gpuSub,
    };
  } catch (e) {
    console.warn("[hardware] GPU detection failed:", e);
    return fallback;
  }
}

// ── Sub-scores ────────────────────────────────────────────────────────────

/**
 * CPU benchmark sub-score: 0 → 1.
 *   0.0 at bench ≤ 0.3  (very slow / mobile / throttled)
 *   1.0 at bench ≥ 4.0  (current-gen desktop high-end)
 * Log-scale so improvements at the low end matter more.
 */
function computeBenchSub(bench: number): number {
  return logRamp(bench, 0.3, 4.0);
}

/**
 * CPU cores sub-score: 0 → 1.
 *   0.0 at ≤ 2 threads
 *   1.0 at ≥ 32 threads
 * Log-scale: going 4→8 matters more than 24→32.
 */
function computeCoresSub(cores: number): number {
  return logRamp(cores, 2, 32);
}

// ── Composite capability ──────────────────────────────────────────────────

/**
 * Sub-score weights — based only on what the browser can actually measure.
 *
 * GPU class   (40%) — discrete vs integrated vs software.  Coarse but
 *                      reliable.  The single most important factor for
 *                      this particle renderer.
 * CPU bench   (35%) — our own 20 ms microbenchmark.  Directly measures
 *                      the math operations used in physics workers.
 * CPU cores   (25%) — navigator.hardwareConcurrency.  Accurate.
 *
 * Removed from scoring:
 *   - deviceMemory: capped at 8 GB by browsers (fingerprinting protection)
 *   - maxBufferSize / maxTextureDimension2D: WebGPU API limits, identical
 *     across vastly different discrete GPUs
 *   - Screen resolution: not a hardware capability
 */
const W_BENCH = 0.35;
const W_CORES = 0.25;
const W_GPU   = 0.40;

function computeRawCapability(cpu: CpuInfo, gpu: GpuInfo): number {
  return clamp(
    cpu.benchSub * W_BENCH +
    cpu.coresSub * W_CORES +
    gpu.gpuSub   * W_GPU,
    0, 1,
  );
}

// ── Cosmetic tier label ───────────────────────────────────────────────────

function tierLabel(t: number): HardwareTier {
  if (t >= 0.75) return "ultra";
  if (t >= 0.45) return "high";
  if (t >= 0.20) return "mid";
  return "low";
}

// ── Budget interpolation ──────────────────────────────────────────────────

/**
 * Build a complete ComputeBudget by interpolating every parameter along
 * the raw hardware capability h ∈ [0, 1].
 *
 * Screen resolution is NOT factored in.  Bloom and particle rendering
 * costs scale with resolution, but the user has sliders for that —
 * the budget shouldn't pre-emptively throttle based on pixel count.
 *
 * floor   = value at h = 0 (worst hardware)
 * ceiling = value at h = 1 (best hardware)
 * exponent > 1 skews toward ceiling (high-end benefits more)
 */
/** Bytes per particle in the GPU ring buffer (2 × vec4 × 4 bytes). */
const BYTES_PER_PARTICLE = 32;
/**
 * Fraction of user-reported VRAM we're willing to dedicate to the
 * particle ring buffer.  Conservative: 15 % leaves plenty for textures,
 * bloom FBOs, depth buffers, etc.
 */
const VRAM_BUDGET_FRACTION = 0.15;

function buildBudget(
  h: number,
  cpuCores: number,
  cpuT: number,
  overrides: ManualOverrides = { ramGB: 0, vramGB: 0, peakNits: 0 },
): ComputeBudget {
  // ── VRAM-aware caps ──────────────────────────────────────────
  // When the user tells us their VRAM size, compute a hard cap from
  // that instead of the conservative h-based interpolation.
  let emergencyHitCap   = lerpInt(200_000,  20_000_000, h, 1.5);
  let maxVisibleHits    = lerpInt(50_000,   800_000,    h, 1.3);
  let initialGpuCap     = lerpPow2(14, 20, h, 1.2);

  if (overrides.vramGB > 0) {
    const vramBytes = overrides.vramGB * 1_073_741_824; // 1 GiB
    const particleBudget = Math.floor(vramBytes * VRAM_BUDGET_FRACTION / BYTES_PER_PARTICLE);
    // Emergency cap: up to full VRAM budget, still capped at 20M absolute
    emergencyHitCap  = Math.min(particleBudget, 20_000_000);
    // Visible-hits cap: a tenth of the VRAM-based budget, max 4M
    maxVisibleHits   = Math.min(Math.floor(particleBudget * 0.4), 4_000_000);
    // Initial GPU buffer: nearest power-of-2 between 16K and VRAM cap
    const idealInit  = Math.min(particleBudget, 1 << 20);
    initialGpuCap    = 1 << Math.max(14, Math.min(20, Math.round(Math.log2(idealInit))));
  }

  // ── RAM bonus ────────────────────────────────────────────────
  // When the user tells us actual RAM, add a small bonus to h
  // (RAM ≥ 16 GB lifts, RAM < 8 GB drags down).  Only affects
  // this budget calculation — does not change rawCapability.
  let hEffective = h;
  if (overrides.ramGB > 0) {
    // 0 at ≤ 4 GB, 1 at ≥ 64 GB  →  mapped to ±0.10 bonus
    const ramFactor = ramp(overrides.ramGB, 4, 64);
    hEffective = clamp(h + (ramFactor - 0.5) * 0.20, 0, 1);
  }

  return {
    // ── Defaults (first-launch values) ────────────────────────────
    particleRate:           lerpInt(300,      20_000,    hEffective, 1.3),
    recommendedLMax:        lerpInt(3,        32,        hEffective, 1.2),
    bloomDefault:           hEffective >= 0.20,

    // ── Internal throughput caps ──────────────────────────────────
    emergencyHitCap,
    maxParticlesPerTick:    lerpInt(5_000,    300_000,    hEffective, 1.3),
    initialGpuCapacity:     initialGpuCap,

    // ── Workers ──────────────────────────────────────────────────
    recommendedWorkers:     Math.max(1, Math.min(lerpInt(2, cpuCores - 2, cpuT), cpuCores - 2)),

    // ── Slider limits (normal mode) ──────────────────────────────
    sliderLimits: {
      particleRateMax:      lerpInt(1_000,    200_000,   hEffective, 1.4),
      lMaxMax:              lerpInt(6,        96,        hEffective, 1.2),
      persistenceMax:       lerpInt(3,        120,       hEffective, 1.1),
      arrivalSpreadMax:     lerp(10,          120,       hEffective, 1.1),
      bloomStrengthMax:     lerp(1.5,         8,         hEffective, 1.0),
    },

    // ── Compound budget limits ──────────────────────────────────
    maxVisibleHits,

    maxPhysicsCostPerSec:   lerpInt(
      2_000_000,
      Math.max(1, Math.min(lerpInt(2, cpuCores - 2, cpuT), cpuCores - 2)) * 8_000_000,
      hEffective, 1.2,
    ),
  };
}

// ── Summary ───────────────────────────────────────────────────────────────

function buildSummary(
  cpu: CpuInfo,
  gpu: GpuInfo,
  h: number,
  renderPixels: number,
): string {
  const parts: string[] = [];

  // CPU
  parts.push(`CPU: ${cpu.logicalCores} threads`);
  parts.push(`bench ${cpu.benchmarkScore.toFixed(2)}×`);

  // GPU
  if (gpu.webgpuAvailable) {
    const gpuName = gpu.device || `${gpu.vendor} ${gpu.architecture}`.trim();
    parts.push(`GPU: ${gpuName}${gpu.isIntegrated ? " (iGPU)" : ""}`);
  } else {
    parts.push("GPU: no WebGPU");
  }

  // Resolution
  if (renderPixels > 0) {
    const megapixels = (renderPixels / 1_000_000).toFixed(1);
    parts.push(`${megapixels} MP`);
  }

  // Capability
  const tier = tierLabel(h);
  const pct = (h * 100).toFixed(0);
  parts.push(`Capability: ${pct}% (${tier.toUpperCase()})`);

  return parts.join(" · ");
}

// ── Detector Class ────────────────────────────────────────────────────────

export class HardwareDetector {
  private _info: HardwareInfo | null = null;
  private _benchPromise: Promise<[GpuInfo, number]> | null = null;

  /**
   * Kick off CPU benchmark + GPU adapter query immediately.
   * Neither depends on renderPixels, so this can run in parallel
   * with screen detection.  Call finalize() once renderPixels is known.
   *
   * @param gpuAdapter  Optional pre-existing WebGPU adapter.
   */
  startBenchmarks(gpuAdapter?: GPUAdapter | null): void {
    if (this._benchPromise) return; // already started
    console.log("[hardware] Detecting hardware capabilities...");
    this._benchPromise = Promise.all([
      detectGpu(gpuAdapter),
      new Promise<number>((resolve) => {
        setTimeout(() => resolve(cpuBenchmark()), 0);
      }),
    ]);
  }

  /**
   * Await the benchmarks kicked off by startBenchmarks() and apply
   * the screen-resolution penalty to produce the final HardwareInfo.
   *
   * @param renderPixels  Effective render-pixel count (viewportW × viewportH × DPR²).
   *                      Pass 0 or omit to skip screen penalty.
   */
  async finalize(renderPixels = 0): Promise<HardwareInfo> {
    if (!this._benchPromise) {
      this.startBenchmarks();
    }
    const [gpu, benchResult] = await this._benchPromise!;

    const cores = detectCpuCores();

    const cpu: CpuInfo = {
      logicalCores: cores,
      benchmarkScore: benchResult,
      benchSub: computeBenchSub(benchResult),
      coresSub: computeCoresSub(cores),
    };

    const rawH = computeRawCapability(cpu, gpu);

    // CPU-only sub-score for worker allocation (bench 60%, cores 40%).
    // Workers are purely CPU-bound so the GPU should not limit how many
    // threads we spin up.
    const cpuT = clamp(cpu.benchSub * 0.6 + cpu.coresSub * 0.4, 0.05, 1.0);

    const noOverrides: ManualOverrides = { ramGB: 0, vramGB: 0, peakNits: 0 };
    const tier = tierLabel(rawH);
    const budget = buildBudget(rawH, cpu.logicalCores, cpuT, noOverrides);
    const summary = buildSummary(cpu, gpu, rawH, renderPixels);

    this._info = {
      cpu, gpu, tier,
      rawCapability: rawH,
      capability: rawH,
      renderPixels,
      budget, summary,
      overrides: noOverrides,
    };

    console.log(`[hardware] ${summary}`);
    console.log(
      `[hardware] Sub-scores: bench=${(cpu.benchSub * 100).toFixed(0)}% ` +
      `cores=${(cpu.coresSub * 100).toFixed(0)}% ` +
      `gpu=${gpu.isIntegrated ? 'integrated' : 'discrete'} (${(gpu.gpuSub * 100).toFixed(0)}%)`,
    );
    console.log(
      `[hardware] Budget: default ${budget.particleRate}/s, ` +
      `slider max ${budget.sliderLimits.particleRateMax}/s, ` +
      `${(budget.emergencyHitCap / 1_000_000).toFixed(1)}M hit cap, ` +
      `bloom=${budget.bloomDefault}, lMax=${budget.recommendedLMax}, ` +
      `GPU buf=${budget.initialGpuCapacity}`,
    );

    return this._info;
  }

  /**
   * Recalculate the budget using user-supplied manual overrides
   * (RAM, VRAM, peak brightness) that the browser cannot detect.
   * Re-uses the original CPU/GPU benchmark results.
   *
   * Returns the updated HardwareInfo, or null if finalize() hasn't run.
   */
  recalculate(overrides: ManualOverrides): HardwareInfo | null {
    if (!this._info) return null;

    const { cpu, gpu, renderPixels } = this._info;
    const rawH = this._info.rawCapability;
    const cpuT = clamp(cpu.benchSub * 0.6 + cpu.coresSub * 0.4, 0.05, 1.0);

    const budget = buildBudget(rawH, cpu.logicalCores, cpuT, overrides);
    const summary = buildSummary(cpu, gpu, rawH, renderPixels);

    this._info = {
      ...this._info,
      budget,
      summary,
      overrides,
    };

    console.log(
      `[hardware] Recalculated with overrides: ` +
      `RAM=${overrides.ramGB || 'auto'} GB, ` +
      `VRAM=${overrides.vramGB || 'auto'} GB, ` +
      `brightness=${overrides.peakNits || 'auto'} nits`,
    );
    console.log(
      `[hardware] Budget: default ${budget.particleRate}/s, ` +
      `slider max ${budget.sliderLimits.particleRateMax}/s, ` +
      `${(budget.emergencyHitCap / 1_000_000).toFixed(1)}M hit cap`,
    );

    return this._info;
  }

  /**
   * Backward-compatible wrapper: runs startBenchmarks() + finalize()
   * sequentially.
   *
   * @param renderPixels  Effective render-pixel count.
   * @param gpuAdapter    Optional pre-existing WebGPU adapter.
   */
  async detect(
    renderPixels = 0,
    gpuAdapter?: GPUAdapter | null,
  ): Promise<HardwareInfo> {
    this.startBenchmarks(gpuAdapter);
    return this.finalize(renderPixels);
  }

  /** Last detected hardware info (null before detect() completes). */
  get info(): HardwareInfo | null {
    return this._info;
  }
}
