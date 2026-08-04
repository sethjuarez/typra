import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TypeNode } from "../src/ir/ast.js";
import { emitPythonTest } from "../src/languages/python/test-emitter.js";
import { buildBaseTestContext, pythonTestOptions } from "../src/testing/test-context.js";

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
    assert.match(context.examples[0].yaml[0], /add some\\ \\npersonal flair/);

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
});
