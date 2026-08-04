import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TypeNode } from "../src/ir/ast.js";
import { emitCSharpTest } from "../src/languages/csharp/test-emitter.js";

describe("C# test emitter", () => {
  it("preserves trailing spaces before newlines in expected string literals", () => {
    const node = {
      typeName: { namespace: "Prompty", name: "Prompty" },
      properties: [],
    } as unknown as TypeNode;
    const expected = "first line with trailing space \nsecond line\u2028third line";
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
      renderName: name => name,
      renderCsharpFactoryMethodName: name => name,
      renderCsharpFactoryTestValue: () => "default",
    });

    assert.match(
      code,
      /Assert\.Equal\("first line with trailing space \\nsecond line\\u2028third line", instance\.Instructions\);/,
    );
    assert.doesNotMatch(code, /first line with trailing space $/m);
  });
});
