import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TypeNode } from "../src/ir/ast.js";
import { emitTypeScriptTest } from "../src/languages/typescript/test-emitter.js";
import { buildBaseTestContext, typescriptTestOptions } from "../src/testing/test-context.js";

function emit(node: TypeNode): string {
  const context = buildBaseTestContext(node, "prompty", typescriptTestOptions);
  return emitTypeScriptTest({
    ...context,
    importPath: "../../../src/model/index",
    namespace: "prompty",
  });
}

function dictionaryTest(output: string): string {
  const start = output.indexOf('it("should load from dictionary"');
  assert.notEqual(start, -1, "expected a dictionary load test to be emitted");
  const end = output.indexOf('it("should save to dictionary"', start);
  return output.slice(start, end === -1 ? undefined : end);
}

describe("TypeScript test emitter", () => {
  it("loads the built example rather than an empty payload", () => {
    const node = {
      typeName: { namespace: "prompty", name: "UsageChunk" },
      properties: [{
        name: "totalTokens",
        type: { name: "integer", coercions: [] },
        isScalar: true,
        samples: [{ sample: { totalTokens: 42 }, description: "" }],
      }],
      factories: [],
    } as unknown as TypeNode;

    const body = dictionaryTest(emit(node));

    // An empty object fails required-field validation for any type that has one,
    // so the test must load the same payload the JSON/YAML tests already use.
    assert.doesNotMatch(
      body,
      /const data: Record<string, unknown> = \{\};/,
      "expected the dictionary load test to stop hardcoding an empty payload",
    );
    assert.match(body, /const data = JSON\.parse\(/);
    assert.match(body, /"totalTokens": 42/);
    assert.match(body, /UsageChunk\.load\(data\)/);
  });

  it("emits no dictionary test when the type has no example to load", () => {
    const node = {
      typeName: { namespace: "prompty", name: "UsageChunk" },
      properties: [{
        name: "totalTokens",
        type: { name: "integer", coercions: [] },
        isScalar: true,
        samples: [],
      }],
      factories: [],
    } as unknown as TypeNode;

    const output = emit(node);

    // Loading {} into a type with a required field must throw, so asserting
    // that it succeeds is a false assertion, not coverage.
    assert.doesNotMatch(output, /it\("should load from dictionary"/);
    assert.doesNotMatch(output, /const data: Record<string, unknown> = \{\};/);
    // The sibling save test is unaffected.
    assert.match(output, /it\("should save to dictionary"/);
  });
});
