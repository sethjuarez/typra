/**
 * Regression tests for missing-required-field guards on wildcard discriminator carriers.
 *
 * A required, non-defaulted complex field must fail load with a pathful diagnostic when it is
 * absent or null. Emitter 0.4.x gated that guard behind "the enclosing type owns a wildcard
 * discriminator field whose incoming value is a non-empty string", so an absent, empty, or
 * non-string discriminator skipped the check entirely and the field silently kept its
 * struct/class initializer default. A fabricated value must never substitute for a missing
 * required field.
 *
 * The fix has two halves:
 *
 *  - TypeScript, Python, C#, Go and Java model an open discriminated base as a real base
 *    class, so the guard inside the wildcard carrier is now unconditional, and dispatch treats
 *    a blank discriminator as absent (routing it to the base instead of the wildcard carrier).
 *
 *  - Swift and Rust still model a wildcard-defaulted open base as an enum with no base case, so
 *    a blank or absent discriminator has nowhere to go but the wildcard carrier. There the guard
 *    fires for every discriminator value except absent/null/blank, which closes the non-string
 *    hole without rejecting the only representation those backends have for a base instance.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Model, ModelProperty } from "@typespec/compiler";

import { TypeNode, PropertyNode } from "../src/ir/ast.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { lowerFile } from "../src/ir/lower.js";
import { emitTypeScriptFile } from "../src/languages/typescript/emitter.js";
import { TypeScriptExprVisitor } from "../src/languages/typescript/visitor.js";
import { emitPythonFile } from "../src/languages/python/emitter.js";
import { PythonExprVisitor } from "../src/languages/python/visitor.js";
import { emitCSharpClass } from "../src/languages/csharp/emitter.js";
import { CSharpExprVisitor } from "../src/languages/csharp/visitor.js";
import { emitGoFileContent } from "../src/languages/go/emitter.js";
import { GoExprVisitor } from "../src/languages/go/visitor.js";
import { emitJavaFileContent } from "../src/languages/java/emitter.js";
import { JavaExprVisitor } from "../src/languages/java/visitor.js";
import { emitSwiftFile } from "../src/languages/swift/emitter.js";
import { SwiftExprVisitor } from "../src/languages/swift/visitor.js";
import { emitRustFile } from "../src/languages/rust/emitter.js";
import { RustExprVisitor } from "../src/languages/rust/visitor.js";

// ============================================================================
// Fixture: a wildcard-discriminator variant carrying a required complex field.
//
//   @discriminator("kind") model GuardTool { kind: string; }
//   model GuardCustomTool extends GuardTool { kind: "*"; connection: GuardConnection; }
//
// `kind: "*"` makes GuardCustomTool the open/wildcard carrier, which is exactly the shape
// that used to disable the required-`connection` check.
// ============================================================================

function prop(name: string, typeName: string, opts?: {
  isScalar?: boolean;
  isOptional?: boolean;
  type?: TypeNode;
  defaultValue?: string | null;
}): PropertyNode {
  const node = new PropertyNode({} as ModelProperty, `Guard ${name}`);
  node.name = name;
  node.typeName = { namespace: "Test", name: typeName };
  node.isScalar = opts?.isScalar ?? false;
  node.isOptional = opts?.isOptional ?? false;
  node.isCollection = false;
  node.isDict = false;
  node.type = opts?.type;
  node.defaultValue = opts?.defaultValue ?? null;
  node.hasExplicitDefault = opts?.defaultValue !== undefined;
  node.allowedValues = [];
  node.isNamedCollection = false;
  return node;
}

function type(name: string, props: PropertyNode[], opts?: {
  discriminator?: string;
  childTypes?: TypeNode[];
  isAbstract?: boolean;
  base?: { namespace: string; name: string };
}): TypeNode {
  const node = new TypeNode({} as Model, `Guard ${name}`);
  node.typeName = { namespace: "Test", name };
  node.properties = props;
  node.discriminator = opts?.discriminator;
  node.childTypes = opts?.childTypes ?? [];
  node.factories = [];
  node.coercions = [];
  node.isAbstract = opts?.isAbstract ?? false;
  node.base = opts?.base ?? null;
  node.methods = [];
  return node;
}

const guardConnection = type("GuardConnection", [
  prop("name", "string", { isScalar: true }),
]);

const guardCustomTool = type("GuardCustomTool", [
  prop("kind", "string", { isScalar: true, defaultValue: "*" }),
  prop("connection", "GuardConnection", { type: guardConnection }),
], { base: { namespace: "Test", name: "GuardTool" } });

const guardTool = type("GuardTool", [
  prop("kind", "string", { isScalar: true }),
], { discriminator: "kind", childTypes: [guardCustomTool], isAbstract: true });

const registry = TypeRegistry.fromTypeGraph([guardTool, guardCustomTool, guardConnection]);
const polymorphicNames = new Set(["GuardTool"]);
const file = lowerFile(guardTool, registry, polymorphicNames);

// The lowering must actually produce the shape under test, otherwise the assertions below
// would pass vacuously against a fixture that never had a wildcard carrier at all.
describe("wildcard discriminator carrier fixture", () => {
  it("lowers a wildcard-defaulted discriminator alongside a required complex field", () => {
    const custom = file.types.find(candidate => candidate.typeName.name === "GuardCustomTool");
    assert.ok(custom, "GuardCustomTool must be lowered");
    assert.equal(custom!.fields.find(f => f.name === "kind")?.defaultValue, "*");
    const connection = custom!.fields.find(f => f.name === "connection");
    assert.equal(connection?.category.kind, "complex");
    assert.equal(connection?.isOptional, false);
    assert.equal(connection?.hasExplicitDefault, false);
  });
});

describe("missing required complex fields always fail load", () => {
  it("TypeScript guards unconditionally", () => {
    const code = emitTypeScriptFile(file, new TypeScriptExprVisitor(registry));

    assert.match(code, /if \(data\["connection"\] === undefined \|\| data\["connection"\] === null\) \{/);
    assert.match(code, /context\.at\("connection"\)\.path\}: missing required field/);
    assert.doesNotMatch(code, /typeof data\["kind"\] === "string" && data\["kind"\] !== ""/);
    // A blank discriminator must not select the wildcard carrier.
    assert.match(code, /String\(discriminatorValue\) !== ""/);
  });

  it("Python guards unconditionally", () => {
    const code = emitPythonFile(file, new PythonExprVisitor(registry));

    assert.match(code, /if "connection" not in data or data\["connection"\] is None:/);
    assert.match(code, /context\.at\('connection'\)\.path\}: missing required field/);
    assert.doesNotMatch(code, /isinstance\(data\.get\("kind"\), str\)/);
    assert.match(code, /str\(data\["kind"\]\) != ""/);
  });

  it("C# guards unconditionally", () => {
    const custom = file.types.find(candidate => candidate.typeName.name === "GuardCustomTool")!;
    const code = emitCSharpClass(
      custom,
      "Test",
      new CSharpExprVisitor(),
      file.types,
      name => file.types.find(candidate => candidate.typeName.name === name),
    );

    assert.match(code, /if \(!data\.TryGetValue\("connection", out var requiredConnectionValue\) \|\| requiredConnectionValue is null\)/);
    assert.match(code, /At\("connection"\)\.Path\}: missing required field/);
    assert.doesNotMatch(code, /IsNullOrEmpty\(data\.GetValueOrDefault\("kind"\)/);
  });

  it("C# dispatch ignores a blank discriminator", () => {
    const code = emitCSharpClass(
      file.types.find(candidate => candidate.typeName.name === "GuardTool")!,
      "Test",
      new CSharpExprVisitor(),
      file.types,
      name => file.types.find(candidate => candidate.typeName.name === name),
    );

    assert.match(code, /discriminatorValue\.ToString\(\) != ""/);
  });

  it("Go guards unconditionally", () => {
    const code = emitGoFileContent(
      file.types,
      "fixtures",
      new GoExprVisitor(registry),
      polymorphicNames,
      file.enums,
      file.group,
    );

    assert.match(code, /if requiredValue, exists := m\["connection"\]; !exists \|\| requiredValue == nil \{/);
    assert.match(code, /ctx\.At\("connection"\)\.Path\)/);
    assert.doesNotMatch(code, /hasDiscriminator := m\["kind"\]/);
    assert.match(code, /case "":\n\t+\/\/ blank discriminator: not a variant selector/);
  });

  it("Java guards unconditionally", () => {
    const code = emitJavaFileContent(
      file.types,
      "fixtures",
      new JavaExprVisitor(registry),
      polymorphicNames,
      file.enums,
    );

    assert.match(code, /if \(!map\.containsKey\("connection"\) \|\| map\.get\("connection"\) == null\) \{/);
    assert.match(code, /ctx\.at\("connection"\)\.path \+ ": missing required field"/);
    assert.doesNotMatch(code, /instanceof String discriminator && !discriminator\.isEmpty\(\)/);
    assert.match(code, /discriminator != null && !String\.valueOf\(discriminator\)\.isEmpty\(\)/);
  });

  it("Swift guards every wildcard-default discriminator except a blank one", () => {
    const code = emitSwiftFile(file, new SwiftExprVisitor(registry), polymorphicNames);

    assert.match(code, /if object\["connection"\] == nil \|\| object\["connection"\] is NSNull \{/);
    assert.match(code, /context\.at\("connection"\)\.path \+ ": missing required field"/);
    // The old guard only fired for a non-empty *String*, so a numeric or boolean `kind`
    // skipped it entirely. That form must be gone.
    assert.doesNotMatch(code, /if let discriminator = object\["kind"\] as\? String, !discriminator\.isEmpty \{/);
    assert.match(code, /\(object\["kind"\] as\? String\)\?\.isEmpty == true/);
  });

  it("Rust guards every discriminator except a blank one", () => {
    const code = emitRustFile(file, new RustExprVisitor(registry), polymorphicNames);

    assert.match(code, /value\.get\("connection"\)\.filter\(\|candidate\| !candidate\.is_null\(\)\)/);
    assert.match(code, /missing required field", child_path/);
    assert.doesNotMatch(code, /as_str\(\)\)\.is_some_and\(\|discriminator\| !discriminator\.is_empty\(\)\)/);
    assert.match(code, /!candidate\.is_null\(\) && candidate\.as_str\(\) != Some\(""\)/);
  });
});
