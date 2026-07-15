import { toSnakeCase } from "../../ir/utilities.js";
import { toPascalCase } from "../../ir/visitor.js";

const SWIFT_KEYWORDS = new Set([
  "Any", "Type", "Protocol", "Self", "associatedtype", "associativity", "break", "case",
  "catch", "class", "continue", "convenience", "default", "defer", "deinit", "didSet",
  "do", "dynamic", "else", "enum", "extension", "fallthrough", "false", "fileprivate",
  "final", "for", "func", "get", "guard", "if", "import", "in", "indirect", "infix",
  "init", "inout", "internal", "is", "lazy", "left", "let", "mutating", "nil", "none",
  "nonmutating", "open", "operator", "optional", "override", "postfix", "precedence",
  "prefix", "private", "protocol", "public", "repeat", "required", "rethrows", "return",
  "right", "self", "set", "some", "static", "struct", "subscript", "super", "switch",
  "throw", "throws", "true", "try", "typealias", "unowned", "var", "weak", "where",
  "while", "willSet",
]);

export function swiftTypeName(name: string): string {
  return escapeSwiftIdentifier(ensureIdentifierStart(toSwiftPascalCase(name), "Typra"));
}

export function swiftPropertyName(name: string): string {
  const pascal = toSwiftPascalCase(name);
  const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);
  return escapeSwiftIdentifier(ensureIdentifierStart(camel, "value"));
}

export function swiftFunctionName(name: string): string {
  return swiftPropertyName(name);
}

export function swiftFileName(name: string): string {
  return `${toSnakeCase(name)}.swift`;
}

export function swiftModuleName(rawName: string): string {
  const parts = rawName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => toPascalCase(part));
  const candidate = parts.join("") || "TypraGenerated";
  return /^[0-9]/.test(candidate) ? `Typra${candidate}` : candidate;
}

export function escapeSwiftIdentifier(identifier: string): string {
  if (SWIFT_KEYWORDS.has(identifier)) {
    return `\`${identifier}\``;
  }
  return identifier;
}

function toSwiftPascalCase(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "Value";
  return parts.map(part => toPascalCase(part)).join("");
}

function ensureIdentifierStart(identifier: string, prefix: string): string {
  return /^[A-Za-z_]/.test(identifier) ? identifier : `${prefix}${identifier}`;
}

export function swiftStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u{2028}")
    .replace(/\u2029/g, "\\u{2029}");
}
