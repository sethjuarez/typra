import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  CoercionDecl,
  CollectionHelperDecl,
  FieldDecl,
  LoadAssignment,
  TypeDecl,
} from "../src/ir/declarations.js";
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
    load: {
      coercions,
      assignments: [],
      hasPolymorphicDispatch: false,
      hasContextHooks: false,
    },
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

function helperWith(hasNameProperty: boolean): CollectionHelperDecl {
  return {
    propertyName: "entries",
    elementTypeName: { namespace: "Test", name: "Property" },
    innerFields: ["default"],
    coercionProperty: "default",
    entryShorthand: {
      valueField: "default",
      cases: [
        {
          scalarType: "integer",
          assignments: [{ fieldName: "kind", literalValue: "integer" }],
        },
        {
          scalarType: "float32",
          assignments: [{ fieldName: "kind", literalValue: "number" }],
        },
      ],
    },
    hasNameProperty,
  } as unknown as CollectionHelperDecl;
}

function emitWithHelper(helper: CollectionHelperDecl): string {
  const type = typeWith([]);
  const assignment = {
    sourceName: "entries",
    fieldName: "entries",
    category: { kind: "collection_complex", typeName: "Property" },
    isOptional: false,
    parentTypeName: "Property",
    enumName: null,
    allowedValues: [],
    parseAliases: {},
    defaultValue: null,
    isOpenEnum: false,
  } as unknown as TypeDecl["load"]["assignments"][number];
  return emitGoFileContent(
    [
      {
        ...type,
        collectionHelpers: [helper],
        load: { ...type.load, assignments: [assignment] },
      } as TypeDecl,
    ],
    "model",
    new GoExprVisitor(),
    new Set<string>(),
  );
}

describe("Go emitter numeric coercion bridging", () => {
  it("bridges decoder-native float64 and int for mixed integral/fractional coercions", () => {
    const out = emit([
      coercion("integer", "integer"),
      coercion("float32", "float"),
    ]);

    // encoding/json decodes every JSON number as float64, so without this case a schema
    // that declares `integer`/`float32` coercions never matches a decoded number.
    assert.ok(
      out.includes("case float64:"),
      "expected a decoder-native float64 case",
    );
    // gopkg.in/yaml.v3 decodes integral YAML scalars as int.
    assert.ok(out.includes("case int:"), "expected a decoder-native int case");

    // 4 must stay an integer and 3.14 must stay a float, so the float64 case has to
    // discriminate rather than collapsing both onto one coercion.
    assert.ok(
      out.includes("if v == math.Trunc(v) {"),
      "expected integral discrimination",
    );
    assert.ok(
      out.includes('"math"'),
      "expected the math import to be plumbed through",
    );

    const truncIndex = out.indexOf("if v == math.Trunc(v) {");
    assert.ok(
      out.indexOf('"kind": "integer"', truncIndex) <
        out.indexOf('"kind": "float"', truncIndex),
      "whole numbers must route to the integral coercion, fractions to the fractional one",
    );
  });

  it("does not emit math.Trunc when only one numeric coercion is declared", () => {
    const out = emit([coercion("integer", "integer")]);

    assert.ok(
      out.includes("case float64:"),
      "expected a decoder-native float64 case",
    );
    assert.ok(
      !out.includes("math.Trunc"),
      "single-numeric coercions need no discrimination",
    );
    assert.ok(
      !out.includes('"math"'),
      "the math import must not be emitted when unused",
    );
  });

  it("does not add numeric bridging for non-numeric coercions", () => {
    const out = emit([coercion("string", "string")]);

    assert.ok(
      out.includes("case string:"),
      "expected the declared string coercion",
    );
    assert.ok(
      !out.includes("case float64:"),
      "string-only coercions need no numeric bridge",
    );
    assert.ok(
      !out.includes("case int:"),
      "string-only coercions need no numeric bridge",
    );
  });
});

describe("Go emitter entry-shorthand math import", () => {
  // The entry-shorthand arms that call math.Trunc are emitted only for a name-keyed
  // collection. A plain array helper emits no such arm, so requesting the import would
  // leave the generated file with an unused import, which Go rejects at build time.
  it("omits the math import for a plain array helper", () => {
    const out = emitWithHelper(helperWith(false));

    assert.ok(
      !out.includes("math.Trunc"),
      "a plain array helper emits no shorthand arms",
    );
    assert.ok(
      !out.includes('"math"'),
      "the math import must not be emitted when unused",
    );
  });

  it("keeps the math import for a name-keyed helper that discriminates integrality", () => {
    const out = emitWithHelper(helperWith(true));

    assert.ok(
      out.includes("math.Trunc"),
      "a name-keyed helper discriminates integrality",
    );
    assert.ok(
      out.includes('"math"'),
      "expected the math import to be plumbed through",
    );
  });
});

// ============================================================================
// Dead-store elimination for the LoadContext guard
// ============================================================================
//
// Go's LoadContext has no ProcessInput hook, so a loader only reads `ctx` when it
// threads it into a nested load or calls `ctx.At(...)` for a required-field path.
// Leaf loaders touch neither, which made the unconditional
// `if ctx == nil { ctx = NewLoadContext() }` prologue a dead store that CodeQL flags
// (go/useless-assignment-to-local). The guard must now be elided for leaf loaders
// while the `ctx *LoadContext` parameter stays on every loader for a uniform API.

function scalarField(name: string, scalarType: string): FieldDecl {
  return {
    name,
    typeName: { namespace: "Test", name: scalarType },
    category: { kind: "scalar", scalarType },
    isOptional: false,
    defaultValue: null,
    allowedValues: [],
    parseAliases: {},
    enumName: null,
    isOpenEnum: false,
    description: "",
    knownAs: {},
  };
}

function complexField(name: string, typeName: string): FieldDecl {
  return {
    name,
    typeName: { namespace: "Test", name: typeName },
    category: { kind: "complex", typeName },
    isOptional: false,
    defaultValue: null,
    allowedValues: [],
    parseAliases: {},
    enumName: null,
    isOpenEnum: false,
    description: "",
    knownAs: {},
  };
}

function assignmentFor(
  field: FieldDecl,
  parentTypeName: string,
): LoadAssignment {
  return {
    sourceName: field.name,
    fieldName: field.name,
    category: field.category,
    isOptional: field.isOptional,
    parentTypeName,
    enumName: null,
    allowedValues: [],
    parseAliases: {},
    defaultValue: null,
    isOpenEnum: false,
  };
}

function loaderType(name: string, fields: FieldDecl[]): TypeDecl {
  const base = typeWith([]);
  return {
    ...base,
    typeName: { namespace: "Test", name },
    fields,
    load: {
      ...base.load,
      assignments: fields.map((field) => assignmentFor(field, name)),
    },
  } as TypeDecl;
}

function emitLoader(type: TypeDecl): string {
  return emitGoFileContent(
    [type],
    "model",
    new GoExprVisitor(),
    new Set<string>(),
  );
}

/** Extract the body of a single `func Load<Name>(...) { ... }` from the emitted file. */
function loaderBody(out: string, name: string): string {
  const marker = `func Load${name}(`;
  const start = out.indexOf(marker);
  assert.ok(start >= 0, `expected a Load${name} function`);
  // Match the closing brace at column 0 that terminates the function.
  const rest = out.slice(start);
  const end = rest.indexOf("\n}\n");
  assert.ok(end >= 0, `expected Load${name} to be terminated`);
  return rest.slice(0, end);
}

describe("Go emitter LoadContext guard dead-store elimination", () => {
  it("omits the ctx guard for a leaf loader that never uses ctx", () => {
    const out = emitLoader(
      loaderType("LeafModel", [scalarField("label", "string")]),
    );
    const body = loaderBody(out, "LeafModel");

    // The parameter stays for a uniform loader API across all generated types.
    assert.ok(
      body.includes("ctx *LoadContext"),
      "leaf loader must keep the ctx *LoadContext parameter",
    );
    // ...but the dead guard assignment must be gone.
    assert.ok(
      !body.includes("ctx = NewLoadContext()"),
      "leaf loader must not emit the dead ctx = NewLoadContext() guard",
    );
    assert.ok(
      !body.includes("if ctx == nil {"),
      "leaf loader must not emit the ctx == nil guard block",
    );
  });

  it("retains the ctx guard for a loader that threads ctx into a nested load", () => {
    const out = emitLoader(
      loaderType("NestedModel", [complexField("child", "LeafModel")]),
    );
    const body = loaderBody(out, "NestedModel");

    assert.ok(
      body.includes("ctx *LoadContext"),
      "nested loader keeps the ctx *LoadContext parameter",
    );
    // The required-field guard and the nested load both read ctx, so the guard is needed.
    assert.ok(
      body.includes("if ctx == nil {"),
      "nested loader must retain the ctx == nil guard block",
    );
    assert.ok(
      body.includes("ctx = NewLoadContext()"),
      "nested loader must retain the ctx = NewLoadContext() assignment",
    );
    assert.ok(
      body.includes('ctx.At("child")'),
      "nested loader threads ctx into the nested load",
    );
  });

  it("omits the ctx guard even when a leaf field's wire name is literally \"ctx\"", () => {
    // Regression guard: the usage check strips string literals, so `m["ctx"]` for a
    // field named ctx must not be mistaken for a read of the ctx variable.
    const out = emitLoader(
      loaderType("CtxNamedFieldModel", [scalarField("ctx", "string")]),
    );
    const body = loaderBody(out, "CtxNamedFieldModel");

    assert.ok(
      body.includes("ctx *LoadContext"),
      "loader keeps the ctx *LoadContext parameter",
    );
    assert.ok(
      body.includes('m["ctx"]') || body.includes('"ctx"'),
      "the leaf field named ctx is still read from the map by its wire name",
    );
    assert.ok(
      !body.includes("ctx = NewLoadContext()"),
      "a field literally named ctx must not resurrect the dead guard",
    );
    assert.ok(
      !body.includes("if ctx == nil {"),
      "a field literally named ctx must not resurrect the ctx == nil guard block",
    );
  });
});
