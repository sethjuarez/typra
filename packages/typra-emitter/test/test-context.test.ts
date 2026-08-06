import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Model, ModelProperty } from "@typespec/compiler";

import { TypeNode, PropertyNode } from "../src/ir/ast.js";
import { buildBaseTestContext, goTestOptions } from "../src/testing/test-context.js";
import { renderTests } from "../src/languages/csharp/driver.js";

interface PropOptions {
  isScalar?: boolean;
  isOptional?: boolean;
  isCollection?: boolean;
  defaultValue?: string | null;
  allowedValues?: string[];
  sample?: Record<string, unknown>;
  type?: TypeNode;
}

function makeProp(name: string, typeName: string, options: PropOptions = {}): PropertyNode {
  const prop = new PropertyNode({} as ModelProperty, `Test ${name}`);
  prop.name = name;
  prop.typeName = { namespace: "Test", name: typeName };
  prop.isScalar = options.isScalar ?? false;
  prop.isOptional = options.isOptional ?? false;
  prop.isCollection = options.isCollection ?? false;
  prop.defaultValue = options.defaultValue ?? null;
  prop.allowedValues = options.allowedValues ?? [];
  prop.samples = options.sample ? [{ sample: options.sample }] : [];
  prop.type = options.type;
  return prop;
}

interface TypeOptions {
  discriminator?: string;
  childTypes?: TypeNode[];
  isAbstract?: boolean;
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
  node.base = null;
  node.methods = [];
  return node;
}

function sampleFor(node: TypeNode, types: TypeNode[] = []): Record<string, any> {
  const byName = new Map(types.map(type => [type.typeName.name, type]));
  const context = buildBaseTestContext(node, undefined, goTestOptions, name => byName.get(name));
  assert.equal(context.examples.length, 1, "expected exactly one generated example");
  return context.examples[0].sample;
}

describe("test context — required complex sample synthesis", () => {
  it("includes a required complex property that declares no @sample", () => {
    const detail = makeType("Detail", [
      makeProp("code", "string", { isScalar: true, sample: { code: "detail-code" } }),
    ]);
    const node = makeType("Root", [
      makeProp("label", "string", { isScalar: true, sample: { label: "root" } }),
      makeProp("detail", "Detail", { type: detail }),
    ]);

    // Emitters validate that required complex fields are present before constructing an
    // instance, so a payload missing one cannot pass the validation generated beside it.
    assert.deepEqual(sampleFor(node, [detail]).detail, { code: "detail-code" });
  });

  it("leaves an optional complex property absent", () => {
    const detail = makeType("Detail", [
      makeProp("code", "string", { isScalar: true, sample: { code: "detail-code" } }),
    ]);
    const node = makeType("Root", [
      makeProp("label", "string", { isScalar: true, sample: { label: "root" } }),
      makeProp("detail", "Detail", { isOptional: true, type: detail }),
    ]);

    // Guard against over-broad synthesis: nothing rejects an omitted optional, so filling it
    // in would assert coverage the schema never asked for.
    assert.ok(!("detail" in sampleFor(node, [detail])), "optional complex field must stay absent");
  });

  it("resolves the target type through the registry when the property back-reference is unset", () => {
    // `resolveModel` only attaches `.type` to the first property of a given element type, so
    // a later sibling of the same type must still be synthesizable.
    const detail = makeType("Detail", [
      makeProp("code", "string", { isScalar: true, sample: { code: "detail-code" } }),
    ]);
    const node = makeType("Root", [
      makeProp("label", "string", { isScalar: true, sample: { label: "root" } }),
      makeProp("detail", "Detail"),
    ]);

    assert.deepEqual(sampleFor(node, [detail]).detail, { code: "detail-code" });
  });

  it("wraps the synthesized payload for a required complex collection", () => {
    const detail = makeType("Detail", [
      makeProp("code", "string", { isScalar: true, sample: { code: "detail-code" } }),
    ]);
    const node = makeType("Root", [
      makeProp("label", "string", { isScalar: true, sample: { label: "root" } }),
      makeProp("details", "Detail", { isCollection: true, type: detail }),
    ]);

    assert.deepEqual(sampleFor(node, [detail]).details, [{ code: "detail-code" }]);
  });

  it("recurses into a nested required complex property and fills unsampled required scalars", () => {
    const inner = makeType("Inner", [
      makeProp("id", "string", { isScalar: true }),
    ]);
    const middle = makeType("Middle", [
      makeProp("inner", "Inner", { type: inner }),
    ]);
    const node = makeType("Root", [
      makeProp("label", "string", { isScalar: true, sample: { label: "root" } }),
      makeProp("middle", "Middle", { type: middle }),
    ]);

    // A nested type carrying no samples at all still has to produce a loadable payload, or
    // the synthesized value trades one "missing required field" failure for another.
    assert.deepEqual(sampleFor(node, [inner, middle]).middle, { inner: { id: "sample" } });
  });

  it("names a concrete variant when the required property is a polymorphic base", () => {
    const text = makeType("TextContent", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "text" }),
      makeProp("value", "string", { isScalar: true, sample: { value: "hello" } }),
    ]);
    const base = makeType("Content", [
      makeProp("kind", "ContentKind", { allowedValues: ["text"] }),
    ], { discriminator: "kind", childTypes: [text], isAbstract: true });
    const node = makeType("Root", [
      makeProp("label", "string", { isScalar: true, sample: { label: "root" } }),
      makeProp("content", "Content", { type: base }),
    ]);

    // A polymorphic base is not loadable without a discriminator that selects a variant.
    assert.deepEqual(sampleFor(node, [base, text]).content, { kind: "text", value: "hello" });
  });

  it("names a concrete variant when the root node is itself a polymorphic base", () => {
    const text = makeType("TextContent", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "text" }),
      makeProp("value", "string", { isScalar: true, sample: { value: "hello" } }),
    ]);
    const node = makeType("Content", [
      makeProp("kind", "ContentKind", { allowedValues: ["text"] }),
      makeProp("label", "string", { isScalar: true, sample: { label: "root" } }),
    ], { discriminator: "kind", childTypes: [text] });

    // The root sample is as unloadable as a nested one when it omits the discriminator, and
    // the backends disagree about what to do with it, so complete it the same way (#92).
    assert.deepEqual(sampleFor(node, [node, text]), {
      label: "root",
      kind: "text",
      value: "hello",
    });
  });

  it("keeps an author-supplied discriminator instead of renaming the variant", () => {
    const text = makeType("TextContent", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "text" }),
    ]);
    const image = makeType("ImageContent", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "image" }),
    ]);
    const node = makeType("Content", [
      makeProp("kind", "ContentKind", { allowedValues: ["text", "image"], sample: { kind: "image" } }),
    ], { discriminator: "kind", childTypes: [text, image] });

    // Completion only fills gaps; a sampled discriminator already selects a variant.
    assert.equal(sampleFor(node, [node, text, image]).kind, "image");
  });

  it("skips a wildcard variant when naming a concrete type", () => {
    const custom = makeType("CustomContent", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "*" }),
    ]);
    const text = makeType("TextContent", [
      makeProp("kind", "string", { isScalar: true, defaultValue: "text" }),
    ]);
    const base = makeType("Content", [
      makeProp("kind", "ContentKind", { allowedValues: ["text"] }),
    ], { discriminator: "kind", childTypes: [custom, text], isAbstract: true });
    const node = makeType("Root", [
      makeProp("label", "string", { isScalar: true, sample: { label: "root" } }),
      makeProp("content", "Content", { type: base }),
    ]);

    // `*` is a routing rule, not a value; emitting it would name no variant at all.
    assert.deepEqual(sampleFor(node, [base, custom, text]).content, { kind: "text" });
  });

  it("stops at a self-referential required property instead of recursing forever", () => {
    const node = makeType("Tree", [
      makeProp("label", "string", { isScalar: true, sample: { label: "root" } }),
    ]);
    // A cycle can only be broken by an optional edge, and an omitted optional is accepted.
    node.properties.push(makeProp("child", "Tree", { type: node }));

    assert.ok(!("child" in sampleFor(node, [node])), "self-reference must not be synthesized");
  });
});

describe("csharp driver — generated fixtures satisfy generated loaders", () => {
  function renderCSharp(node: TypeNode, types: TypeNode[]): string {
    const byName = new Map(types.map(type => [type.typeName.name, type]));
    return renderTests(node, "Test.Namespace", name => byName.get(name));
  }

  it("includes a required complex property that declares no @sample", () => {
    const detail = makeType("Detail", [
      makeProp("code", "string", { isScalar: true, sample: { code: "detail-code" } }),
    ]);
    const node = makeType("Root", [
      makeProp("label", "string", { isScalar: true, sample: { label: "root" } }),
      makeProp("detail", "Detail", { type: detail }),
    ]);

    // C# renders its conversion tests through its own driver rather than
    // `buildBaseTestContext`. When that path skips payload completion the emitted fixture
    // omits a field the emitted loader requires, so the generated test fails against the
    // generated validation shipped beside it.
    const rendered = renderCSharp(node, [detail]);
    assert.match(rendered, /detail-code/, "required complex payload must reach the C# fixture");
  });

  it("leaves an optional complex property out of the fixture", () => {
    const detail = makeType("Detail", [
      makeProp("code", "string", { isScalar: true, sample: { code: "detail-code" } }),
    ]);
    const node = makeType("Root", [
      makeProp("label", "string", { isScalar: true, sample: { label: "root" } }),
      makeProp("detail", "Detail", { isOptional: true, type: detail }),
    ]);

    // Counterpart guard: nothing rejects an omitted optional, so synthesizing one would
    // assert coverage the schema never asked for.
    const rendered = renderCSharp(node, [detail]);
    assert.ok(!rendered.includes("detail-code"), "optional complex field must stay absent");
  });

  it("emits a multiline double-quoted scalar unfolded so spaces survive the round trip", () => {
    const raw = "first line with two spaces  \n\n  \nlast line with three spaces   \n";
    const node = makeType("Root", [
      makeProp("value", "string", { isScalar: true, sample: { value: raw } }),
    ]);

    const rendered = renderCSharp(node, []);

    // yaml folds a long double-quoted scalar using `\` line continuations, and a space
    // adjacent to a fold is not recoverable on reload — the value loses one space per
    // folded break. Every other backend opts out via `yamlDoubleQuotedMinMultiLineLength`;
    // this driver hand-rolls the document, so it has to opt out explicitly. See #93.
    assert.doesNotMatch(
      rendered,
      /\\$/m,
      "YAML fixture must not fold a double-quoted scalar across lines",
    );
    // The assertion and the payload must agree on the raw value, byte for byte.
    assert.match(
      rendered,
      /Assert\.Equal\("first line with two spaces {2}\\n\\n {2}\\nlast line with three spaces {3}\\n", instance\.Value\);/,
    );
  });
});
