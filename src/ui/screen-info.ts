/**
 * screen-info.ts — Comprehensive screen capability detection.
 *
 * Detects (where supported by the browser):
 *   - Physical resolution & device pixel ratio
 *   - Effective render resolution
 *   - Refresh rate (measured via rAF timing; VRR-aware)
 *   - Display category (phone / 720p / 1080p / 1440p / 4K / 5K / 8K)
 *   - Orientation (landscape / portrait)
 *   - HDR capability (dynamic-range: high media query)
 *   - Color gamut (sRGB / P3 / Rec.2020)
 *   - Peak brightness estimate (Screen Details API where available)
 *   - VRR detection heuristic (frame-time variance analysis)
 *   - Touch capability (pointer: coarse)
 *
 * All detection is progressive: unsupported features gracefully fall back
 * to sensible defaults so the simulation always works.
 *
 * The ScreenDetector class fires onChange callbacks on:
 *   - Window resize / orientation change
 *   - DPR change (moving between monitors)
 *   - Refresh rate change (monitor switch / VRR shift)
 *   - HDR capability change
 *
 * Usage:
 *   const detector = new ScreenDetector();
 *   const info = await detector.init();
 *   detector.onChange(si => { ... });
 */

// ── Types ─────────────────────────────────────────────────────────────────

export interface ScreenInfo {
  // ── Resolution ────────────────────────────────────
  /** Physical screen pixels wide (screen.width × DPR) */
  screenWidth: number;
  /** Physical screen pixels high (screen.height × DPR) */
  screenHeight: number;
  /** Browser viewport CSS pixels wide */
  viewportWidth: number;
  /** Browser viewport CSS pixels high */
  viewportHeight: number;
  /** Device pixel ratio (e.g. 1, 1.25, 1.5, 2, 3) */
  dpr: number;
  /** Effective render resolution wide (viewport × DPR, before any cap) */
  renderWidth: number;
  /** Effective render resolution high (viewport × DPR, before any cap) */
  renderHeight: number;

  // ── Refresh rate ──────────────────────────────────
  /** Detected refresh rate in Hz (snapped to nearest common value) */
  refreshRate: number;
  /** Raw measured frame interval in ms */
  measuredFrameInterval: number;
  /** Whether VRR (FreeSync / G-Sync / adaptive) is probably active */
  vrrDetected: boolean;
  /** Estimated VRR range [min, max] Hz — null if not VRR or unknown */
  vrrRange: [number, number] | null;

  // ── Display classification ────────────────────────
  /** Display category string (e.g. "Phone", "1440p", "4K HDR") */
  category: string;
  /** Orientation: "landscape" | "portrait" | "square" */
  orientation: "landscape" | "portrait" | "square";
  /** Whether this is likely a mobile/touch device */
  isMobile: boolean;

  // ── HDR & color ───────────────────────────────────
  /** Whether the display supports HDR (high dynamic range) */
  hdrCapable: boolean;
  /** Color gamut of the display */
  colorGamut: "srgb" | "p3" | "rec2020";
  /**
   * Estimated peak brightness in nits (cd/m²).
   * - null if unknown (most browsers)
   * - From Screen Details API on Chrome 100+ (experimental)
   * Typical values: SDR ~300, HDR TV 600-2000, OLED 1000+
   */
  peakBrightnessNits: number | null;
  /** Color depth in bits per channel (8 = SDR, 10/12 = HDR) */
  colorDepth: number;

  // ── Summary ───────────────────────────────────────
  /** Human-readable one-line summary */
  summary: string;
}

export type ScreenChangeCallback = (info: ScreenInfo) => void;

interface DetailedScreenLike {
  width?: number;
  height?: number;
  devicePixelRatio?: number;
  refreshRate?: number;
  label?: string;
  isInternal?: boolean;
  isPrimary?: boolean;
  addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

interface ScreenDetailsLike {
  currentScreen?: DetailedScreenLike;
  screens?: DetailedScreenLike[];
  addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

interface NativeRefreshRateInfo {
  rate: number;
  source: "current-screen" | "window-screen";
}

interface ScreenMetrics {
  screenWidth: number;
  screenHeight: number;
  dpr: number;
  renderWidth: number;
  renderHeight: number;
}

interface ExtendedScreenLike {
  isExtended?: boolean;
}

// ── Common refresh rates (for snapping measured values) ───────────────────

const COMMON_RATES = [24, 25, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240, 300, 360, 480];

function snapToCommonRate(measuredHz: number): number {
  let best = 60;
  let bestDist = Infinity;
  for (const rate of COMMON_RATES) {
    const dist = Math.abs(measuredHz - rate);
    if (dist < bestDist) {
      bestDist = dist;
      best = rate;
    }
  }
  // Only snap if within 8% of a known rate; otherwise just round
  if (bestDist / best > 0.08) return Math.round(measuredHz);
  return best;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && isFinite(value) && value > 0 ? value : null;
}

export function resolveNativeRefreshRate(
  currentScreen?: DetailedScreenLike | null,
  fallbackScreen?: DetailedScreenLike | null,
  allowWindowScreenFallback = true,
): NativeRefreshRateInfo | null {
  const currentRate = readPositiveNumber(currentScreen?.refreshRate);
  if (currentRate !== null) {
    return { rate: currentRate, source: "current-screen" };
  }

  if (!allowWindowScreenFallback) {
    return null;
  }

  const fallbackRate = readPositiveNumber(fallbackScreen?.refreshRate);
  if (fallbackRate !== null) {
    return { rate: fallbackRate, source: "window-screen" };
  }

  return null;
}

export function resolveScreenMetrics(
  currentScreen?: DetailedScreenLike | null,
  fallbackWindowScreen?: Pick<Screen, "width" | "height"> | null,
  viewport?: { width: number; height: number },
  fallbackDpr?: number,
): ScreenMetrics {
  const dpr = readPositiveNumber(currentScreen?.devicePixelRatio) ??
    readPositiveNumber(fallbackDpr) ??
    1;
  const screenWidthCss = readPositiveNumber(currentScreen?.width) ?? fallbackWindowScreen?.width ?? 0;
  const screenHeightCss = readPositiveNumber(currentScreen?.height) ?? fallbackWindowScreen?.height ?? 0;
  const viewportWidth = viewport?.width ?? 0;
  const viewportHeight = viewport?.height ?? 0;

  return {
    screenWidth: Math.round(screenWidthCss * dpr),
    screenHeight: Math.round(screenHeightCss * dpr),
    dpr,
    renderWidth: Math.round(viewportWidth * dpr),
    renderHeight: Math.round(viewportHeight * dpr),
  };
}

// ── Display category ──────────────────────────────────────────────────────

function classifyDisplay(w: number, h: number, isMobile: boolean, hdr: boolean): string {
  const maxDim = Math.max(w, h);
  const minDim = Math.min(w, h);

  let base: string;
  if (isMobile) {
    base = "Phone";
  } else if (maxDim >= 7680 && minDim >= 4320) {
    base = "8K (4320p)";
  } else if (maxDim >= 5120 && minDim >= 2880) {
    base = "5K";
  } else if (maxDim >= 3840 && minDim >= 2160) {
    base = "4K (2160p)";
  } else if (maxDim >= 3440 && minDim >= 1440) {
    base = "Ultrawide 1440p";
  } else if (maxDim >= 2560 && minDim >= 1440) {
    base = "1440p";
  } else if (maxDim >= 1920 && minDim >= 1080) {
    base = "1080p";
  } else if (maxDim >= 1280 && minDim >= 720) {
    base = "720p";
  } else if (maxDim >= 640) {
    base = "SD";
  } else {
    base = `${w}×${h}`;
  }

  return hdr ? `${base} HDR` : base;
}

// ── Orientation ───────────────────────────────────────────────────────────

function detectOrientation(w: number, h: number): "landscape" | "portrait" | "square" {
  const ratio = w / h;
  if (ratio > 1.05) return "landscape";
  if (ratio < 0.95) return "portrait";
  return "square";
}

// ── Mobile detection ──────────────────────────────────────────────────────

function detectMobile(): boolean {
  // Primary: coarse pointer = touch
  if (window.matchMedia("(pointer: coarse)").matches) return true;
  // Secondary: small screen + high DPR (typical phone pattern)
  if (window.screen.width <= 480 && window.devicePixelRatio >= 2) return true;
  // Tertiary: touch points
  if (navigator.maxTouchPoints > 0 && window.screen.width <= 768) return true;
  return false;
}

// ── HDR detection ─────────────────────────────────────────────────────────

function detectHDR(): boolean {
  // CSS media query — widest browser support (Chrome 98+, Safari 15.4+, Firefox 100+)
  if (window.matchMedia("(dynamic-range: high)").matches) return true;
  // Fallback: video-dynamic-range (less common but covers some edge cases)
  if (window.matchMedia("(video-dynamic-range: high)").matches) return true;
  return false;
}

// ── Color gamut detection ─────────────────────────────────────────────────

function detectColorGamut(): "srgb" | "p3" | "rec2020" {
  // Check widest first, narrow down
  if (window.matchMedia("(color-gamut: rec2020)").matches) return "rec2020";
  if (window.matchMedia("(color-gamut: p3)").matches) return "p3";
  return "srgb";
}

// ── Color depth ───────────────────────────────────────────────────────────

function detectColorDepth(): number {
  // screen.colorDepth gives total bits (24 = 8/ch, 30 = 10/ch, 48 = 16/ch)
  const total = window.screen.colorDepth || 24;
  return Math.round(total / 3);
}

// ── Peak brightness (experimental) ────────────────────────────────────────

/**
 * Attempt to read peak luminance via the Screen Details API (Chrome 100+).
 * This is still experimental and not available in most browsers, but when
 * present it gives actual screen capability in nits.
 *
 * Falls back to null if the API isn't available.
 */
async function detectPeakBrightness(hdrCapable: boolean): Promise<number | null> {
  // Try the Window Management API (getScreenDetails)
  // This requires the "window-management" permission
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const screenDetails = await (window as any).getScreenDetails?.();
    if (screenDetails?.currentScreen) {
      const cs = screenDetails.currentScreen;
      // Chrome exposes highDynamicRangeHeadroom as a multiplier over SDR white
      // e.g. 4.0 means peak = 4× SDR white ≈ 4 × 203 nits (BT.2408 ref) ≈ 812 nits
      if (typeof cs.highDynamicRangeHeadroom === "number" && cs.highDynamicRangeHeadroom > 0) {
        const SDR_WHITE_NITS = 203; // BT.2408 reference
        return Math.round(cs.highDynamicRangeHeadroom * SDR_WHITE_NITS);
      }
      // Some older Chrome builds used a different property name
      if (typeof cs.hdrHeadroom === "number" && cs.hdrHeadroom > 0) {
        const SDR_WHITE_NITS = 203;
        return Math.round(cs.hdrHeadroom * SDR_WHITE_NITS);
      }
    }
  } catch {
    // Permission denied or API not available — expected on most browsers
  }

  // Cannot determine nits — return null; consumers use hdrCapable flag instead
  return null;
}

async function getScreenDetails(): Promise<ScreenDetailsLike | null> {
  try {
    const details = await (window as Window & { getScreenDetails?: () => Promise<ScreenDetailsLike> }).getScreenDetails?.();
    return details ?? null;
  } catch {
    return null;
  }
}

// ── VRR detection heuristic ───────────────────────────────────────────────

interface RefreshMeasurement {
  hz: number;
  intervalMs: number;
  vrrDetected: boolean;
  vrrRange: [number, number] | null;
}

function isExtendedDesktop(screenLike?: ExtendedScreenLike | null): boolean {
  return Boolean(screenLike?.isExtended);
}

function isNearMultiple(higherHz: number, lowerHz: number): boolean {
  if (lowerHz <= 0) return false;
  const ratio = higherHz / lowerHz;
  const rounded = Math.round(ratio);
  return rounded >= 2 && rounded <= 4 && Math.abs(ratio - rounded) <= 0.08;
}

export function resolveMeasuredRefreshRate(
  pass1: RefreshMeasurement,
  pass2: RefreshMeasurement,
  preferConservativeRate: boolean,
): number {
  if (pass1.hz === pass2.hz) {
    return pass1.hz;
  }

  const higherHz = Math.max(pass1.hz, pass2.hz);
  const lowerHz = Math.min(pass1.hz, pass2.hz);

  if (preferConservativeRate && isNearMultiple(higherHz, lowerHz)) {
    return lowerHz;
  }

  return higherHz;
}

/**
 * Try to read the native screen refresh rate from the browser.
 * Chrome 110+ exposes `screen.refreshRate` (behind flag or origin trial).
 * Falls back to null if not available.
 */
function nativeRefreshRate(currentScreen?: DetailedScreenLike | null): NativeRefreshRateInfo | null {
  const native = resolveNativeRefreshRate(
    currentScreen,
    window.screen as DetailedScreenLike,
    !isExtendedDesktop(window.screen as Screen & ExtendedScreenLike),
  );
  if (native !== null) {
    console.log(`[screen] Native ${native.source}.refreshRate = ${native.rate} Hz`);
  } else if (isExtendedDesktop(window.screen as Screen & ExtendedScreenLike)) {
    console.log("[screen] Ignoring generic window.screen.refreshRate on extended desktop; using per-screen/rAF detection only");
  }
  return native;
}

/**
 * Single rAF measurement pass — collects frame intervals.
 * Uses a larger sample count (60) and skips warmup frames.
 */
function singleMeasurementPass(sampleCount = 60, warmupFrames = 10): Promise<number[]> {
  return new Promise((resolve) => {
    const samples: number[] = [];
    let prev = 0;
    let frame = 0;

    function tick(ts: number) {
      if (prev > 0) {
        frame++;
        const dt = ts - prev;
        // Skip warmup frames and reject extreme outliers (tab switch, GC pause)
        if (frame > warmupFrames && dt > 1.5 && dt < 60) {
          samples.push(dt);
        }
      }
      prev = ts;

      if (samples.length < sampleCount && frame < sampleCount + warmupFrames + 20) {
        requestAnimationFrame(tick);
      } else {
        resolve(samples);
      }
    }

    requestAnimationFrame(tick);
  });
}

/**
 * Analyse a set of frame-interval samples and return the Hz + VRR info.
 * Uses a trimmed mean (discarding top/bottom 10%) for robustness.
 */
function analyseIntervals(samples: number[]): RefreshMeasurement {
  if (samples.length < 8) {
    return { hz: 60, intervalMs: 16.667, vrrDetected: false, vrrRange: null };
  }

  // Sort ascending
  const sorted = [...samples].sort((a, b) => a - b);

  // Trimmed mean: drop bottom 10% and top 10%
  const trimLow = Math.floor(sorted.length * 0.1);
  const trimHigh = sorted.length - trimLow;
  const trimmed = sorted.slice(trimLow, trimHigh);

  const trimmedMean = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
  const hz = 1000 / trimmedMean;
  const snappedHz = snapToCommonRate(hz);

  // Also get median for the interval report
  const median = sorted[Math.floor(sorted.length / 2)];

  // VRR detection: coefficient of variation on the trimmed set
  const variance = trimmed.reduce((s, v) => s + (v - trimmedMean) ** 2, 0) / trimmed.length;
  const stddev = Math.sqrt(variance);
  const cv = stddev / trimmedMean;

  const vrrDetected = cv >= 0.05;
  let vrrRange: [number, number] | null = null;

  if (vrrDetected) {
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const highHz = Math.round(1000 / p10);
    const lowHz = Math.round(1000 / p90);
    vrrRange = [Math.max(lowHz, 24), Math.min(highHz, 500)];
  }

  console.log(
    `[screen] Refresh pass: ${snappedHz} Hz (trimmed mean ${trimmedMean.toFixed(2)}ms, median ${median.toFixed(2)}ms), ` +
    `CV=${cv.toFixed(3)}${vrrDetected ? ` → VRR detected (est. ${vrrRange![0]}-${vrrRange![1]} Hz)` : " → fixed rate"}`
  );

  return { hz: snappedHz, intervalMs: median, vrrDetected, vrrRange };
}

/**
 * Measures refresh rate using a robust multi-pass approach:
 * 1. Check native screen.refreshRate API (Chrome 110+) — instant & accurate.
 * 2. Fall back to two rAF measurement passes, each with 60 samples + warmup.
 *    If both passes agree, use that value.  If they disagree, prefer the
 *    higher rate (more likely the true rate; lower is usually from load).
 *
 * Also analyses frame-time variance to detect VRR (variable refresh rate).
 */
function measureRefreshRate(currentScreen?: DetailedScreenLike | null): Promise<RefreshMeasurement> {
  return new Promise(async (resolve) => {
    // ── Attempt 1: native API (instant, most reliable) ──────────
    const native = nativeRefreshRate(currentScreen);
    if (native !== null) {
      const snapped = snapToCommonRate(native.rate);
      // Still do a quick rAF pass for VRR detection
      const samples = await singleMeasurementPass(40, 5);
      const analysis = analyseIntervals(samples);
      resolve({
        hz: snapped,
        intervalMs: 1000 / snapped,
        vrrDetected: analysis.vrrDetected,
        vrrRange: analysis.vrrRange,
      });
      return;
    }

    // ── Attempt 2: two rAF measurement passes with consensus ────
    const samples1 = await singleMeasurementPass(60, 10);
    const pass1 = analyseIntervals(samples1);

    const samples2 = await singleMeasurementPass(60, 5);
    const pass2 = analyseIntervals(samples2);

    let finalHz: number;
    if (pass1.hz === pass2.hz) {
      // Both passes agree — high confidence
      finalHz = pass1.hz;
      console.log(`[screen] Both passes agree: ${finalHz} Hz`);
    } else {
      const preferConservativeRate = isExtendedDesktop(window.screen as Screen & ExtendedScreenLike);
      finalHz = resolveMeasuredRefreshRate(pass1, pass2, preferConservativeRate);
      const strategy = finalHz === Math.min(pass1.hz, pass2.hz)
        ? "using lower harmonic on extended desktop"
        : "using higher";
      console.log(
        `[screen] Passes disagree (${pass1.hz} vs ${pass2.hz} Hz) → ${strategy}: ${finalHz} Hz`
      );
    }

    // Merge VRR info from the more stable pass (lower CV = better data)
    const bestPass = (pass1.vrrDetected === pass2.vrrDetected)
      ? pass1  // both agree on VRR status, use first
      : (pass1.intervalMs < pass2.intervalMs ? pass1 : pass2);

    resolve({
      hz: finalHz,
      intervalMs: bestPass.intervalMs,
      vrrDetected: bestPass.vrrDetected,
      vrrRange: bestPass.vrrRange,
    });
  });
}

// ── Build info snapshot ───────────────────────────────────────────────────

function buildInfo(
  refresh: RefreshMeasurement,
  hdrCapable: boolean,
  colorGamut: "srgb" | "p3" | "rec2020",
  peakNits: number | null,
  currentScreen?: DetailedScreenLike | null,
): ScreenInfo {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const metrics = resolveScreenMetrics(
    currentScreen,
    window.screen,
    { width: vw, height: vh },
    window.devicePixelRatio,
  );
  const { dpr, screenWidth: sw, screenHeight: sh, renderWidth: rw, renderHeight: rh } = metrics;

  const isMobile = detectMobile();
  const orientation = detectOrientation(sw, sh);
  const colorDepth = detectColorDepth();
  const category = classifyDisplay(sw, sh, isMobile, hdrCapable);

  // Build summary string
  const parts = [
    `Screen: ${sw}×${sh} (${category})`,
    `Viewport: ${vw}×${vh}`,
    `DPR: ${dpr.toFixed(2)}`,
    `Render: ${rw}×${rh}`,
    `${refresh.hz} Hz${refresh.vrrDetected ? " VRR" : ""}`,
  ];
  if (hdrCapable) {
    parts.push(`HDR/${colorGamut.toUpperCase()}`);
    if (peakNits !== null) parts.push(`~${peakNits} nits`);
  }
  if (isMobile) parts.push("Mobile");

  return {
    screenWidth: sw,
    screenHeight: sh,
    viewportWidth: vw,
    viewportHeight: vh,
    dpr,
    renderWidth: rw,
    renderHeight: rh,
    refreshRate: refresh.hz,
    measuredFrameInterval: refresh.intervalMs,
    vrrDetected: refresh.vrrDetected,
    vrrRange: refresh.vrrRange,
    category,
    orientation,
    isMobile,
    hdrCapable,
    colorGamut,
    peakBrightnessNits: peakNits,
    colorDepth,
    summary: parts.join(" · "),
  };
}

// ── Scaling helpers ───────────────────────────────────────────────────────

/**
 * Recommended pixel-ratio cap for the renderer.
 *
 * Strategy:
 *   - Phones (DPR 2-3, small screen): cap at DPR itself — phones need it
 *   - Low res (≤720p): cap at 1 — every pixel counts
 *   - 1080p: cap at 1.5 — saves GPU, minor visual difference
 *   - 1440p: cap at 2
 *   - 4K: cap at 2 (8M effective pixels is plenty)
 *   - 5K/8K: cap at 1.5 (already extremely dense, diminishing returns)
 */
export function recommendedPixelRatioCap(info: ScreenInfo): number {
  if (info.isMobile) {
    // Phones: honour native DPR (usually 2 or 3) — text/UI needs sharpness
    return Math.min(info.dpr, 3);
  }

  const maxDim = Math.max(info.screenWidth, info.screenHeight);
  if (maxDim >= 7680) return 1.5;   // 8K — already extremely dense
  if (maxDim >= 5120) return 1.5;   // 5K
  if (maxDim >= 3840) return 2;     // 4K
  if (maxDim >= 2560) return 2;     // 1440p
  if (maxDim >= 1920) return 1.5;   // 1080p
  if (maxDim >= 1280) return 1;     // 720p
  return 1;                          // very low res
}

/**
 * Display-density scaling factor for hit sizes.
 * Reference baseline: 1440p at DPR 1 ⇒ scale = 1.0.
 * Higher resolution / DPR → slightly larger particles so they stay visible.
 * Phones get a boost because the viewport is physically small.
 */
export function hitSizeScale(info: ScreenInfo): number {
  const baseline = 1440;
  const limitingRenderAxis = Math.min(info.renderWidth, info.renderHeight);
  const ratio = limitingRenderAxis / baseline;

  // Scale against the limiting axis because the simulation disk is fitted to
  // the shorter viewport side. This keeps particle footprints stable when the
  // device rotates between portrait and landscape.
  return Math.max(0.5, Math.sqrt(ratio));
}

/**
 * Recommended tone mapping exposure based on HDR capability.
 * Only used for the SDR and soft-HDR paths (ACES / Linear tone mapping).
 * The full-HDR path uses NoToneMapping with nits-based color encoding.
 */
export function recommendedExposure(info: ScreenInfo): number {
  if (!info.hdrCapable) return 1.0;

  if (info.peakBrightnessNits !== null && info.peakBrightnessNits >= 1000) {
    return 1.4; // bright HDR panel → more headroom for bloom
  }
  return 1.2; // modest HDR
}

// ── HDR helpers ───────────────────────────────────────────────────────────

/**
 * BT.2408 SDR reference white level in nits (cd/m²).
 * On an HDR display, canvas pixel value 1.0 maps to this brightness.
 * Values above 1.0 (in an extended-range canvas) are brighter than SDR white.
 */
export const SDR_REFERENCE_WHITE_NITS = 203;

/**
 * Default assumed peak brightness when the Screen Details API
 * cannot report the display's actual peak luminance.
 * 800 nits is typical for a mid-range HDR laptop/monitor.
 */
export const DEFAULT_HDR_PEAK_NITS = 800;

/**
 * Eps threshold for the dim end of the HDR nits ramp.
 * Corresponds to β ≈ 0.20 (low energy, strong torsion).
 */
const EPS_DIM = 10;
/**
 * Eps threshold for the bright end of the HDR nits ramp.
 * Corresponds to a_min = 0.1 (eps = 10 000).
 */
const EPS_BRIGHT = 10_000;

/**
 * Map physics energy density to display luminance in nits.
 *
 * Uses a **linear** mapping from eps (energy density at bounce, 1/a_min⁴)
 * to nits so that HDR brightness is directly proportional to the physics
 * parameter — no log compression, no gamma.  The display shows actual
 * physical energy density as actual display brightness.
 *
 * eps spans a huge range (~13 at β=0.20 to ~10 000+ at β→0), so we
 * clamp and linearly map within a reasonable range:
 *   - eps ≤ EPS_DIM   (≈10)  → minNits  (dim glow, well above black)
 *   - eps ≥ EPS_BRIGHT (≈10 000) → peakNits (display peak)
 *   - In between: linear interpolation
 *
 * @param eps       Raw physics energy density 1/a_min⁴
 * @param peakNits  Display peak luminance in nits
 * @param minNits   Floor luminance for the dimmest particles
 */
export function epsToNits(
  eps: number,
  peakNits: number,
  minNits = 20,
  epsDim = EPS_DIM,
  epsBright = EPS_BRIGHT,
): number {
  const range = epsBright - epsDim;
  const t = range > 0
    ? Math.max(0, Math.min(1, (eps - epsDim) / range))
    : 0.5;
  return minNits + t * (peakNits - minNits);
}

// ── Detector class ────────────────────────────────────────────────────────

export class ScreenDetector {
  private _info!: ScreenInfo;
  private _callbacks: ScreenChangeCallback[] = [];
  private _refresh!: RefreshMeasurement;
  private _hdrCapable = false;
  private _colorGamut: "srgb" | "p3" | "rec2020" = "srgb";
  private _peakNits: number | null = null;
  private _screenDetails: ScreenDetailsLike | null = null;
  private _currentScreen: DetailedScreenLike | null = null;
  private _initialized = false;
  private _remeasureTimer: ReturnType<typeof setTimeout> | null = null;
  private _screenDetailsHandler = () => this._onDisplayChange();
  private _currentScreenHandler = () => this._onDisplayChange();

  /**
   * One-time async initialization.
   * Measures refresh rate (~30 frames ≈ 250-500ms depending on Hz),
   * probes HDR / gamut / brightness in parallel.
   */
  async init(): Promise<ScreenInfo> {
    this._screenDetails = await getScreenDetails();
    this._currentScreen = this._screenDetails?.currentScreen ?? null;

    // Run refresh measurement and static detection concurrently
    const [refresh] = await Promise.all([
      measureRefreshRate(this._currentScreen),
      this._detectDisplayCapabilities(),
    ]);

    this._refresh = refresh;
    this._info = buildInfo(refresh, this._hdrCapable, this._colorGamut, this._peakNits, this._currentScreen);
    this._initialized = true;

    // Listen for resize / orientation changes
    window.addEventListener("resize", () => this._onResize());
    window.addEventListener("orientationchange", () => this._onResize());

    // DPR changes (e.g. dragging to a different monitor)
    this._watchDpr();

    // Screen object changes are the most direct signal that the window moved
    // to a different monitor, even when the viewport size does not change.
    (window.screen as Screen & {
      addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
    }).addEventListener?.("change", this._screenDetailsHandler);

    this._watchScreenDetails();

    // HDR media query changes (e.g. user toggles HDR in display settings)
    const mqHdr = window.matchMedia("(dynamic-range: high)");
    mqHdr.addEventListener("change", () => this._onHdrChange());

    console.log(`[screen] ${this._info.summary}`);
    return this._info;
  }

  /** Current screen info snapshot. */
  get info(): ScreenInfo {
    if (!this._initialized) {
      const fallback: RefreshMeasurement = {
        hz: 60, intervalMs: 16.667,
        vrrDetected: false, vrrRange: null,
      };
      return buildInfo(fallback, false, "srgb", null);
    }
    return this._info;
  }

  /** Register a callback for screen/display changes. */
  onChange(cb: ScreenChangeCallback): void {
    this._callbacks.push(cb);
  }

  /** Force a re-measurement of refresh rate. */
  async remeasureRefreshRate(): Promise<void> {
    this._currentScreen = this._screenDetails?.currentScreen ?? this._currentScreen;
    const refresh = await measureRefreshRate(this._currentScreen);
    const changed = refresh.hz !== this._refresh.hz ||
                    refresh.vrrDetected !== this._refresh.vrrDetected;
    if (changed) {
      console.log(
        `[screen] Refresh changed: ${this._refresh.hz} Hz → ${refresh.hz} Hz` +
        (refresh.vrrDetected && refresh.vrrRange
          ? ` (VRR ${refresh.vrrRange[0]}-${refresh.vrrRange[1]} Hz)` : "")
      );
    }
    this._refresh = refresh;
    if (changed) this._update();
  }

  // ── Internal: detect static display features ─────────────────────

  private async _detectDisplayCapabilities(): Promise<void> {
    this._hdrCapable = detectHDR();
    this._colorGamut = detectColorGamut();
    if (this._screenDetails === null) {
      this._screenDetails = await getScreenDetails();
    }
    this._currentScreen = this._screenDetails?.currentScreen ?? this._currentScreen;
    this._peakNits = await detectPeakBrightness(this._hdrCapable);

    if (this._hdrCapable) {
      console.log(
        `[screen] HDR: yes, gamut: ${this._colorGamut}, depth: ${detectColorDepth()}bit/ch` +
        (this._peakNits ? `, peak: ~${this._peakNits} nits` : "")
      );
    }
  }

  // ── Internal: DPR watcher ─────────────────────────────────────────
  // matchMedia("(resolution: Xdppx)") fires "change" once when DPR
  // shifts away from X. Re-register for the new DPR each time.

  private _dprMq: MediaQueryList | null = null;
  private _dprHandler = () => this._onDisplayChange();

  private _watchDpr(): void {
    if (this._dprMq) {
      this._dprMq.removeEventListener("change", this._dprHandler);
    }
    this._dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this._dprMq.addEventListener("change", this._dprHandler);
  }

  private _watchScreenDetails(): void {
    this._screenDetails?.removeEventListener?.("currentscreenchange", this._screenDetailsHandler);
    this._screenDetails?.addEventListener?.("currentscreenchange", this._screenDetailsHandler);

    this._currentScreen?.removeEventListener?.("change", this._currentScreenHandler);
    this._currentScreen = this._screenDetails?.currentScreen ?? this._currentScreen;
    this._currentScreen?.addEventListener?.("change", this._currentScreenHandler);
  }

  // ── Event handlers ────────────────────────────────────────────────

  private _onResize(): void {
    this._update();
    // Re-measure refresh rate after resize settles (monitor switch)
    if (this._remeasureTimer) clearTimeout(this._remeasureTimer);
    this._remeasureTimer = setTimeout(() => this.remeasureRefreshRate(), 600);
  }

  private _onDisplayChange(): void {
    console.log(`[screen] Display change detected → DPR ${window.devicePixelRatio}`);
    this._watchDpr(); // re-register for the new DPR value
    this._update();
    // Re-measure refresh rate + re-detect HDR (new monitor may differ)
    setTimeout(async () => {
      this._screenDetails = await getScreenDetails();
      this._watchScreenDetails();
      await this._detectDisplayCapabilities();
      await this.remeasureRefreshRate();
      this._update();
    }, 400);
  }

  private _onHdrChange(): void {
    const wasHdr = this._hdrCapable;
    this._hdrCapable = detectHDR();
    this._colorGamut = detectColorGamut();
    if (wasHdr !== this._hdrCapable) {
      console.log(`[screen] HDR capability changed: ${wasHdr} → ${this._hdrCapable}`);
      detectPeakBrightness(this._hdrCapable).then((nits) => {
        this._peakNits = nits;
        this._update();
      });
    }
    this._update();
  }

  private _update(): void {
    this._currentScreen = this._screenDetails?.currentScreen ?? this._currentScreen;
    this._info = buildInfo(this._refresh, this._hdrCapable, this._colorGamut, this._peakNits, this._currentScreen);
    for (const cb of this._callbacks) {
      try { cb(this._info); } catch (e) { console.warn("[screen] callback error:", e); }
    }
  }
}
