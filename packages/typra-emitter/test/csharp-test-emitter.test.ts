import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TypeNode } from "../src/ir/ast.js";
import { emitCSharpTest } from "../src/languages/csharp/test-emitter.js";

describe("C# test emitter", () => {
  it("matches YAML trailing-space normalization while JSON preserves raw strings", () => {
    const node = {
      typeName: { namespace: "Prompty", name: "Prompty" },
      properties: [],
    } as unknown as TypeNode;
    const expected = "first line with trailing space \nsecond line \u2028third line";
    const code = emitCSharpTest({
      node,
      namespace: "Prompty.Core.Tests",
      examples: [{
        json: ["{}"],
        yaml: ["{}"],
        validations: [{
          key: "Instructions",
          value: expected,
          isExpression: false,
        }],
      }],
      coercions: [],
      factories: [],
      singlePrecisionKeys: new Set<string>(),
      renderName: name => name,
      renderCsharpFactoryMethodName: name => name,
      renderCsharpFactoryTestValue: () => "default",
    });

    assert.match(code, /^#nullable enable$/m);
    const assertions = code.match(/Assert\.Equal\("[^"]+", instance\.Instructions\);/g);
    assert.deepEqual(assertions, [
      'Assert.Equal("first line with trailing space\\nsecond line \\u2028third line", instance.Instructions);',
      'Assert.Equal("first line with trailing space \\nsecond line \\u2028third line", instance.Instructions);',
    ]);
    assert.match(
      code,
      /Assert\.Equal\("first line with trailing space \\nsecond line \\u2028third line", reloaded\.Instructions\);/,
    );
    assert.match(
      code,
      /Assert\.Equal\("first line with trailing space\\nsecond line \\u2028third line", reloaded\.Instructions\);/,
    );
    assert.doesNotMatch(code, /first line with trailing space $/m);
  });

  it("suffixes fractional literals with 'f' only for 32-bit float fields", () => {
    const node = {
      typeName: { namespace: "Fixtures", name: "WireOptions" },
      properties: [],
    } as unknown as TypeNode;
    const code = emitCSharpTest({
      node,
      namespace: "Fixtures.Tests",
      examples: [{
        json: ["{}"],
        yaml: ["{}"],
        validations: [
          { key: "Temperature", value: 0.7, isExpression: false },
          { key: "TopP", value: 0.9, isExpression: false },
        ],
      }],
      coercions: [],
      factories: [],
      // Only Temperature is float32; TopP is a 64-bit double.
      singlePrecisionKeys: new Set(["Temperature"]),
      renderName: name => name,
      renderCsharpFactoryMethodName: name => name,
      renderCsharpFactoryTestValue: () => "default",
    });

    assert.match(code, /Assert\.Equal\(0\.7f, instance\.Temperature\);/);
    // A `double?` field must not receive an `f` literal: 0.9f widens to
    // 0.8999999761581421 and the generated assertion would fail on precision.
    assert.match(code, /Assert\.Equal\(0\.9, instance\.TopP\);/);
    assert.doesNotMatch(code, /Assert\.Equal\(0\.9f, instance\.TopP\);/);
  });
});
