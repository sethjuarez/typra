import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Model, ModelProperty } from "@typespec/compiler";

import type { CoercionDecl, FieldDecl, FileDecl, TypeDecl } from "../src/ir/declarations.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { TypeNode, PropertyNode } from "../src/ir/ast.js";
import { lowerFile } from "../src/ir/lower.js";
import { emitRustFile } from "../src/languages/rust/emitter.js";
import { RustExprVisitor } from "../src/languages/rust/visitor.js";

interface PropOptions {
  isScalar?: boolean;
  defaultValue?: string | null;
  allowedValues?: string[];
  isOpenEnum?: boolean;
}

function makeProp(name: string, typeName: string, options: PropOptions = {}): PropertyNode {
  const prop = new PropertyNode({} as ModelProperty, `Test ${name}`);
  prop.name = name;
  prop.typeName = { namespace: "Test", name: typeName };
  prop.isScalar = options.isScalar ?? false;
  prop.defaultValue = options.defaultValue ?? null;
  prop.allowedValues = options.allowedValues ?? [];
  prop.isOpenEnum = options.isOpenEnum ?? false;
  return prop;
}

interface TypeOptions {
  discriminator?: string;
  childTypes?: TypeNode[];
  isAbstract?: boolean;
  base?: { namespace: string; name: string } | null;
}

function makeType(name: string, properties: PropertyNode[], options: TypeOptions = {}): TypeNode {
  const node = new TypeNode({} as Model, `Test ${name}`);
  node.typeName = { namespace: "Test", name };
  node.properties = properties;
  node.discriminator = options.discriminator;
  node.childTypes = options.childTypes ?? [];
  node.factories = [];
  node.coercions = [];
  node.isAbstract = options.isAbstract ?? false;
  node.base = options.base ?? null;
  node.methods = [];
  return node;
}

/**
 * Builds an open polymorphic base whose discriminator is declared as a *named union*
 * (`alias ConnectionType = "reference" | "key" | string`), which is how an open
 * discriminator is most naturally spelled in TypeSpec.
 */
function emitOpenDiscriminatorBase(extraBaseProps: PropertyNode[] = []): string {
  const reference = makeType(
    "ReferenceConnection",
    [makeProp("kind", "string", { isScalar: true, defaultValue: "reference" })],
    { base: { namespace: "Test", name: "Conn" } },
  );
  const key = makeType(
    "KeyConnection",
    [makeProp("kind", "string", { isScalar: true, defaultValue: "key" })],
    { base: { namespace: "Test", name: "Conn" } },
  );
  const base = makeType(
    "Conn",
    [
      makeProp("kind", "ConnectionType", { allowedValues: ["reference", "key"], isOpenEnum: true }),
      ...extraBaseProps,
    ],
    { discriminator: "kind", childTypes: [reference, key], isAbstract: true },
  );

  const registry = TypeRegistry.fromTypeGraph([base, reference, key]);
  const polymorphic = new Set(["Conn"]);
  return emitRustFile(lowerFile(base, registry, polymorphic), new RustExprVisitor(registry), polymorphic);
}

describe("rust emitter — open polymorphic discriminators", () => {
  it("does not validate the discriminator field against its declared union type", () => {
    const code = emitOpenDiscriminatorBase();

    // The dispatch owns the discriminator: `validate_discriminator()` when closed, and the
    // `Unknown` fallback arm when open. Validating it *again* as an ordinary field checks it
    // against `ConnectionType`, whose declared variants are only "reference" | "key" — so an
    // unknown kind is rejected before dispatch and the open fallback arm becomes dead code.
    assert.ok(
      !/ConnectionType::validate_input_at/.test(code),
      "open discriminator must not be pre-validated against its declared union type",
    );

    // The fallback arm the pre-validation would have made unreachable.
    assert.ok(/Unknown \{/.test(code), "open dispatch must emit an Unknown fallback variant");
    assert.ok(
      /raw: serde_json::Map/.test(code),
      "Unknown fallback must retain the raw payload so undeclared keys survive a roundtrip",
    );
  });

  it("still validates non-discriminator fields that have a named complex type", () => {
    const code = emitOpenDiscriminatorBase([makeProp("auth", "AuthMode")]);

    // Guard against over-broad removal: excluding the discriminator must not disable input
    // validation for every other complex field on the same type.
    assert.ok(
      /AuthMode::validate_input_at/.test(code),
      "non-discriminator complex fields must still be input-validated",
    );
    assert.ok(
      !/ConnectionType::validate_input_at/.test(code),
      "the discriminator must remain exempt even when sibling complex fields are validated",
    );
  });
});

// ============================================================================
// Numeric coercion bridging (immediate scalar Property loads)
// ============================================================================

function scalarField(name: string, scalarType: string, isOptional = true): FieldDecl {
  return {
    name,
    typeName: { namespace: "Test", name: scalarType },
    category: { kind: "scalar", scalarType },
    isOptional,
    defaultValue: null,
    allowedValues: [],
    parseAliases: {},
    enumName: null,
    isOpenEnum: false,
    description: "",
    knownAs: {},
  } as unknown as FieldDecl;
}

function numericCoercion(scalarType: string, kindLiteral: string): CoercionDecl {
  return {
    scalarType,
    assignments: [
      { fieldName: "example", isInput: true, literalValue: "" },
      { fieldName: "kind", isInput: false, literalValue: kindLiteral },
    ],
    needsDispatch: false,
  } as unknown as CoercionDecl;
}

function emitCoercingType(coercions: CoercionDecl[], exampleType = "unknown"): string {
  const type = {
    typeName: { namespace: "Test", name: "Property" },
    base: null,
    isAbstract: false,
    isProtocol: false,
    description: "",
    fields: [scalarField("example", exampleType), scalarField("kind", "string")],
    coercionProperty: null,
    load: { coercions, assignments: [], hasPolymorphicDispatch: false, hasContextHooks: false },
    save: { assignments: [], hasBase: false, hasContextHooks: false },
    factories: [],
    collectionHelpers: [],
    polymorphicDispatch: null,
    methods: [],
    wire: null,
  } as unknown as TypeDecl;

  const file = { group: "", imports: [], enums: [], types: [type] } as unknown as FileDecl;
  return emitRustFile(file, new RustExprVisitor(TypeRegistry.fromTypeGraph([])), new Set<string>());
}

describe("rust emitter — numeric coercion bridging", () => {
  it("tests the integral coercion before the fractional one", () => {
    const code = emitCoercingType([
      numericCoercion("float32", "float"),
      numericCoercion("integer", "integer"),
    ]);

    // `serde_json::Value::as_f64()` returns Some for whole numbers too, so a fractional branch
    // placed first swallows every integer: `4` then reports kind "float" instead of "integer",
    // violating the vector's "the exact primitive kind". Declaration order must not decide this.
    const integral = code.indexOf("value.as_i64()");
    const fractional = code.indexOf("value.as_f64()");
    assert.ok(integral > -1, "expected an as_i64 guard for the integral coercion");
    assert.ok(fractional > -1, "expected an as_f64 guard for the fractional coercion");
    assert.ok(
      integral < fractional,
      "the integral coercion must be tested first — as_f64() also matches whole numbers",
    );
    assert.ok(
      code.indexOf('"integer"', integral) < code.indexOf('"float"', integral),
      "whole numbers must route to the integral coercion and fractions to the fractional one",
    );
  });

  it("does not reconstruct integrality from f64", () => {
    const code = emitCoercingType([
      numericCoercion("integer", "integer"),
      numericCoercion("float32", "float"),
    ]);

    // Go must use math.Trunc because encoding/json decodes every number as float64. serde_json
    // keeps the token's own int/float distinction, so rebuilding it from f64 would store 4.0
    // where the vector requires the unmodified 4.
    assert.ok(!/trunc\(\)/.test(code), "serde_json distinguishes int from float natively");
  });

  it("keeps full f64 precision when the destination field is not f32", () => {
    const code = emitCoercingType([
      numericCoercion("integer", "integer"),
      numericCoercion("float32", "float"),
    ]);

    // 3.140000104904175 is exactly 3.14f32 widened back to f64. serde_json holds an exact f64
    // and the vector contract requires "the unmodified scalar", so a float32-*declared*
    // coercion must not narrow when the destination can hold the f64.
    assert.ok(
      !/as f32/.test(code),
      "a float32 coercion into a non-f32 field must not round-trip through f32",
    );
    assert.ok(
      !/as_f64\(\)\.map\(\|value\| value as f32\)/.test(code),
      "the lossy f32 narrowing must not reappear",
    );
  });

  it("still narrows when the destination field is genuinely f32", () => {
    // Counterpart guard: the fix removes gratuitous narrowing, not required narrowing.
    const code = emitCoercingType([numericCoercion("float32", "float")], "float32");

    assert.ok(
      /\(value as f32\)\.into\(\)/.test(code),
      "an f32 destination field still requires the narrowing cast to typecheck",
    );
  });

  it("emits only the guard a lone integral coercion needs", () => {
    const code = emitCoercingType([numericCoercion("integer", "integer")]);

    assert.ok(/if let Some\(value\) = value\.as_i64\(\)/.test(code), "expected an as_i64 guard");
    assert.ok(!/as_f64\(\)/.test(code), "an integral-only type needs no fractional guard");
  });

  it("does not bridge non-numeric coercions", () => {
    const code = emitCoercingType([numericCoercion("string", "string")]);

    assert.ok(/if let Some\(s\) = value\.as_str\(\)/.test(code), "expected the declared string coercion");
    assert.ok(!/as_f64\(\)/.test(code), "string-only coercions must gain no numeric bridge");
    assert.ok(!/as_i64\(\)/.test(code), "string-only coercions must gain no numeric bridge");
  });
});
