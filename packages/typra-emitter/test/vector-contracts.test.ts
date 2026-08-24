import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DecoratorContext,
  Interface,
  Operation,
  Program,
  Type,
} from "@typespec/compiler";

import { $vector } from "../src/decorators.js";
import { lowerTypeSpecCallableContract } from "../src/ir/callable.js";
import { lowerOperationVectors } from "../src/ir/vector.js";

function type(name: string): Type {
  return {
    kind: "Model",
    name,
  } as unknown as Type;
}

function operation(): Operation {
  return {
    kind: "Operation",
    name: "render",
    parameters: {
      kind: "Model",
      name: "",
      properties: new Map([["request", { type: type("RenderRequest") }]]),
    },
    returnType: type("RenderResult"),
  } as unknown as Operation;
}

function interfaceFor(op: Operation): Interface {
  return {
    kind: "Interface",
    name: "Renderer",
    namespace: {
      name: "Runtime",
      namespaces: new Map(),
      interfaces: new Map(),
      models: new Map(),
      namespace: {
        name: "Typra",
      },
    },
    operations: new Map([[op.name, op]]),
  } as unknown as Interface;
}

function testContext(): {
  context: DecoratorContext;
  program: Program;
  diagnostics: Array<{ code: string; message: string }>;
} {
  const state = new Map<symbol, Map<unknown, unknown>>();
  const diagnostics: Array<{ code: string; message: string }> = [];
  const program = {
    stateMap: (key: symbol) => {
      if (!state.has(key)) state.set(key, new Map());
      return state.get(key)!;
    },
    reportDiagnostic: (diagnostic: { code: string; message: string }) => {
      diagnostics.push(diagnostic);
    },
  } as unknown as Program;

  return {
    context: { program } as unknown as DecoratorContext,
    program,
    diagnostics,
  };
}

describe("@vector callable behavior contracts", () => {
  it("captures inline success and expected-error vectors in operation vector IR", () => {
    const { context, program, diagnostics } = testContext();
    const op = operation();

    $vector(context, op, {
      name: "basic",
      input: { request: { prompt: "hi" } },
      expected: { output: "hi" },
      provider: "openai",
      targetApi: "chat",
      portability: "portable",
      normalization: { trailingNewline: "trim" },
    });
    $vector(context, op, {
      name: "bad-template",
      input: { request: { prompt: "" } },
      expectedError: { code: "empty-template" },
    });

    assert.deepEqual(diagnostics, []);
    assert.deepEqual(lowerOperationVectors(program, op), [
      {
        name: "basic",
        stage: "callable",
        operation: "render",
        input: { request: { prompt: "hi" } },
        expected: { output: "hi" },
        provider: "openai",
        targetApi: "chat",
        portability: "portable",
        normalization: { trailingNewline: "trim" },
      },
      {
        name: "bad-template",
        stage: "callable",
        operation: "render",
        input: { request: { prompt: "" } },
        expectedError: { code: "empty-template" },
      },
    ]);
  });

  it("carries an author-declared requires token list into the vector IR", () => {
    const { context, program, diagnostics } = testContext();
    const op = operation();

    $vector(context, op, {
      name: "live-structure",
      input: { request: { prompt: "hi" } },
      expected: { output: "hi" },
      requires: ["provider:openai", "var:live-enabled"],
    });

    assert.deepEqual(diagnostics, []);
    assert.deepEqual(lowerOperationVectors(program, op), [
      {
        name: "live-structure",
        stage: "callable",
        operation: "render",
        input: { request: { prompt: "hi" } },
        expected: { output: "hi" },
        requires: ["provider:openai", "var:live-enabled"],
      },
    ]);
  });

  it("rejects a requires field that is not an array of non-empty strings", () => {
    const { context, program, diagnostics } = testContext();
    const op = operation();

    // Not an array.
    $vector(context, op, {
      name: "bad-scalar",
      input: { request: { prompt: "hi" } },
      expected: {},
      requires: "provider:openai",
    } as unknown as object);
    // Array with a non-string entry.
    $vector(context, op, {
      name: "bad-entry",
      input: { request: { prompt: "hi" } },
      expected: {},
      requires: ["provider:openai", 7],
    } as unknown as object);
    // Array with an empty-string entry.
    $vector(context, op, {
      name: "bad-empty",
      input: { request: { prompt: "hi" } },
      expected: {},
      requires: [""],
    } as unknown as object);

    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      [
        "typra-emitter-vector-shape",
        "typra-emitter-vector-shape",
        "typra-emitter-vector-shape",
      ],
    );
    for (const diagnostic of diagnostics) {
      assert.match(diagnostic.message, /'requires' must be an array of non-empty/);
    }
    assert.deepEqual(lowerOperationVectors(program, op), []);
  });

  it("captures named vector-set style arrays without changing operation ownership", () => {
    const { context, program } = testContext();
    const op = operation();

    $vector(context, op, [
      { name: "one", input: { request: { prompt: "one" } }, expected: {} },
      { name: "two", input: { request: { prompt: "two" } }, expected: {} },
    ]);

    assert.deepEqual(
      lowerOperationVectors(program, op).map((vector) => ({
        name: vector.name,
        operation: vector.operation,
        stage: vector.stage,
      })),
      [
        { name: "one", operation: "render", stage: "callable" },
        { name: "two", operation: "render", stage: "callable" },
      ],
    );
  });

  it("reports invalid vector shapes instead of silently skipping them", () => {
    const { context, program, diagnostics } = testContext();
    const op = operation();

    $vector(context, op, [
      "not-an-object",
      { expected: {} },
      { input: {}, expected: {}, expectedError: {} },
      { input: {} },
      { operation: "parse", input: {}, expected: {} },
    ] as any);

    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      [
        "typra-emitter-vector-shape",
        "typra-emitter-vector-shape",
        "typra-emitter-vector-shape",
        "typra-emitter-vector-shape",
        "typra-emitter-vector-shape",
      ],
    );
    assert.deepEqual(lowerOperationVectors(program, op), []);
  });

  it("includes captured vectors on TypeSpec-native callable operations", () => {
    const { context, program } = testContext();
    const op = operation();
    const iface = interfaceFor(op);

    $vector(context, op, {
      name: "basic",
      input: { request: { prompt: "hi" } },
      expected: { output: "hi" },
    });

    const contract = lowerTypeSpecCallableContract(
      program,
      iface,
      "Typra.Runtime",
      "Runtime",
    );

    assert.deepEqual(contract.operations[0].vectors, [
      {
        name: "basic",
        stage: "callable",
        operation: "render",
        input: { request: { prompt: "hi" } },
        expected: { output: "hi" },
      },
    ]);
  });

  it("parses a JSON-string vector set carrying keyword field names and opaque wire payloads", () => {
    const { context, program, diagnostics } = testContext();
    const op = operation();

    // TypeSpec object-value literals (`#{ ... }`) cannot express a `model` key
    // (reserved keyword) or embed provider wire JSON with arbitrary keys. The
    // JSON-string form is the blessed escape hatch for such evidence.
    $vector(
      context,
      op,
      JSON.stringify([
        {
          name: "wire-payload",
          input: {
            request: { model: { provider: "openai", apiType: "chat" } },
            response: { id: "resp-1", model: "gpt-4o-mini", choices: [] },
          },
          expected: "Hello!",
        },
      ]) as unknown as object,
    );

    assert.deepEqual(diagnostics, []);
    assert.deepEqual(lowerOperationVectors(program, op), [
      {
        name: "wire-payload",
        stage: "callable",
        operation: "render",
        input: {
          request: { model: { provider: "openai", apiType: "chat" } },
          response: { id: "resp-1", model: "gpt-4o-mini", choices: [] },
        },
        expected: "Hello!",
      },
    ]);
  });

  it("accepts a JSON-string that encodes a single vector object", () => {
    const { context, program, diagnostics } = testContext();
    const op = operation();

    $vector(
      context,
      op,
      JSON.stringify({
        name: "single",
        input: { request: { model: "gpt-4o-mini" } },
        expected: "ok",
      }) as unknown as object,
    );

    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      lowerOperationVectors(program, op).map((vector) => vector.name),
      ["single"],
    );
  });

  it("reports a diagnostic when a JSON-string vector set cannot be parsed", () => {
    const { context, program, diagnostics } = testContext();
    const op = operation();

    $vector(context, op, "[ { not valid json } ]" as unknown as object);

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, "typra-emitter-vector-shape");
    assert.match(diagnostics[0].message, /Vector JSON literal could not be parsed/);
    assert.deepEqual(lowerOperationVectors(program, op), []);
  });
});
