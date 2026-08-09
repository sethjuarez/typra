import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TypeNode } from "../src/ir/ast.js";
import { emitPythonTest } from "../src/languages/python/test-emitter.js";
import { buildBaseTestContext, pythonTestOptions } from "../src/testing/test-context.js";

function emptyClassCtx(node: TypeNode) {
  return {
    node,
    typeMapper: {},
    coercions: [],
    polymorphicTypes: undefined,
    imports: [],
    collectionTypes: [],
    coercionProperty: null,
    factoryNameMap: {},
    renderedFactories: [],
    renderedCoercions: [],
    factoryTypeRefs: [],
  };
}

describe("Python test emitter", () => {
  it("preserves multiline values in trim-proof JSON and YAML fixtures", () => {
    const raw = "system:\r\nAn instruction long enough to trigger YAML wrapping and even add some \npersonal flair.";
    const node = {
      typeName: { namespace: "prompty", name: "Prompty" },
      properties: [{
        name: "instructions",
        type: { name: "string", coercions: [] },
        isScalar: true,
        samples: [{ sample: { instructions: raw }, description: "" }],
      }],
      factories: [],
    } as unknown as TypeNode;
    const context = buildBaseTestContext(node, "prompty", pythonTestOptions);
    assert.equal(context.examples[0].yaml.length, 2);
    assert.match(context.examples[0].yaml[0], /add some \\npersonal flair/);

    const output = emitPythonTest({
      ...context,
      classCtx: {
        node,
        typeMapper: {},
        coercions: [],
        polymorphicTypes: undefined,
        imports: [],
        collectionTypes: [],
        coercionProperty: null,
        factoryNameMap: {},
        renderedFactories: [],
        renderedCoercions: [],
        factoryTypeRefs: [],
      },
    });

    const jsonStart = output.indexOf("def test_load_json_prompty():");
    const jsonEnd = output.indexOf("def test_load_yaml_prompty():");
    const jsonTest = output.slice(jsonStart, jsonEnd);
    assert.match(jsonTest, /assert instance\.instructions == "system:\\r\\n.*add some \\npersonal flair\."/);

    const yamlStart = output.indexOf("def test_load_yaml_prompty():");
    const yamlEnd = output.indexOf("def test_roundtrip_json_prompty():");
    const yamlTest = output.slice(yamlStart, yamlEnd);
    assert.match(yamlTest, /assert instance\.instructions == "system:\\r\\n.*add some \\npersonal flair\."/);
    for (const line of output.split("\n")) {
      assert.equal(line, line.trimEnd());
    }
  });

  it("renders JSON boolean and null coercion literals as Python literals", () => {
    // `buildCoercions` stringifies the sample value, so a boolean coercion arrives as the
    // JSON spelling `true`. Emitting that verbatim produces `FixtureProperty.load(true)`,
    // which raises `NameError: name 'true' is not defined` at pytest collection time.
    const node = {
      typeName: { namespace: "fixtures", name: "FixtureProperty" },
      discriminator: "kind",
      properties: [
        { name: "kind", type: { name: "string", coercions: [] }, isScalar: true, samples: [] },
        { name: "default", type: { name: "unknown", coercions: [] }, isScalar: true, samples: [] },
      ],
      coercions: [
        { scalar: "boolean", example: true, title: "boolean", expansion: { kind: "boolean", default: "{value}" } },
        { scalar: "string", example: "hello", title: "string", expansion: { kind: "string", default: "{value}" } },
      ],
      factories: [],
    } as unknown as TypeNode;

    const context = buildBaseTestContext(node, "fixtures", pythonTestOptions);
    const output = emitPythonTest({ ...context, classCtx: emptyClassCtx(node) });

    assert.match(output, /instance = FixtureProperty\.load\(True\)/);
    assert.match(output, /assert instance\.default == True/);
    assert.doesNotMatch(output, /\bload\(true\)/);
    assert.doesNotMatch(output, /== true\b/);

    // A genuine string coercion must keep its quotes and must not be re-spelled.
    assert.match(output, /instance = FixtureProperty\.load\("hello"\)/);
    assert.match(output, /assert instance\.default == "hello"/);
  });

  it("keeps a string value that merely spells a Python keyword as a string", () => {
    const node = {
      typeName: { namespace: "fixtures", name: "FixtureFlagLabel" },
      properties: [{
        name: "label",
        type: { name: "string", coercions: [] },
        isScalar: true,
        samples: [{ sample: { label: "true" }, description: "" }],
      }],
      coercions: [],
      factories: [],
    } as unknown as TypeNode;

    const context = buildBaseTestContext(node, "fixtures", pythonTestOptions);
    const output = emitPythonTest({ ...context, classCtx: emptyClassCtx(node) });

    assert.match(output, /assert instance\.label == "true"/);
    assert.doesNotMatch(output, /assert instance\.label == True/);
  });

  it("substitutes {param} placeholders in factory assertions", () => {
    // The generated call passes concrete test values, so asserting the raw `{id}` template
    // compares against a literal "{id}" and always fails. Mirrors the C# test emitter.
    const node = {
      typeName: { namespace: "fixtures", name: "FixtureReference" },
      properties: [
        { name: "id", type: { name: "string", coercions: [] }, isScalar: true, samples: [] },
        { name: "label", type: { name: "string", coercions: [] }, isScalar: true, samples: [] },
      ],
      coercions: [],
      factories: [{
        name: "named",
        params: { id: "string", label: "string" },
        sets: { id: "{id}", label: "{label}" },
      }],
    } as unknown as TypeNode;

    const context = buildBaseTestContext(node, "fixtures", pythonTestOptions);
    const output = emitPythonTest({
      ...context,
      classCtx: { ...emptyClassCtx(node), factoryNameMap: { named: "named" } },
    });

    assert.match(output, /instance = FixtureReference\.named\("test", "test"\)/);
    assert.match(output, /assert instance\.id == "test"/);
    assert.match(output, /assert instance\.label == "test"/);
    assert.doesNotMatch(output, /\{id\}/);
    assert.doesNotMatch(output, /\{label\}/);
  });

  it("adds Pydantic differential assertions only for native serialization mode", () => {
    const node = {
      typeName: { namespace: "fixtures", name: "FixtureReference" },
      properties: [{
        name: "id",
        type: { name: "string", coercions: [] },
        isScalar: true,
        samples: [{ sample: { id: "ref-1" }, description: "" }],
      }],
      coercions: [],
      factories: [],
    } as unknown as TypeNode;

    const context = buildBaseTestContext(node, "fixtures", pythonTestOptions);
    const defaultOutput = emitPythonTest({ ...context, classCtx: emptyClassCtx(node) });
    const pydanticOutput = emitPythonTest(
      { ...context, classCtx: emptyClassCtx(node) },
      { nativeSerialization: "pydantic" },
    );

    assert.doesNotMatch(defaultOutput, /model_dump/);
    assert.match(pydanticOutput, /assert instance\.model_dump\(\) == saved_data/);
    assert.match(pydanticOutput, /assert json\.loads\(instance\.model_dump_json\(\)\) == saved_data/);
    assert.match(pydanticOutput, /assert FixtureReference\.model_validate\(original_data\)\.save\(\) == saved_data/);
    assert.match(pydanticOutput, /assert FixtureReference\.model_validate_json\(json_data\)\.save\(\) == saved_data/);
    assert.match(pydanticOutput, /FixtureReference\.model_validate_strings\(original_data\)/);
    assert.match(pydanticOutput, /raise AssertionError\("model_validate_strings bypassed Typra load"\)/);
  });
});
