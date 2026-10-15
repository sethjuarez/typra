// Issue #336: a model whose string indexer is `unknown` (`...Record<unknown>`,
// `is Record<unknown>`, `extends Record<unknown>`) passes undeclared fields
// through load → save. Typed indexers (`Record<string>`, ...) are still not
// supported, so compilation must say so instead of silently dropping them.

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
  it("does not warn when a model spreads Record<unknown>", () => {
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
    assert.doesNotMatch(output, /unsupported-additional-properties/, output);
    assert.doesNotMatch(output, /error/i, output);
  });

  it("does not warn for `is`/`extends` Record<unknown> or derived models", () => {
    const output = compile([
      "model Root {",
      "  bag: Bag;",
      "  open: Open;",
      "  event: Event;",
      "}",
      "",
      "model Bag is Record<unknown> {",
      "  label: string;",
      "}",
      "",
      "model Open extends Record<unknown> {",
      "  label: string;",
      "}",
      "",
      '@discriminator("kind")',
      "model Event {",
      "  kind: string;",
      "  ...Record<unknown>;",
      "}",
      "",
      "model Click extends Event {",
      '  kind: "click";',
      "  x: int32;",
      "}",
    ]);
    assert.doesNotMatch(output, /unsupported-additional-properties/, output);
    assert.doesNotMatch(output, /error/i, output);
  });

  it("warns when a model spreads a typed string-keyed Record", () => {
    const output = compile([
      "model Root {",
      "  row: PlanningRow;",
      "}",
      "",
      "model PlanningRow {",
      "  time: string;",
      "  ...Record<string>;",
      "}",
    ]);
    assert.match(output, /typra-emitter-unsupported-additional-properties/);
    assert.match(output, /PlanningRow/);
    assert.match(output, /Only 'Record<unknown>' is supported/);
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
      "  ...TypeSpec.Record<int32>;",
      "}",
    ]);
    const hits = output.match(/typra-emitter-unsupported-additional-properties/g) ?? [];
    assert.equal(hits.length, 1, output);
  });

  for (const name of ["additionalProperties", "additional_properties"]) {
    it(`errors when a passthrough model declares a '${name}' property`, () => {
      const output = compile([
        "model Root {",
        "  row: Row;",
        "}",
        "",
        "model Row {",
        `  ${name}: string;`,
        "  ...Record<unknown>;",
        "}",
      ]);
      assert.match(output, /typra-emitter-additional-properties-collision/, output);
      assert.match(output, new RegExp(name), output);
    });
  }

  // Passthrough models also get generated known-key helpers: TS/Java
  // `isKnownWireKey`, C# `IsKnownWireKey`, Python `_known_wire_keys`, Swift
  // `additionalPropertiesKnownKeys`. A property that maps onto one of them after a
  // target's casing transform would not compile, so it must be diagnosed.
  for (const name of [
    "isKnownWireKey",
    "IsKnownWireKey",
    "is_known_wire_key",
    "_known_wire_keys",
    "_knownWireKeys",
    "additionalPropertiesKnownKeys",
    "additional_properties_known_keys",
  ]) {
    it(`errors when a passthrough model declares the generated helper name '${name}'`, () => {
      const output = compile([
        "model Root {",
        "  row: Row;",
        "}",
        "",
        "model Row {",
        `  ${name}: string;`,
        "  ...Record<unknown>;",
        "}",
      ]);
      assert.match(output, /typra-emitter-additional-properties-collision/, output);
      assert.match(output, new RegExp(name), output);
    });
  }

  it("errors when a base model's property collides with a derived passthrough helper", () => {
    const output = compile([
      "model Root {",
      "  row: Row;",
      "}",
      "",
      "model Base {",
      "  isKnownWireKey: string;",
      "}",
      "",
      "model Row extends Base {",
      "  time: string;",
      "  ...Record<unknown>;",
      "}",
    ]);
    assert.match(output, /typra-emitter-additional-properties-collision/, output);
    assert.match(output, /isKnownWireKey/, output);
  });

  it("does not reserve near-miss names that cannot map onto a generated helper", () => {
    const output = compile([
      "model Root {",
      "  row: Row;",
      "}",
      "",
      "model Row {",
      "  knownWireKeys: string;",
      "  knownWireKey: string;",
      "  additionalProps: string;",
      "  ...Record<unknown>;",
      "}",
    ]);
    assert.doesNotMatch(output, /additional-properties-collision/, output);
    assert.doesNotMatch(output, /error/i, output);
  });

  it("does not report a collision when the model has no passthrough", () => {
    const output = compile([
      "model Root {",
      "  row: Row;",
      "}",
      "",
      "model Row {",
      "  additionalProperties: string;",
      "}",
    ]);
    assert.doesNotMatch(output, /additional-properties-collision/, output);
  });
});
