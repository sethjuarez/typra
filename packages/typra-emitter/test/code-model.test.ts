import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildVectorConformanceCodeModel } from "../src/ir/code-model.js";
import type { CallableVectorSnapshot } from "../src/ir/vector.js";

describe("structural CodeModel", () => {
  it("derives vector conformance imports and roundtrip cases once for target renderers", () => {
    const snapshot: CallableVectorSnapshot = {
      emitter: "typra-emitter",
      version: 1,
      vectors: [
        {
          contract: "Renderer",
          operation: "render",
          params: {
            request: "RenderRequest",
            count: "int32",
            started: "utcDateTime",
            role: "Role",
            tags: "string[]",
          },
          returns: "RenderResult",
          vector: {
            name: "basic",
            stage: "callable",
            operation: "render",
            input: {
              request: { template: "Hello {{name}}" },
              count: 1,
              started: "2025-01-01T00:00:00Z",
              role: "admin",
              tags: ["smoke"],
            },
            expected: { output: "Hello Typra" },
          },
        },
        {
          contract: "Parser",
          operation: "parse",
          params: { value: "string" },
          returns: "unknown",
          vector: {
            stage: "callable",
            operation: "parse",
            input: { value: "{{bad" },
            expectedError: { code: "parse-error" },
          },
        },
      ],
    };

    assert.deepEqual(
      buildVectorConformanceCodeModel(snapshot, {
        loadSaveTypes: new Set(["RenderRequest", "RenderResult"]),
      }),
      {
        fileName: "vector-conformance",
        vectors: snapshot.vectors,
        constants: [{ name: "vectors", value: snapshot.vectors }],
        modelImports: ["RenderRequest", "RenderResult"],
        cases: [
          {
            index: 0,
            contract: "Renderer",
            operation: "render",
            vectorName: "basic",
            paramRoundTrips: [
              { paramName: "request", typeName: "RenderRequest" },
            ],
            expectedRoundTrip: "RenderResult",
          },
          {
            index: 1,
            contract: "Parser",
            operation: "parse",
            vectorName: undefined,
            paramRoundTrips: [],
            expectedRoundTrip: undefined,
          },
        ],
      },
    );
  });
});
