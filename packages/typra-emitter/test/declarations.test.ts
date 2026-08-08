/**
 * Tests for Declaration IR — lowering pass and property classification.
 *
 * Uses Node.js built-in test runner (`node --test`).
 *
 * Reuses the same TypeNode/PropertyNode fixtures from expansion.test.ts
 * to verify that lowerFile(), lowerType(), and classifyProperty() produce
 * correct Declaration IR from known type graphs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Model, ModelProperty, Program } from "@typespec/compiler";

import { TypeRegistry } from "../src/ir/expansion.js";
import { TypeNode, PropertyNode, resolveProperty } from "../src/ir/ast.js";
import {
  classifyProperty,
  lowerFile,
  lowerType,
  collectPolymorphicTypeNames,
} from "../src/ir/lower.js";
import { emitSwiftFile } from "../src/languages/swift/emitter.js";
import { SwiftExprVisitor } from "../src/languages/swift/visitor.js";
import { emitGoFileContent } from "../src/languages/go/emitter.js";
import { isClosedPolymorphicDispatch } from "../src/ir/declarations.js";
import { goFieldName } from "../src/languages/go/identifiers.js";
import { emitGoTest } from "../src/languages/go/test-emitter.js";
import { GoExprVisitor } from "../src/languages/go/visitor.js";
import { buildGoFieldNames } from "../src/languages/go/identifiers.js";
import { emitRustFile } from "../src/languages/rust/emitter.js";
import type { RustTestContext } from "../src/languages/rust/driver.js";
import { RustExprVisitor } from "../src/languages/rust/visitor.js";
import { emitPythonFile } from "../src/languages/python/emitter.js";
import { PythonExprVisitor } from "../src/languages/python/visitor.js";
import { emitCSharpClass } from "../src/languages/csharp/emitter.js";
import { CSharpExprVisitor } from "../src/languages/csharp/visitor.js";
import { buildBaseTestContext, goTestOptions } from "../src/testing/test-context.js";

type CapturedDiagnostic = { code: string; message: string; severity: string; target?: unknown };

// ============================================================================
// Test fixtures (same as expansion.test.ts)
// ============================================================================

function makeType(name: string, props: PropertyNode[] = [], opts?: {
  discriminator?: string;
  childTypes?: TypeNode[];
  namespace?: string;
  base?: { namespace: string; name: string };
  factories?: Array<{ name: string; sets: Record<string, any>; params: Record<string, string> }>;
  coercions?: Array<{ scalar: string; expansion: Record<string, any> }>;
  isAbstract?: boolean;
  methods?: Array<{ name: string; returns: string; description: string; params?: Record<string, string>; optional?: boolean; sync?: boolean }>;
}): TypeNode {
  const node = new TypeNode({} as Model, `Test ${name}`);
  node.typeName = { namespace: opts?.namespace ?? "Test", name };
  node.properties = props;
  node.discriminator = opts?.discriminator;
  node.childTypes = opts?.childTypes ?? [];
  node.factories = opts?.factories ?? [];
  node.coercions = opts?.coercions ?? [];
  node.isAbstract = opts?.isAbstract ?? false;
  node.base = opts?.base ?? null;
  node.methods = (opts?.methods ?? []).map(m => ({ ...m, params: m.params ?? {}, optional: m.optional ?? false, sync: m.sync ?? false }));
  return node;
}

function makeProp(name: string, typeName: string, opts?: {
  isScalar?: boolean;
  isOptional?: boolean;
  isCollection?: boolean;
  isDict?: boolean;
  type?: TypeNode;
  defaultValue?: string | number | boolean | null;
  namespace?: string;
  allowedValues?: string[];
  isNamedCollection?: boolean;
}): PropertyNode {
  const prop = new PropertyNode({} as ModelProperty, `Test ${name}`);
  prop.name = name;
  prop.typeName = { namespace: opts?.namespace ?? "Test", name: typeName };
  prop.isScalar = opts?.isScalar ?? (["string", "boolean", "number", "integer", "int32", "int64", "float", "float32", "float64"].includes(typeName));
  prop.isOptional = opts?.isOptional ?? false;
  prop.isCollection = opts?.isCollection ?? false;
  prop.isDict = opts?.isDict ?? false;
  prop.type = opts?.type;
  prop.defaultValue = opts?.defaultValue ?? null;
  prop.hasExplicitDefault = opts?.defaultValue !== undefined;
  prop.allowedValues = opts?.allowedValues ?? [];
  prop.isNamedCollection = opts?.isNamedCollection ?? false;
  return prop;
}

// -- Shared fixtures --

const textPart = makeType("TextPart", [
  makeProp("kind", "string", { isScalar: true, defaultValue: "text" }),
  makeProp("value", "string", { isScalar: true }),
], { base: { namespace: "Test", name: "ContentPart" } });

const imagePart = makeType("ImagePart", [
  makeProp("kind", "string", { isScalar: true, defaultValue: "image" }),
  makeProp("url", "string", { isScalar: true }),
], { base: { namespace: "Test", name: "ContentPart" } });

const contentPart = makeType("ContentPart", [
  makeProp("kind", "string", { isScalar: true }),
], {
  discriminator: "kind",
  childTypes: [textPart, imagePart],
});

describe("closed polymorphic dispatch", () => {
  it("uses the lowered discriminator contract instead of abstractness", () => {
    const base = {
      discriminatorField: "kind",
      variants: [],
      isAbstract: true,
      defaultVariant: null,
    };
    assert.equal(isClosedPolymorphicDispatch({ ...base, isClosed: true }), true);
    assert.equal(isClosedPolymorphicDispatch({ ...base, isClosed: false }), false);
  });

  describe("property lowering diagnostics", () => {
    it("rejects complex defaults so they cannot disable required-field guards", () => {
      const diagnostics: CapturedDiagnostic[] = [];
      const stateMaps = new Map<symbol, Map<unknown, unknown>>();
      const program = {
        reportDiagnostic(diagnostic: CapturedDiagnostic) {
          diagnostics.push(diagnostic);
        },
        stateMap(key: symbol) {
          let values = stateMaps.get(key);
          if (!values) {
            values = new Map();
            stateMaps.set(key, values);
          }
          return values;
        },
      } as unknown as Program;
      const owner = { kind: "Model", name: "FixtureOwner", derivedModels: [] } as unknown as Model;
      const property = {
        kind: "ModelProperty",
        name: "owner",
        optional: false,
        type: owner,
        defaultValue: { valueKind: "ObjectValue", value: {} },
      } as unknown as ModelProperty;

      const lowered = resolveProperty(program, property, new Set(["FixtureOwner"]), "Test", "");

      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].code, "typra-emitter-unsupported-complex-default");
      assert.equal(diagnostics[0].severity, "error");
      assert.match(diagnostics[0].message, /does not support complex object defaults/);
      assert.equal(lowered.hasExplicitDefault, false);
      assert.equal(lowered.defaultValue, null);
    });
  });

  it("lowers closed enums separately from open abstract discriminators", () => {
    const closedText = makeType("ClosedText", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "text" }),
    ], { base: { namespace: "Test", name: "ClosedContent" } });
    const closedContent = makeType("ClosedContent", [
      makeProp("kind", "ClosedContentKind", { allowedValues: ["text"] }),
    ], {
      discriminator: "kind",
      childTypes: [closedText],
    });
    const closedDispatch = lowerFile(closedContent, buildTestRegistry(), new Set(["ClosedContent"])).types[0].polymorphicDispatch!;
    const openDispatch = lowerFile(connectionType, buildTestRegistry(), new Set(["Connection"])).types[0].polymorphicDispatch!;

    assert.equal(isClosedPolymorphicDispatch(closedDispatch), true);
    assert.equal(closedDispatch.defaultVariant, null);
    assert.equal(isClosedPolymorphicDispatch(openDispatch), false);

    const closedRegistry = TypeRegistry.fromTypeGraph([closedContent, closedText]);
    const closedFile = lowerFile(closedContent, closedRegistry, new Set(["ClosedContent"]));
    const goSource = emitGoFileContent(
      closedFile.types,
      "fixtures",
      new GoExprVisitor(closedRegistry),
      new Set(["ClosedContent"]),
      closedFile.enums,
      closedFile.group,
    );
    assert.match(goSource, /"fmt"/);
    assert.match(goSource, /unknown ClosedContent discriminator field 'kind' value/);
  });

  // Reachable schema shape, verified against TypeSpec 1.10:
  //   union Kind { known: "known", wildcard: "*" }
  //   @discriminator("kind") model Base { kind: Kind; }
  //   model K extends Base { kind: "known"; }
  //   model W extends Base { kind: "*"; }
  // That compiles cleanly, so allowedValues is non-empty and the dispatch would look
  // closed. Backends validating closed-ness before dispatch (Rust) would then reject
  // unknown values and leave W's arm dead. The declared wildcard must open the dispatch.
  it("lets a schema-declared wildcard subtype own the open decision", () => {
    const knownVariant = makeType("SeamKnown", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "known" }),
    ], { base: { namespace: "Test", name: "SeamContent" } });
    const wildcardVariant = makeType("SeamCustom", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "*" }),
    ], { base: { namespace: "Test", name: "SeamContent" } });
    const seamContent = makeType("SeamContent", [
      makeProp("kind", "SeamContentKind", { allowedValues: ["known", "*"] }),
    ], { discriminator: "kind", childTypes: [knownVariant, wildcardVariant] });

    const dispatch = lowerType(seamContent, buildTestRegistry(), new Set(["SeamContent"])).polymorphicDispatch!;

    assert.equal(isClosedPolymorphicDispatch(dispatch), false);
    assert.ok(dispatch.defaultVariant);
    assert.equal(dispatch.defaultVariant!.isSelfReference, false);
    assert.equal(dispatch.defaultVariant!.typeName.name, "SeamCustom");
    // The wildcard owns unknown values, so it must not also appear as a keyed variant.
    assert.deepEqual(dispatch.variants.map(v => v.value), ["known"]);
  });

  // Contract lock (not a regression test for this change): the canonical schema owner
  // relies on a declared wildcard subtype outranking the emitter's self-reference
  // fallback, so unknown handling stays schema-owned. Ordering in retrievePolymorphicTypes
  // already guarantees this; this test pins it so a future reorder cannot silently
  // hand ownership back to the emitter.
  it("prefers a declared wildcard subtype over the self-reference fallback", () => {
    const wildcardVariant = makeType("SeamOpenCustom", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "*" }),
    ], { base: { namespace: "Test", name: "SeamOpen" } });
    // Non-abstract base, so a self-reference default is also available.
    const seamOpen = makeType("SeamOpen", [
      makeProp("kind", "string", { isScalar: true }),
    ], { discriminator: "kind", childTypes: [wildcardVariant] });

    const dispatch = lowerType(seamOpen, buildTestRegistry(), new Set(["SeamOpen"])).polymorphicDispatch!;

    assert.equal(dispatch.defaultVariant!.isSelfReference, false);
    assert.equal(dispatch.defaultVariant!.typeName.name, "SeamOpenCustom");
  });

  // Regression lock for the concrete-base fallback. Prompty's `Property` is a NON-abstract
  // model with @discriminator("kind") whose union permits string/integer/float/boolean/
  // array/object/union, but only array/object/union are claimed by subtypes. The scalar
  // kinds are legal values the base itself represents. Emitter 0.4.15-0.4.18 dropped the
  // self-reference fallback for these, so Rust emitted `panic!` and Go returned a zero
  // value on `kind: "string"`. A non-abstract base must absorb permitted-but-unclaimed
  // discriminator values instead of rejecting them.
  it("lets a non-abstract base absorb permitted discriminator values no subtype claims", () => {
    const arrayProperty = makeType("ArrayProperty", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "array" }),
    ], { base: { namespace: "Test", name: "BaseProperty" } });
    const objectProperty = makeType("ObjectProperty", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "object" }),
    ], { base: { namespace: "Test", name: "BaseProperty" } });
    // Non-abstract: "string" and "boolean" are permitted but claimed by no subtype.
    const baseProperty = makeType("BaseProperty", [
      makeProp("kind", "SimpleTypes", { allowedValues: ["string", "boolean", "array", "object"] }),
    ], { discriminator: "kind", childTypes: [arrayProperty, objectProperty] });

    const dispatch = lowerType(baseProperty, buildTestRegistry(), new Set(["BaseProperty"])).polymorphicDispatch!;

    // The base absorbs the unclaimed values via its own self-reference.
    assert.ok(dispatch.defaultVariant, "non-abstract base must keep a self-reference fallback");
    assert.equal(dispatch.defaultVariant!.isSelfReference, true);
    assert.equal(dispatch.defaultVariant!.typeName.name, "BaseProperty");
    assert.deepEqual(dispatch.variants.map(v => v.value), ["array", "object"]);

    // A reachable fallback means backends must not emit reject-before-dispatch validation,
    // which would make the fallback arm dead code.
    assert.equal(isClosedPolymorphicDispatch(dispatch), false);
  });

  // Counterpart to the test above: being non-abstract is not on its own enough. When every
  // permitted value is claimed by a subtype there is nothing for the base to absorb, so the
  // dispatch stays genuinely closed and unknown values must still be rejected.
  it("keeps a non-abstract base closed when every permitted value is claimed", () => {
    const onlyVariant = makeType("OnlyVariant", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "only" }),
    ], { base: { namespace: "Test", name: "FullyClaimed" } });
    const fullyClaimed = makeType("FullyClaimed", [
      makeProp("kind", "FullyClaimedKind", { allowedValues: ["only"] }),
    ], { discriminator: "kind", childTypes: [onlyVariant] });

    const dispatch = lowerType(fullyClaimed, buildTestRegistry(), new Set(["FullyClaimed"])).polymorphicDispatch!;

    assert.equal(dispatch.defaultVariant, null);
    assert.equal(isClosedPolymorphicDispatch(dispatch), true);
  });
});

// NamedProp for testing collection hasNameProperty
const namedBinding = makeType("Binding", [
  makeProp("name", "string", { isScalar: true }),
  makeProp("value", "string", { isScalar: true }),
]);

const toolResult = makeType("ToolResult", [
  makeProp("parts", "ContentPart", { isCollection: true, type: contentPart }),
], {
  factories: [
    { name: "text", sets: { parts: [{ kind: "text", value: "{value}" }] }, params: { value: "string" } },
  ],
});

const message = makeType("Message", [
  makeProp("role", "string", { isScalar: true }),
  makeProp("parts", "ContentPart", { isCollection: true, type: contentPart }),
  makeProp("metadata", "dictionary", { isDict: true, isOptional: true }),
]);

// Type with coercions (shorthand)
const modelType = makeType("Model", [
  makeProp("id", "string", { isScalar: true }),
  makeProp("provider", "string", { isScalar: true, isOptional: true }),
], {
  coercions: [{ scalar: "string", expansion: { id: "{value}" } }],
});

// Abstract polymorphic base (e.g., Connection)
const apiKeyConnection = makeType("ApiKeyConnection", [
  makeProp("kind", "string", { isScalar: true, defaultValue: "key" }),
  makeProp("endpoint", "string", { isScalar: true }),
  makeProp("apiKey", "string", { isScalar: true, isOptional: true }),
], { base: { namespace: "Test", name: "Connection" } });

const connectionType = makeType("Connection", [
  makeProp("kind", "string", { isScalar: true }),
], {
  discriminator: "kind",
  childTypes: [apiKeyConnection],
  isAbstract: true,
});

// Type with methods
const output = makeType("Output", [
  makeProp("value", "string", { isScalar: true }),
], {
  methods: [{ name: "text", returns: "string", description: "Get the text value", optional: false, sync: false }],
});

// Type with dict, optional complex, and polymorphic ref
const complexType = makeType("ComplexType", [
  makeProp("name", "string", { isScalar: true }),
  makeProp("model", "Model", { type: modelType }),
  makeProp("tags", "string", { isScalar: true, isCollection: true }),
  makeProp("bindings", "Binding", { isCollection: true, type: namedBinding }),
  makeProp("metadata", "dictionary", { isDict: true }),
  makeProp("content", "ContentPart", { type: contentPart }),
  makeProp("optModel", "Model", { type: modelType, isOptional: true }),
]);

function buildTestRegistry(): TypeRegistry {
  return TypeRegistry.fromTypeGraph([
    contentPart, textPart, imagePart,
    toolResult, message, modelType,
    connectionType, apiKeyConnection,
    output, namedBinding, complexType,
  ]);
}

// ============================================================================
// classifyProperty tests
// ============================================================================

describe("classifyProperty", () => {
  const polyNames = new Set(["ContentPart", "Connection"]);

  it("classifies scalar property", () => {
    const prop = makeProp("name", "string", { isScalar: true });
    const cat = classifyProperty(prop, polyNames);
    assert.deepEqual(cat, { kind: "scalar", scalarType: "string" });
  });

  it("classifies optional scalar property", () => {
    const prop = makeProp("reason", "string", { isScalar: true, isOptional: true });
    const cat = classifyProperty(prop, polyNames);
    assert.deepEqual(cat, { kind: "scalar", scalarType: "string" });
  });

  it("classifies boolean scalar", () => {
    const prop = makeProp("allowed", "boolean", { isScalar: true });
    const cat = classifyProperty(prop, polyNames);
    assert.deepEqual(cat, { kind: "scalar", scalarType: "boolean" });
  });

  it("classifies complex type", () => {
    const prop = makeProp("model", "Model", { type: modelType });
    const cat = classifyProperty(prop, polyNames);
    assert.deepEqual(cat, { kind: "complex", typeName: "Model" });
  });

  it("classifies collection of scalars", () => {
    const prop = makeProp("tags", "string", { isScalar: true, isCollection: true });
    const cat = classifyProperty(prop, polyNames);
    assert.deepEqual(cat, { kind: "collection_scalar", scalarType: "string" });
  });

  it("classifies collection of complex types", () => {
    const prop = makeProp("parts", "ContentPart", { isCollection: true, type: contentPart });
    const cat = classifyProperty(prop, polyNames);
    assert.deepEqual(cat, { kind: "collection_complex", typeName: "ContentPart" });
  });

  it("classifies dict property", () => {
    const prop = makeProp("metadata", "dictionary", { isDict: true });
    const cat = classifyProperty(prop, polyNames);
    assert.deepEqual(cat, { kind: "dict" });
  });

  it("classifies polymorphic reference as complex", () => {
    // Previously was polymorphic_ref; now all non-scalar non-collection types are "complex"
    const prop = makeProp("content", "ContentPart", { type: contentPart });
    const cat = classifyProperty(prop, polyNames);
    assert.deepEqual(cat, { kind: "complex", typeName: "ContentPart" });
  });

  it("dict takes priority over collection", () => {
    // A dict+collection combo should be classified as dict
    const prop = makeProp("extra", "string", { isDict: true, isCollection: true });
    const cat = classifyProperty(prop, polyNames);
    assert.deepEqual(cat, { kind: "dict" });
  });

  it("non-polymorphic complex type is classified as complex", () => {
    const prop = makeProp("model", "Model", { type: modelType });
    const cat = classifyProperty(prop, polyNames);
    assert.deepEqual(cat, { kind: "complex", typeName: "Model" });
  });
});

// ============================================================================
// collectPolymorphicTypeNames tests
// ============================================================================

describe("collectPolymorphicTypeNames", () => {
  it("finds polymorphic base types", () => {
    const registry = buildTestRegistry();
    const names = collectPolymorphicTypeNames(contentPart, registry);
    assert.ok(names.has("ContentPart"));
    assert.equal(names.size, 1); // Only ContentPart itself
  });

  it("returns empty set for non-polymorphic types", () => {
    const registry = buildTestRegistry();
    const names = collectPolymorphicTypeNames(modelType, registry);
    assert.equal(names.size, 0);
  });

  it("finds polymorphic types through property references", () => {
    const registry = buildTestRegistry();
    const names = collectPolymorphicTypeNames(message, registry);
    assert.ok(names.has("ContentPart"));
  });
});

// ============================================================================
// lowerType tests
// ============================================================================

describe("lowerType", () => {
  const registry = buildTestRegistry();
  const polyNames = new Set(["ContentPart", "Connection"]);

  it("lowers a simple type with scalar fields", () => {
    const decl = lowerType(modelType, registry, polyNames);
    assert.equal(decl.typeName.name, "Model");
    assert.equal(decl.isAbstract, false);
    assert.equal(decl.base, null);
    assert.equal(decl.fields.length, 2);
    assert.equal(decl.fields[0].name, "id");
    assert.deepEqual(decl.fields[0].category, { kind: "scalar", scalarType: "string" });
    assert.equal(decl.fields[1].name, "provider");
    assert.equal(decl.fields[1].isOptional, true);
  });

  it("detects coercion property", () => {
    const decl = lowerType(modelType, registry, polyNames);
    assert.equal(decl.coercionProperty, "id");
  });

  it("lowers coercions in load method", () => {
    const decl = lowerType(modelType, registry, polyNames);
    assert.equal(decl.load.coercions.length, 1);
    assert.equal(decl.load.coercions[0].scalarType, "string");
    assert.equal(decl.load.coercions[0].assignments.length, 1);
    assert.equal(decl.load.coercions[0].assignments[0].fieldName, "id");
    assert.equal(decl.load.coercions[0].assignments[0].isInput, true);
  });

  it("lowers a type with complex collection", () => {
    const decl = lowerType(message, registry, polyNames);
    assert.equal(decl.fields.length, 3);
    // parts is collection_complex
    assert.deepEqual(decl.fields[1].category, { kind: "collection_complex", typeName: "ContentPart" });
    // metadata is dict
    assert.deepEqual(decl.fields[2].category, { kind: "dict" });
    // Should have a collection helper for parts
    assert.equal(decl.collectionHelpers.length, 1);
    assert.equal(decl.collectionHelpers[0].propertyName, "parts");
  });

  it("lowers polymorphic dispatch", () => {
    const decl = lowerType(contentPart, registry, polyNames);
    assert.ok(decl.polymorphicDispatch);
    assert.equal(decl.polymorphicDispatch!.discriminatorField, "kind");
    assert.equal(decl.polymorphicDispatch!.variants.length, 2);
    assert.equal(decl.polymorphicDispatch!.variants[0].value, "text");
    assert.equal(decl.polymorphicDispatch!.variants[0].typeName.name, "TextPart");
    assert.equal(decl.polymorphicDispatch!.variants[1].value, "image");
  });

  it("lowers abstract polymorphic base", () => {
    const decl = lowerType(connectionType, registry, polyNames);
    assert.ok(decl.polymorphicDispatch);
    assert.equal(decl.polymorphicDispatch!.isAbstract, true);
    assert.equal(decl.polymorphicDispatch!.variants.length, 1);
    assert.equal(decl.polymorphicDispatch!.variants[0].value, "key");
  });

  it("lowers non-abstract polymorphic base with default", () => {
    const decl = lowerType(contentPart, registry, polyNames);
    assert.ok(decl.polymorphicDispatch);
    assert.ok(decl.polymorphicDispatch!.defaultVariant);
    assert.equal(decl.polymorphicDispatch!.defaultVariant!.isSelfReference, true);
  });

  it("lowers factory methods", () => {
    const decl = lowerType(toolResult, registry, polyNames);
    assert.equal(decl.factories.length, 1);
    assert.equal(decl.factories[0].name, "text");
    assert.deepEqual(decl.factories[0].params, { value: "string" });
    assert.equal(decl.factories[0].body.kind, "construct");
  });

  it("factory name is always the canonical name (no collision avoidance in IR)", () => {
    // Collision avoidance is language-specific — the IR stores the canonical name.
    // Python adds create_ prefix in its emitter; TS/Rust/C#/Go use name directly.
    const conflictType = makeType("Conflict", [
      makeProp("text", "string", { isScalar: true }),
    ], {
      factories: [
        { name: "text", sets: { text: "{val}" }, params: { val: "string" } },
      ],
    });
    const conflictRegistry = TypeRegistry.fromTypeGraph([conflictType]);
    const decl = lowerType(conflictType, conflictRegistry, new Set());
    assert.equal(decl.factories[0].name, "text");
  });

  it("lowers method stubs", () => {
    const decl = lowerType(output, registry, polyNames);
    assert.equal(decl.methods.length, 1);
    assert.equal(decl.methods[0].name, "text");
    assert.equal(decl.methods[0].returns, "string");
  });

  it("uses keyed serialization only for explicitly named collections", () => {
    const typeWithNamedCollection = makeType("Container", [
      makeProp("bindings", "Binding", { isCollection: true, isNamedCollection: true, type: namedBinding }),
    ]);
    const decl = lowerType(typeWithNamedCollection, registry, polyNames);
    assert.equal(decl.collectionHelpers.length, 1);
    assert.equal(decl.collectionHelpers[0].hasNameProperty, true);
    assert.deepEqual(decl.collectionHelpers[0].innerFields, ["value"]); // "name" excluded
  });

  it("keeps explicit keyed-collection metadata for a 2nd same-element collection whose prop.type is unset", () => {
    // resolveModel leaves a collection property's `type` UNSET when the same element type
    // was already resolved by an earlier sibling (cycle-prevention) — e.g. Prompty.outputs
    // after inputs, both `Record<Property>|Named<..>[]`. Without registry fallback the 2nd
    // collection loses keyed-collection codegen (hasNameProperty=false) and saves/loads as a
    // degenerate array — silent data loss on map-form input. The registry lookup restores it.
    const inputs = makeProp("inputs", "Binding", { isCollection: true, isNamedCollection: true, type: namedBinding });
    const outputs = makeProp("outputs", "Binding", { isCollection: true, isNamedCollection: true }); // type UNSET (cycle quirk)
    const holder = makeType("Holder", [inputs, outputs]);
    const holderRegistry = TypeRegistry.fromTypeGraph([holder, namedBinding]);
    const decl = lowerType(holder, holderRegistry, new Set());
    const out = decl.collectionHelpers.find(h => h.propertyName === "outputs")!;
    assert.equal(out.hasNameProperty, true, "2nd same-element collection must retain the explicit keyed shape");
    assert.deepEqual(out.innerFields, ["value"]);
  });

  it("does not infer keyed serialization from an ordinary element name field", () => {
    const requests = makeProp("pendingToolRequests", "Binding", { isCollection: true, type: namedBinding });
    const checkpoint = makeType("Checkpoint", [requests]);
    const checkpointRegistry = TypeRegistry.fromTypeGraph([checkpoint, namedBinding]);
    const decl = lowerType(checkpoint, checkpointRegistry, new Set());
    const helper = decl.collectionHelpers.find(h => h.propertyName === "pendingToolRequests")!;
    assert.equal(helper.hasNameProperty, false);

    const source = emitPythonFile({
      typeName: checkpoint.typeName,
      types: [decl],
      imports: [],
      containsAbstract: false,
      enums: [],
      group: "",
    }, new PythonExprVisitor(checkpointRegistry));
    assert.match(source, /The schema declares an ordered collection[\s\S]*return \[item\.save\(context\) for item in items\]/);
    assert.doesNotMatch(source, /Object format: use name as key/);
  });

  it("recovers keyed-collection detection via structural isNamedCollection when the element type lacks a real name field", () => {
    // Record<T>|Named<T>[]: the `name` field is INJECTED by the Named<T> wrapper, not present
    // on raw T. When prop.type is unset on the 2nd sibling, registry.get(T) returns raw T
    // WITHOUT name, so the registry fallback alone can't recover keyed detection. The structural
    // isNamedCollection flag (set in resolveUnionProperty regardless of the cycle guard) does.
    const rawBinding = makeType("RawBinding", [makeProp("value", "string", { isScalar: true })]);
    const outputs = makeProp("outputs", "RawBinding", { isCollection: true, isNamedCollection: true }); // type UNSET, raw element has NO name
    const holder = makeType("KeyedHolder", [outputs]);
    const holderRegistry = TypeRegistry.fromTypeGraph([holder, rawBinding]);
    const decl = lowerType(holder, holderRegistry, new Set());
    const out = decl.collectionHelpers.find(h => h.propertyName === "outputs")!;
    assert.equal(out.hasNameProperty, true, "structural isNamedCollection must recover keyed detection even when the raw element type has no name field");
  });

  it("lowers load assignments for all property categories", () => {
    const decl = lowerType(complexType, registry, polyNames);
    const cats = decl.load.assignments.map(a => a.category.kind);
    assert.ok(cats.includes("scalar")); // name
    assert.ok(cats.includes("complex")); // model
    assert.ok(cats.includes("collection_scalar")); // tags
    assert.ok(cats.includes("collection_complex")); // bindings
    assert.ok(cats.includes("dict")); // metadata
    assert.ok(cats.includes("complex")); // content (was polymorphic_ref, now just complex)
  });

  it("lowers save assignments matching load assignments", () => {
    const decl = lowerType(complexType, registry, polyNames);
    assert.equal(decl.save.assignments.length, decl.load.assignments.length);
    // Save categories should match load categories
    for (let i = 0; i < decl.save.assignments.length; i++) {
      assert.deepEqual(
        decl.save.assignments[i].category,
        decl.load.assignments[i].category,
      );
    }
  });

  it("sets hasBase correctly for child types", () => {
    const decl = lowerType(textPart, registry, polyNames);
    assert.equal(decl.save.hasBase, true);
    assert.equal(decl.base?.name, "ContentPart");
  });

  it("sets hasBase to false for root types", () => {
    const decl = lowerType(modelType, registry, polyNames);
    assert.equal(decl.save.hasBase, false);
  });
});

// ============================================================================
// lowerFile tests
// ============================================================================

describe("lowerFile", () => {
  const registry = buildTestRegistry();
  const polyNames = new Set(["ContentPart", "Connection"]);

  it("lowers a simple file with one type", () => {
    const file = lowerFile(modelType, registry, polyNames);
    assert.equal(file.typeName.name, "Model");
    assert.equal(file.types.length, 1);
    assert.equal(file.containsAbstract, false);
  });

  describe("Swift emitter inheritance", () => {
    it("does not emit invalid struct conformance for non-polymorphic model inheritance", () => {
      const base = makeType("BaseModel", [
        makeProp("id", "string", { isScalar: true }),
      ]);
      const child = makeType("ChildModel", [
        makeProp("id", "string", { isScalar: true }),
        makeProp("label", "string", { isScalar: true }),
      ], { base: { namespace: "Test", name: "BaseModel" } });

      const content = emitSwiftFile({
        typeName: child.typeName,
        types: [child].map(node => lowerType(node, TypeRegistry.fromTypeGraph([base, child]), new Set())),
        imports: [],
        containsAbstract: false,
        enums: [],
        group: "",
      }, new SwiftExprVisitor(TypeRegistry.fromTypeGraph([base, child])), new Set());

      assert.match(content, /public struct ChildModel: TypraModel \{/);
      assert.doesNotMatch(content, /public struct ChildModel: TypraModel, BaseModel/);
    });
  });

  // ============================================================================
  // Go emitter dispatch hardening tests
  // ============================================================================

  describe("Go emitter dispatch hardening", () => {
    it("keeps abstract scalar coercions reachable before missing-discriminator errors", () => {
      const tokenConnection = makeType("TokenConnection", [
        makeProp("kind", "string", { isScalar: true, defaultValue: "token" }),
        makeProp("endpoint", "string", { isScalar: true }),
      ], { base: { namespace: "Test", name: "ConnectionWithCoercion" } });
      const connectionWithCoercion = makeType("ConnectionWithCoercion", [
        makeProp("kind", "string", { isScalar: true }),
        makeProp("endpoint", "string", { isScalar: true }),
      ], {
        discriminator: "kind",
        childTypes: [tokenConnection],
        isAbstract: true,
        coercions: [{ scalar: "string", expansion: { kind: "token", endpoint: "{value}" } }],
      });
      const registry = TypeRegistry.fromTypeGraph([connectionWithCoercion, tokenConnection]);
      const file = lowerFile(connectionWithCoercion, registry, new Set(["ConnectionWithCoercion"]));
      const code = emitGoFileContent(
        file.types,
        "fixtures",
        new GoExprVisitor(registry),
        new Set(["ConnectionWithCoercion"]),
        file.enums,
        file.group,
      );

      const coercionIndex = code.indexOf("// Handle alternate scalar representations");
      const dispatchIndex = code.indexOf("// Handle polymorphic types based on discriminator");
      assert.ok(coercionIndex >= 0, "expected generated coercion block");
      assert.ok(dispatchIndex >= 0, "expected generated polymorphic dispatch block");
      assert.ok(coercionIndex < dispatchIndex, "scalar coercions must run before abstract dispatch errors");

      // `kind` here is a bare `string` with no allowedValues, so this dispatch is OPEN. An open
      // dispatch is not exhaustive, so the loader must fall through and absorb the unknown kind
      // into the base rather than error. See issue #54: `isAbstract` was previously conflated
      // with `isClosed`, which made every abstract base terminal regardless of openness.
      const loadStart = code.indexOf("func LoadConnectionWithCoercion(");
      const loadBody = code.slice(loadStart, code.indexOf("\nfunc ", loadStart + 1));
      assert.doesNotMatch(loadBody, /unknown ConnectionWithCoercion discriminator/);
      assert.doesNotMatch(loadBody, /missing ConnectionWithCoercion discriminator/);
      assert.match(loadBody, /\/\/ Load from map/);
      assert.match(loadBody, /return result, nil/);
      assert.match(loadBody, /result\.raw\[key\] = cloneConnectionWithCoercionRawValue\(value\)/);
    });

    it("keeps an abstract CLOSED dispatch terminal so no unreachable load tail is emitted", () => {
      // Counterpart guard for the test above. Closedness -- not abstractness -- is what makes a
      // dispatch exhaustive. This pins the original terminal-loader behaviour for the case where
      // it is actually correct, so a future fix cannot make every abstract base fall through.
      const textPart = makeType("ClosedTextPart", [
        makeProp("kind", "ClosedPartKind", { defaultValue: "text", allowedValues: ["text"] }),
      ], { base: { namespace: "Test", name: "ClosedPartBase" } });
      const closedBase = makeType("ClosedPartBase", [
        makeProp("kind", "ClosedPartKind", { allowedValues: ["text"] }),
      ], {
        discriminator: "kind",
        childTypes: [textPart],
        isAbstract: true,
      });
      const registry = TypeRegistry.fromTypeGraph([closedBase, textPart]);
      const file = lowerFile(closedBase, registry, new Set(["ClosedPartBase"]));
      const code = emitGoFileContent(
        file.types,
        "fixtures",
        new GoExprVisitor(registry),
        new Set(["ClosedPartBase"]),
        file.enums,
        file.group,
      );

      const loadStart = code.indexOf("func LoadClosedPartBase(");
      const loadBody = code.slice(loadStart, code.indexOf("\nfunc ", loadStart + 1));
      assert.match(loadBody, /return nil, fmt\.Errorf\("unknown ClosedPartBase discriminator field 'kind' value: %s", discriminator\)/);
      assert.match(loadBody, /return nil, fmt\.Errorf\("missing ClosedPartBase discriminator property: kind"\)/);
      assert.doesNotMatch(loadBody, /\/\/ Load from map/);
      assert.doesNotMatch(code, /cloneClosedPartBaseRawValue/);
    });

    it("exports safe field identifiers while preserving leading-underscore wire keys", () => {
      const traceSpan = makeType("TraceSpan", [
        makeProp("__time", "string", { isScalar: true }),
        makeProp("__usage", "Record<unknown>", { isScalar: true }),
        makeProp("__frames", "string", { isScalar: true, isCollection: true }),
      ]);
      const registry = TypeRegistry.fromTypeGraph([traceSpan]);
      const file = lowerFile(traceSpan, registry);
      const code = emitGoFileContent(
        file.types,
        "fixtures",
        new GoExprVisitor(registry),
        new Set(),
        file.enums,
        file.group,
      );

      assert.match(code, /Time string `json:"__time" yaml:"__time"`/);
      assert.match(code, /Usage interface\{\} `json:"__usage" yaml:"__usage"`/);
      assert.match(code, /Frames \[\]string `json:"__frames" yaml:"__frames"`/);
      assert.match(code, /result\.Time = string\(val\.\(string\)\)/);
      assert.match(code, /result\["__time"\] = obj\.Time/);
      assert.doesNotMatch(code, /\n\s+_Time\s/);
      assert.equal(goFieldName("__time"), "Time");
      assert.equal(
        new GoExprVisitor(registry).visitExpr({
          kind: "field_read",
          objectName: "span",
          fieldName: "__time",
          fieldType: "string",
          isOptional: false,
        }),
        "span.Time",
      );

      const envelope = makeType("TraceEnvelope", [
        makeProp("span", "TraceSpan", { type: traceSpan }),
      ]);
      const testCode = emitGoTest({
        node: envelope,
        isAbstract: false,
        package: "fixtures",
        importPath: "fixtures/model",
        examples: [{
          sample: { span: { __time: "now" } },
          json: ['{"span":{"__time":"now"}}'],
          yaml: ['span:', '  __time: "now"'],
          validations: [],
        }],
        coercions: [],
        factories: [],
      });
      assert.match(testCode, /instance\.Span\.Time/);
      assert.doesNotMatch(testCode, /instance\.Span\._Time/);
    });

    it("deterministically disambiguates normalized leading-underscore collisions", () => {
      const traceSpan = makeType("TraceSpan", [
        makeProp("__time", "string", { isScalar: true }),
        makeProp("time", "string", { isScalar: true }),
        makeProp("fieldTime", "string", { isScalar: true }),
      ]);
      const registry = TypeRegistry.fromTypeGraph([traceSpan]);
      const file = lowerFile(traceSpan, registry);
      const code = emitGoFileContent(
        file.types,
        "fixtures",
        new GoExprVisitor(registry),
        new Set(),
        file.enums,
        file.group,
      );

      assert.match(code, /Time string `json:"time" yaml:"time"`/);
      assert.match(code, /FieldTime string `json:"fieldTime" yaml:"fieldTime"`/);
      assert.match(code, /Field2Time string `json:"__time" yaml:"__time"`/);
      assert.match(code, /result\.Field2Time = string\(val\.\(string\)\)/);
      assert.match(code, /result\["__time"\] = obj\.Field2Time/);
    });

    it("falls through self-referential defaults so base fields are loaded", () => {
      const registry = buildTestRegistry();
      const file = lowerFile(contentPart, registry, new Set(["ContentPart"]));
      const code = emitGoFileContent(
        file.types,
        "fixtures",
        new GoExprVisitor(registry),
        new Set(["ContentPart"]),
        file.enums,
        file.group,
      );
      assert.match(code, /switch discriminator := discriminator\.\(type\) \{/);
      assert.doesNotMatch(code, /default:\n\s+return result, nil/);

      const dispatchIndex = code.indexOf("// Handle polymorphic types based on discriminator");
      const loadIndex = code.indexOf("// Load from map", dispatchIndex);
      assert.ok(dispatchIndex >= 0 && loadIndex > dispatchIndex);
      assert.match(code.slice(loadIndex), /m\["kind"\]/);
    });

    it("preserves unmodeled payload only for self-referential open defaults", () => {
      const openConnection = makeType("OpenConnection", [
        makeProp("kind", "string", { isScalar: true }),
        makeProp("name", "string", { isScalar: true, isOptional: true }),
      ], {
        discriminator: "kind",
        childTypes: [apiKeyConnection],
      });
      const registry = TypeRegistry.fromTypeGraph([openConnection, apiKeyConnection]);
      const file = lowerFile(openConnection, registry, new Set(["OpenConnection"]));
      const code = emitGoFileContent(
        file.types,
        "fixtures",
        new GoExprVisitor(registry),
        new Set(["OpenConnection"]),
        file.enums,
        file.group,
      );

      assert.match(code, /type OpenConnection struct \{[\s\S]*\traw map\[string\]interface\{\}/);
      assert.match(code, /result\.raw = make\(map\[string\]interface\{\}, len\(m\)\)/);
      assert.match(code, /delete\(result\.raw, "kind"\)/);
      assert.match(code, /delete\(result\.raw, "name"\)/);
      assert.match(code, /func cloneOpenConnectionRawValue\(value interface\{\}\) interface\{\}/);
      assert.match(code, /result\.raw\[key\] = cloneOpenConnectionRawValue\(value\)/);
      assert.match(code, /for key, value := range obj\.raw \{[\s\S]*result\[key\] = cloneOpenConnectionRawValue\(value\)/);
      assert.ok(
        code.indexOf("for key, value := range obj.raw") < code.indexOf('result["kind"] = obj.Kind'),
        "modeled fields must overwrite any retained raw payload",
      );
      assert.doesNotMatch(code, /type ApiKeyConnection struct \{[\s\S]*\traw map\[string\]interface\{\}/);
    });

    it("flattens inherited base fields into child structs (extends)", () => {
      // Base carries the discriminator PLUS extra optional non-discriminator fields.
      const apiKeyConn = makeType("ApiKeyConn", [
        makeProp("kind", "string", { isScalar: true, defaultValue: "apiKey" }),
        makeProp("endpoint", "string", { isScalar: true }),
        makeProp("apiKey", "string", { isScalar: true, isOptional: true }),
      ], { base: { namespace: "Test", name: "Conn" } });
      const conn = makeType("Conn", [
        makeProp("kind", "string", { isScalar: true }),
        makeProp("authenticationMode", "string", { isScalar: true, isOptional: true }),
        makeProp("usageDescription", "string", { isScalar: true, isOptional: true }),
      ], {
        discriminator: "kind",
        childTypes: [apiKeyConn],
        isAbstract: true,
      });

      const registry = TypeRegistry.fromTypeGraph([conn, apiKeyConn]);
      const file = lowerFile(conn, registry, new Set(["Conn"]));
      const code = emitGoFileContent(
        file.types,
        "fixtures",
        new GoExprVisitor(registry),
        new Set(["Conn"]),
        file.enums,
        file.group,
      );

      // Isolate the child struct definition.
      const structStart = code.indexOf("type ApiKeyConn struct {");
      assert.ok(structStart >= 0, "expected ApiKeyConn struct");
      const structBody = code.slice(structStart, code.indexOf("}", structStart));

      // Inherited base fields must be present in the child struct...
      assert.match(structBody, /AuthenticationMode \*string/);
      assert.match(structBody, /UsageDescription \*string/);
      // ...alongside the child's own fields...
      assert.match(structBody, /Endpoint string/);
      assert.match(structBody, /ApiKey \*string/);
      // ...and the discriminator exactly once.
      assert.equal((structBody.match(/\bKind\b/g) || []).length, 1);

      // Load and Save for the child must also cover the inherited fields so round-trips work.
      const loadStart = code.indexOf("func LoadApiKeyConn(");
      const loadBody = code.slice(loadStart, code.indexOf("\nfunc ", loadStart + 1));
      assert.match(loadBody, /m\["authenticationMode"\]/);
      assert.match(loadBody, /m\["usageDescription"\]/);
    });

    it("flattens named collection helpers from ancestors emitted in another file", () => {
      const binding = makeType("Binding", [
        makeProp("name", "string", { isScalar: true, isOptional: true }),
        makeProp("input", "string", { isScalar: true }),
        makeProp("source", "string", { isScalar: true }),
      ], {
        coercions: [{ scalar: "string", expansion: { source: "{value}" } }],
      });
      const tool = makeType("Tool", [
        makeProp("kind", "string", { isScalar: true }),
        makeProp("bindings", "Binding", {
          isCollection: true,
          isNamedCollection: true,
          type: binding,
        }),
      ]);
      const functionTool = makeType("FunctionTool", [
        makeProp("kind", "string", { isScalar: true, defaultValue: "function" }),
      ], { base: tool.typeName });
      const registry = TypeRegistry.fromTypeGraph([tool, functionTool, binding]);
      const baseDecl = lowerType(tool, registry, new Set());
      const childDecl = lowerType(functionTool, registry, new Set());
      const code = emitGoFileContent(
        [childDecl],
        "fixtures",
        new GoExprVisitor(registry),
        new Set(),
        [],
        "",
        new Set(),
        [baseDecl, childDecl],
      );

      assert.match(code, /type FunctionTool struct \{[\s\S]*Bindings \[\]Binding/);
      assert.match(code, /if named, ok := val\.\(map\[string\]interface\{\}\); ok \{/);
      assert.match(code, /sort\.Strings\(keys\)/);
      assert.match(code, /item\["name"\] = key/);
      assert.match(code, /item\["source"\] = entry/);
      assert.doesNotMatch(code, /item\["value"\] = entry/);
      assert.match(code, /if \(ctx == nil \|\| ctx\.UseShorthand\) && len\(copy\) == 1 \{/);
      assert.match(code, /objectItems\[name\] = shorthand/);
    });
  });

  describe("Go test emitter optional assertions", () => {
    it("uses collision-aware field names in generated validations", () => {
      const traceSpan = makeType("TraceSpan", [
        makeProp("__time", "string", { isScalar: true }),
        makeProp("time", "string", { isScalar: true }),
        makeProp("fieldTime", "string", { isScalar: true }),
      ]);
      const code = emitGoTest({
        node: traceSpan,
        isAbstract: false,
        package: "prompty",
        importPath: "prompty/model",
        examples: [{
          sample: { __time: "internal", time: "public", fieldTime: "existing" },
          json: ['{"__time":"internal","time":"public","fieldTime":"existing"}'],
          yaml: ["__time: internal", "time: public", "fieldTime: existing"],
          validations: [
            { key: "Time", value: "internal", delimiter: '"', isOptional: false },
            { key: "Time", value: "public", delimiter: '"', isOptional: false },
            { key: "FieldTime", value: "existing", delimiter: '"', isOptional: false },
          ],
        }],
        coercions: [],
        factories: [],
      });

      assert.match(code, /instance\.Field2Time != "internal"/);
      assert.match(code, /instance\.Time != "public"/);
      assert.match(code, /instance\.FieldTime != "existing"/);
    });

    it("keeps scalar validations aligned after complex shorthand properties", () => {
      const model = makeType("Model", [
        makeProp("id", "string", { isScalar: true }),
      ], {
        coercions: [{ scalar: "string", expansion: { id: "{value}" } }],
      });
      const prompty = makeType("Prompty", [
        makeProp("model", "Model", { isScalar: false, type: model }),
        makeProp("name", "string", { isScalar: true }),
      ]);
      const code = emitGoTest({
        node: prompty,
        isAbstract: false,
        package: "prompty",
        importPath: "prompty/model",
        examples: [{
          sample: { model: "provider/model", name: "example" },
          json: ['{"model":"provider/model","name":"example"}'],
          yaml: ["model: provider/model", "name: example"],
          validations: [
            { key: "Name", value: "example", delimiter: '"', isOptional: false },
          ],
        }],
        coercions: [],
        factories: [],
      });

      assert.match(code, /instance\.Name != "example"/);
      assert.doesNotMatch(code, /instance\.Model != "example"/);
    });

    it("uses collision-aware field names in coercion validations", () => {
      const traceSpan = makeType("TraceSpan", [
        makeProp("__time", "string", { isScalar: true }),
        makeProp("time", "string", { isScalar: true }),
      ]);
      const code = emitGoTest({
        node: traceSpan,
        isAbstract: false,
        package: "prompty",
        importPath: "prompty/model",
        examples: [],
        coercions: [{
          title: "string",
          scalarType: "string",
          value: '"internal"',
          validations: [{
            sourceKey: "__time",
            key: "Time",
            value: "internal",
            delimiter: '"',
            isOptional: false,
          }],
        }],
        factories: [],
      });

      assert.match(code, /instance\.FieldTime != "internal"/);
      assert.doesNotMatch(code, /instance\.Time != "internal"/);
    });

    it("uses inherited fields when naming generated validations", () => {
      const traceSpan = makeType("TraceSpan", [
        makeProp("__time", "string", { isScalar: true }),
      ], {
        base: { namespace: "Test", name: "BaseSpan" },
      });
      const code = emitGoTest({
        node: traceSpan,
        isAbstract: false,
        package: "prompty",
        importPath: "prompty/model",
        fieldNames: buildGoFieldNames(["time", "__time"]),
        examples: [{
          sample: { __time: "internal" },
          json: ['{"__time":"internal"}'],
          yaml: ["__time: internal"],
          validations: [{
            sourceKey: "__time",
            key: "Time",
            value: "internal",
            delimiter: '"',
            isOptional: false,
          }],
        }],
        coercions: [],
        factories: [],
      });

      assert.match(code, /instance\.FieldTime != "internal"/);
      assert.doesNotMatch(code, /instance\.Time != "internal"/);
    });

    it("nil-checks and dereferences optional string properties", () => {
      const instructions = makeProp("instructions", "string", { isScalar: true, isOptional: true });
      const prompty = makeType("Prompty", [instructions]);
      const expected = "system:\\nBe helpful.";
      const code = emitGoTest({
        node: prompty,
        isAbstract: false,
        package: "prompty",
        importPath: "prompty/model",
        examples: [{
          sample: { instructions: expected },
          json: [`{"instructions":${JSON.stringify(expected)}}`],
          yaml: [`instructions: ${JSON.stringify(expected)}`],
          validations: [{
            key: "Instructions",
            value: expected.replace(/\\/g, "\\\\").replace(/\n/g, "\\n"),
            delimiter: '"',
            isOptional: true,
          }],
        }],
        coercions: [],
        factories: [],
      });

      assert.match(code, /if instance\.Instructions == nil \|\| \*instance\.Instructions != "system:\\\\nBe helpful\." \{/);
      assert.doesNotMatch(code, /if instance\.Instructions != /);
    });

    it("keeps whitespace-sensitive multiline YAML trim-proof", () => {
      const instructions = makeProp("instructions", "string", { isScalar: true });
      const expected = "some \npersonal\ncontent";
      instructions.samples = [{ sample: { instructions: expected }, description: "" }];
      const prompty = makeType("Prompty", [instructions]);

      const context = buildBaseTestContext(prompty, "prompty", goTestOptions);

      assert.deepEqual(context.examples[0].yaml, [
        'instructions: "some \\npersonal\\ncontent"',
        "",
      ]);
      assert.equal(context.examples[0].sample.instructions, expected);

      const generated = emitGoTest({
        ...context,
        importPath: "prompty/model",
      });
      const loadJson = generated.slice(
        generated.indexOf("func TestPromptyLoadJSON"),
        generated.indexOf("func TestPromptyLoadYAML"),
      );
      const loadYaml = generated.slice(
        generated.indexOf("func TestPromptyLoadYAML"),
        generated.indexOf("func TestPromptyFromJSON"),
      );
      const fromYaml = generated.slice(
        generated.indexOf("func TestPromptyFromYAML"),
        generated.indexOf("func TestPromptyRoundtrip"),
      );
      assert.match(
        loadJson,
        /instance\.Instructions != "some \\npersonal\\ncontent"/,
      );
      assert.match(
        loadYaml,
        /instance\.Instructions != "some \\npersonal\\ncontent"/,
      );
      assert.match(
        fromYaml,
        /instance\.Instructions != "some \\npersonal\\ncontent"/,
      );

      const blockValue = "some\npersonal\ncontent";
      instructions.samples = [{ sample: { instructions: blockValue }, description: "" }];
      const blockContext = buildBaseTestContext(prompty, "prompty", goTestOptions);
      assert.deepEqual(blockContext.examples[0].yaml, [
        "instructions: |-",
        "  some",
        "  personal",
        "  content",
        "",
      ]);
      assert.equal(blockContext.examples[0].sample.instructions, blockValue);

      const trailingValue = "some\npersonal\ncontent\u00a0";
      instructions.samples = [{ sample: { instructions: trailingValue }, description: "" }];
      const trailingContext = buildBaseTestContext(prompty, "prompty", goTestOptions);
      assert.deepEqual(trailingContext.examples[0].yaml, [
        "instructions: |-",
        "  some",
        "  personal",
        `  content${"\u00a0"}`,
        "",
      ]);

      const trailingSpace = makeProp("value", "string", { isScalar: true });
      trailingSpace.samples = [{
        sample: { value: "first line with trailing space \nsecond line\n" },
        description: "",
      }];
      const trailingSpaceContext = buildBaseTestContext(
        makeType("TrailingSpace", [trailingSpace]),
        "prompty",
        goTestOptions,
      );
      assert.deepEqual(
        trailingSpaceContext.examples[0].yaml,
        ['value: "first line with trailing space \\nsecond line\\n"', ""],
      );

      const mixedWhitespaceValue = "first line with two spaces  \n\n  \nlast line with three spaces   \n";
      trailingSpace.samples = [{
        sample: { value: mixedWhitespaceValue },
        description: "",
      }];
      const mixedWhitespaceContext = buildBaseTestContext(
        makeType("MixedWhitespace", [trailingSpace]),
        "prompty",
        goTestOptions,
      );
      assert.deepEqual(
        mixedWhitespaceContext.examples[0].yaml,
        ['value: "first line with two spaces  \\n\\n  \\nlast line with three spaces   \\n"', ""],
      );
      assert.equal(mixedWhitespaceContext.examples[0].sample.value, mixedWhitespaceValue);

      const leadingTab = makeProp("value", "string", { isScalar: true });
      leadingTab.samples = [{
        sample: { value: "\tfirst indented\nsecond line" },
        description: "",
      }];
      const leadingTabContext = buildBaseTestContext(
        makeType("LeadingTab", [leadingTab]),
        "prompty",
        goTestOptions,
      );
      assert.deepEqual(
        leadingTabContext.examples[0].yaml,
        ['value: "\\tfirst indented\\nsecond line"', ""],
      );

      const whitespace = makeProp("value", "string", { isScalar: true });
      whitespace.samples = [{ sample: { value: "\n" }, description: "" }];
      const whitespaceContext = buildBaseTestContext(
        makeType("Whitespace", [whitespace]),
        "prompty",
        goTestOptions,
      );
      assert.deepEqual(whitespaceContext.examples[0].yaml, ['value: "\\n"', ""]);

      const unicodeSeparator = makeProp("value", "string", { isScalar: true });
      unicodeSeparator.samples = [{
        sample: { value: "first\u2028second\nthird" },
        description: "",
      }];
      const unicodeContext = buildBaseTestContext(
        makeType("UnicodeSeparator", [unicodeSeparator]),
        "prompty",
        goTestOptions,
      );
      assert.doesNotMatch(unicodeContext.examples[0].yaml.join("\n"), /\|[-+]?/);
    });
  });

  it("lowers a polymorphic file with parent + children", () => {
    const file = lowerFile(contentPart, registry, polyNames);
    assert.equal(file.typeName.name, "ContentPart");
    assert.equal(file.types.length, 3); // ContentPart + TextPart + ImagePart
    assert.equal(file.types[0].typeName.name, "ContentPart");
    assert.equal(file.types[1].typeName.name, "TextPart");
    assert.equal(file.types[2].typeName.name, "ImagePart");
  });

  it("marks containsAbstract when base is abstract", () => {
    const file = lowerFile(connectionType, registry, polyNames);
    assert.equal(file.containsAbstract, true);
  });

  it("resolves imports excluding types defined in file", () => {
    const file = lowerFile(contentPart, registry, polyNames);
    // ContentPart, TextPart, ImagePart are all in this file — no self-imports
    const importNames = file.imports.flatMap(i => i.names);
    assert.ok(!importNames.includes("ContentPart"));
    assert.ok(!importNames.includes("TextPart"));
    assert.ok(!importNames.includes("ImagePart"));
  });

  it("resolves factory-referenced imports", () => {
    const file = lowerFile(toolResult, registry, polyNames);
    // ToolResult.text factory references TextPart and ContentPart
    const importNames = file.imports.flatMap(i => i.names);
    assert.ok(importNames.includes("TextPart"));
  });

  it("groups imports by module", () => {
    const file = lowerFile(toolResult, registry, polyNames);
    // TextPart should be imported from ContentPart module
    const contentImport = file.imports.find(i => i.module === "ContentPart");
    assert.ok(contentImport);
    assert.ok(contentImport!.names.includes("TextPart"));
  });

  it("produces identical IR regardless of eventual target language", () => {
    // The IR is language-agnostic — same input always produces same output
    const file1 = lowerFile(modelType, registry, polyNames);
    const file2 = lowerFile(modelType, registry, polyNames);
    assert.deepEqual(file1, file2);
  });
});

// ============================================================================
// Open self-reference payload preservation
// ============================================================================

describe("open self-reference payload preservation", () => {
  const registry = buildTestRegistry();
  const file = lowerFile(contentPart, registry, new Set(["ContentPart"]));

  it("emits exact, deep-cloned C# passthrough state", () => {
    const code = emitCSharpClass(
      file.types[0],
      "Test",
      new CSharpExprVisitor(),
      file.types,
      name => file.types.find(type => type.typeName.name === name),
    );

    assert.match(code, /protected Dictionary<string, object\?> _raw = new\(\);/);
    assert.match(code, /protected static object\? CloneRawValue\(object\? value\)/);
    assert.match(code, /var discriminator = discriminatorValue\.ToString\(\);/);
    assert.doesNotMatch(code, /ToLowerInvariant/);
    assert.match(code, /if \(instance\.GetType\(\) == typeof\(ContentPart\)\)/);
    assert.match(code, /instance\._raw = \(Dictionary<string, object\?>\)CloneRawValue\(data\)!;/);
    assert.match(code, /var result = \(Dictionary<string, object\?>\)CloneRawValue\(obj\._raw\)!;/);
  });

  it("emits exact, deep-cloned Python passthrough state", () => {
    const code = emitPythonFile(file, new PythonExprVisitor(registry));

    assert.match(code, /import copy/);
    assert.match(code, /_raw: dict\[str, Any\] = field\(default_factory=dict, init=False, repr=False\)/);
    assert.match(code, /discriminator_value = str\(data\["kind"\]\)/);
    assert.doesNotMatch(code, /discriminator_value = .*\.lower\(\)/);
    assert.match(code, /if type\(instance\) is ContentPart:\s+instance\._raw = copy\.deepcopy\(data\)/);
    assert.match(code, /result: dict\[str, Any\] = copy\.deepcopy\(obj\._raw\)/);
  });
});

// ============================================================================
// Rust emitter — first-class serde derives (Serialize/Deserialize/PartialEq)
// ============================================================================

describe("Rust emitter serde derives", () => {
  const registry = buildTestRegistry();

  it("preserves unknown abstract discriminator payloads losslessly", () => {
    const file = lowerFile(connectionType, registry, new Set(["Connection"]));
    const code = emitRustFile(file, new RustExprVisitor(registry), new Set(["Connection"]));

    assert.match(
      code,
      /Unknown \{\s+\/\/\/ The raw `kind` string for this unknown variant\.\s+kind_name: String,\s+\/\/\/ Unmodeled fields preserved for forward-compatible round trips\.\s+raw: serde_json::Map<String, serde_json::Value>/,
    );
    assert.match(code, /_ => ConnectionKind::Unknown \{\s+kind_name: kind_str\.to_string\(\),\s+raw: \{/);
    assert.match(code, /raw\.remove\("kind"\);/);
    assert.match(code, /ConnectionKind::Unknown \{ kind_name, \.\. \} => kind_name\.as_str\(\)/);
    assert.match(code, /ConnectionKind::Unknown \{ raw, \.\. \} => \{\s+for \(key, value\) in raw/);
  });

  it("preserves open self-reference discriminator payloads losslessly", () => {
    const file = lowerFile(contentPart, registry, new Set(["ContentPart"]));
    const code = emitRustFile(file, new RustExprVisitor(registry), new Set(["ContentPart"]));

    assert.match(
      code,
      /Custom \{\s+\/\/\/ The raw `kind` string for this unknown variant\.\s+kind_name: String,\s+\/\/\/ Unmodeled fields preserved for forward-compatible round trips\.\s+raw: serde_json::Map<String, serde_json::Value>/,
    );
    assert.match(code, /_ => ContentPartKind::Custom \{\s+kind_name: kind_str\.to_string\(\),\s+raw: \{/);
    assert.match(code, /raw\.remove\("kind"\);/);
    assert.match(code, /ContentPartKind::Custom \{ raw, \.\. \} => \{\s+for \(key, value\) in raw \{\s+if matches!\(key\.as_str\(\), "kind"\) \{ continue; \}/);
  });

  it("initializes raw payloads for coerced self-reference variants", () => {
    const known = makeType("CoercedOpenKnown", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "known" }),
    ], { base: { namespace: "Test", name: "CoercedOpen" } });
    const open = makeType("CoercedOpen", [
      makeProp("kind", "string", { isScalar: true }),
    ], {
      discriminator: "kind",
      childTypes: [known],
      coercions: [{ scalar: "string", expansion: { kind: "vendor" } }],
    });
    const coercionRegistry = TypeRegistry.fromTypeGraph([open, known]);
    const file = lowerFile(open, coercionRegistry, new Set(["CoercedOpen"]));
    const code = emitRustFile(file, new RustExprVisitor(coercionRegistry), new Set(["CoercedOpen"]));

    assert.match(
      code,
      /kind: CoercedOpenKind::Custom \{ kind_name: "vendor"\.to_string\(\), raw: serde_json::Map::new\(\) \}/,
    );
  });

  it("preserves unmatched coerced discriminators for open abstract variants", () => {
    const known = makeType("CoercedAbstractKnown", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "known" }),
    ], { base: { namespace: "Test", name: "CoercedAbstract" } });
    const open = makeType("CoercedAbstract", [
      makeProp("kind", "string", { isScalar: true }),
    ], {
      discriminator: "kind",
      childTypes: [known],
      coercions: [{ scalar: "string", expansion: { kind: "vendor" } }],
      isAbstract: true,
    });
    const coercionRegistry = TypeRegistry.fromTypeGraph([open, known]);
    const file = lowerFile(open, coercionRegistry, new Set(["CoercedAbstract"]));
    const code = emitRustFile(file, new RustExprVisitor(coercionRegistry), new Set(["CoercedAbstract"]));

    assert.match(
      code,
      /kind: CoercedAbstractKind::Unknown \{ kind_name: "vendor"\.to_string\(\), raw: serde_json::Map::new\(\) \}/,
    );
  });

  it("uses concrete vectors for explicit empty defaults and options for absent defaults", () => {
    const owner = makeType("CollectionOwner", [
      makeProp("name", "string", { isScalar: true }),
    ]);
    const collectionModel = makeType("CollectionModel", [
      makeProp("inputModalities", "string", {
        isScalar: true,
        isCollection: true,
        isOptional: true,
      }),
      makeProp("outputModalities", "string", {
        isScalar: true,
        isCollection: true,
        isOptional: true,
        defaultValue: null,
      }),
      makeProp("owners", "CollectionOwner", {
        isCollection: true,
        isOptional: true,
        type: owner,
      }),
      makeProp("defaultOwners", "CollectionOwner", {
        isCollection: true,
        isOptional: true,
        type: owner,
        defaultValue: null,
      }),
    ]);
    const collectionRegistry = TypeRegistry.fromTypeGraph([collectionModel, owner]);
    const file = lowerFile(collectionModel, collectionRegistry, new Set());
    const code = emitRustFile(file, new RustExprVisitor(collectionRegistry), new Set());

    assert.match(code, /pub input_modalities: Option<Vec<String>>/);
    assert.match(code, /pub output_modalities: Vec<String>/);
    assert.match(code, /pub owners: Option<Vec<CollectionOwner>>/);
    assert.match(code, /pub default_owners: Vec<CollectionOwner>/);
    assert.match(
      code,
      /output_modalities: value\.get\("outputModalities"\).*\.unwrap_or_default\(\)/,
    );
    assert.match(
      code,
      /default_owners: value\.get\("defaultOwners"\).*\.unwrap_or_default\(\)/,
    );
    assert.match(
      code,
      /result\.insert\("outputModalities"\.to_string\(\), serde_json::to_value\(&self\.output_modalities\)/,
    );
    assert.match(
      code,
      /result\.insert\("defaultOwners"\.to_string\(\), Self::save_default_owners\(&self\.default_owners, ctx\)\)/,
    );
  });

  it("emits manual serde (delegating to canonical to_value/load_from_value) on plain data structs", () => {
    // Every data struct — flat ones included — routes serde through the canonical
    // to_value/load_from_value path, NOT a field-by-field derive, so custom
    // canonicalization (map<->list, empty-omission, etc.) is always honored.
    const file = lowerFile(namedBinding, registry, new Set());
    const code = emitRustFile(file, new RustExprVisitor(registry), new Set());

    // No serde derive on the struct — only Debug/Clone/Default/PartialEq.
    assert.match(
      code,
      /#\[derive\(Debug, Clone, Default, PartialEq\)\]\npub struct Binding \{/,
    );
    assert.doesNotMatch(code, /#\[derive\([^)]*serde::Serialize[^)]*\)\]\npub struct Binding/);
    assert.doesNotMatch(code, /#\[serde\(rename_all = "camelCase"\)\]\n#\[serde\(default\)\]\npub struct Binding/);
    // Manual delegating serde instead.
    assert.match(code, /impl serde::Serialize for Binding \{/);
    assert.match(
      code,
      /serde::Serialize::serialize\(&self\.to_value\(&SaveContext::default\(\)\), serializer\)/,
    );
    assert.match(code, /impl<'de> serde::Deserialize<'de> for Binding \{/);
    assert.match(
      code,
      /Self::load_from_value\(&value, &LoadContext::default\(\)\)/,
    );
  });

  it("uses a manual serde impl (not a derive) for scalar-coercible structs", () => {
    // `Model` has a `@coerce(Model, string, ...)` shorthand: a bare string expands
    // into the struct. Derived `Deserialize` would reject that scalar, so the struct
    // must delegate to the canonical load_from_value (which understands the coercion).
    const file = lowerFile(modelType, registry, new Set());
    const code = emitRustFile(file, new RustExprVisitor(registry), new Set());

    assert.match(
      code,
      /#\[derive\(Debug, Clone, Default, PartialEq\)\]\npub struct Model \{/,
    );
    assert.match(code, /impl serde::Serialize for Model \{/);
    assert.match(code, /impl<'de> serde::Deserialize<'de> for Model \{/);
    assert.match(
      code,
      /Self::load_from_value\(&value, &LoadContext::default\(\)\)/,
    );
  });

  it("uses a manual serde impl (not a derive) for polymorphic discriminated unions", () => {
    const file = lowerFile(contentPart, registry, new Set(["ContentPart"]));
    const code = emitRustFile(
      file,
      new RustExprVisitor(registry),
      new Set(["ContentPart"]),
    );

    // The Kind data enum keeps PartialEq but must NOT derive serde: the derived
    // (externally-tagged) repr would emit Rust variant names instead of the wire
    // discriminator. An exact match on the derive line proves serde is absent.
    assert.match(
      code,
      /#\[derive\(Debug, Clone, PartialEq\)\]\npub enum ContentPartKind \{/,
    );

    // The polymorphic base struct also does not derive serde...
    assert.match(
      code,
      /#\[derive\(Debug, Clone, Default, PartialEq\)\]\npub struct ContentPart \{/,
    );

    // ...instead it gets manual serde impls delegating to the canonical
    // to_value/load_from_value so the `kind` discriminator round-trips to its
    // exact wire value while the LoadContext/SaveContext API stays intact.
    assert.match(code, /impl serde::Serialize for ContentPart \{/);
    assert.match(
      code,
      /serde::Serialize::serialize\(&self\.to_value\(&SaveContext::default\(\)\), serializer\)/,
    );
    assert.match(code, /impl<'de> serde::Deserialize<'de> for ContentPart \{/);
    assert.match(
      code,
      /Self::load_from_value\(&value, &LoadContext::default\(\)\)/,
    );

    // The Kind enum ITSELF is also independently serde-serializable to the same
    // canonical, internally-tagged wire: it wraps the variant back into its parent
    // and delegates to to_value/load_from_value — NOT the externally-tagged derive.
    assert.match(code, /impl serde::Serialize for ContentPartKind \{/);
    assert.match(
      code,
      /let parent = ContentPart \{ kind: self\.clone\(\), \.\.Default::default\(\) \};/,
    );
    assert.match(
      code,
      /serde::Serialize::serialize\(&parent\.to_value\(&SaveContext::default\(\)\), serializer\)/,
    );
    assert.match(code, /impl<'de> serde::Deserialize<'de> for ContentPartKind \{/);
    assert.match(
      code,
      /Ok\(ContentPart::load_from_value\(&value, &LoadContext::default\(\)\)\.kind\)/,
    );
  });

  it("emits serde support for string enums (plain-string round-trip)", () => {
    const role = makeProp("role", "string", {
      isScalar: true,
      allowedValues: ["user", "assistant"],
    });
    role.enumName = "Role";
    role.isOpenEnum = false;
    const chat = makeType("ChatTurn", [role]);
    const reg = TypeRegistry.fromTypeGraph([chat]);
    const file = lowerFile(chat, reg, new Set());
    const code = emitRustFile(file, new RustExprVisitor(reg), new Set());

    assert.match(code, /pub enum Role \{/);
    assert.match(code, /impl serde::Serialize for Role \{/);
    assert.match(code, /impl<'de> serde::Deserialize<'de> for Role \{/);
    assert.match(code, /serializer\.serialize_str\(self\.as_str\(\)\)/);
  });

  it("materializes explicit optional collection defaults as concrete vectors", () => {
    const tags = makeProp("tags", "string", {
      isScalar: true,
      isOptional: true,
      isCollection: true,
    });
    tags.hasExplicitDefault = true;
    const messages = makeProp("messages", "Message", {
      isOptional: true,
      isCollection: true,
    });
    messages.hasExplicitDefault = true;
    const optionalMessages = makeProp("optionalMessages", "Message", {
      isOptional: true,
      isCollection: true,
    });
    const response = makeType("Response", [tags, messages, optionalMessages]);
    const reg = TypeRegistry.fromTypeGraph([response]);
    const file = lowerFile(response, reg, new Set());
    const code = emitRustFile(file, new RustExprVisitor(reg), new Set());

    assert.match(code, /pub tags: Vec<String>/);
    assert.match(code, /pub messages: Vec<Message>/);
    assert.match(code, /pub optional_messages: Option<Vec<Message>>/);
    assert.match(code, /tags: value\.get\("tags"\)[^\n]+\.unwrap_or_default\(\)/);
    assert.match(code, /messages: value\.get\("messages"\)[^\n]+\.unwrap_or_default\(\)/);
    assert.match(code, /result\.insert\("tags"\.to_string\(\), serde_json::to_value\(&self\.tags\)/);
    assert.match(code, /result\.insert\("messages"\.to_string\(\), Self::save_messages\(&self\.messages, ctx\)\)/);
    assert.doesNotMatch(code, /Some\(Vec::new\(\)\)/);
  });

  it("materializes explicit collection defaults inside polymorphic variants", () => {
    const allowedTools = makeProp("allowedTools", "string", {
      isScalar: true,
      isOptional: true,
      isCollection: true,
    });
    allowedTools.hasExplicitDefault = true;
    const routedChoice = makeType("RoutedChoice", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "routed" }),
      allowedTools,
    ], { base: { namespace: "Test", name: "ToolChoice" } });
    const toolChoice = makeType("ToolChoice", [
      makeProp("kind", "string", { isScalar: true }),
    ], {
      discriminator: "kind",
      childTypes: [routedChoice],
    });
    const reg = TypeRegistry.fromTypeGraph([toolChoice]);
    const file = lowerFile(toolChoice, reg, new Set(["ToolChoice"]));
    const code = emitRustFile(file, new RustExprVisitor(reg), new Set(["ToolChoice"]));

    assert.match(code, /RoutedChoice \{[\s\S]*allowed_tools: Vec<String>/);
    assert.match(code, /allowed_tools: value\.get\("allowedTools"\)[^\n]+\.unwrap_or_default\(\)/);
    assert.match(code, /result\.insert\("allowedTools"\.to_string\(\), serde_json::to_value\(allowed_tools\)/);
    assert.doesNotMatch(code, /allowed_tools: Option<Vec<String>>/);
    assert.doesNotMatch(code, /Some\(ref items\)/);
  });
});

// ----------------------------------------------------------------------------
// Rust test-generator — sample-completeness gating of the serde_roundtrip gate
// ----------------------------------------------------------------------------
// The auto-generated `*_serde_roundtrip` template runs against BOTH typra's own
// complete-sample fixtures AND arbitrary consumer models whose `@sample` annotates
// only some fields. Byte-identity vs the sample is only valid for complete, float-safe
// samples; partial samples must fall back to the always-on delegation-equivalence
// assertions. This guards that the template partitions correctly on sample shape.
describe("Rust test generator serde_roundtrip gating", () => {
  function makeExample(sample: Record<string, unknown>, json: string[]): any {
    return { sample, json, yaml: [], validations: [] };
  }

  it("falls back to delegation-equivalence (no byte-identity) for a partial / float-unsafe sample", async () => {
    const { emitRustTest } = await import("../src/languages/rust/driver.js");
    // `status` is REQUIRED but unsampled (to_value would emit it → partial sample),
    // and `weight` is a float sampled as an integer (`3` canonicalizes to `3.0`).
    const node = makeType("PartialSample", [
      makeProp("title", "string", { isScalar: true }),
      makeProp("status", "string", { isScalar: true }),
      makeProp("weight", "float64", { isScalar: true }),
    ]);
    const code = emitRustTest({
      node,
      isAbstract: false,
      examples: [makeExample({ title: "hi", weight: 3 }, ['{', '  "title": "hi",', '  "weight": 3', '}'])],
      coercions: [],
      factories: [],
      importPath: "crate::model",
      isPolymorphicBase: false,
    } as RustTestContext);

    // Delegation-equivalence is ALWAYS emitted — the sample-agnostic invariant.
    assert.match(code, /serde serialize must equal canonical to_value/);
    assert.match(code, /serde deserialize must equal canonical load_from_value/);
    // Byte-identity against the partial/float-unsafe sample must be suppressed.
    assert.doesNotMatch(code, /byte-identical canonical wire/);
  });

  it("keeps byte-identity for a complete, float-safe sample", async () => {
    const { emitRustTest } = await import("../src/languages/rust/driver.js");
    const node = makeType("CompleteSample", [
      makeProp("title", "string", { isScalar: true }),
      makeProp("count", "int32", { isScalar: true }),
    ]);
    const code = emitRustTest({
      node,
      isAbstract: false,
      examples: [makeExample({ title: "hi", count: 3 }, ['{', '  "title": "hi",', '  "count": 3', '}'])],
      coercions: [],
      factories: [],
      importPath: "crate::model",
      isPolymorphicBase: false,
    } as RustTestContext);

    // Delegation-equivalence still present...
    assert.match(code, /serde serialize must equal canonical to_value/);
    // ...AND the stronger byte-identity check is retained for complete samples.
    assert.match(code, /byte-identical canonical wire/);
  });

  it("suppresses byte-identity when an optional-WITH-DEFAULT field is absent from the sample", async () => {
    const { emitRustTest } = await import("../src/languages/rust/driver.js");
    // `status` is optional (`?`) but carries a default, so to_value materializes+emits it
    // on save even though the sample omits it — byte-identity vs the partial sample would
    // FAIL (this is prompty's TurnCommit `status`/`contextState` case). Must suppress.
    const node = makeType("DefaultedSample", [
      makeProp("title", "string", { isScalar: true }),
      makeProp("status", "string", { isScalar: true, isOptional: true, defaultValue: "active" }),
    ]);
    const code = emitRustTest({
      node,
      isAbstract: false,
      examples: [makeExample({ title: "hi" }, ['{', '  "title": "hi"', '}'])],
      coercions: [],
      factories: [],
      importPath: "crate::model",
      isPolymorphicBase: false,
    } as RustTestContext);

    assert.match(code, /serde serialize must equal canonical to_value/);
    assert.doesNotMatch(code, /byte-identical canonical wire/);
  });

  it("never emits integer-index nested-discriminator navigation", async () => {
    const { emitRustTest } = await import("../src/languages/rust/driver.js");
    // The `value[prop][0].get(disc)` navigation is unsafe for keyed collections (name-keyed
    // MAP wire) and redundant with delegation-equivalence — it must not be generated at all.
    const child = makeType("TextPart2", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "text" }),
      makeProp("value", "string", { isScalar: true }),
    ], { base: { namespace: "Test", name: "Part2" } });
    const part = makeType("Part2", [makeProp("kind", "string", { isScalar: true })], {
      discriminator: "kind",
      childTypes: [child],
    });
    const holder = makeType("Holder2", [
      makeProp("parts", "Part2", { isCollection: true, type: part }),
    ]);
    const code = emitRustTest({
      node: holder,
      isAbstract: false,
      examples: [makeExample(
        { parts: [{ kind: "text", value: "hi" }] },
        ['{', '  "parts": [ { "kind": "text", "value": "hi" } ]', '}'],
      )],
      coercions: [],
      factories: [],
      importPath: "crate::model",
      isPolymorphicBase: false,
    } as RustTestContext);

    assert.doesNotMatch(code, /nested discriminator must round-trip/);
    assert.doesNotMatch(code, /\.and_then\(\|v\| v\.get\(0\)\)/);
  });

  it("suppresses byte-identity when a REQUIRED field is authored at its omittable zero/empty value", async () => {
    const { emitRustTest } = await import("../src/languages/rust/driver.js");
    // to_value OMITS required string==""/int==0/float==0.0/empty-collection fields, so a
    // sample authoring them is NOT a canonical fixed point — byte-identity vs it would fail
    // (prompty's validation_result `errors:[]`, turn_model_request `iteration:0`). Must fall
    // back to delegation-equivalence. (Optional fields authored at zero ARE emitted → safe.)
    const node = makeType("OverAuthored", [
      makeProp("title", "string", { isScalar: true }),
      makeProp("count", "int32", { isScalar: true }),
      makeProp("tags", "string", { isScalar: true, isCollection: true }),
    ]);
    const code = emitRustTest({
      node,
      isAbstract: false,
      examples: [makeExample(
        { title: "hi", count: 0, tags: [] },
        ['{', '  "title": "hi",', '  "count": 0,', '  "tags": []', '}'],
      )],
      coercions: [],
      factories: [],
      importPath: "crate::model",
      isPolymorphicBase: false,
    } as RustTestContext);

    assert.match(code, /serde serialize must equal canonical to_value/);
    assert.doesNotMatch(code, /byte-identical canonical wire/);
  });
});
