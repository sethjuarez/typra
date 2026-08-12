import { toPascalCase } from "../../ir/visitor.js";

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

export function javaEnumMemberName(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^(\d)/, "_$1")
    .toUpperCase();
  return javaIdentifier(normalized || "VALUE", "VALUE");
}
