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
  swiftPropertyName,
  swiftStringLiteral,
  swiftTypeName,
} from "./identifiers.js";

export class SwiftExprVisitor implements ExprVisitor {
  registry?: TypeRegistry;

  constructor(registry?: TypeRegistry) {
    this.registry = registry;
  }

  visitExpr(expr: Expr): string {
    switch (expr.kind) {
      case "string":
        return swiftStringLiteral(expr.value);
      case "number":
        return String(expr.value);
      case "boolean":
        return expr.value ? "true" : "false";
      case "null":
        return "nil";
      case "param":
        return swiftPropertyName(expr.name);
      case "construct":
        return this.visitConstruct(expr);
      case "variant":
        return this.visitVariant(expr);
      case "array":
        return this.visitArray(expr);
      case "dict":
        return `[${expr.entries.map((e) => `${swiftStringLiteral(e.key)}: ${this.visitExpr(e.value)}`).join(", ")}]`;
      case "field_read":
        return `${expr.objectName}.${swiftPropertyName(expr.fieldName)}`;
      default:
        return assertNever(expr);
    }
  }

  private visitConstruct(expr: Construct): string {
    const typeName = swiftTypeName(expr.typeName.name);
    if (expr.fields.length === 0) return `${typeName}()`;
    return `${typeName}(${expr.fields
      .map(
        (field) =>
          `${swiftPropertyName(field.propertyName)}: ${this.visitFieldValue(expr.typeName.name, field)}`,
      )
      .join(", ")})`;
  }

  private visitVariant(expr: VariantConstruct): string {
    const variantName = swiftTypeName(expr.variantTypeName.name);
    const fields = [
      `${swiftPropertyName(expr.discriminator)}: ${swiftStringLiteral(expr.discriminatorValue)}`,
      ...expr.fields.map(
        (field) =>
          `${swiftPropertyName(field.propertyName)}: ${this.visitFieldValue(expr.variantTypeName.name, field)}`,
      ),
    ];
    return `.${swiftPropertyName(expr.variantTypeName.name)}(${variantName}(${fields.join(", ")}))`;
  }

  private visitArray(expr: ArrayLiteral): string {
    return `[${expr.items.map((item) => this.visitExpr(item)).join(", ")}]`;
  }

  private visitFieldValue(typeName: string, field: FieldAssignment): string {
    const property = this.registry
      ?.get(typeName)
      ?.properties.find((candidate) => candidate.name === field.propertyName);
    if (field.value.kind === "string" && property?.enumName) {
      return this.visitEnumValue(
        property.enumName,
        property.allowedValues,
        field.value.value,
      );
    }
    if (field.value.kind === "array" && property?.enumName) {
      const enumName = property.enumName;
      return `[${field.value.items
        .map((item) =>
          item.kind === "string"
            ? this.visitEnumValue(enumName, property.allowedValues, item.value)
            : this.visitExpr(item),
        )
        .join(", ")}]`;
    }
    return this.visitExpr(field.value);
  }

  private visitEnumValue(
    enumName: string,
    allowedValues: string[],
    value: string,
  ): string {
    if (allowedValues.includes(value)) return `.${swiftPropertyName(value)}`;
    return `(try! ${swiftTypeName(enumName)}.parse(${swiftStringLiteral(value)}))`;
  }
}
