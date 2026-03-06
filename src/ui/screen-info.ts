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

// ── VRR detection heuristic ───────────────────────────────────────────────

interface RefreshMeasurement {
  hz: number;
  intervalMs: number;
  vrrDetected: boolean;
  vrrRange: [number, number] | null;
}

/**
 * Measures refresh rate by timing requestAnimationFrame over ~30 frames.
 * Also analyses frame-time variance to detect VRR (variable refresh rate).
 *
 * VRR heuristic: on a fixed-rate display, frame intervals cluster tightly
 * around 1/rate (±0.5ms jitter). On VRR, the compositor may deliver frames
 * at varying intervals when the GPU finishes at different times.
 * We check the coefficient of variation (CV = stddev/mean):
 *   - CV < 0.05 → fixed rate (consistent intervals)
 *   - CV ≥ 0.05 → likely VRR (variable intervals)
 *
 * Note: this is a heuristic. A heavily loaded fixed-rate display can also
 * show variance. But for our purposes (choosing render strategies), it's
 * good enough.
 */
function measureRefreshRate(): Promise<RefreshMeasurement> {
  return new Promise((resolve) => {
    const samples: number[] = [];
    const SAMPLE_COUNT = 30;
    let prev = 0;
    let count = 0;

    function tick(ts: number) {
      if (prev > 0) {
        const dt = ts - prev;
        // Reject extreme outliers (tab switch, GC pause, warmup noise)
        if (dt > 1.5 && dt < 60) {
          samples.push(dt);
        }
        count++;
      }
      prev = ts;

      if (count < SAMPLE_COUNT + 5) {
        requestAnimationFrame(tick);
      } else {
        if (samples.length < 8) {
          resolve({
            hz: 60, intervalMs: 16.667,
            vrrDetected: false, vrrRange: null,
          });
          return;
        }

        // Sort for median
        samples.sort((a, b) => a - b);
        const median = samples[Math.floor(samples.length / 2)];
        const hz = 1000 / median;
        const snappedHz = snapToCommonRate(hz);

        // VRR detection: check coefficient of variation
        const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
        const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
        const stddev = Math.sqrt(variance);
        const cv = stddev / mean;

        const vrrDetected = cv >= 0.05;
        let vrrRange: [number, number] | null = null;

        if (vrrDetected) {
          // Estimate the VRR range from the spread of frame intervals
          // Use P10/P90 to be robust against outliers
          const p10 = samples[Math.floor(samples.length * 0.1)];
          const p90 = samples[Math.floor(samples.length * 0.9)];
          const highHz = Math.round(1000 / p10); // shortest interval = highest rate
          const lowHz = Math.round(1000 / p90);  // longest interval = lowest rate
          vrrRange = [Math.max(lowHz, 24), Math.min(highHz, 500)];
        }

        console.log(
          `[screen] Refresh: ${snappedHz} Hz (median ${median.toFixed(2)}ms), ` +
          `CV=${cv.toFixed(3)}${vrrDetected ? ` → VRR detected (est. ${vrrRange![0]}-${vrrRange![1]} Hz)` : " → fixed rate"}`
        );

        resolve({
          hz: snappedHz,
          intervalMs: median,
          vrrDetected,
          vrrRange,
        });
      }
    }

    requestAnimationFrame(tick);
  });
}

// ── Build info snapshot ───────────────────────────────────────────────────

function buildInfo(
  refresh: RefreshMeasurement,
  hdrCapable: boolean,
  colorGamut: "srgb" | "p3" | "rec2020",
  peakNits: number | null,
): ScreenInfo {
  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Physical screen resolution
  // screen.width/height report CSS pixels on Windows/Linux (need ×DPR),
  // but physical pixels on macOS. We multiply by DPR uniformly and
  // accept a slight over-report on macOS — it still classifies correctly.
  const sw = Math.round(window.screen.width * dpr);
  const sh = Math.round(window.screen.height * dpr);
  const rw = Math.round(vw * dpr);
  const rh = Math.round(vh * dpr);

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
  const ratio = info.renderHeight / baseline;

  if (info.isMobile) {
    // Phone: viewport is small so particles need to be relatively bigger.
    // Cube-root scaling so they don't dominate the tiny screen.
    return Math.max(0.8, Math.cbrt(ratio) * 1.3);
  }

  // Desktop: square-root scaling — doubling pixels → ~1.4× size
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
): number {
  // Reference range matching the physics:
  //   β = 0.20  → eps ≈ 13   (low energy, strong torsion)
  //   β → 0     → eps → ∞    (high energy, weak torsion)
  // We anchor the bright end at eps = 10 000 (a_min = 0.1).

  const t = Math.max(0, Math.min(1,
    (eps - EPS_DIM) / (EPS_BRIGHT - EPS_DIM),
  ));
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
  private _initialized = false;
  private _remeasureTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * One-time async initialization.
   * Measures refresh rate (~30 frames ≈ 250-500ms depending on Hz),
   * probes HDR / gamut / brightness in parallel.
   */
  async init(): Promise<ScreenInfo> {
    // Run refresh measurement and static detection concurrently
    const [refresh] = await Promise.all([
      measureRefreshRate(),
      this._detectDisplayCapabilities(),
    ]);

    this._refresh = refresh;
    this._info = buildInfo(refresh, this._hdrCapable, this._colorGamut, this._peakNits);
    this._initialized = true;

    // Listen for resize / orientation changes
    window.addEventListener("resize", () => this._onResize());
    window.addEventListener("orientationchange", () => this._onResize());

    // DPR changes (e.g. dragging to a different monitor)
    this._watchDpr();

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
    const refresh = await measureRefreshRate();
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

  // ── Event handlers ────────────────────────────────────────────────

  private _onResize(): void {
    this._update();
    // Re-measure refresh rate after resize settles (monitor switch)
    if (this._remeasureTimer) clearTimeout(this._remeasureTimer);
    this._remeasureTimer = setTimeout(() => this.remeasureRefreshRate(), 600);
  }

  private _onDisplayChange(): void {
    console.log(`[screen] DPR change detected → ${window.devicePixelRatio}`);
    this._watchDpr(); // re-register for the new DPR value
    this._update();
    // Re-measure refresh rate + re-detect HDR (new monitor may differ)
    setTimeout(async () => {
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
    this._info = buildInfo(this._refresh, this._hdrCapable, this._colorGamut, this._peakNits);
    for (const cb of this._callbacks) {
      try { cb(this._info); } catch (e) { console.warn("[screen] callback error:", e); }
    }
  }
}
