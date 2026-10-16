/**
 * C# expression visitor — Expr IR → C# source fragments.
 */

import {
  Expr,
  Construct,
  VariantConstruct,
  ArrayLiteral,
  TypeRegistry,
} from "../../ir/expansion.js";
import { ExprVisitor, toPascalCase, assertNever } from "../../ir/visitor.js";
import { csharpIdentifier } from "./identifiers.js";
import { csNumericLiteral, csharpScalarType } from "./emitter.js";

export class CSharpExprVisitor implements ExprVisitor {
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
        return csharpIdentifier(expr.name);
      case "construct":
        return this.visitConstruct(expr);
      case "variant":
        return this.visitVariant(expr);
      case "array":
        return this.visitArray(expr);
      case "dict":
        return `new Dictionary<string, object?> { ${expr.entries.map((e) => `{ "${e.key}", ${this.visitExpr(e.value)} }`).join(", ")} }`;
      case "field_read":
        return `${expr.objectName}.${toPascalCase(expr.fieldName)}`;
      default:
        return assertNever(expr);
    }
  }

  private visitConstruct(expr: Construct): string {
    const typeName = expr.typeName.name;
    if (expr.fields.length === 0) {
      return `new ${typeName}()`;
    }
    // C# uses object initializer syntax: new Type { Prop = value }
    const fields = expr.fields
      .map((f) => {
        const prop = this.registry
          ?.get(typeName)
          ?.properties.find((p) => p.name === f.propertyName);
        let val = this.visitFieldValue(f.value, prop?.typeName.name);
        // For enum fields, convert string literals to EnumName.MemberName
        if (f.value.kind === "string" && prop?.enumName) {
          val = `${prop.enumName}.${toPascalCase(f.value.value)}`;
        }
        return `${toPascalCase(f.propertyName)} = ${val}`;
      })
      .join(", ");
    return `new ${typeName} { ${fields} }`;
  }

  private visitVariant(expr: VariantConstruct): string {
    // In C#, polymorphic children are full classes
    const variantName = expr.variantTypeName.name;
    if (expr.fields.length === 0) {
      return `new ${variantName}()`;
    }
    const owners = [
      this.registry?.get(variantName),
      this.registry?.get(expr.baseTypeName.name),
    ];
    const fields = expr.fields
      .map((f) => {
        const prop = owners
          .flatMap((o) => o?.properties ?? [])
          .find((p) => p.name === f.propertyName);
        return `${toPascalCase(f.propertyName)} = ${this.visitFieldValue(f.value, prop?.typeName.name)}`;
      })
      .join(", ");
    return `new ${variantName} { ${fields} }`;
  }

  private visitArray(expr: ArrayLiteral): string {
    const scalarName = expr.elementTypeName.name;
    const elementType = csharpScalarType(scalarName) ?? scalarName;
    if (expr.items.length === 0) {
      return `new List<${elementType}>()`;
    }
    const items = expr.items
      .map((i) => this.visitFieldValue(i, scalarName))
      .join(", ");
    return `new List<${elementType}> { ${items} }`;
  }

  /** Numeric literals are suffixed for their destination scalar (e.g. `0.5F` for `float`). */
  private visitFieldValue(value: Expr, scalarType: string | undefined): string {
    if (value.kind === "number" && scalarType) {
      const csType = csharpScalarType(scalarType);
      if (csType) return csNumericLiteral(value.value, csType);
    }
    return this.visitExpr(value);
  }

  private escapeString(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
}
