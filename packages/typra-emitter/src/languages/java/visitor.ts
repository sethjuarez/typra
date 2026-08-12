import {
  ArrayLiteral,
  Construct,
  Expr,
  FieldAssignment,
  TypeRegistry,
  VariantConstruct,
} from "../../ir/expansion.js";
import { assertNever, ExprVisitor } from "../../ir/visitor.js";
import {
  javaEnumTypeName,
  javaPropertyName,
  javaTypeName,
} from "./identifiers.js";

export class JavaExprVisitor implements ExprVisitor {
  registry?: TypeRegistry;

  constructor(registry?: TypeRegistry) {
    this.registry = registry;
  }

  visitExpr(expr: Expr): string {
    switch (expr.kind) {
      case "string":
        return `"${this.escapeString(expr.value)}"`;
      case "number":
        return String(expr.value);
      case "boolean":
        return expr.value ? "true" : "false";
      case "null":
        return "null";
      case "param":
        return javaPropertyName(expr.name);
      case "construct":
        return this.visitConstruct(expr);
      case "variant":
        return this.visitVariant(expr);
      case "array":
        return this.visitArray(expr);
      case "dict":
        return `TypraMaps.mapOf(${expr.entries.map((e) => `"${e.key}", ${this.visitExpr(e.value)}`).join(", ")})`;
      case "field_read":
        return `${javaPropertyName(expr.objectName)}.${javaPropertyName(expr.fieldName)}`;
      default:
        return assertNever(expr);
    }
  }

  private visitConstruct(expr: Construct): string {
    return this.constructWithFields(expr.typeName.name, expr.fields);
  }

  private visitVariant(expr: VariantConstruct): string {
    return this.constructWithFields(expr.variantTypeName.name, expr.fields);
  }

  private constructWithFields(
    rawTypeName: string,
    fields: Construct["fields"],
  ): string {
    const typeName = javaTypeName(rawTypeName);
    if (fields.length === 0) {
      return `new ${typeName}()`;
    }
    return `new ${typeName}() {{ ${fields
      .map(
        (field) =>
          `this.${javaPropertyName(field.propertyName)} = ${this.visitFieldValue(rawTypeName, field)};`,
      )
      .join(" ")} }}`;
  }

  private visitFieldValue(typeName: string, field: FieldAssignment): string {
    const property = this.registry
      ?.get(typeName)
      ?.properties.find((candidate) => candidate.name === field.propertyName);
    if (
      field.value.kind === "string" &&
      property?.enumName &&
      !property.isOpenEnum
    ) {
      return `${javaEnumTypeName(property.enumName)}.fromValue("${this.escapeString(field.value.value)}")`;
    }
    if (field.value.kind === "number" && property) {
      return this.numberLiteral(field.value.value, property.typeName.name);
    }
    return this.visitExpr(field.value);
  }

  private numberLiteral(value: number, typeName: string): string {
    if (typeName === "int64") return `${value}L`;
    if (typeName === "float32")
      return `${Number.isInteger(value) ? `${value}.0` : value}f`;
    if (["number", "float", "numeric", "float64"].includes(typeName)) {
      return `${Number.isInteger(value) ? `${value}.0` : value}d`;
    }
    return String(value);
  }

  private visitArray(expr: ArrayLiteral): string {
    return `new java.util.ArrayList<>(java.util.Arrays.asList(${expr.items.map((i) => this.visitExpr(i)).join(", ")}))`;
  }

  private escapeString(s: string): string {
    return s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n");
  }
}
