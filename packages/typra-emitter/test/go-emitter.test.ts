import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CoercionDecl, TypeDecl } from "../src/ir/declarations.js";
import { emitGoFileContent } from "../src/languages/go/emitter.js";
import { GoExprVisitor } from "../src/languages/go/visitor.js";

function coercion(scalarType: string, kindLiteral: string): CoercionDecl {
  return {
    scalarType,
    assignments: [
      { fieldName: "value", isInput: true, literalValue: "" },
      { fieldName: "kind", isInput: false, literalValue: kindLiteral },
    ] as CoercionDecl["assignments"],
    needsDispatch: false,
  };
}

function typeWith(coercions: CoercionDecl[]): TypeDecl {
  return {
    typeName: { namespace: "Test", name: "Property" },
    base: null,
    isAbstract: false,
    isProtocol: false,
    description: "",
    fields: [],
    coercionProperty: null,
    load: { coercions, assignments: [], hasPolymorphicDispatch: false, hasContextHooks: false },
    save: { assignments: [], hasBase: false, hasContextHooks: false },
    factories: [],
    collectionHelpers: [],
    polymorphicDispatch: null,
    methods: [],
    wire: null,
  } as unknown as TypeDecl;
}

function emit(coercions: CoercionDecl[]): string {
  return emitGoFileContent(
    [typeWith(coercions)],
    "model",
    new GoExprVisitor(),
    new Set<string>(),
  );
}

describe("Go emitter numeric coercion bridging", () => {
  it("bridges decoder-native float64 and int for mixed integral/fractional coercions", () => {
    const out = emit([coercion("integer", "integer"), coercion("float32", "float")]);

    // encoding/json decodes every JSON number as float64, so without this case a schema
    // that declares `integer`/`float32` coercions never matches a decoded number.
    assert.ok(out.includes("case float64:"), "expected a decoder-native float64 case");
    // gopkg.in/yaml.v3 decodes integral YAML scalars as int.
    assert.ok(out.includes("case int:"), "expected a decoder-native int case");

    // 4 must stay an integer and 3.14 must stay a float, so the float64 case has to
    // discriminate rather than collapsing both onto one coercion.
    assert.ok(out.includes("if v == math.Trunc(v) {"), "expected integral discrimination");
    assert.ok(out.includes('"math"'), "expected the math import to be plumbed through");

    const truncIndex = out.indexOf("if v == math.Trunc(v) {");
    assert.ok(
      out.indexOf('"kind": "integer"', truncIndex) < out.indexOf('"kind": "float"', truncIndex),
      "whole numbers must route to the integral coercion, fractions to the fractional one",
    );
  });

  it("does not emit math.Trunc when only one numeric coercion is declared", () => {
    const out = emit([coercion("integer", "integer")]);

    assert.ok(out.includes("case float64:"), "expected a decoder-native float64 case");
    assert.ok(!out.includes("math.Trunc"), "single-numeric coercions need no discrimination");
    assert.ok(!out.includes('"math"'), "the math import must not be emitted when unused");
  });

  it("does not add numeric bridging for non-numeric coercions", () => {
    const out = emit([coercion("string", "string")]);

    assert.ok(out.includes("case string:"), "expected the declared string coercion");
    assert.ok(!out.includes("case float64:"), "string-only coercions need no numeric bridge");
    assert.ok(!out.includes("case int:"), "string-only coercions need no numeric bridge");
  });
});
