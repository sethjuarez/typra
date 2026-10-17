import { toPascalCase } from "../../ir/visitor.js";
import { createUniqueEnumMemberNames } from "../enum-identifiers.js";

/**
 * Java has no unsigned primitives, so sized/unsigned TypeSpec integers widen to the
 * smallest boxed type holding their full range: up to 16 bits -> `Integer` (handled as
 * `int32`), `uint32`/`safeint`/`uint64` -> `Long` (handled as `int64`). `uint64` values
 * above `Long.MAX_VALUE` are out of range. Returns the scalar whose Java handling applies.
 */
export function javaIntegralScalar(scalarType: string): string {
  switch (scalarType) {
    case "int8":
    case "int16":
    case "uint8":
    case "uint16":
      return "int32";
    case "uint32":
    case "uint64":
    case "safeint":
      return "int64";
    default:
      return scalarType;
  }
}

/**
 * Renders a numeric default as a Java literal typed for its field. Floating literals keep
 * JavaScript's exponent form (`1e+300`, valid in Java) and only gain `.0` when they have
 * neither a fraction nor an exponent, so `1e300` never becomes the invalid `1e+300.0d`.
 * javac rejects a nonzero `float` literal that rounds to zero, so those narrow from a
 * `double` literal instead; `-0` keeps its sign.
 */
export function javaNumericLiteral(value: number, scalarType: string): string {
  const text = String(value);
  const real = Object.is(value, -0) ? "-0" : text;
  const floating = /[.eE]/.test(real) ? real : `${real}.0`;
  switch (javaIntegralScalar(scalarType)) {
    case "int64":
      return `${text}L`;
    case "float32":
      return value !== 0 && Math.fround(value) === 0
        ? `(float) ${floating}d`
        : `${floating}f`;
    case "number":
    case "float":
    case "numeric":
    case "float64":
      return `${floating}d`;
    default:
      return text;
  }
}

const JAVA_KEYWORDS = new Set([
  "abstract",
  "assert",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "exports",
  "extends",
  "final",
  "finally",
  "float",
  "for",
  "goto",
  "if",
  "implements",
  "import",
  "instanceof",
  "int",
  "interface",
  "long",
  "module",
  "native",
  "new",
  "non-sealed",
  "open",
  "opens",
  "package",
  "permits",
  "private",
  "protected",
  "provides",
  "public",
  "record",
  "requires",
  "return",
  "sealed",
  "short",
  "static",
  "strictfp",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "to",
  "transient",
  "transitive",
  "try",
  "uses",
  "var",
  "void",
  "volatile",
  "while",
  "with",
  "yield",
  "true",
  "false",
  "null",
  "_",
]);

export function javaIdentifier(name: string, fallback = "value"): string {
  const normalized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  const started = /^[A-Za-z_$]/.test(normalized)
    ? normalized
    : `${fallback}_${normalized}`;
  return JAVA_KEYWORDS.has(started) ? `${started}Value` : started;
}

export function javaPropertyName(name: string): string {
  return javaIdentifier(name, "field");
}

export function javaMethodName(name: string): string {
  return javaIdentifier(name, "method");
}

export function javaTypeName(name: string): string {
  return javaIdentifier(toPascalCase(name), "Typra");
}

export function javaEnumTypeName(name: string): string {
  return javaTypeName(name);
}

export function javaEnumMemberNames(
  values: readonly string[],
): Map<string, string> {
  return createUniqueEnumMemberNames(values, (value) => {
    const normalized = value
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^(\d)/, "_$1")
      .toUpperCase();
    return javaIdentifier(normalized || "VALUE", "VALUE");
  });
}
