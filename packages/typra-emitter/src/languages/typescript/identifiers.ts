/**
 * TypeScript types the generated code references unqualified; a same-named model,
 * interface, or enum shadows or redeclares them (#358). Calibrated by native compiles.
 */
const RESERVED_TYPE_NAMES = new Set<string>([
  "String",
  "Object",
  "Error",
  "JSON",
  "LoadContext",
  "SaveContext",
]);

/** Why a model, interface, or enum named `name` cannot be emitted, or undefined. */
export function typescriptReservedTypeName(name: string): string | undefined {
  return RESERVED_TYPE_NAMES.has(name)
    ? `shadows or redeclares the '${name}' type`
    : undefined;
}
