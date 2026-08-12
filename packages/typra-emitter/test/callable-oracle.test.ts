import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareCallableTranscript,
  expectedTranscript,
  vectorId,
} from "../src/ir/oracle.js";
import type { CallableVectorSnapshotEntry } from "../src/ir/vector.js";

function vectorEntry(): CallableVectorSnapshotEntry {
  return {
    contract: "Renderer",
    operation: "render",
    params: { request: "RenderRequest" },
    returns: "RenderResult",
    vector: {
      name: "basic",
      stage: "callable",
      operation: "render",
      provider: "openai",
      targetApi: "chat",
      portability: "portable",
      normalization: { trailingNewline: "trim" },
      input: { request: { prompt: "hi" } },
      expected: { output: "hi" },
    },
  };
}

describe("callable conformance oracle", () => {
  it("builds normalized expected transcripts from callable vectors", () => {
    const entry = vectorEntry();

    assert.equal(vectorId(entry), "Renderer.render:basic");
    assert.deepEqual(expectedTranscript(entry, "typescript"), {
      vectorId: "Renderer.render:basic",
      target: "typescript",
      input: { request: { prompt: "hi" } },
      result: { output: "hi" },
      metadata: {
        stage: "callable",
        provider: "openai",
        targetApi: "chat",
        portability: "portable",
        normalization: { trailingNewline: "trim" },
      },
    });
  });

  it("reports vector id, target, expected transcript, observed transcript, and mismatch paths", () => {
    const expected = expectedTranscript(vectorEntry(), "python");
    const observed = {
      ...expected,
      result: { output: "bye" },
    };

    assert.deepEqual(compareCallableTranscript(expected, observed), {
      vectorId: "Renderer.render:basic",
      target: "python",
      matched: false,
      expected,
      observed,
      mismatches: [
        {
          path: "result",
          expected: { output: "hi" },
          observed: { output: "bye" },
        },
      ],
    });
  });

  it("supports expected error observations", () => {
    const entry = vectorEntry();
    entry.vector = {
      name: "bad-template",
      stage: "callable",
      operation: "render",
      input: { request: { prompt: "" } },
      expectedError: { code: "empty-template" },
    };

    assert.deepEqual(expectedTranscript(entry, "typescript"), {
      vectorId: "Renderer.render:bad-template",
      target: "typescript",
      input: { request: { prompt: "" } },
      error: { code: "empty-template" },
      metadata: { stage: "callable" },
    });
  });
});
