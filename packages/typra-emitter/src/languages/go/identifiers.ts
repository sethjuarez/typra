import { toPascalCase } from "../../ir/visitor.js";

export function goFieldName(name: string): string {
  const converted = toPascalCase(name);
  const leading = converted.match(/^[^A-Za-z]+/)?.[0] ?? "";
  const identifier = converted.slice(leading.length);
  const prefix = "Field".repeat(leading.length);
  return `${prefix}${identifier || "Value"}`;
}
