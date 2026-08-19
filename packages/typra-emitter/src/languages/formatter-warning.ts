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
