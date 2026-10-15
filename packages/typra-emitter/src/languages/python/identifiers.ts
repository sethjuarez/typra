import { toSnakeCase } from "../../ir/utilities.js";

const PYTHON_KEYWORDS = new Set<string>([
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

export function pythonDispatchIdentifier(name: string): string {
  const candidate = toSnakeCase(name) || "value";
  const sanitized =
    candidate
      .replace(/[^A-Za-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "value";
  const started = /^[A-Za-z_]/.test(sanitized)
    ? sanitized
    : `slot_${sanitized}`;
  return PYTHON_KEYWORDS.has(started) ? `${started}_` : started;
}
