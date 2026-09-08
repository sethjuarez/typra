import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Model, ModelProperty } from "@typespec/compiler";

import { TypeNode, PropertyNode } from "../src/ir/ast.js";
import { renderTests } from "../src/languages/csharp/driver.js";

interface PropOptions {
  isScalar?: boolean;
  enumName?: string;
  isOpenEnum?: boolean;
  sample?: Record<string, unknown>;
  type?: TypeNode;
}

function makeProp(
  name: string,
  typeName: string,
  options: PropOptions = {},
): PropertyNode {
  const prop = new PropertyNode({} as ModelProperty, `Test ${name}`);
  prop.name = name;
  prop.typeName = { namespace: "Test", name: typeName };
  prop.isScalar = options.isScalar ?? false;
  prop.isOptional = false;
  prop.isCollection = false;
  prop.defaultValue = null;
  prop.allowedValues = [];
  prop.enumName = options.enumName ?? null;
  prop.isOpenEnum = options.isOpenEnum ?? false;
  prop.samples = options.sample ? [{ sample: options.sample }] : [];
  prop.type = options.type;
  return prop;
}

function makeType(name: string, properties: PropertyNode[]): TypeNode {
  const node = new TypeNode({} as Model, `Test ${name}`);
  node.typeName = { namespace: "Test", name };
  node.properties = properties;
  node.childTypes = [];
  node.factories = [];
  node.coercions = [];
  node.isAbstract = false;
  node.base = null;
  node.methods = [];
  return node;
}

function renderCSharp(node: TypeNode, types: TypeNode[] = []): string {
  const byName = new Map(types.map((type) => [type.typeName.name, type]));
  return renderTests(node, "Test.Namespace", (name) => byName.get(name));
}

// These pin the C# emit path (now sourced from the shared `buildBaseTestContext`) rather
// than an internal predicate: only a genuine scalar/enum property of the node becomes an
// assertion, so the generated test still compiles against the generated loader.
describe("C# generated conversion-test validations", () => {
  it("asserts scalar and closed-enum properties declared on the node", () => {
    const node = makeType("N", [
      makeProp("kind", "string", {
        isScalar: true,
        sample: { kind: "custom" },
      }),
      makeProp("mode", "FixtureMode", {
        enumName: "FixtureMode",
        sample: { mode: "fast" },
      }),
    ]);

    const rendered = renderCSharp(node);
    assert.match(rendered, /Assert\.Equal\("custom", instance\.Kind\);/);
    assert.match(
      rendered,
      /Assert\.Equal\(FixtureMode\.Fast, instance\.Mode\);/,
    );
  });

  it("skips sample keys that are not properties of the emitted class", () => {
    // A polymorphic base carries a subtype-shaped @sample; `endpoint` lives on the subtype,
    // so asserting instance.Endpoint on the base would not compile (CS1061).
    const base = makeType("Base", [
      makeProp("kind", "string", {
        isScalar: true,
        sample: { kind: "custom", endpoint: "https://example.test" },
      }),
    ]);

    const rendered = renderCSharp(base);
    assert.match(rendered, /instance\.Kind/);
    assert.ok(
      !rendered.includes("instance.Endpoint"),
      "subtype-only sample key must not become an assertion",
    );
  });

  it("skips complex properties populated through a scalar coercion", () => {
    // `reference` is a complex FixtureReference reached via @coerce from a string. Comparing
    // the scalar sample to the complex property resolves to the wrong overload (CS1503).
    const node = makeType("N", [
      makeProp("label", "string", {
        isScalar: true,
        sample: { label: "root", reference: "ref-shortcut" },
      }),
      makeProp("reference", "FixtureReference", { isScalar: false }),
    ]);

    const rendered = renderCSharp(node);
    assert.match(rendered, /instance\.Label/);
    assert.ok(
      !rendered.includes("instance.Reference"),
      "scalar-coerced complex field must not become an assertion",
    );
  });
});
