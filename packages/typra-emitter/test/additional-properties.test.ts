// Issue #336: no backend emits a passthrough for a model's string indexer
// (`...Record<unknown>`, `is Record<T>`), so unknown keys are dropped on
// load → save. Until a passthrough exists, compilation must say so instead of
// silently discarding the spread.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function compile(body: string[]): string {
  const root = mkdtempSync(path.join(process.cwd(), "tmp-additional-props-"));
  const source = path.join(root, "main.tsp");
  const config = path.join(root, "tspconfig.yaml");
  const compilerEntry = require.resolve("@typespec/compiler");
  const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
  const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
  try {
    writeFileSync(
      source,
      ['import "@typra/emitter";', "", "namespace Probe;", "", ...body, ""].join(
        "\n",
      ),
    );
    writeFileSync(
      config,
      [
        "emit:",
        '  - "@typra/emitter"',
        "options:",
        '  "@typra/emitter":',
        `    emitter-output-dir: ${JSON.stringify(path.join(root, "generated"))}`,
        '    root-object: "Probe.Root"',
        '    root-namespace: "Probe"',
        "    emit-targets:",
        "      - type: TypeScript",
        `        output-dir: ${JSON.stringify(path.join(root, "generated", "typescript"))}`,
        "        format: false",
        "",
      ].join("\n"),
    );
    const result = spawnSync(
      process.execPath,
      [tspCli, "compile", source, "--config", config],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    return `${result.stdout}${result.stderr}`;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("unknown-field passthrough (#336)", () => {
  it("warns when a model spreads a string-keyed Record", () => {
    const output = compile([
      "model Root {",
      "  row: PlanningRow;",
      "}",
      "",
      "model PlanningRow {",
      "  time: string;",
      "  ...Record<unknown>;",
      "}",
    ]);
    assert.match(output, /typra-emitter-unsupported-additional-properties/);
    assert.match(output, /PlanningRow/);
  });

  it("does not warn for models without an indexer or with Record-typed fields", () => {
    const output = compile([
      "model Root {",
      "  time: string;",
      "  tags: Record<string>;",
      "  items: string[];",
      "}",
    ]);
    assert.doesNotMatch(output, /unsupported-additional-properties/);
  });

  it("warns once for a user model named Record", () => {
    const output = compile([
      "model Root {",
      "  row: Record;",
      "}",
      "",
      "model Record {",
      "  time: string;",
      "  ...TypeSpec.Record<unknown>;",
      "}",
    ]);
    const hits = output.match(/typra-emitter-unsupported-additional-properties/g) ?? [];
    assert.equal(hits.length, 1, output);
  });
});
