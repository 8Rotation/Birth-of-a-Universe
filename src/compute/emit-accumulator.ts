// Pure helper for the GPU emission rate accumulator.
//
// Mirrors the per-frame pattern used by the CPU path in
// `src/physics/shell.ts` (`tryEmitParticles`):
//
//     accumulator += dt * effectiveRate;
//     const count = Math.floor(accumulator);
//     accumulator -= count;
//
// A plain floor of `rate * dt` each frame discards the sub-1 remainder and
// under-emits (especially at high refresh rates where `rate * dt < 1`).
// The accumulator carries that fractional remainder to the next frame so
// the long-run emission rate matches the requested rate.

export interface EmitAccumulatorState {
  /** Fractional remainder carried between frames. */
  value: number;
}

/**
 * Advance the accumulator by one frame and return the integer count of
 * particles to emit this frame. The state is mutated in place.
 *
 * If `rate <= 0` the accumulator is left unchanged (no decay) and 0 is
 * returned, matching the CPU path which skips emission when the effective
 * rate is zero.
 */
export function stepEmitAccumulator(
  state: EmitAccumulatorState,
  rate: number,
  dt: number,
): number {
  if (rate <= 0 || dt <= 0) return 0;
  state.value += rate * dt;
  const count = Math.floor(state.value);
  state.value -= count;
  return count;
}

/** Reset the accumulator (use on sim reset / GPU-compute toggle). */
export function resetEmitAccumulator(state: EmitAccumulatorState): void {
  state.value = 0;
}
