import { FieldDecl, LoadAssignment, PropertyCategory } from "./declarations.js";

export interface RequiredFieldGuardOptions {
  /**
   * Swift value types cannot distinguish inherited required scalar/dict fields from absence once
   * the default initializer has run, so the existing Swift backend guards those inherited fields
   * alongside required complex fields. Other backends currently guard required complex fields only.
   */
  includeInheritedScalarAndDict?: boolean;
  hasBase?: boolean;
}

export type LoadFieldPresencePolicy = "guard-then-fail" | "load-when-present";

function isRequiredWithoutDefault(field: {
  isOptional: boolean;
  hasExplicitDefault?: boolean;
  defaultValue?: string | number | boolean | null;
}): boolean {
  return !field.isOptional && !field.hasExplicitDefault && field.defaultValue === null;
}

function isGuardedCategory(
  category: PropertyCategory,
  options: RequiredFieldGuardOptions,
): boolean {
  if (category.kind === "complex") return true;
  return options.includeInheritedScalarAndDict === true
    && options.hasBase === true
    && (category.kind === "scalar" || category.kind === "dict");
}

/**
 * Decide whether a load-side field must be checked for presence before assignment.
 *
 * Runtime semantics require missing required complex fields to fail instead of materializing a
 * fabricated default. This shared predicate is the first extracted field-emission policy slice:
 * emitters still render their own language syntax, but no longer re-derive when to guard.
 */
export function loadFieldPresencePolicy(
  field: FieldDecl | LoadAssignment | undefined,
  options: RequiredFieldGuardOptions = {},
): LoadFieldPresencePolicy {
  if (!field) return "load-when-present";
  if (!isRequiredWithoutDefault(field)) return "load-when-present";
  return isGuardedCategory(field.category, options) ? "guard-then-fail" : "load-when-present";
}

export function shouldGuardMissingRequiredField(
  field: FieldDecl | LoadAssignment | undefined,
  options: RequiredFieldGuardOptions = {},
): boolean {
  return loadFieldPresencePolicy(field, options) === "guard-then-fail";
}
