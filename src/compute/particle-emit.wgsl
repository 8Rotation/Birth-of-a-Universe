// ── Particle Emission Compute Shader ──────────────────────────────────────
// Evaluates perturbation field δ(θ,φ) via spherical harmonics, computes
// ECSK bounce physics, and writes visual-encoded particles directly to
// the ring buffer in packed vec4 format.

// ── Group 0: Perturbation coefficients (storage — may exceed 16KB) ──────
struct Coeff {
  l: u32,
  m: i32,
  c: f32,
  sigma: f32,
};
@group(0) @binding(0) var<storage, read> coeffs: array<Coeff>;

// ── Group 1: Frame parameters (uniform) ─────────────────────────────────
struct Params {
  beta: f32,
  kCurvature: f32,
  perturbAmplitude: f32,
  lMax: u32,
  arrivalSpread: f32,
  simTime: f32,
  emitCount: u32,
  frameSeed: u32,
  sensitivity: f32,

  // Visual encoding
  hueMin: f32,
  hueRange: f32,
  brightnessFloor: f32,
  brightnessCeil: f32,
  sizeVariation: f32,

  // Acceleration range (precomputed on CPU)
  globalMinAcc: f32,
  globalMaxAcc: f32,

  // Hue normalization (precomputed on CPU)
  minWEff: f32,
  maxWEff: f32,

  // Ring buffer write position
  writeOffset: u32,
  bufferCapacity: u32,

  // Double-bounce modulation (Cubero & Popławski 2019 §26)
  doubleBounce: u32,        // bool: 0 or 1
  dbPhase: f32,             // current phase accumulator [0, 1)
  dbSecondHueShift: f32,
  dbSecondBriScale: f32,

  // Pair production (Popławski 2014; 2021)
  bounceCount: u32,         // # bounce particles (rest are production)
  ppHueShift: f32,
  ppBriBoost: f32,
  ppSizeScale: f32,
  ppBaseDelay: f32,
  ppScatterRange: f32,
  ppBrightnessCeil: f32,

  // Production particle normalization bounds
  ppMinWEff: f32,
  ppMaxWEff: f32,
  ppGlobalMinAcc: f32,
  ppGlobalMaxAcc: f32,
};
@group(1) @binding(0) var<uniform> params: Params;

// ── Group 2: Output particle buffer (read-write storage) ────────────────
// attrA: [lx, ly, bornTime, hue]
// attrB: [brightness, eps, hitSize, 0.0]
@group(2) @binding(0) var<storage, read_write> outA: array<vec4<f32>>;
@group(2) @binding(1) var<storage, read_write> outB: array<vec4<f32>>;

// ── Constants ───────────────────────────────────────────────────────────
const PI: f32 = 3.141592653589793;
const TWO_PI: f32 = 6.283185307179586;
const SQRT2: f32 = 1.4142135623730951;
const INV_4PI: f32 = 0.07957747154594767;
const EPS_LOG_REF: f32 = 9.210440366976517;  // ln(10001)
const PP_SCATTER_BIAS: f32 = -0.6;

// ── PCG PRNG ────────────────────────────────────────────────────────────
fn pcg(state: ptr<function, u32>) -> u32 {
  let old = *state;
  *state = old * 747796405u + 2891336453u;
  let word = ((old >> ((old >> 28u) + 4u)) ^ old) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand01(state: ptr<function, u32>) -> f32 {
  return f32(pcg(state)) / 4294967296.0;
}

// ── Bounce physics result ───────────────────────────────────────────────
struct BounceResult {
  a: f32,
  a2: f32,
  eps: f32,
  wEff: f32,
  acc: f32,
};

// ── bounceProps — ECSK bounce turning-point algebra ─────────────────────
// Port of ecsk-physics.ts bounceProps() lines 139–181.
fn bounceProps(betaEff: f32, k: f32) -> BounceResult {
  let be = clamp(betaEff, 0.002, 0.2499);
  var a2: f32;
  if (k > 0.5) {
    // k=+1: a² = (1 − √(1−4β)) / 2
    let disc = sqrt(max(0.0, 1.0 - 4.0 * be));
    a2 = (1.0 - disc) / 2.0;
  } else if (k > -0.5) {
    // k=0: a² = β
    a2 = be;
  } else {
    // k=−1: a² = (−1 + √(1+4β)) / 2
    let disc = sqrt(1.0 + 4.0 * be);
    a2 = max(1e-12, (-1.0 + disc) / 2.0);
  }
  let a = sqrt(a2);

  let wDenom = 3.0 * (a2 - be);
  var wEff: f32;
  if (abs(wDenom) > 1e-12) {
    wEff = (a2 - 3.0 * be) / wDenom;
  } else {
    wEff = -1.0;
  }

  let eps = 1.0 / (a2 * a2);
  let acc = -1.0 / (a2 * a) + (2.0 * be) / (a2 * a2 * a);

  return BounceResult(a, a2, eps, wEff, acc);
}

// ── productionProps — post-bounce pair-production epoch ──────────────────
// Port of ecsk-physics.ts productionProps().
// Evaluates at a ≈ a_min × √2 (near H² peak).
struct ProductionResult {
  a: f32,
  a2: f32,
  eps: f32,
  wEff: f32,
  acc: f32,
};

fn productionProps(betaEff: f32, k: f32) -> ProductionResult {
  let bounce = bounceProps(betaEff, k);
  let be = clamp(betaEff, 0.002, 0.2499);

  // Production epoch: a ≈ a_min × √2
  let aPost = bounce.a * SQRT2;
  let a2 = aPost * aPost;
  let a4 = a2 * a2;

  // w_eff at production-epoch scale factor
  let wDenom = 3.0 * (a2 - be);
  var wEff: f32;
  if (abs(wDenom) > 1e-12) {
    wEff = (a2 - 3.0 * be) / wDenom;
  } else {
    wEff = -1.0;
  }

  // eps at production epoch
  let eps = 1.0 / a4;

  // acc at production epoch (from D2)
  let acc = -1.0 / (a2 * aPost) + (2.0 * be) / (a4 * aPost);

  return ProductionResult(aPost, a2, eps, wEff, acc);
}

// ── evalPerturbation — spherical harmonic field δ(θ,φ) ──────────────────
// Port of perturbation.ts evaluatePerturbationFast() lines 265–347.
// Walks Associated Legendre recurrence once across all (m, l) pairs.
fn evalPerturbation(cosT: f32, sinT: f32, phi: f32) -> f32 {
  let numCoeffs = arrayLength(&coeffs);
  let lMax = params.lMax;
  if (lMax < 1u || numCoeffs == 0u) {
    return 0.0;
  }

  var delta: f32 = 0.0;

  // cos(φ) and sin(φ) for angle-addition recurrence
  let cosPhi = cos(phi);
  let sinPhi = sin(phi);

  // Sectoral Legendre value P_m^m (built incrementally)
  var pmm: f32 = 1.0;  // P_0^0 = 1

  // Angle-addition state: cos(m·φ), sin(m·φ)
  var cosMPhi: f32 = 1.0;  // cos(0) = 1
  var sinMPhi: f32 = 0.0;  // sin(0) = 0

  for (var m: u32 = 0u; m <= lMax; m = m + 1u) {
    // Advance sectoral & trig values for m > 0
    if (m > 0u) {
      // P_m^m = -(2m-1) · sinT · P_{m-1}^{m-1}
      pmm *= -(f32(2u * m) - 1.0) * sinT;

      // Angle-addition recurrence for cos(mφ), sin(mφ)
      let c = cosMPhi * cosPhi - sinMPhi * sinPhi;
      let s = sinMPhi * cosPhi + cosMPhi * sinPhi;
      cosMPhi = c;
      sinMPhi = s;
    }

    // Initial normalization factorial: fac = (2m)!
    var fac: f32 = 1.0;
    for (var i: u32 = 1u; i <= 2u * m; i = i + 1u) {
      fac *= f32(i);
    }

    // Upward recurrence in l for fixed m
    var plm_prev: f32 = 0.0;
    var plm_curr: f32 = pmm;

    for (var l: u32 = m; l <= lMax; l = l + 1u) {
      // Advance Legendre and fac for l > m
      if (l > m) {
        let plm_next =
          ((2.0 * f32(l) - 1.0) * cosT * plm_curr - (f32(l + m) - 1.0) * plm_prev) /
          f32(l - m);
        plm_prev = plm_curr;
        plm_curr = plm_next;

        // fac(l) = fac(l−1) × (l+m) / (l−m)
        fac *= f32(l + m) / f32(l - m);
      }

      // No l=0 modes in the coefficient array
      if (l < 1u) {
        continue;
      }

      // N_l^m = √((2l+1) / (4π · fac))
      let norm = sqrt((2.0 * f32(l) + 1.0) * INV_4PI / fac);

      if (m == 0u) {
        // Y_l^0 = N · P_l^0
        let idx = l * l + l - 1u;
        if (idx < numCoeffs) {
          delta += coeffs[idx].c * norm * plm_curr;
        }
      } else {
        // Both +m and −m share the same P_l^m and norm
        let nPlm = norm * plm_curr * SQRT2;
        // Y_l^{+m} = N · P_l^m · √2 · cos(mφ)
        let idxPos = l * l + l + m - 1u;
        if (idxPos < numCoeffs) {
          delta += coeffs[idxPos].c * nPlm * cosMPhi;
        }
        // Y_l^{−m} = N · P_l^m · √2 · sin(mφ)
        let idxNeg = l * l + l - m - 1u;
        if (idxNeg < numCoeffs) {
          delta += coeffs[idxNeg].c * nPlm * sinMPhi;
        }
      }
    }
  }

  return delta;
}

// ── Main compute entry point ────────────────────────────────────────────
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.emitCount) {
    return;
  }

  // Per-invocation PRNG seed
  var rng: u32 = params.frameSeed ^ (idx * 2654435761u);

  // Determine if this is a production particle (idx >= bounceCount)
  let isProduction = params.bounceCount > 0u && idx >= params.bounceCount;

  // ── Sphere sampling (uniform on S²) ──
  let u1 = rand01(&rng);
  let u2 = rand01(&rng);
  let cosTheta = 1.0 - 2.0 * u1;
  let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  let phi = TWO_PI * u2;

  // ── Perturbation evaluation ──
  let delta = evalPerturbation(cosTheta, sinTheta, phi);

  // betaEff — coefficients already incorporate amplitude (do NOT multiply by perturbAmplitude)
  let betaEff = clamp(params.beta * (1.0 + delta), 0.002, 0.2499);

  // ── Shared arrival-time derivation constants ──
  let denom = max(1e-6, abs(params.sensitivity) * params.beta * params.perturbAmplitude);
  let td = params.arrivalSpread / denom;
  let rawDelay = params.sensitivity * (betaEff - params.beta) * td;
  let maxDelay = params.arrivalSpread * 1.5;

  // ── Lambert azimuthal equal-area projection ──
  let theta = acos(cosTheta);
  let lx = 2.0 * sin(theta / 2.0) * cos(phi);
  let ly = 2.0 * sin(theta / 2.0) * sin(phi);

  // Tail angle (random)
  let tailAngle = rand01(&rng) * TWO_PI;

  var arrivalTime: f32;
  var hue: f32;
  var brightness: f32;
  var epsOut: f32;
  var hitSize: f32;

  if (isProduction) {
    // ── Production particle path (Popławski 2014; 2021) ──
    let ppProps = productionProps(betaEff, params.kCurvature);

    // Brightness: log-compressed eps × ppBriBoost, capped at ppBrightnessCeil
    brightness = clamp(
      log(ppProps.eps + 1.0) / EPS_LOG_REF * params.ppBriBoost,
      params.brightnessFloor,
      params.ppBrightnessCeil,
    );
    epsOut = ppProps.eps;

    // Arrival time: bounce delay + fixed production offset + scatter
    let scatter = params.ppScatterRange * (rand01(&rng) * 2.0 + PP_SCATTER_BIAS);
    let ppMaxDelay = params.ppBaseDelay + params.ppScatterRange + 2.0;
    let totalDelay = rawDelay + params.ppBaseDelay + scatter;
    arrivalTime = params.simTime + clamp(totalDelay, -ppMaxDelay, ppMaxDelay);

    // Hue: use production normalization bounds
    let ppWRange = params.ppMinWEff - params.ppMaxWEff;
    let ppWNorm = select((ppProps.wEff - params.ppMaxWEff) / ppWRange, 0.5, abs(ppWRange) < 1e-12);
    let baseHue = params.hueMin + ppWNorm * params.hueRange;
    // Add ppHueShift + double-bounce shift (if active on second bounce)
    var dbShift: f32 = 0.0;
    if (params.doubleBounce == 1u && params.kCurvature > 0.5) {
      let isSecond = params.dbPhase > 0.25 && params.dbPhase < 0.75;
      if (isSecond) {
        dbShift = params.dbSecondHueShift;
      }
    }
    hue = min(params.hueMin + params.hueRange, baseHue + params.ppHueShift + dbShift);

    // Size: production-specific normalization × ppSizeScale
    let ppAccRange = max(1e-6, params.ppGlobalMaxAcc - params.ppGlobalMinAcc);
    let ppNormAcc = clamp((ppProps.acc - params.ppGlobalMinAcc) / ppAccRange, 0.0, 1.0);
    hitSize = (1.0 - params.sizeVariation * 0.5 + ppNormAcc * params.sizeVariation) * params.ppSizeScale;

    // Production particles: do NOT apply double-bounce brightness modulation
    // (matches CPU: prevents rhythmic flicker on sustained creation particles)

  } else {
    // ── Bounce particle path ──
    let props = bounceProps(betaEff, params.kCurvature);

    // Brightness: log-compressed eps
    brightness = clamp(log(props.eps + 1.0) / EPS_LOG_REF, params.brightnessFloor, params.brightnessCeil);
    epsOut = props.eps;

    // Arrival time
    arrivalTime = params.simTime + clamp(rawDelay, -maxDelay, maxDelay);

    // Hue: pre-computed min/max wEff from CPU
    let wRange = params.minWEff - params.maxWEff;
    let wNorm = select((props.wEff - params.maxWEff) / wRange, 0.5, abs(wRange) < 1e-12);
    hue = min(params.hueMin + params.hueRange, params.hueMin + wNorm * params.hueRange);

    // Size: lerp between uniform and physics-driven
    let accRange = max(1e-6, params.globalMaxAcc - params.globalMinAcc);
    let normAcc = clamp((props.acc - params.globalMinAcc) / accRange, 0.0, 1.0);
    hitSize = 1.0 - params.sizeVariation * 0.5 + normAcc * params.sizeVariation;

    // ── Double-bounce visual shift (Cubero & Popławski 2019 §26) ──
    // Approach A: CPU pre-modulates the rate; shader only applies visual shift.
    if (params.doubleBounce == 1u && params.kCurvature > 0.5) {
      let isSecond = params.dbPhase > 0.25 && params.dbPhase < 0.75;
      if (isSecond) {
        hue += params.dbSecondHueShift;
        hue = min(params.hueMin + params.hueRange, hue);
        brightness *= params.dbSecondBriScale;
        epsOut *= params.dbSecondBriScale;
      }
    }
  }

  // ── Write to ring buffer (modulo wrap) ──
  let slot = (params.writeOffset + idx) % params.bufferCapacity;
  outA[slot] = vec4<f32>(lx, ly, arrivalTime, hue);
  outB[slot] = vec4<f32>(brightness, epsOut, hitSize, tailAngle);
}
