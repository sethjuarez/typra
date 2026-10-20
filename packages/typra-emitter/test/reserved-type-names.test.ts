// Issue #358: a model, interface, or enum name that a target's generated code
// cannot carry (it shadows a built-in type, is a keyword, or overwrites a
// generated support file) must be diagnosed instead of emitting code that does
// not compile.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reservedTypeNameReason } from "../src/reserved-type-names.js";
import { claimGeneratedPath } from "../src/cleanup/generated-file.js";
import type { Program } from "@typespec/compiler";

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

const COLLISION = /typra-emitter-generated-file-collision/;

const inSubNamespace = [
  "model Root {",
  "  item: Sub.Context;",
  "}",
  "",
  "namespace Sub {",
  "  model Context {",
  "    value: string;",
  "  }",
  "}",
];

describe("reserved type names (#358)", () => {
  it("reports a support-file collision only for targets that emit that file", () => {
    const { output } = compile(withModel("Context"));
    assert.match(output, COLLISION, output);
    for (const target of ["typescript", "python", "go", "csharp", "rust"]) {
      assert.match(output, new RegExp(`generated/${target}/`, "i"), output);
    }
    // Java and Swift keep their context types in LoadContext/SaveContext and
    // TypraRuntime, so a plain `Context` model is fine there.
    assert.doesNotMatch(output, /generated\/(java|swift)\//i, output);
  });

  for (const [name, target] of [
    ["Index", "TypeScript"],
    ["CONTEXT", "Python"],
    ["Utils", "CSharp"],
    ["CONTEXT", "Rust"],
  ]) {
    it(`reports '${name}' colliding with a ${target} support file, ignoring case`, () => {
      const { output } = compile(withModel(name), [target]);
      assert.match(output, COLLISION, output);
    });
  }

  for (const [name, target] of [
    ["String", "TypeScript"],
    ["Object", "Java"],
    ["Error", "Swift"],
    ["Result", "Rust"],
    ["ClassVar", "Python"],
    ["JsonElement", "CSharp"],
    ["LoadContext", "Go"],
    ["None", "Python"],
    ["Match", "Rust"],
  ]) {
    it(`errors when '${name}' is emitted for ${target}`, () => {
      const { output, emitted } = compile(withModel(name), [target]);
      assert.match(output, /typra-emitter-reserved-type-name/, output);
      assert.match(output, new RegExp(`'${name}'`), output);
      assert.equal(emitted, false, "no target output on a reserved name");
    });
  }

  it("allows a name that is reserved only by targets that are not selected", () => {
    const { output, emitted } = compile(withModel("Result"), [
      "TypeScript",
      "Python",
      "Swift",
    ]);
    assert.doesNotMatch(output, /reserved-type-name|collision/, output);
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
    assert.doesNotMatch(output, /reserved-type-name|collision/, output);
    assert.equal(emitted, true, output);
  });

  it("keeps type shadowing exact and leaves file clashes to write time", () => {
    assert.equal(reservedTypeNameReason("java", "Strings"), undefined);
    for (const target of ["typescript", "python", "csharp", "java", "rust", "swift"]) {
      assert.equal(reservedTypeNameReason(target, "Load_Context"), undefined);
      assert.equal(reservedTypeNameReason(target, "Context"), undefined);
    }
  });

  it("reserves names that are keywords where the runtime cannot escape them", () => {
    for (const name of ["None", "True", "False"]) {
      assert.match(reservedTypeNameReason("python", name) ?? "", /keyword/);
    }
    assert.equal(reservedTypeNameReason("python", "Self"), undefined);
    for (const name of ["Self", "Type", "Crate", "Super", "Match", "Struct", "Mod"]) {
      assert.match(reservedTypeNameReason("rust", name) ?? "", /Rust keyword/);
    }
    // Swift escapes keyword type names with backticks.
    for (const name of ["Self", "Type", "Protocol"]) {
      assert.equal(reservedTypeNameReason("swift", name), undefined);
    }
  });

  it("allows a support-file name in a structural sub-namespace", () => {
    const { output, emitted } = compile(inSubNamespace, [
      "TypeScript",
      "Python",
      "Rust",
    ]);
    assert.doesNotMatch(output, /reserved-type-name|collision/, output);
    assert.equal(emitted, true, output);
  });

  it("still reports a sub-namespace support-file name for flat Go output", () => {
    const { output } = compile(inSubNamespace, ["Go"]);
    assert.match(output, COLLISION, output);
    assert.match(output, /context\.go/i, output);
  });

  it("claims each generated path once per program, ignoring case", () => {
    const diagnostics: string[] = [];
    const program = {
      reportDiagnostic: (d: { code: string }) => diagnostics.push(d.code),
    } as unknown as Program;
    const file = path.join(process.cwd(), "out", "context.go");
    assert.equal(claimGeneratedPath(program, file, "a"), true);
    assert.equal(claimGeneratedPath(program, file, "a"), true, "identical rewrite");
    assert.equal(diagnostics.length, 0);
    assert.equal(
      claimGeneratedPath(program, file.replace("context", "Context"), "b"),
      false,
    );
    assert.deepEqual(diagnostics, ["typra-emitter-generated-file-collision"]);
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