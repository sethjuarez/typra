import { ArrayLiteral, Construct, Expr, TypeRegistry, VariantConstruct } from "../../ir/expansion.js";
import { assertNever, ExprVisitor } from "../../ir/visitor.js";
import { swiftPropertyName, swiftStringLiteral, swiftTypeName } from "./identifiers.js";

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
        return `[${expr.entries.map(e => `${swiftStringLiteral(e.key)}: ${this.visitExpr(e.value)}`).join(", ")}]`;
      case "field_read":
        return `${expr.objectName}.${swiftPropertyName(expr.fieldName)}`;
      default:
        return assertNever(expr);
    }
  }

  private visitConstruct(expr: Construct): string {
    const typeName = swiftTypeName(expr.typeName.name);
    if (expr.fields.length === 0) return `${typeName}()`;
    return `${typeName}(${expr.fields.map(f => `${swiftPropertyName(f.propertyName)}: ${this.visitExpr(f.value)}`).join(", ")})`;
  }

  private visitVariant(expr: VariantConstruct): string {
    const variantName = swiftTypeName(expr.variantTypeName.name);
    const fields = [
      `${swiftPropertyName(expr.discriminator)}: ${swiftStringLiteral(expr.discriminatorValue)}`,
      ...expr.fields.map(f => `${swiftPropertyName(f.propertyName)}: ${this.visitExpr(f.value)}`),
    ];
    return `${variantName}(${fields.join(", ")})`;
  }

  private visitArray(expr: ArrayLiteral): string {
    return `[${expr.items.map(item => this.visitExpr(item)).join(", ")}]`;
  }
}
