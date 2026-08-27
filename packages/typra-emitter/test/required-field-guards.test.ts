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
 * The guard is now unconditional inside the wildcard carrier's own load path across all seven
 * targets. Crucially, this holds even after the open-union loader fallback (Bug #2): a union
 * with a default variant no longer rejects an absent/blank/non-string discriminator up front,
 * but normalizes it to "" and routes it to the default variant -- here the `*` carrier
 * GuardCustomTool. Because the carrier still runs its own required-field guard, the
 * no-fabrication guarantee is preserved: only the error *site* moves, from a discriminator
 * reject to the carrier's `missing required field` diagnostic. Closed unions (no default
 * variant) still reject an invalid discriminator up front -- see the dispatch-loader-fallback
 * and declarations suites for that gating.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Model, ModelProperty } from "@typespec/compiler";

import { TypeNode, PropertyNode } from "../src/ir/ast.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { lowerFile } from "../src/ir/lower.js";
import {
  optionalFieldAbsencePolicy,
  saveFieldEmissionPolicy,
  shouldGuardMissingRequiredField,
  shouldMaterializeCollectionDefault,
  shouldPreserveOptionalAbsence,
} from "../src/ir/field-emission-policy.js";
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

function prop(
  name: string,
  typeName: string,
  opts?: {
    isScalar?: boolean;
    isOptional?: boolean;
    type?: TypeNode;
    defaultValue?: string | null;
  },
): PropertyNode {
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

function type(
  name: string,
  props: PropertyNode[],
  opts?: {
    discriminator?: string;
    childTypes?: TypeNode[];
    isAbstract?: boolean;
    base?: { namespace: string; name: string };
  },
): TypeNode {
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

const guardCustomTool = type(
  "GuardCustomTool",
  [
    prop("kind", "string", { isScalar: true, defaultValue: "*" }),
    prop("connection", "GuardConnection", { type: guardConnection }),
  ],
  { base: { namespace: "Test", name: "GuardTool" } },
);

const guardTool = type(
  "GuardTool",
  [prop("kind", "string", { isScalar: true })],
  { discriminator: "kind", childTypes: [guardCustomTool], isAbstract: true },
);

const registry = TypeRegistry.fromTypeGraph([
  guardTool,
  guardCustomTool,
  guardConnection,
]);
const polymorphicNames = new Set(["GuardTool"]);
const file = lowerFile(guardTool, registry, polymorphicNames);

// The lowering must actually produce the shape under test, otherwise the assertions below
// would pass vacuously against a fixture that never had a wildcard carrier at all.
describe("wildcard discriminator carrier fixture", () => {
  it("lowers a wildcard-defaulted discriminator alongside a required complex field", () => {
    const custom = file.types.find(
      (candidate) => candidate.typeName.name === "GuardCustomTool",
    );
    assert.ok(custom, "GuardCustomTool must be lowered");
    assert.equal(
      custom!.fields.find((f) => f.name === "kind")?.defaultValue,
      "*",
    );
    const connection = custom!.fields.find((f) => f.name === "connection");
    assert.equal(connection?.category.kind, "complex");
    assert.equal(connection?.isOptional, false);
    assert.equal(connection?.hasExplicitDefault, false);
  });
});

describe("shared missing-required-field policy", () => {
  it("guards required complex fields and not optional or defaulted fields", () => {
    const custom = file.types.find(
      (candidate) => candidate.typeName.name === "GuardCustomTool",
    )!;
    const connection = custom.fields.find(
      (field) => field.name === "connection",
    );
    const kind = custom.fields.find((field) => field.name === "kind");

    assert.equal(shouldGuardMissingRequiredField(connection), true);
    assert.equal(
      shouldGuardMissingRequiredField({ ...connection!, isOptional: true }),
      false,
    );
    assert.equal(
      shouldGuardMissingRequiredField({
        ...connection!,
        hasExplicitDefault: true,
      }),
      false,
    );
    assert.equal(shouldGuardMissingRequiredField(kind), false);
  });

  it("does not guard a subtype's own required scalar field (parity with Rust)", () => {
    const base = file.types.find(
      (candidate) => candidate.typeName.name === "GuardTool",
    )!;
    const kind = base.fields.find((field) => field.name === "kind");

    // A discriminated-union subtype's required scalar defaults to its zero value on load
    // (Rust `.unwrap_or_default()`); only required complex fields guard-then-fail.
    assert.equal(shouldGuardMissingRequiredField(kind), false);
  });
});

describe("shared save-side field emission policy", () => {
  it("names the default optional-only emit/omit decision", () => {
    const custom = file.types.find(
      (candidate) => candidate.typeName.name === "GuardCustomTool",
    )!;
    const connection = custom.fields.find(
      (field) => field.name === "connection",
    )!;

    assert.equal(saveFieldEmissionPolicy(connection), "emit-always");
    assert.equal(
      saveFieldEmissionPolicy({ ...connection, isOptional: true }),
      "omit-when-absent",
    );
  });

  it("preserves backend-specific current save profiles explicitly", () => {
    const custom = file.types.find(
      (candidate) => candidate.typeName.name === "GuardCustomTool",
    )!;
    const connection = custom.fields.find(
      (field) => field.name === "connection",
    )!;
    const requiredCollection = {
      ...connection,
      category: {
        kind: "collection_complex" as const,
        typeName: "GuardConnection",
      },
    };

    assert.equal(
      saveFieldEmissionPolicy(connection, "always-check"),
      "omit-when-absent",
    );
    assert.equal(
      saveFieldEmissionPolicy(requiredCollection, "go"),
      "omit-when-absent",
    );
    assert.equal(
      saveFieldEmissionPolicy(
        { ...requiredCollection, isOptional: true },
        "rust-collection-default",
      ),
      "omit-when-absent",
    );
    assert.equal(
      saveFieldEmissionPolicy(
        { ...requiredCollection, isOptional: true, hasExplicitDefault: true },
        "rust-collection-default",
      ),
      "emit-always",
    );
    assert.equal(
      saveFieldEmissionPolicy(
        { ...connection, hasExplicitDefault: true },
        "rust-value-sentinel",
      ),
      "omit-when-absent",
    );
  });
});

describe("shared optional absence/default policy", () => {
  it("preserves absent optional fields unless an explicit default materializes them", () => {
    const custom = file.types.find(
      (candidate) => candidate.typeName.name === "GuardCustomTool",
    )!;
    const connection = custom.fields.find(
      (field) => field.name === "connection",
    )!;
    const optionalCollection = {
      ...connection,
      isOptional: true,
      hasExplicitDefault: false,
      category: {
        kind: "collection_complex" as const,
        typeName: "GuardConnection",
      },
    };
    const defaultedOptionalCollection = {
      ...optionalCollection,
      hasExplicitDefault: true,
    };

    assert.equal(
      optionalFieldAbsencePolicy(optionalCollection),
      "preserve-absence",
    );
    assert.equal(shouldPreserveOptionalAbsence(optionalCollection), true);
    assert.equal(
      optionalFieldAbsencePolicy(defaultedOptionalCollection),
      "materialize-default",
    );
    assert.equal(
      shouldPreserveOptionalAbsence(defaultedOptionalCollection),
      false,
    );
    assert.equal(optionalFieldAbsencePolicy(connection), "materialize-default");
  });

  it("preserves backend-specific collection default materialization profiles", () => {
    const custom = file.types.find(
      (candidate) => candidate.typeName.name === "GuardCustomTool",
    )!;
    const connection = custom.fields.find(
      (field) => field.name === "connection",
    )!;
    const requiredCollection = {
      ...connection,
      category: {
        kind: "collection_complex" as const,
        typeName: "GuardConnection",
      },
    };
    const optionalCollection = {
      ...requiredCollection,
      isOptional: true,
      hasExplicitDefault: false,
    };
    const defaultedOptionalCollection = {
      ...optionalCollection,
      hasExplicitDefault: true,
    };

    assert.equal(shouldMaterializeCollectionDefault(requiredCollection), true);
    assert.equal(shouldMaterializeCollectionDefault(optionalCollection), false);
    assert.equal(
      shouldMaterializeCollectionDefault(defaultedOptionalCollection),
      true,
    );
    assert.equal(
      shouldMaterializeCollectionDefault(requiredCollection, "explicit-only"),
      false,
    );
    assert.equal(
      shouldMaterializeCollectionDefault(
        defaultedOptionalCollection,
        "explicit-only",
      ),
      true,
    );
    assert.equal(shouldMaterializeCollectionDefault(connection), false);
  });
});

describe("missing required complex fields always fail load", () => {
  it("TypeScript routes an invalid discriminator to the wildcard carrier, which still guards", () => {
    const code = emitTypeScriptFile(file, new TypeScriptExprVisitor(registry));

    assert.match(
      code,
      /if \(data\["connection"\] === undefined \|\| data\["connection"\] === null\) \{/,
    );
    assert.match(
      code,
      /context\.at\("connection"\)\.path\}: missing required field/,
    );
    assert.doesNotMatch(
      code,
      /typeof data\["kind"\] === "string" && data\["kind"\] !== ""/,
    );
    // Open union with a `*` carrier: an absent/non-string discriminator normalizes
    // to "" and routes to the carrier rather than being rejected up front.
    assert.doesNotMatch(
      code,
      /Invalid GuardTool discriminator field 'kind': expected non-blank string/,
    );
    assert.match(
      code,
      /const discriminator = typeof discriminatorValue === "string" \? discriminatorValue : "";/,
    );
    assert.match(code, /return GuardCustomTool\.load\(data, context\);/);
  });

  it("Python routes an invalid discriminator to the wildcard carrier, which still guards", () => {
    const code = emitPythonFile(file, new PythonExprVisitor(registry));

    assert.match(
      code,
      /if "connection" not in data or data\["connection"\] is None:/,
    );
    assert.match(
      code,
      /context\.at\('connection'\)\.path\}: missing required field/,
    );
    assert.doesNotMatch(code, /isinstance\(data\.get\("kind"\), str\)/);
    assert.doesNotMatch(
      code,
      /Invalid GuardTool discriminator field 'kind': expected non-blank string/,
    );
    assert.match(code, /discriminator_value = ""/);
    assert.match(
      code,
      /if isinstance\(discriminator_raw, str\):\s*\n\s*discriminator_value = discriminator_raw/,
    );
    assert.match(code, /return GuardCustomTool\.load\(data, context\)/);
  });

  it("C# guards unconditionally", () => {
    const custom = file.types.find(
      (candidate) => candidate.typeName.name === "GuardCustomTool",
    )!;
    const code = emitCSharpClass(
      custom,
      "Test",
      new CSharpExprVisitor(),
      file.types,
      (name) =>
        file.types.find((candidate) => candidate.typeName.name === name),
    );

    assert.match(
      code,
      /if \(!data\.TryGetValue\("connection", out var requiredConnectionValue\) \|\| requiredConnectionValue is null\)/,
    );
    assert.match(code, /At\("connection"\)\.Path\}: missing required field/);
    assert.doesNotMatch(
      code,
      /IsNullOrEmpty\(data\.GetValueOrDefault\("kind"\)/,
    );
  });

  it("C# dispatch routes an invalid discriminator to the wildcard carrier", () => {
    const code = emitCSharpClass(
      file.types.find((candidate) => candidate.typeName.name === "GuardTool")!,
      "Test",
      new CSharpExprVisitor(),
      file.types,
      (name) =>
        file.types.find((candidate) => candidate.typeName.name === name),
    );

    assert.doesNotMatch(
      code,
      /Invalid GuardTool discriminator field 'kind': expected non-blank string/,
    );
    assert.match(
      code,
      /var discriminator = data\.TryGetValue\("kind", out var discriminatorValue\) && discriminatorValue is string discriminatorString \? discriminatorString : "";/,
    );
    assert.match(code, /_ => GuardCustomTool\.Load\(data, context\),/);
  });

  it("Go routes an invalid discriminator to the wildcard carrier, which still guards", () => {
    const code = emitGoFileContent(
      file.types,
      "fixtures",
      new GoExprVisitor(registry),
      polymorphicNames,
      file.enums,
      file.group,
    );

    assert.match(
      code,
      /if requiredValue, exists := m\["connection"\]; !exists \|\| requiredValue == nil \{/,
    );
    assert.match(code, /ctx\.At\("connection"\)\.Path\)/);
    assert.doesNotMatch(code, /hasDiscriminator := m\["kind"\]/);
    assert.doesNotMatch(
      code,
      /invalid GuardTool discriminator field 'kind': expected non-blank string/,
    );
    assert.match(code, /return LoadGuardCustomTool\(data, ctx\)/);
  });

  it("Java routes an invalid discriminator to the wildcard carrier, which still guards", () => {
    const code = emitJavaFileContent(
      file.types,
      "fixtures",
      new JavaExprVisitor(registry),
      polymorphicNames,
      file.enums,
    );

    assert.match(
      code,
      /if \(!map\.containsKey\("connection"\) \|\| map\.get\("connection"\) == null\) \{/,
    );
    assert.match(
      code,
      /ctx\.at\("connection"\)\.path \+ ": missing required field"/,
    );
    assert.match(code, /discriminator instanceof String discriminatorRaw/);
    assert.doesNotMatch(code, /String\.valueOf\(discriminator\)/);
    assert.match(code, /return GuardCustomTool\.load\(data, ctx\);/);
  });

  it("Swift routes an invalid discriminator to the wildcard carrier and preserves fallback payload", () => {
    const code = emitSwiftFile(
      file,
      new SwiftExprVisitor(registry),
      polymorphicNames,
    );

    assert.match(
      code,
      /if object\["connection"\] == nil \|\| object\["connection"\] is NSNull \{/,
    );
    assert.match(
      code,
      /context\.at\("connection"\)\.path \+ ": missing required field"/,
    );
    assert.match(code, /let discriminator = object\["kind"\] as\? String \?\? ""/);
    assert.doesNotMatch(
      code,
      /if let discriminator = object\["kind"\] as\? String, !discriminator\.isEmpty \{/,
    );
    assert.match(
      code,
      /case guardCustomTool\(GuardCustomTool, \[String: Any\]\)/,
    );
    assert.match(
      code,
      /default: return \.guardCustomTool\(try GuardCustomTool\.load\(normalizedData, context: context\), object\)/,
    );
  });

  it("Rust routes an invalid discriminator to the wildcard carrier, which still guards", () => {
    const code = emitRustFile(
      file,
      new RustExprVisitor(registry),
      polymorphicNames,
    );

    assert.match(
      code,
      /value\.get\("connection"\)\.filter\(\|candidate\| !candidate\.is_null\(\)\)/,
    );
    assert.match(code, /missing required field", child_path/);
    assert.doesNotMatch(
      code,
      /as_str\(\)\)\.is_some_and\(\|discriminator\| !discriminator\.is_empty\(\)\)/,
    );
    assert.doesNotMatch(
      code,
      /Invalid GuardTool discriminator field 'kind': expected non-blank string/,
    );
    assert.match(code, /_ => GuardToolKind::GuardCustomTool \{/);
  });

  it("Rust exposes a fallible try_load_from_value routed through validate_input_at (#210)", () => {
    const code = emitRustFile(
      file,
      new RustExprVisitor(registry),
      polymorphicNames,
    );

    // Fallible sibling of load_from_value: takes a parsed value, returns Result.
    assert.match(
      code,
      /pub fn try_load_from_value\(\s*value: &serde_json::Value,\s*ctx: &LoadContext,\s*\) -> Result<Self, serde_json::Error> \{/,
    );
    // Identical validation policy to from_json: same validate_input_at routing
    // and the same serde custom-error mapping, so a missing required field
    // surfaces the same "missing required field" Err instead of panicking.
    assert.match(
      code,
      /pub fn try_load_from_value\([\s\S]*?Self::validate_input_at\(value, ""\)\s*\.map_err\(\|message\| <serde_json::Error as serde::de::Error>::custom\(message\)\)\?;\s*Ok\(Self::load_from_value\(value, ctx\)\)\s*\}/,
    );
    // The infallible internal entry point is unchanged and still present.
    assert.match(code, /pub fn load_from_value\(/);
  });
});
