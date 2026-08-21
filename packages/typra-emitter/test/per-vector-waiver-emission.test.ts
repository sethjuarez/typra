// Copyright (c) Microsoft. All rights reserved.

// Deterministic, toolchain-free lock for #265: the @vector conformance harness
// must consult the runtime waiver registry PER VECTOR (not just per operation)
// and honour it as an xfail/xpass gate on every target runtime.
//
// We compile ONE spec carrying a @vector operation into all seven targets in a
// single pass, then read each generated harness and assert it contains:
//   * the per-vector XFAIL branch (waived vector that fails is expected -> green)
//   * the XPASS branch ("waived vector unexpectedly passed" -> hard failure so
//     stale waivers are removed)
//   * a per-vector waiver key ("<operation>:<name>") distinct from the
//     operation-level key, proving the lookup fires on the adapter-present path.
//
// This needs no language toolchain (only `tsp compile`, i.e. Node), so it runs
// everywhere and pins the rendered target code, per the reproduce-before-fix
// contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function yamlString(value: string): string {
  return JSON.stringify(value);
}

const SPEC = [
  'import "@typra/emitter";',
  "",
  "namespace Typra.Waiver;",
  "",
  "model Root {",
  "  id: string;",
  "}",
  "",
  "const EchoVectors = #[",
  '  #{ name: "shout", input: #{ payload: "hi" }, expected: "HI" },',
  '  #{ name: "quiet", input: #{ payload: "lo" }, expected: "lo" }',
  "];",
  "",
  "interface Echo {",
  "  @vector(EchoVectors)",
  "  echo(payload: string): string;",
  "}",
  "",
].join("\n");

// Recursively locate the single harness file with the given basename.
function findFile(root: string, basename: string): string {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
      } else if (entry === basename) {
        return full;
      }
    }
  }
  throw new Error(`harness file ${basename} not found under ${root}`);
}

// Per-language harness filename plus the exact per-vector key expression the
// generated code uses to probe the waiver registry beyond the operation key.
const TARGETS: Array<{ name: string; file: string; perVectorKey: RegExp }> = [
  { name: "typescript", file: "vector-conformance.test.ts", perVectorKey: /\$\{entry\.operation\}:\$\{vectorName\}/ },
  { name: "python", file: "test_vector_conformance.py", perVectorKey: /\{entry\['operation'\]\}:\{vector_name\}/ },
  { name: "go", file: "vector_conformance_test.go", perVectorKey: /operation\+":"\+vectorName/ },
  { name: "rust", file: "vector_conformance_test.rs", perVectorKey: /format!\("\{\}:\{\}", operation, vector_name\)/ },
  { name: "java", file: "VectorConformanceTests.java", perVectorKey: /operation \+ ":" \+ vectorName/ },
  { name: "swift", file: "VectorConformanceTests.swift", perVectorKey: /\\\(operation\):\\\(vectorName\)/ },
  { name: "csharp", file: "VectorConformanceTests.cs", perVectorKey: /\{operation\}:\{vectorName\}/ },
];

describe("@vector harness consults per-vector waivers on every target (#265)", () => {
  it("emits an xfail/xpass per-vector waiver gate for all seven runtimes", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-per-vector-waiver-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const gen = path.join(output, "generated");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");

    const dir = (name: string): string => path.join(gen, name);

    try {
      writeFileSync(source, SPEC);
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(gen)}`,
          '    root-object: "Typra.Waiver.Root"',
          '    root-namespace: "Typra.Waiver"',
          "    emit-targets:",
          "      - type: TypeScript",
          `        output-dir: ${yamlString(dir("typescript"))}`,
          `        test-dir: ${yamlString(dir("typescript-tests"))}`,
          "        format: false",
          "      - type: Python",
          `        output-dir: ${yamlString(dir("python"))}`,
          `        test-dir: ${yamlString(dir("python-tests"))}`,
          "        format: false",
          "      - type: Go",
          `        output-dir: ${yamlString(dir("go"))}`,
          `        test-dir: ${yamlString(dir("go-tests"))}`,
          '        vector-adapter-path: "typrawaiver/vectoradapters"',
          "        format: false",
          "      - type: Rust",
          `        output-dir: ${yamlString(dir("rust"))}`,
          `        test-dir: ${yamlString(dir("rust-tests"))}`,
          '        vector-adapter-path: "vector_adapters.rs"',
          "        format: false",
          "      - type: Java",
          `        output-dir: ${yamlString(dir("java"))}`,
          `        test-dir: ${yamlString(dir("java-tests"))}`,
          '        package-name: "typra.waiver"',
          '        vector-adapter-path: "typra.waiver.adapters.VectorAdapters"',
          "        format: false",
          "      - type: Swift",
          `        output-dir: ${yamlString(dir("swift"))}`,
          `        test-dir: ${yamlString(dir("swift-tests"))}`,
          '        package-name: "TypraWaiver"',
          "        format: false",
          "      - type: CSharp",
          `        output-dir: ${yamlString(dir("csharp"))}`,
          `        test-dir: ${yamlString(dir("csharp-tests"))}`,
          '        vector-adapter-path: "Typra.Waiver.Adapters"',
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", source, "--config", config],
        { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );

      for (const target of TARGETS) {
        const harness = readFileSync(findFile(gen, target.file), "utf8");
        assert.match(
          harness,
          /XFAIL/,
          `${target.name} harness must emit an XFAIL branch for waived-and-failing vectors`,
        );
        assert.match(
          harness,
          /waived vector unexpectedly/,
          `${target.name} harness must emit an XPASS guard for waived-but-passing vectors`,
        );
        assert.match(
          harness,
          target.perVectorKey,
          `${target.name} harness must probe a per-vector waiver key ("<operation>:<name>")`,
        );
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
