import { toSnakeCase } from "../../ir/utilities.js";

// Python 3 hard keywords (keyword.kwlist). ``toSnakeCase`` lowercases its input,
// so only the lowercase spellings can ever collide, but the full set is listed
// for clarity.
const PY_KEYWORDS = new Set<string>([
  "false",
  "none",
  "true",
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
