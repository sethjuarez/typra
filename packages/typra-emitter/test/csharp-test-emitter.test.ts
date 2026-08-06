import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TypeNode } from "../src/ir/ast.js";
import { emitCSharpTest } from "../src/languages/csharp/test-emitter.js";

describe("C# test emitter", () => {
  it("preserves raw strings byte-exactly in both JSON and YAML assertions", () => {
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
    // C# no longer folds double-quoted multiline YAML scalars, so the trailing space
    // survives the round trip and the YAML assertion is identical to the JSON one.
    // Previously the YAML variant was trailing-space normalized to compensate for the
    // space the fold silently dropped. See #93.
    const assertions = code.match(/Assert\.Equal\("[^"]+", instance\.Instructions\);/g);
    assert.deepEqual(assertions, [
      'Assert.Equal("first line with trailing space \\nsecond line \\u2028third line", instance.Instructions);',
      'Assert.Equal("first line with trailing space \\nsecond line \\u2028third line", instance.Instructions);',
    ]);
    const roundtrips = code.match(/Assert\.Equal\("[^"]+", reloaded\.Instructions\);/g);
    assert.deepEqual(roundtrips, [
      'Assert.Equal("first line with trailing space \\nsecond line \\u2028third line", reloaded.Instructions);',
      'Assert.Equal("first line with trailing space \\nsecond line \\u2028third line", reloaded.Instructions);',
    ]);
    // The trailing space must be inside the literal, never dangling at end-of-line.
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

  it("substitutes factory parameter placeholders in generated assertions", () => {
    const node = {
      typeName: { namespace: "Fixtures", name: "FixtureReference" },
      properties: [],
    } as unknown as TypeNode;
    const code = emitCSharpTest({
      node,
      namespace: "Fixtures.Tests",
      examples: [],
      coercions: [],
      factories: [{
        name: "named",
        params: { id: "string", label: "string" },
        // `sets` values are templates resolved from the call arguments at runtime.
        sets: { id: "{id}", label: "{label}" },
      }],
      singlePrecisionKeys: new Set<string>(),
      renderName: name => name.charAt(0).toUpperCase() + name.slice(1),
      renderCsharpFactoryMethodName: name => name.charAt(0).toUpperCase() + name.slice(1),
      renderCsharpFactoryTestValue: () => '"test"',
    });

    // The generated call passes "test" for both params, so the assertions must compare
    // against the substituted result — asserting the raw "{id}" template always fails.
    assert.match(code, /Assert\.Equal\("test", instance\.Id\);/);
    assert.match(code, /Assert\.Equal\("test", instance\.Label\);/);
    assert.doesNotMatch(code, /\{id\}|\{label\}/);
  });
});
