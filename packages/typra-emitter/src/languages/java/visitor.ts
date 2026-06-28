import { ArrayLiteral, Construct, Expr, TypeRegistry, VariantConstruct } from "../../ir/expansion.js";
import { assertNever, ExprVisitor, toPascalCase } from "../../ir/visitor.js";

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
        return expr.name;
      case "construct":
        return this.visitConstruct(expr);
      case "variant":
        return this.visitVariant(expr);
      case "array":
        return this.visitArray(expr);
      case "dict":
        return `TypraMaps.mapOf(${expr.entries.map(e => `"${e.key}", ${this.visitExpr(e.value)}`).join(", ")})`;
      case "field_read":
        return `${expr.objectName}.${expr.fieldName}`;
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

  private constructWithFields(typeName: string, fields: Construct["fields"]): string {
    if (fields.length === 0) {
      return `new ${typeName}()`;
    }
    return `new ${typeName}() {{ ${fields.map(f => `this.${f.propertyName} = ${this.visitExpr(f.value)};`).join(" ")} }}`;
  }

  private visitArray(expr: ArrayLiteral): string {
    return `new java.util.ArrayList<>(java.util.Arrays.asList(${expr.items.map(i => this.visitExpr(i)).join(", ")}))`;
  }

  private escapeString(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  }
}

