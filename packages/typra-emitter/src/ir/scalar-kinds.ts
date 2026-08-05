/**
 * Shared classification of TypeSpec scalar types for the numeric-bridging and
 * entry-shorthand paths.
 *
 * These live here rather than in a single backend because every backend that
 * expands an immediate scalar has to agree on two things: which TypeSpec scalars
 * are integral versus fractional, and the order the resulting runtime checks are
 * emitted in. Duplicating either per backend is how the coercion family drifted
 * apart in the first place.
 *
 * The sets cover the whole TypeSpec numeric tower rather than the handful a
 * particular schema happens to use, because a scalar that falls through every
 * classification produces no runtime arm at all — a silent degradation that is
 * far harder to notice than a compile error.
 */

import type { CollectionHelperDecl, EntryShorthandCase } from "./declarations.js";

/**
 * TypeSpec scalars that decode from a JSON integer token.
 *
 * Includes the sized and unsigned families and `safeint`; omitting them meant a
 * schema declaring `int16` got neither a numeric bridge nor a shorthand arm.
 */
export const INTEGRAL_SCALAR_TYPES = new Set([
  "integer",
  "int8",
  "int16",
  "int32",
  "int64",
  "safeint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
]);

/**
 * TypeSpec scalars that decode from a JSON fractional token.
 *
 * `numeric` is the root of the numeric tower and may carry a fraction, so it is
 * classified fractional. `decimal`/`decimal128` are included because they too
 * arrive as JSON numbers even though some runtimes widen them differently.
 */
export const FRACTIONAL_SCALAR_TYPES = new Set([
  "numeric",
  "number",
  "float",
  "float32",
  "float64",
  "decimal",
  "decimal128",
]);

/**
 * TypeSpec scalars whose JSON encoding is a string.
 *
 * These are not interchangeable with `string` in the type system, but every one
 * of them arrives at a decoder as a JSON string, so the runtime check that
 * distinguishes them from numbers and booleans is exactly the `string` check.
 */
export const STRING_ENCODED_SCALAR_TYPES = new Set([
  "string",
  "bytes",
  "plainDate",
  "plainTime",
  "utcDateTime",
  "offsetDateTime",
  "duration",
  "url",
  "uuid",
]);

export function isIntegralScalar(scalarType: string): boolean {
  return INTEGRAL_SCALAR_TYPES.has(scalarType);
}

export function isFractionalScalar(scalarType: string): boolean {
  return FRACTIONAL_SCALAR_TYPES.has(scalarType);
}

export function isStringEncodedScalar(scalarType: string): boolean {
  return STRING_ENCODED_SCALAR_TYPES.has(scalarType);
}

export function isBooleanScalar(scalarType: string): boolean {
  return scalarType === "boolean";
}

/**
 * The four runtime shapes a decoded JSON scalar can take.
 *
 * Backends map this, rather than the raw TypeSpec scalar name, onto their own
 * runtime checks. `null` means the scalar has no distinguishable JSON form and
 * the caller must decide whether to skip it or report it.
 */
export type ScalarRuntimeKind = "integral" | "fractional" | "string" | "boolean";

export function scalarRuntimeKind(scalarType: string): ScalarRuntimeKind | null {
  if (isIntegralScalar(scalarType)) return "integral";
  if (isFractionalScalar(scalarType)) return "fractional";
  if (isStringEncodedScalar(scalarType)) return "string";
  if (isBooleanScalar(scalarType)) return "boolean";
  return null;
}

/**
 * Order entry-shorthand cases so integral checks precede fractional ones.
 *
 * Every runtime that distinguishes the two must test integral first. Decoders
 * that preserve the token's int/float distinction (serde_json, yaml.v3,
 * `Number.isInteger`) will answer "is this a float?" affirmatively for an
 * integer under a widening check, so a fractional-first order silently collapses
 * every integer into a float — the exact defect fixed in the direct-coercion path.
 *
 * Cases whose scalar has no distinguishable JSON form are dropped here rather
 * than emitted as an unreachable arm; `unmappableShorthandScalars` reports them.
 */
export function orderedEntryShorthandCases(
  cases: readonly EntryShorthandCase[],
): EntryShorthandCase[] {
  const byKind = (kind: ScalarRuntimeKind) =>
    cases.filter(c => scalarRuntimeKind(c.scalarType) === kind);
  return [
    ...byKind("integral"),
    ...byKind("fractional"),
    ...byKind("string"),
    ...byKind("boolean"),
  ];
}

/** Scalar types in the shorthand table that no runtime check can recognise. */
export function unmappableShorthandScalars(cases: readonly EntryShorthandCase[]): string[] {
  return cases.filter(c => scalarRuntimeKind(c.scalarType) === null).map(c => c.scalarType);
}

/**
 * The field an immediate scalar entry value is assigned to.
 *
 * Prefers the explicit `@entryShorthand` declaration, then the field that direct
 * coercion targets, and only then falls back to the first declared field. That
 * last fallback is positional and unsound for a discriminated element type — it
 * lands the raw scalar in the discriminator — but it is the historical behaviour
 * and is preserved so undeclared schemas do not change shape.
 */
export function entryShorthandTarget(helper: CollectionHelperDecl, fallback = "value"): string {
  return (
    helper.entryShorthand?.valueField
    ?? helper.coercionProperty
    ?? (helper.innerFields.length > 0 ? helper.innerFields[0] : fallback)
  );
}
