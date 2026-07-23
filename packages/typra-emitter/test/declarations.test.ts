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
import { Model, ModelProperty } from "@typespec/compiler";

import { TypeRegistry } from "../src/ir/expansion.js";
import { TypeNode, PropertyNode } from "../src/ir/ast.js";
import {
  classifyProperty,
  lowerFile,
  lowerType,
  collectPolymorphicTypeNames,
} from "../src/ir/lower.js";
import { emitSwiftFile } from "../src/languages/swift/emitter.js";
import { SwiftExprVisitor } from "../src/languages/swift/visitor.js";
import { emitGoFileContent } from "../src/languages/go/emitter.js";
import { GoExprVisitor } from "../src/languages/go/visitor.js";
import { emitRustFile } from "../src/languages/rust/emitter.js";
import type { RustTestContext } from "../src/languages/rust/driver.js";
import { RustExprVisitor } from "../src/languages/rust/visitor.js";

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

  it("lowers collection helper with name property detection", () => {
    const typeWithNamedCollection = makeType("Container", [
      makeProp("bindings", "Binding", { isCollection: true, type: namedBinding }),
    ]);
    const decl = lowerType(typeWithNamedCollection, registry, polyNames);
    assert.equal(decl.collectionHelpers.length, 1);
    assert.equal(decl.collectionHelpers[0].hasNameProperty, true);
    assert.deepEqual(decl.collectionHelpers[0].innerFields, ["value"]); // "name" excluded
  });

  it("recovers keyed-collection detection for a 2nd same-element collection whose prop.type is unset", () => {
    // resolveModel leaves a collection property's `type` UNSET when the same element type
    // was already resolved by an earlier sibling (cycle-prevention) — e.g. Prompty.outputs
    // after inputs, both `Record<Property>|Named<..>[]`. Without registry fallback the 2nd
    // collection loses keyed-collection codegen (hasNameProperty=false) and saves/loads as a
    // degenerate array — silent data loss on map-form input. The registry lookup restores it.
    const inputs = makeProp("inputs", "Binding", { isCollection: true, type: namedBinding });
    const outputs = makeProp("outputs", "Binding", { isCollection: true }); // type UNSET (cycle quirk)
    const holder = makeType("Holder", [inputs, outputs]);
    const holderRegistry = TypeRegistry.fromTypeGraph([holder, namedBinding]);
    const decl = lowerType(holder, holderRegistry, new Set());
    const out = decl.collectionHelpers.find(h => h.propertyName === "outputs")!;
    assert.equal(out.hasNameProperty, true, "2nd same-element collection must still detect the keyed collection via registry");
    assert.deepEqual(out.innerFields, ["value"]);
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
      assert.match(code, /\t"fmt"/);
      assert.match(code, /return nil, fmt\.Errorf\("unknown ConnectionWithCoercion discriminator value: %s", discriminator\)/);
      assert.match(code, /return nil, fmt\.Errorf\("missing ConnectionWithCoercion discriminator property: kind"\)/);
    });

    it("routes non-string discriminators through the default variant when one exists", () => {
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
      assert.match(code, /\t\t\tdefault:\n\t\t\t\treturn result, nil/);
      assert.match(code, /\t\t\tdefault:\n\t\t\t\treturn result, nil/);
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
// Rust emitter — first-class serde derives (Serialize/Deserialize/PartialEq)
// ============================================================================

describe("Rust emitter serde derives", () => {
  const registry = buildTestRegistry();

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
