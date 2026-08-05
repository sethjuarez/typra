import { swiftTypeName } from "./identifiers.js";

export const SWIFT_TYPE_MAP: Record<string, string> = {
  string: "String",
  number: "Double",
  array: "[Any]",
  object: "[String: Any]",
  boolean: "Bool",
  int64: "Int64",
  int32: "Int32",
  float64: "Double",
  float32: "Float",
  integer: "Int",
  float: "Double",
  numeric: "Double",
  any: "Any",
  unknown: "Any",
  dictionary: "[String: Any]",
  void: "Void",
};

export function swiftType(typeName: string): string {
  const trimmed = typeName.trim();
  if (trimmed.endsWith("?")) {
    return `${swiftType(trimmed.slice(0, -1))}?`;
  }
  if (trimmed.endsWith("[]")) {
    return `[${swiftType(trimmed.slice(0, -2))}]`;
  }
  if (/^Record\s*<\s*unknown\s*>$/i.test(trimmed)) {
    return "[String: Any]";
  }
  return SWIFT_TYPE_MAP[trimmed.toLowerCase()] ?? swiftTypeName(trimmed);
}
