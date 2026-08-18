import {
  FieldDecl,
  LoadAssignment,
  PropertyCategory,
  SaveAssignment,
} from "./declarations.js";

export type LoadFieldPresencePolicy = "guard-then-fail" | "load-when-present";
export type SaveFieldEmissionPolicy = "emit-always" | "omit-when-absent";
export type OptionalFieldAbsencePolicy =
  | "preserve-absence"
  | "materialize-default";
export type CollectionDefaultProfile = "required-or-explicit" | "explicit-only";

export type SaveFieldEmissionProfile =
  | "optional-only"
  | "always-check"
  | "go"
  | "rust-collection-default"
  | "rust-value-sentinel";

function isRequiredWithoutDefault(field: {
  isOptional: boolean;
  hasExplicitDefault?: boolean;
  defaultValue?: string | number | boolean | null;
}): boolean {
  return (
    !field.isOptional &&
    !field.hasExplicitDefault &&
    field.defaultValue === null
  );
}

function isGuardedCategory(category: PropertyCategory): boolean {
  return category.kind === "complex";
}

function isCollectionCategory(category: PropertyCategory): boolean {
  return (
    category.kind === "collection_scalar" ||
    category.kind === "collection_complex"
  );
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
): LoadFieldPresencePolicy {
  if (!field) return "load-when-present";
  if (!isRequiredWithoutDefault(field)) return "load-when-present";
  return isGuardedCategory(field.category)
    ? "guard-then-fail"
    : "load-when-present";
}

export function shouldGuardMissingRequiredField(
  field: FieldDecl | LoadAssignment | undefined,
): boolean {
  return loadFieldPresencePolicy(field) === "guard-then-fail";
}

export function saveFieldEmissionPolicy(
  field: FieldDecl | SaveAssignment | undefined,
  profile: SaveFieldEmissionProfile = "optional-only",
): SaveFieldEmissionPolicy {
  if (!field) return "omit-when-absent";

  switch (profile) {
    case "always-check":
      return "omit-when-absent";
    case "go":
      return field.isOptional || field.category.kind === "collection_complex"
        ? "omit-when-absent"
        : "emit-always";
    case "rust-collection-default":
      return shouldPreserveOptionalAbsence(field)
        ? "omit-when-absent"
        : "emit-always";
    case "rust-value-sentinel":
      return field.isOptional || field.hasExplicitDefault
        ? "omit-when-absent"
        : "emit-always";
    case "optional-only":
      return field.isOptional ? "omit-when-absent" : "emit-always";
  }
}

export function shouldOmitAbsentOnSave(
  field: FieldDecl | SaveAssignment | undefined,
  profile: SaveFieldEmissionProfile = "optional-only",
): boolean {
  return saveFieldEmissionPolicy(field, profile) === "omit-when-absent";
}

export function optionalFieldAbsencePolicy(
  field:
    | {
        isOptional: boolean;
        hasExplicitDefault?: boolean;
      }
    | undefined,
): OptionalFieldAbsencePolicy {
  if (!field?.isOptional) return "materialize-default";
  return field.hasExplicitDefault ? "materialize-default" : "preserve-absence";
}

export function shouldPreserveOptionalAbsence(
  field:
    | {
        isOptional: boolean;
        hasExplicitDefault?: boolean;
      }
    | undefined,
): boolean {
  return optionalFieldAbsencePolicy(field) === "preserve-absence";
}

export function shouldMaterializeCollectionDefault(
  field:
    | {
        category: PropertyCategory;
        isOptional: boolean;
        hasExplicitDefault?: boolean;
      }
    | undefined,
  profile: CollectionDefaultProfile = "required-or-explicit",
): boolean {
  if (!field || !isCollectionCategory(field.category)) return false;
  switch (profile) {
    case "explicit-only":
      return field.hasExplicitDefault === true;
    case "required-or-explicit":
      return !shouldPreserveOptionalAbsence(field);
  }
}
