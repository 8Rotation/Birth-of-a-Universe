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
 *   CPU single-thread benchmark   (weight 0.25)
 *     Measured via 20 ms transcendental-math loop.
 *     0.0 at bench ≤ 0.3×  (very slow / throttled)
 *     1.0 at bench ≥ 4.0×  (current-gen high-end desktop)
 *
 *   CPU logical cores             (weight 0.15)
 *     0.0 at ≤ 2 threads
 *     1.0 at ≥ 32 threads
 *
 *   Device RAM                    (weight 0.10)
 *     0.0 at ≤ 2 GB
 *     1.0 at ≥ 64 GB
 *     Unknown (API unavailable) → 0.35 (assume ≈ 8 GB)
 *
 *   GPU capability                (weight 0.50)
 *     Combines maxBufferSize + maxTextureDimension2D into a single
 *     0 → 1 value, with a penalty for integrated GPUs and a hard
 *     cap for software renderers (0.05).
 *
 * Weighted sum → raw hardware capability h ∈ [0, 1].
 *
 * Screen penalty:
 *   effectiveCapability = h × (1 / sqrt(renderPixels / 1080pPixels))
 *   clamped to [0.02, h].  Never boosts, only attenuates.
 *
 * All budget numbers and slider limits are then:
 *   value = floor + (ceiling − floor) × t^exponent
 * where t = effectiveCapability.
 *
 * A cosmetic tier label (low / mid / high / ultra) is still derived
 * for display but has no functional effect.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type HardwareTier = "low" | "mid" | "high" | "ultra";

export interface CpuInfo {
  /** Logical core count (navigator.hardwareConcurrency) */
  logicalCores: number;
  /** Device memory in GB (navigator.deviceMemory, 0 if unavailable) */
  deviceMemoryGB: number;
  /** Single-thread benchmark score. ~1.0 on a mid-range 2020 CPU. */
  benchmarkScore: number;
  /** Continuous sub-score 0 → 1 for single-thread speed */
  benchSub: number;
  /** Continuous sub-score 0 → 1 for core count */
  coresSub: number;
  /** Continuous sub-score 0 → 1 for RAM */
  ramSub: number;
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
  timeDilationMax: number;
  bloomStrengthMax: number;
}

export interface ComputeBudget {
  /** Recommended default particle rate (/s) */
  particleRate: number;
  /** Emergency hit cap (absolute max hits in memory) */
  emergencyHitCap: number;
  /** Max particles the worker should produce per tick */
  maxParticlesPerTick: number;
  /** Max arrivals to process per frame on the main thread */
  maxArrivalsPerFrame: number;
  /** Max heap inserts per frame */
  maxHeapInsertsPerFrame: number;
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

// ── CPU Detection ─────────────────────────────────────────────────────────

function detectCpuCores(): number {
  return navigator.hardwareConcurrency || 4;
}

function detectDeviceMemory(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mem = (navigator as any).deviceMemory;
  return typeof mem === "number" ? mem : 0;
}

/**
 * Quick single-thread benchmark: tight transcendental-math loop.
 * Calibrated so a mid-range 2020 CPU (i5-10400 / Ryzen 5 3600) ≈ 1.0×.
 * Runs for ~20 ms to avoid blocking the UI.
 */
function cpuBenchmark(): number {
  const DURATION_MS = 20;
  const start = performance.now();
  let iterations = 0;
  let x = 1.0;

  while (performance.now() - start < DURATION_MS) {
    for (let i = 0; i < 1000; i++) {
      x = Math.sin(x) + Math.cos(x * 0.7) + Math.sqrt(Math.abs(x) + 1);
      iterations++;
    }
  }

  const elapsed = performance.now() - start;
  const opsPerMs = iterations / elapsed;
  const BASELINE_OPS_PER_MS = 4500;
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
 * Continuous GPU sub-score ∈ [0, 1].
 *
 * Signals:
 *   - maxBufferSize: log-ramp from 128 MB to 16 GB  (70% weight)
 *     Proxy for VRAM — imperfect but the best WebGPU exposes.
 *   - maxTextureDimension2D: ramp from 4096 to 16384 (30% weight)
 *   - Integrated penalty: iGPU × 0.55 (Apple × 0.85)
 *   - Software renderer: hard cap at 0.05
 */
function computeGpuSub(
  vendor: string,
  maxBufferSize: number,
  maxTexDim: number,
  isIntegrated: boolean,
): number {
  if (vendor === "software") return 0.05;

  const bufSub = logRamp(maxBufferSize, 128 * 1024 * 1024, 16 * 1024 * 1024 * 1024);
  const texSub = ramp(maxTexDim, 4096, 16384);
  let sub = bufSub * 0.7 + texSub * 0.3;

  if (isIntegrated && vendor !== "apple") sub *= 0.55;
  if (isIntegrated && vendor === "apple") sub *= 0.85;

  return clamp(sub, 0, 1);
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

/**
 * RAM sub-score: 0 → 1.
 *   0.0 at ≤ 2 GB
 *   1.0 at ≥ 64 GB
 *   Unknown (0) → 0.35 (assume about 8 GB).
 */
function computeRamSub(memGB: number): number {
  if (memGB === 0) return 0.35;
  return logRamp(memGB, 2, 64);
}

// ── Composite capability ──────────────────────────────────────────────────

/**
 * Sub-score weights.
 * GPU dominates (50%) — this is a GPU-heavy particle renderer.
 * CPU bench (25%) — physics runs off-thread.
 * Cores (15%) and RAM (10%) are secondary.
 */
const W_BENCH = 0.25;
const W_CORES = 0.15;
const W_RAM   = 0.10;
const W_GPU   = 0.50;

function computeRawCapability(cpu: CpuInfo, gpu: GpuInfo): number {
  return clamp(
    cpu.benchSub * W_BENCH +
    cpu.coresSub * W_CORES +
    cpu.ramSub   * W_RAM   +
    gpu.gpuSub   * W_GPU,
    0, 1,
  );
}

// ── Screen penalty ────────────────────────────────────────────────────────

/**
 * Attenuate capability based on render-pixel count.
 * Reference: 1920×1080 ≈ 2.07 MP → factor 1.0.
 * 4K ≈ 8.3 MP → factor ≈ 0.5.
 * Below 1080p → no boost (clamped at 1.0).
 */
function screenPenalty(renderPixels: number): number {
  const REF = 1920 * 1080;
  const ratio = renderPixels / REF;
  if (ratio <= 1.0) return 1.0;
  return 1.0 / Math.sqrt(ratio);
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
 * the effective capability t ∈ [0, 1].
 *
 * floor   = value at t = 0 (worst hardware + demanding display)
 * ceiling = value at t = 1 (best hardware + modest display)
 * exponent > 1 skews toward ceiling (high-end benefits more)
 */
function buildBudget(t: number, cpuCores: number): ComputeBudget {
  return {
    // ── Defaults (first-launch values) ────────────────────────────
    particleRate:           lerpInt(300,      20_000,    t, 1.3),
    recommendedLMax:        lerpInt(3,        32,        t, 1.2),
    bloomDefault:           t >= 0.35,

    // ── Internal throughput caps ──────────────────────────────────
    emergencyHitCap:        lerpInt(200_000,  20_000_000, t, 1.5),
    maxParticlesPerTick:    lerpInt(3_000,    200_000,    t, 1.4),
    maxArrivalsPerFrame:    lerpInt(2_000,    80_000,     t, 1.3),
    maxHeapInsertsPerFrame: lerpInt(5_000,    200_000,    t, 1.3),
    initialGpuCapacity:     lerpPow2(14, 20, t, 1.2), // 2^14=16K → 2^20=1M

    // ── Workers ──────────────────────────────────────────────────
    recommendedWorkers:     Math.max(1, Math.min(lerpInt(1, 4, t), cpuCores - 2)),

    // ── Slider limits (normal mode) ──────────────────────────────
    sliderLimits: {
      particleRateMax:      lerpInt(1_000,    200_000,   t, 1.4),
      lMaxMax:              lerpInt(6,        96,        t, 1.2),
      persistenceMax:       lerpInt(3,        120,       t, 1.1),
      timeDilationMax:      lerpInt(1_000,    100_000,   t, 1.3),
      bloomStrengthMax:     lerp(1.5,         8,         t, 1.0),
    },
  };
}

// ── Summary ───────────────────────────────────────────────────────────────

function buildSummary(
  cpu: CpuInfo,
  gpu: GpuInfo,
  rawH: number,
  t: number,
  renderPixels: number,
): string {
  const parts: string[] = [];

  // CPU
  parts.push(`CPU: ${cpu.logicalCores} threads`);
  if (cpu.deviceMemoryGB > 0) parts.push(`${cpu.deviceMemoryGB}GB RAM`);
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
  const tier = tierLabel(t);
  const rawPct = (rawH * 100).toFixed(0);
  const effPct = (t * 100).toFixed(0);
  const capStr = renderPixels > 0 && rawH !== t
    ? `Capability: ${rawPct}% hw → ${effPct}% eff (${tier.toUpperCase()})`
    : `Capability: ${effPct}% (${tier.toUpperCase()})`;
  parts.push(capStr);

  return parts.join(" · ");
}

// ── Detector Class ────────────────────────────────────────────────────────

export class HardwareDetector {
  private _info: HardwareInfo | null = null;

  /**
   * Detect hardware + screen capabilities and produce a continuous
   * ComputeBudget scaled to the effective capability.
   *
   * @param renderPixels  Effective render-pixel count (viewportW × viewportH × DPR²).
   *                      Pass 0 or omit to skip screen penalty (raw hardware only).
   * @param gpuAdapter    Optional pre-existing WebGPU adapter.
   */
  async detect(
    renderPixels = 0,
    gpuAdapter?: GPUAdapter | null,
  ): Promise<HardwareInfo> {
    console.log("[hardware] Detecting hardware capabilities...");

    const [gpu, benchResult] = await Promise.all([
      detectGpu(gpuAdapter),
      new Promise<number>((resolve) => {
        setTimeout(() => resolve(cpuBenchmark()), 0);
      }),
    ]);

    const cores = detectCpuCores();
    const memGB = detectDeviceMemory();

    const cpu: CpuInfo = {
      logicalCores: cores,
      deviceMemoryGB: memGB,
      benchmarkScore: benchResult,
      benchSub: computeBenchSub(benchResult),
      coresSub: computeCoresSub(cores),
      ramSub:   computeRamSub(memGB),
    };

    const rawH = computeRawCapability(cpu, gpu);

    // Screen penalty
    const penalty = renderPixels > 0 ? screenPenalty(renderPixels) : 1.0;
    const t = clamp(rawH * penalty, 0.02, 1.0);

    const tier = tierLabel(t);
    const budget = buildBudget(t, cpu.logicalCores);
    const summary = buildSummary(cpu, gpu, rawH, t, renderPixels);

    this._info = {
      cpu, gpu, tier,
      rawCapability: rawH,
      capability: t,
      renderPixels,
      budget, summary,
    };

    console.log(`[hardware] ${summary}`);
    console.log(
      `[hardware] Sub-scores: bench=${(cpu.benchSub * 100).toFixed(0)}% ` +
      `cores=${(cpu.coresSub * 100).toFixed(0)}% ` +
      `ram=${(cpu.ramSub * 100).toFixed(0)}% ` +
      `gpu=${(gpu.gpuSub * 100).toFixed(0)}%`,
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

  /** Last detected hardware info (null before detect() completes). */
  get info(): HardwareInfo | null {
    return this._info;
  }
}
