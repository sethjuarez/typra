import { toSnakeCase } from "../../ir/utilities.js";

// Python 3 hard keywords (keyword.kwlist) that a snake_cased field name can hit.
// `True`/`False`/`None` are omitted: toSnakeCase lowercases, and lowercase
// `true`/`false`/`none` are ordinary, valid attribute names.
const PY_KEYWORDS = new Set<string>([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

/**
 * PEP 8 escape for an identifier that clashes with a Python keyword: a single
 * trailing underscore (``class`` → ``class_``). Wire keys stay verbatim.
 */
export function pythonIdentifier(candidate: string): string {
  return PY_KEYWORDS.has(candidate) ? `${candidate}_` : candidate;
}

// Dispatch resolver names have always escaped these too; kept so existing
// generated resolver APIs do not change.
const PY_DISPATCH_LEGACY_ESCAPES = new Set(["true", "false", "none"]);

/** Identifier for an emitted dispatch resolver parameter or method. */
export function pythonDispatchIdentifier(candidate: string): string {
  return PY_DISPATCH_LEGACY_ESCAPES.has(candidate)
    ? `${candidate}_`
    : pythonIdentifier(candidate);
}

/**
 * Python attribute name for a model field. Declarations, load/save, the expression
 * visitor, and generated tests must agree, so every site calls this one rule.
 */
export function pythonFieldName(name: string): string {
  return pythonIdentifier(toSnakeCase(name));
}

/**
 * Snake-casing and keyword escaping are not injective (``fooBar``/``foo_bar``,
 * ``class``/``class_``), so fail generation instead of emitting a class whose
 * later attribute silently overwrites an earlier one.
 */
export function assertDistinctPythonFields(type: {
  typeName: { name: string };
  fields: Array<{ name: string }>;
}): void {
  const seen = new Map<string, string>();
  for (const field of type.fields) {
    const attribute = pythonFieldName(field.name);
    const prior = seen.get(attribute);
    if (prior !== undefined) {
      throw new Error(
        `Python type ${type.typeName.name}: fields "${prior}" and "${field.name}" both map to the attribute "${attribute}". Rename one of the fields to generate Python.`,
      );
    }
    seen.set(attribute, field.name);
  }
}

/**
 * Python types the generated code references unqualified; a same-named model,
 * interface, or enum shadows or redeclares them (#358). Calibrated by native compiles.
 */
const RESERVED_TYPE_NAMES = new Set<string>([
  "ClassVar",
  "LoadContext",
  "SaveContext",
]);

/** Why a model, interface, or enum named `name` cannot be emitted, or undefined. */
export function pythonReservedTypeName(name: string): string | undefined {
  if (RESERVED_TYPE_NAMES.has(name)) {
    return `shadows or redeclares the '${name}' type`;
  }
  // Class names keep their casing, and these three are hard keywords.
  if (name === "None" || name === "True" || name === "False") {
    return `'${name}' is a Python keyword`;
  }
  return undefined;
}
