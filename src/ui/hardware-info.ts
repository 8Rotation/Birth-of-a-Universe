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
  /** True when the benchmark ended early due to abort or wall-clock cap. */
  benchmarkDegraded: boolean;
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

export interface GpuComputeBenchmark {
  /** Measured GPU compute throughput in particles/second */
  particlesPerSec: number;
  /** Optimal workgroup size determined by benchmark */
  optimalWorkgroupSize: number;
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

  /**
   * Max pair-production fraction (caps production-particle count as
   * a multiple of the base bounce rate).  Scales with hardware so
   * low-end devices aren't overwhelmed by 4× particle multipliers.
   */
  ppFractionCap: number;
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
  /** GPU compute benchmark result (null if not yet run or unavailable) */
  gpuComputeBenchmark: GpuComputeBenchmark | null;
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
const CPU_BENCH_MAX_DURATION_MS = CPU_BENCH_DURATION_MS * 2;
/**
 * Baseline ops/ms calibrated to a mid-range 2020 CPU (i5-10400 / Ryzen 5 3600).
 * Score = measured ops/ms / BASELINE_OPS_PER_MS  (≈1.0 for that hardware).
 */
const BASELINE_OPS_PER_MS = 4500;

function detectCpuCores(): number {
  return navigator.hardwareConcurrency || 4;
}

interface CpuBenchmarkResult {
  score: number;
  degraded: boolean;
}

/**
 * Quick single-thread benchmark: tight transcendental-math loop.
 * Calibrated so a mid-range 2020 CPU (i5-10400 / Ryzen 5 3600) ≈ 1.0×.
 * Runs for ~20 ms to avoid blocking the UI.
 */
function cpuBenchmark(isAborted: () => boolean = () => false): CpuBenchmarkResult {
  const start = performance.now();
  let iterations = 0;
  let x = 1.0;
  let degraded = false;

  benchmarkLoop:
  while (!isAborted() && performance.now() - start < CPU_BENCH_DURATION_MS) {
    for (let i = 0; i < 1000; i++) {
      x = Math.sin(x) + Math.cos(x * 0.7) + Math.sqrt(Math.abs(x) + 1);
      iterations++;
      if ((i & 63) === 0) {
        const elapsed = performance.now() - start;
        // LIFE-08: cap at 2x the intended benchmark budget so a throttled
        // browser cannot keep init stuck in the tight math loop. Return the
        // partial score with `degraded: true`; budget calculation remains
        // conservative because fewer iterations lower the score.
        if (elapsed > CPU_BENCH_MAX_DURATION_MS || isAborted()) {
          degraded = true;
          break benchmarkLoop;
        }
      }
    }
  }

  if (isAborted()) degraded = true;

  const elapsed = performance.now() - start;
  const opsPerMs = elapsed > 0 ? iterations / elapsed : 0;
  const score = opsPerMs / BASELINE_OPS_PER_MS;

  // Prevent dead-code elimination
  if (x === -Infinity) console.log(x);

  return { score: Math.round(score * 100) / 100, degraded };
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
 * However, `adapterInfo.device` often contains the GPU model name
 * (e.g. "NVIDIA GeForce RTX 4090"), which lets us infer generation
 * and tier.  We parse this for NVIDIA, AMD, Intel Arc, and Apple.
 *
 * Scoring tiers:
 *   0.05  Software renderer (SwiftShader / llvmpipe)
 *   0.25  Integrated (Intel UHD, AMD Vega)
 *   0.55  Apple integrated (M1+)
 *   0.65  Discrete low-end / old gen (GTX 1050, RX 580, Arc A380)
 *   0.75  Discrete mid-range (RTX 3060, RX 6700, Arc A770)
 *   0.85  Discrete high-end (RTX 3080/3090, RX 6800+, RTX 40-series)
 *   0.95  Discrete flagship (RTX 4080/4090, RX 7900 XTX, RTX 50-series)
 *
 * Falls back to 0.80 for unrecognised discrete GPUs (optimistic default
 * since the user chose a discrete GPU and has Override Mode available).
 */
function computeGpuSub(
  vendor: string,
  _maxBufferSize: number,
  _maxTexDim: number,
  isIntegrated: boolean,
  device: string,
): number {
  if (vendor === "software") return 0.05;
  if (isIntegrated && vendor === "apple") return 0.55;
  if (isIntegrated) return 0.25;

  // Discrete GPU — parse device string for generation/tier info.
  const d = device.toLowerCase();

  // ── NVIDIA ────────────────────────────────────────────────────
  if (vendor === "nvidia") {
    // RTX 50-series (Blackwell)
    if (/rtx\s*50[89]0/.test(d)) return 0.95;
    if (/rtx\s*50[67]0/.test(d)) return 0.90;
    if (/rtx\s*50[56]0/.test(d)) return 0.85;
    // RTX 40-series (Ada Lovelace)
    if (/rtx\s*40[89]0/.test(d)) return 0.95;
    if (/rtx\s*40[67]0/.test(d)) return 0.90;
    if (/rtx\s*40[56]0/.test(d)) return 0.85;
    // RTX 30-series (Ampere)
    if (/rtx\s*30[89]0/.test(d)) return 0.85;
    if (/rtx\s*30[67]0/.test(d)) return 0.80;
    if (/rtx\s*30[56]0/.test(d)) return 0.75;
    // RTX 20-series (Turing)
    if (/rtx\s*20[89]0/.test(d)) return 0.80;
    if (/rtx\s*20[67]0/.test(d)) return 0.75;
    if (/rtx\s*20[56]0/.test(d)) return 0.70;
    // GTX 16-series
    if (/gtx\s*16[68]0/.test(d)) return 0.70;
    if (/gtx\s*16[50]0/.test(d)) return 0.65;
    // GTX 10-series
    if (/gtx\s*10[78]0/.test(d)) return 0.70;
    if (/gtx\s*10[56]0/.test(d)) return 0.65;
    // Anything else NVIDIA discrete
    return 0.75;
  }

  // ── AMD ───────────────────────────────────────────────────────
  if (vendor === "amd") {
    // RX 7900 series
    if (/7900/.test(d)) return 0.95;
    if (/7800/.test(d)) return 0.85;
    if (/7[67]00/.test(d)) return 0.80;
    if (/7[56]00/.test(d)) return 0.75;
    // RX 6000 series
    if (/6[89]00/.test(d)) return 0.85;
    if (/6[67]00/.test(d)) return 0.75;
    if (/6[56]00/.test(d)) return 0.70;
    // RX 5000 / older
    if (/5[67]00/.test(d)) return 0.70;
    return 0.75;
  }

  // ── Intel Arc ────────────────────────────────────────────────
  if (vendor === "intel") {
    if (/a7[78]0/.test(d)) return 0.75;
    if (/a[56]80/.test(d)) return 0.70;
    if (/a3[58]0/.test(d)) return 0.65;
    return 0.70;
  }

  // Unrecognised discrete — optimistic default.
  return 0.80;
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

    const gpuSub = computeGpuSub(vendor, maxBufferSize, maxTextureDimension2D, isIntegrated, device);

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
  let initialGpuCap     = lerpPow2(14, 20, h, 1.2);

  if (overrides.vramGB > 0) {
    const vramBytes = overrides.vramGB * 1_073_741_824; // 1 GiB
    const particleBudget = Math.floor(vramBytes * VRAM_BUDGET_FRACTION / BYTES_PER_PARTICLE);
    // Emergency cap: up to full VRAM budget, still capped at 20M absolute
    emergencyHitCap  = Math.min(particleBudget, 20_000_000);
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
    // maxVisibleHits: derived as 40% of emergencyHitCap so compound
    // budget clamps (e.g. random-settings safety) use a consistent
    // fraction of the VRAM budget rather than an independent curve.
    maxVisibleHits: Math.floor(emergencyHitCap * 0.4),

    maxPhysicsCostPerSec:   lerpInt(
      2_000_000,
      Math.max(1, Math.min(lerpInt(2, cpuCores - 2, cpuT), cpuCores - 2)) * 8_000_000,
      hEffective, 1.2,
    ),

    ppFractionCap:          lerp(1.5, 5.0, hEffective, 1.0),
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
  private _benchPromise: Promise<[GpuInfo, CpuBenchmarkResult]> | null = null;
  private _aborted = false;

  /**
   * Kick off CPU benchmark + GPU adapter query immediately.
   * Neither depends on renderPixels, so this can run in parallel
   * with screen detection.  Call finalize() once renderPixels is known.
   *
   * @param gpuAdapter  Optional pre-existing WebGPU adapter.
   */
  startBenchmarks(gpuAdapter?: GPUAdapter | null): void {
    if (this._benchPromise) return; // already started
    this._aborted = false;
    console.log("[hardware] Detecting hardware capabilities...");
    this._benchPromise = Promise.all([
      detectGpu(gpuAdapter),
      new Promise<CpuBenchmarkResult>((resolve) => {
        setTimeout(() => resolve(cpuBenchmark(() => this._aborted)), 0);
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
      benchmarkScore: benchResult.score,
      benchmarkDegraded: benchResult.degraded,
      benchSub: computeBenchSub(benchResult.score),
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

    const info: HardwareInfo = {
      cpu, gpu, tier,
      rawCapability: rawH,
      capability: rawH,
      renderPixels,
      budget, summary,
      overrides: noOverrides,
      gpuComputeBenchmark: null,
    };

    if (this._aborted) return info;

    this._info = info;

    console.log(`[hardware] ${summary}`);
    console.log(
      `[hardware] Sub-scores: bench=${(cpu.benchSub * 100).toFixed(0)}% ` +
      `cores=${(cpu.coresSub * 100).toFixed(0)}% ` +
      `gpu=${gpu.isIntegrated ? 'integrated' : 'discrete'} (${(gpu.gpuSub * 100).toFixed(0)}%)`,
    );
    if (benchResult.degraded) {
      console.warn("[hardware] CPU benchmark ended early; using degraded partial score");
    }
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

  /**
   * Benchmark GPU compute throughput by dispatching a simple compute shader
   * and measuring wall-clock time. Returns particles/second capability.
   *
   * Should be called after the renderer is initialized and a GPUDevice is
   * available. The result is stored on HardwareInfo.gpuComputeBenchmark.
   *
   * @param device  The GPUDevice to benchmark on.
   */
  async benchmarkGpuCompute(device: GPUDevice): Promise<GpuComputeBenchmark | null> {
    if (this._aborted) return null;
    try {
      const result = await runGpuComputeBenchmark(device, () => this._aborted);
      if (this._aborted) return null;
      if (this._info) {
        this._info = { ...this._info, gpuComputeBenchmark: result };
      }
      console.log(
        `[hardware] GPU compute benchmark: ${(result.particlesPerSec / 1000).toFixed(0)}K particles/s, ` +
        `optimal workgroup size: ${result.optimalWorkgroupSize}`,
      );
      return result;
    } catch (e) {
      console.warn("[hardware] GPU compute benchmark failed:", e);
      return null;
    }
  }

  dispose(): void {
    this._aborted = true;
    this._info = null;
    this._benchPromise = null;
  }
}

// ── GPU Compute Benchmark ────────────────────────────────────────────────

/**
 * Minimal WGSL shader that does the core per-particle work:
 * PCG PRNG, perturbation eval at lMax=8, bounceProps, visual encoding.
 * Writes a single f32 per invocation to prevent dead-code elimination.
 */
function makeBenchmarkShader(workgroupSize: number): string {
  return /* wgsl */`
struct BenchParams {
  count: u32,
  seed: u32,
};
@group(0) @binding(0) var<uniform> params: BenchParams;
@group(0) @binding(1) var<storage, read_write> out: array<f32>;

fn pcg(state: ptr<function, u32>) -> u32 {
  let old = *state;
  *state = old * 747796405u + 2891336453u;
  let word = ((old >> ((old >> 28u) + 4u)) ^ old) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand01(state: ptr<function, u32>) -> f32 {
  return f32(pcg(state)) / 4294967296.0;
}

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.count) { return; }

  var rng: u32 = params.seed ^ (idx * 2654435761u);

  // Sphere sampling
  let u1 = rand01(&rng);
  let u2 = rand01(&rng);
  let cosT = 1.0 - 2.0 * u1;
  let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  let phi = 6.283185307 * u2;

  // Fake perturbation eval (lMax=8 worth of trig + recurrence)
  var delta: f32 = 0.0;
  let cosPhi = cos(phi);
  let sinPhi = sin(phi);
  var pmm: f32 = 1.0;
  var cosMPhi: f32 = 1.0;
  var sinMPhi: f32 = 0.0;
  for (var m: u32 = 0u; m <= 8u; m = m + 1u) {
    if (m > 0u) {
      pmm *= -(f32(2u * m) - 1.0) * sinT;
      let c = cosMPhi * cosPhi - sinMPhi * sinPhi;
      let s = sinMPhi * cosPhi + cosMPhi * sinPhi;
      cosMPhi = c;
      sinMPhi = s;
    }
    var plm_curr: f32 = pmm;
    var plm_prev: f32 = 0.0;
    for (var l: u32 = m; l <= 8u; l = l + 1u) {
      if (l > m) {
        let plm_next = ((2.0 * f32(l) - 1.0) * cosT * plm_curr - (f32(l + m) - 1.0) * plm_prev) / f32(l - m);
        plm_prev = plm_curr;
        plm_curr = plm_next;
      }
      if (l >= 1u) {
        let norm = sqrt((2.0 * f32(l) + 1.0) * 0.07957747154594767 / max(1.0, f32(l)));
        delta += norm * plm_curr * cosMPhi * rand01(&rng);
      }
    }
  }

  // bounceProps
  let beta: f32 = 0.10;
  let betaEff = clamp(beta * (1.0 + delta * 0.1), 0.002, 0.2499);
  let disc = sqrt(max(0.0, 1.0 - 4.0 * betaEff));
  let a2 = (1.0 - disc) / 2.0;
  let a = sqrt(a2);
  let eps = 1.0 / (a2 * a2);
  let acc = -1.0 / (a2 * a) + (2.0 * betaEff) / (a2 * a2 * a);
  let wDenom = 3.0 * (a2 - betaEff);
  var wEff: f32 = -1.0;
  if (abs(wDenom) > 1e-12) {
    wEff = (a2 - 3.0 * betaEff) / wDenom;
  }

  // Visual encoding (same math as production shader)
  let brightness = clamp(log(eps + 1.0) / 9.210440366976517, 0.0, 1.0);
  let normAcc = clamp(acc / max(1e-6, abs(acc) + 1.0), 0.0, 1.0);
  let theta = acos(cosT);
  let lx = 2.0 * sin(theta / 2.0) * cos(phi);
  let ly = 2.0 * sin(theta / 2.0) * sin(phi);

  // Write result to prevent dead-code elimination
  out[idx] = lx + ly + brightness + wEff + normAcc;
}
`;
}

const BENCH_PARTICLE_COUNT = 10_000;
const BENCH_ITERATIONS = 3;
const BENCH_WORKGROUP_SIZES = [32, 64, 128, 256];

async function runGpuComputeBenchmark(
  device: GPUDevice,
  isAborted: () => boolean = () => false,
): Promise<GpuComputeBenchmark> {
  const BUF_UNIFORM  = 0x0040;
  const BUF_STORAGE  = 0x0080;
  const BUF_COPY_DST = 0x0008;

  // Determine max workgroup size supported
  const maxWgSize = device.limits.maxComputeWorkgroupSizeX ?? 256;
  const sizesToTest = BENCH_WORKGROUP_SIZES.filter(s => s <= maxWgSize);
  if (sizesToTest.length === 0) sizesToTest.push(32);

  // Create output buffer (shared across all sizes)
  const outBuffer = device.createBuffer({
    size: BENCH_PARTICLE_COUNT * 4,
    usage: BUF_STORAGE,
  });

  // Create params buffer
  const paramsBuffer = device.createBuffer({
    size: 8, // count (u32) + seed (u32)
    usage: BUF_UNIFORM | BUF_COPY_DST,
  });
  const paramData = new Uint32Array([BENCH_PARTICLE_COUNT, 42]);
  device.queue.writeBuffer(paramsBuffer, 0, paramData);

  let bestRate = 0;
  let bestSize = sizesToTest[0];

  for (const wgSize of sizesToTest) {
    if (isAborted()) break;
    const module = device.createShaderModule({ code: makeBenchmarkShader(wgSize) });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: outBuffer } },
      ],
    });

    const dispatchCount = Math.ceil(BENCH_PARTICLE_COUNT / wgSize);
    const times: number[] = [];

    // Warm-up run
    {
      if (isAborted()) break;
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(dispatchCount);
      pass.end();
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
    }

    // Timed runs
    for (let i = 0; i < BENCH_ITERATIONS; i++) {
      if (isAborted()) break;
      const t0 = performance.now();
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(dispatchCount);
      pass.end();
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      const t1 = performance.now();
      times.push(t1 - t0);
    }

    if (times.length === 0) continue;

    // Take the median time
    times.sort((a, b) => a - b);
    const medianMs = times[Math.floor(times.length / 2)];
    const rate = medianMs > 0 ? (BENCH_PARTICLE_COUNT / medianMs) * 1000 : 0;

    if (rate > bestRate) {
      bestRate = rate;
      bestSize = wgSize;
    }
  }

  // Cleanup
  outBuffer.destroy();
  paramsBuffer.destroy();

  return {
    particlesPerSec: Math.round(bestRate),
    optimalWorkgroupSize: bestSize,
  };
}
