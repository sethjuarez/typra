import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildVectorConformanceCodeModel } from "../src/ir/code-model.js";
import type { CallableVectorSnapshot } from "../src/ir/vector.js";

describe("structural CodeModel", () => {
  it("carries opaque vector payloads without deriving model-typed round-trip cases", () => {
    const snapshot: CallableVectorSnapshot = {
      emitter: "typra-emitter",
      version: 1,
      vectors: [
        {
          contract: "Renderer",
          namespace: "Typra.Sample",
          group: "",
          operation: "render",
          params: {
            request: "RenderRequest",
            count: "int32",
            started: "utcDateTime",
            role: "Role",
            tags: "string[]",
          },
          returns: "RenderResult",
          sync: false,
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
          namespace: "Typra.Sample",
          group: "",
          operation: "parse",
          params: { value: "string" },
          returns: "unknown",
          sync: false,
          vector: {
            stage: "callable",
            operation: "parse",
            input: { value: "{{bad" },
            expectedError: { code: "parse-error" },
          },
        },
      ],
    };

    // Vector input/expected are opaque conformance evidence. The CodeModel must
    // NOT type them against the operation's model-typed params (`RenderRequest`,
    // `RenderResult`) or derive any `load()/save()` round-trip cases — that
    // would contradict the opaque-input contract and force vector authors to
    // pre-normalize inputs. It carries only the opaque payload.
    assert.deepEqual(buildVectorConformanceCodeModel(snapshot), {
      fileName: "vector-conformance",
      vectors: snapshot.vectors,
      constants: [{ name: "vectors", value: snapshot.vectors }],
    });
  });
});
