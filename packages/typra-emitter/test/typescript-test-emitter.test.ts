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

  it("never emits a test file with no test cases", () => {
    // An abstract type with no @sample cannot be constructed and has no example
    // payload to load, so every emitted block is skipped and the file ends up as a
    // bare `describe(..., () => {})`. vitest fails such a file outright, which is
    // how prompty's content-part.test.ts and stream-chunk.test.ts broke.
    const node = {
      typeName: { namespace: "prompty", name: "ContentPart" },
      isAbstract: true,
      properties: [{
        name: "kind",
        type: { name: "string", coercions: [] },
        isScalar: true,
        samples: [],
      }],
      factories: [],
    } as unknown as TypeNode;

    const output = emit(node);

    assert.match(
      output,
      /it\(/,
      "an abstract type with no example still has to emit at least one test case",
    );
    assert.match(output, /it\("should be defined"/);
    assert.match(output, /expect\(ContentPart\)\.toBeDefined\(\);/);
  });
});
