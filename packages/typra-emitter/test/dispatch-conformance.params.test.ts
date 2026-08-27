import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";

// Regression: TYPED per-interface @vector conformance with NON-MODEL op params
// (issue #282 §8 twin).
//
// The per-interface conformance driver deserializes each seam-op param from the
// vector JSON. Model params route through the emitted typed loader; scalar,
// generic (`Record<unknown>`), and optional (`T?`) params must be mapped to the
// target language type + decoded with the native JSON facility — exactly as the
// per-model test path already does for fields. A regression collected param
// types VERBATIM, leaking the raw TypeSpec spelling into the `use`/import list
// AND the decode receiver: `use crate::model::{Record<unknown>?}` aborts
// `cargo fmt`, and `from fixtures import Record<unknown>?` will not import.
//
// This suite compiles the `dispatch-vector-params` fixture — a dispatched
// Renderer whose @vector `render(agent: Agent, template: string,
// inputs: Record<unknown>, context?: Record<unknown>)` mixes a model param with
// each non-model shape — for every target, then asserts the emitted conformance:
//   * imports ONLY the model type (no raw scalar/generic in the import list),
//   * never contains the raw `Record<unknown>` spelling, and
//   * decodes each non-model param into the mapped language type.

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "features",
  "dispatch-vector-params",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.Features.DispatchVectorParams.Root";

type Target =
  | "rust"
  | "python"
  | "typescript"
  | "csharp"
  | "java"
  | "go"
  | "swift";

// Where each target writes its per-interface Renderer conformance file, plus the
// language-mapped decode we expect for the scalar (`template: string`), generic
// (`inputs: Record<unknown>`), and optional-generic (`context?: Record<unknown>`)
// params. `mustInclude` proves the fix; the shared `Record<unknown>` sweep proves
// the raw spelling never leaks.
const CASES: Array<{
  target: Target;
  file: string;
  mustInclude: string[];
}> = [
  {
    target: "rust",
    file: "renderer_conformance_test.rs",
    mustInclude: [
      "use crate::model::{Agent, Renderer};",
      "let template: String = serde_json::from_str(",
      "let inputs: serde_json::Value = serde_json::from_str(",
      "let context: Option<serde_json::Value> = serde_json::from_str(",
    ],
  },
  {
    target: "python",
    file: "test_renderer_conformance.py",
    mustInclude: [
      "import Agent",
      'agent = Agent.load(payload["agent"])',
      'template = payload["template"]',
      'inputs = payload["inputs"]',
      'context = payload.get("context")',
    ],
  },
  {
    target: "typescript",
    file: "renderer.conformance.test.ts",
    mustInclude: [
      'import { Agent } from "../src/index";',
      'const template = payload["template"] as string;',
      'const inputs = payload["inputs"] as Record<string, unknown>;',
      'const context = payload["context"] as Record<string, unknown> | null;',
    ],
  },
  {
    target: "csharp",
    file: "RendererConformanceTests.cs",
    mustInclude: [
      "var template = JsonSerializer.Deserialize<string>(",
      "var inputs = JsonSerializer.Deserialize<Dictionary<string, object?>>(",
      'root.TryGetProperty("context", out var contextEl)',
    ],
  },
  {
    target: "java",
    file: "RendererConformanceTests.java",
    mustInclude: [
      '@SuppressWarnings("unchecked")',
      'String template = (String) input.get("template");',
      'Map<String, Object> inputs = (Map<String, Object>) input.get("inputs");',
      'Map<String, Object> context = (Map<String, Object>) input.get("context");',
    ],
  },
  {
    target: "go",
    file: "renderer_conformance_test.go",
    mustInclude: [
      "var template string",
      "var inputs map[string]interface{}",
      "var context *map[string]interface{}",
      "fixtures.LoadAgent(payload[",
    ],
  },
  {
    target: "swift",
    file: "RendererConformanceTests.swift",
    mustInclude: [
      'let template = input["template"] as! String',
      'let inputs = input["inputs"] as! [String: Any]',
      'let context = input["context"] as? [String: Any]',
    ],
  },
];

describe("typed @vector conformance maps non-model params to language types (issue #282 §8)", () => {
  let output: string;
  let result: Awaited<ReturnType<typeof generate>>;

  before(async () => {
    output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-vector-params-"));
    result = await generate({
      output,
      source: FIXTURE,
      rootObject: ROOT_OBJECT,
      targets: CASES.map((entry) => entry.target),
      format: false,
      generateTests: true,
      deterministic: true,
    });
  });

  after(() => {
    // Best-effort cleanup; leaving the temp dir on failure aids debugging.
  });

  it("emits across every target (non-model params no longer break emit)", () => {
    assert.equal(
      result.success,
      true,
      `emit must succeed with scalar/generic/optional @vector params, got: ${result.errors?.join(
        "\n",
      )}`,
    );
  });

  for (const entry of CASES) {
    it(`${entry.target}: conformance decodes non-model params, never leaking raw TypeSpec spelling`, () => {
      const testsDir = path.join(output, entry.target, "tests");
      const conformance = path.join(testsDir, entry.file);
      const src = readFileSync(conformance, "utf8");

      // The raw generic spelling is the exact token that broke `cargo fmt` and
      // the Python import; it must never survive into the emitted test.
      assert.doesNotMatch(
        src,
        /Record<unknown>/,
        `${entry.target} conformance must not contain raw \`Record<unknown>\``,
      );

      for (const needle of entry.mustInclude) {
        assert.ok(
          src.includes(needle),
          `${entry.target} conformance must include ${JSON.stringify(
            needle,
          )}\n--- emitted ---\n${src}`,
        );
      }
    });
  }

  it("no emitted test file in any target leaks a raw angle-bracket generic param type", () => {
    for (const entry of CASES) {
      const testsDir = path.join(output, entry.target, "tests");
      for (const file of readdirSync(testsDir)) {
        if (file === "fixtures" || file === "Fixtures") continue;
        const full = path.join(testsDir, file);
        let src: string;
        try {
          src = readFileSync(full, "utf8");
        } catch {
          continue; // directories (e.g. an emitted package) — skip
        }
        assert.doesNotMatch(
          src,
          /Record<unknown>/,
          `${entry.target}/${file} leaks raw \`Record<unknown>\``,
        );
      }
    }
  });
});
