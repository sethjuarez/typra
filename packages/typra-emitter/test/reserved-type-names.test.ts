// Issue #358: a model, interface, or enum name that a target's generated code
// cannot carry (it overwrites a runtime support file or shadows a built-in
// type) must be diagnosed instead of emitting code that does not compile.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reservedTypeNameReason } from "../src/reserved-type-names.js";

const require = createRequire(import.meta.url);

const ALL = ["TypeScript", "Python", "Go", "CSharp", "Java", "Rust", "Swift"];

function compile(
  body: string[],
  targets: string[] = ALL,
): { output: string; emitted: boolean } {
  const root = mkdtempSync(path.join(process.cwd(), "tmp-reserved-names-"));
  const source = path.join(root, "main.tsp");
  const config = path.join(root, "tspconfig.yaml");
  const compilerEntry = require.resolve("@typespec/compiler");
  const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
  const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
  const out = path.join(root, "generated");
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
        `    emitter-output-dir: ${JSON.stringify(out)}`,
        '    root-object: "Probe.Root"',
        '    root-namespace: "Probe"',
        "    emit-targets:",
        ...targets.flatMap((target) => [
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
    return {
      output: `${result.stdout}${result.stderr}`,
      emitted: existsSync(path.join(out, "json-ast", "model.json")),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const withModel = (name: string) => [
  "model Root {",
  `  item: ${name};`,
  "}",
  "",
  `model ${name} {`,
  "  value: string;",
  "}",
];

describe("reserved type names (#358)", () => {
  it("names only the targets whose runtime support a model would overwrite", () => {
    const { output, emitted } = compile(withModel("Context"));
    assert.match(output, /typra-emitter-reserved-type-name/, output);
    for (const target of ["typescript", "python", "go", "csharp", "rust"]) {
      assert.match(output, new RegExp(`\\b${target} \\(`), output);
    }
    // Java and Swift keep their context types in LoadContext/SaveContext and
    // TypraRuntime, so a plain `Context` model is fine there.
    assert.doesNotMatch(output, /\bjava \(|\bswift \(/, output);
    assert.equal(emitted, false, "no target output on a reserved name");
  });

  for (const [name, target] of [
    ["String", "TypeScript"],
    ["Object", "Java"],
    ["Error", "Swift"],
    ["Result", "Rust"],
    ["ClassVar", "Python"],
    ["JsonElement", "CSharp"],
    ["LoadContext", "Go"],
  ]) {
    it(`errors when '${name}' is emitted for ${target}`, () => {
      const { output } = compile(withModel(name), [target]);
      assert.match(output, /typra-emitter-reserved-type-name/, output);
      assert.match(output, new RegExp(`'${name}'`), output);
    });
  }

  it("allows a name that is reserved only by targets that are not selected", () => {
    const { output, emitted } = compile(withModel("Result"), [
      "TypeScript",
      "Python",
      "Swift",
    ]);
    assert.doesNotMatch(output, /reserved-type-name/, output);
    assert.equal(emitted, true, output);
  });

  it("diagnoses interfaces and named enums too", () => {
    const iface = compile(
      [
        "model Root {",
        "  value: string;",
        "}",
        "",
        "interface Error {",
        "  run(input: string): string;",
        "}",
      ],
      ["TypeScript"],
    );
    assert.match(iface.output, /typra-emitter-reserved-type-name/, iface.output);
    assert.match(iface.output, /'Error'/, iface.output);

    const enumeration = compile(
      [
        "union String {",
        '  "a",',
        '  "b",',
        "}",
        "",
        "model Root {",
        "  kind: String;",
        "}",
      ],
      ["Java"],
    );
    assert.match(
      enumeration.output,
      /typra-emitter-reserved-type-name/,
      enumeration.output,
    );
  });

  it("does not reserve ordinary names", () => {
    const { output, emitted } = compile([
      "model Root {",
      "  item: ContextWindow;",
      "  result: ResultSet;",
      "}",
      "",
      "model ContextWindow {",
      "  value: string;",
      "}",
      "",
      "model ResultSet {",
      "  value: string;",
      "}",
    ]);
    assert.doesNotMatch(output, /reserved-type-name/, output);
    assert.equal(emitted, true, output);
  });

  it("matches support files ignoring case, only at the output root", () => {
    assert.ok(reservedTypeNameReason("python", "CONTEXT"));
    assert.ok(reservedTypeNameReason("typescript", "Index"));
    assert.ok(reservedTypeNameReason("csharp", "Utils"));
    assert.ok(reservedTypeNameReason("rust", "Mod"));
    assert.equal(
      reservedTypeNameReason("typescript", "Context", { atRoot: false }),
      undefined,
    );
    // Type shadowing is exact, so near-misses stay allowed.
    assert.equal(reservedTypeNameReason("java", "Strings"), undefined);
    for (const target of ["typescript", "python", "csharp", "java", "rust", "swift"]) {
      assert.equal(reservedTypeNameReason(target, "Load_Context"), undefined);
    }
  });

  it("does not reserve names that only conditionally emitted support uses", () => {
    // Vector-conformance, transport, and @dispatch artifacts are emitted only for
    // some specs and targets; reserving them unconditionally would reject valid
    // models, so they are left to a follow-up.
    assert.equal(reservedTypeNameReason("typescript", "TypraClientOptions"), undefined);
    assert.equal(reservedTypeNameReason("csharp", "VectorConformance"), undefined);
    assert.equal(reservedTypeNameReason("java", "RendererProvider"), undefined);
  });

  it("allows a support-file name in a structural sub-namespace", () => {
    const { output, emitted } = compile(
      [
        "model Root {",
        "  item: Sub.Context;",
        "}",
        "",
        "namespace Sub {",
        "  model Context {",
        "    value: string;",
        "  }",
        "}",
      ],
      ["TypeScript", "Python", "Rust"],
    );
    assert.doesNotMatch(output, /reserved-type-name/, output);
    assert.equal(emitted, true, output);
  });

  it("still flags a sub-namespace support-file name for flat Go output", () => {
    const { output } = compile(
      [
        "model Root {",
        "  item: Sub.Context;",
        "}",
        "",
        "namespace Sub {",
        "  model Context {",
        "    value: string;",
        "  }",
        "}",
      ],
      ["Go"],
    );
    assert.match(output, /Type name 'Context' cannot be emitted: in go/, output);
  });

  it("reserves Go names that map to build-constrained file names", () => {
    assert.match(reservedTypeNameReason("go", "FooLinux") ?? "", /_linux/);
    assert.match(reservedTypeNameReason("go", "UnitTest") ?? "", /_test/);
    assert.match(reservedTypeNameReason("go", "WidgetAmd64") ?? "", /_amd64/);
    assert.equal(reservedTypeNameReason("go", "Linux"), undefined);
    assert.equal(reservedTypeNameReason("go", "Testing"), undefined);
    assert.equal(reservedTypeNameReason("typescript", "FooLinux"), undefined);
  });
});
