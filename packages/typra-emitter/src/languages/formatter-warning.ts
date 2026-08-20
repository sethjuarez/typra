/**
 * Shared warning for the optional external-formatter post-pass that every
 * language driver runs when `emitTarget.format !== false` (the default).
 *
 * The formatter is optional — deterministic emitter output is always the
 * fallback — but its *presence* changes the emitted bytes, so a silently
 * swallowed failure turns host-dependent drift into an un-attributable
 * investigation. Emitting a loud, greppable Warning keeps the drift traceable
 * (regen gates can grep for it) while never failing the emit.
 */
export function formatFormatterWarning(
  tool: string,
  dir: string,
  error: unknown,
): string {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return `Warning: ${tool} not found; emitted deterministic fallback formatting for ${dir}. Install ${tool} for idiomatic output.`;
  }
  return `Warning: ${tool} failed for ${dir}; emitted deterministic fallback formatting.`;
}

/** Log {@link formatFormatterWarning} to stderr via `console.warn`. */
export function warnFormatterUnavailable(
  tool: string,
  dir: string,
  error: unknown,
): void {
  console.warn(formatFormatterWarning(tool, dir, error));
}

/**
 * Warning for a consumer-declared formatter whose installed version does not
 * satisfy the pinned `version` in the target's `format` spec.
 *
 * Kept non-fatal and loud, matching {@link formatFormatterWarning}: a version
 * skew still formats the tree, but the greppable warning makes any resulting
 * byte drift attributable to the toolchain rather than the emitter.
 */
export function formatFormatterVersionMismatch(
  tool: string,
  expected: string,
  actual: string | null,
): string {
  return `Warning: ${tool} version ${
    actual ?? "unknown"
  } does not satisfy pinned ${expected}; emitted output may drift from the pinned formatter.`;
}

/** Log {@link formatFormatterVersionMismatch} to stderr via `console.warn`. */
export function warnFormatterVersionMismatch(
  tool: string,
  expected: string,
  actual: string | null,
): void {
  console.warn(formatFormatterVersionMismatch(tool, expected, actual));
}
