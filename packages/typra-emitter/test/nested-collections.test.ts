// Issue #355: a collection nested in a collection (`string[][]`, `Leaf[][]`,
// `Record<string[]>`, `Record<Record<int32>>`) has no single-level IR shape, so
// it must be diagnosed instead of lowering to phantom `string[]` models and
// literal `Record<...>` type names.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

const TARGETS = ["TypeScript", "Python", "Go", "CSharp", "Java", "Rust", "Swift"];

function compile(
  rootBody: string[],
  declarations: string[] = [],
): { output: string; files: string[] } {
  const root = mkdtempSync(path.join(process.cwd(), "tmp-nested-collections-"));
  const source = path.join(root, "main.tsp");
  const config = path.join(root, "tspconfig.yaml");
  const compilerEntry = require.resolve("@typespec/compiler");
  const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
  const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
  const out = path.join(root, "generated");
  try {
    writeFileSync(
      source,
      [
        'import "@typra/emitter";',
        "",
        "namespace Probe;",
        "",
        "model Leaf {",
        "  id: string;",
        "}",
        "",
        ...declarations,
        "",
        "@serializable",
        "model Root {",
        ...rootBody.map((line) => `  ${line}`),
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      config,
      [
        "emit:",
        '  - "@typra/emitter"',
        "options:",
        '  "@typra/emitter":',
        `    emitter-output-dir: ${JSON.stringify(out)}`,
        '    root-object: "Probe.Root"',
        '    root-namespace: "Probe"',
        "    emit-targets:",
        ...TARGETS.flatMap((target) => [
          `      - type: ${target}`,
          `        output-dir: ${JSON.stringify(path.join(out, target.toLowerCase()))}`,
          "        format: false",
        ]),
        "",
      ].join("\n"),
    );
    const result = spawnSync(
      process.execPath,
      [tspCli, "compile", source, "--config", config],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const files = TARGETS.flatMap((target) => {
      try {
        return readdirSync(path.join(out, target.toLowerCase()), {
          recursive: true,
        }).map(String);
      } catch {
        return [];
      }
    });
    return { output: `${result.stdout}${result.stderr}`, files };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("nested collections (#355)", () => {
  for (const [name, type] of [
    ["strings", "string[][]"],
    ["leaves", "Leaf[][]"],
    ["byArray", "Record<string[]>"],
    ["byRecord", "Record<Record<int32>>"],
    ["rowsOfArrays", "Record<string[]>[]"],
    ["maybe", "string[][] | null"],
  ]) {
    it(`errors on '${type}' instead of emitting phantom types`, () => {
      const { output, files } = compile([`${name}: ${type};`]);
      assert.match(output, /typra-emitter-unsupported-nested-collection/, output);
      assert.match(output, new RegExp(`Property '${name}'`), output);
      const phantom = files.filter((file) => /[[\]<>]/.test(file));
      assert.deepEqual(phantom, [], `phantom files: ${phantom.join(", ")}`);
    });
  }

  it("keeps supported single-level collections", () => {
    const { output } = compile([
      "strings: string[];",
      "leaves: Leaf[];",
      "byValue: Record<string>;",
      "byLeaf: Record<Leaf>;",
      "rows: Record<string>[];",
      "maybe: string[] | null;",
    ]);
    assert.doesNotMatch(output, /unsupported-nested-collection/, output);
    assert.doesNotMatch(output, /\berror\b/i, output);
  });

  it("sees through property-less 'model X is ...' collection aliases", () => {
    const { output } = compile(
      ["grid: Grid;", "rows: Row[];"],
      ["model Grid is string[][];", "model Row is string[];"],
    );
    assert.match(output, /Property 'grid' has a nested/, output);
    assert.match(output, /Property 'rows' has a nested/, output);
  });

  it("does not treat a model that spreads Record<T> as a collection", () => {
    const { output } = compile(
      ["bags: Bag[];"],
      ["model Bag {", "  name: string;", "  ...Record<string>;", "}"],
    );
    assert.doesNotMatch(output, /unsupported-nested-collection/, output);
  });

  it("errors once per operation parameter and return", () => {
    const { output } = compile(
      ["id: string;"],
      [
        "interface Seam {",
        "  grid(rows: Leaf[][], flat: Leaf[]): Record<string[]>;",
        "}",
      ],
    );
    assert.equal(
      output.match(/Parameter 'rows' of operation 'grid'/g)?.length,
      1,
      output,
    );
    assert.match(output, /Operation 'grid' return has a nested/, output);
    assert.doesNotMatch(output, /Parameter 'flat'/, output);
  });
});
