import { toPascalCase } from "../../ir/visitor.js";
import { createUniqueEnumMemberNames } from "../enum-identifiers.js";

export function csharpEnumMemberNames(
  values: readonly string[],
): Map<string, string> {
  return createUniqueEnumMemberNames(values, (value) => {
    const normalized = toPascalCase(value).replace(/[^A-Za-z0-9_]/g, "_");
    return /^[A-Za-z_]/.test(normalized) ? normalized : `Value${normalized}`;
  });
}

const CSHARP_KEYWORDS = new Set([
  "abstract",
  "as",
  "base",
  "bool",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "checked",
  "class",
  "const",
  "continue",
  "decimal",
  "default",
  "delegate",
  "do",
  "double",
  "else",
  "enum",
  "event",
  "explicit",
  "extern",
  "false",
  "finally",
  "fixed",
  "float",
  "for",
  "foreach",
  "goto",
  "if",
  "implicit",
  "in",
  "int",
  "interface",
  "internal",
  "is",
  "lock",
  "long",
  "namespace",
  "new",
  "null",
  "object",
  "operator",
  "out",
  "override",
  "params",
  "private",
  "protected",
  "public",
  "readonly",
  "ref",
  "return",
  "sbyte",
  "sealed",
  "short",
  "sizeof",
  "stackalloc",
  "static",
  "string",
  "struct",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "uint",
  "ulong",
  "unchecked",
  "unsafe",
  "ushort",
  "using",
  "virtual",
  "void",
  "volatile",
  "while",
]);

export function csharpIdentifier(name: string): string {
  return CSHARP_KEYWORDS.has(name) ? `@${name}` : name;
}

/**
 * C# types the generated code references unqualified; a same-named model,
 * interface, or enum shadows or redeclares them (#358). Calibrated by native compiles.
 */
const RESERVED_TYPE_NAMES = new Set<string>([
  "Convert",
  "Enumerable",
  "JsonElement",
  "JsonSerializer",
  "LoadContext",
  "SaveContext",
]);

/** Why a model, interface, or enum named `name` cannot be emitted, or undefined. */
export function csharpReservedTypeName(name: string): string | undefined {
  if (RESERVED_TYPE_NAMES.has(name)) {
    return `shadows or redeclares the '${name}' type`;
  }
  return undefined;
}
