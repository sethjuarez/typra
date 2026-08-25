// Copyright (c) Microsoft. All rights reserved.

// Deterministic, toolchain-free lock for the generated requirement guard: the
// @vector conformance harness must, on every one of the seven target runtimes,
//   * load the runtime-supplied capability table (the VECTOR_CAPABILITIES seam),
//   * emit the canonical, byte-identical skip reason "requirement unavailable:
//     <token>" when a required capability is absent, and
//   * hard-fail on an unregistered requirement token (never skip silently),
// and the author-declared `requires` tokens must flow through serialization into
// every harness's embedded vector payload.
//
// We compile ONE spec whose vector declares `requires: ["provider:openai"]` into
// all seven targets in a single pass, then read each generated harness and
// assert the guard text and the token are present. This needs no language
// toolchain (only `tsp compile`, i.e. Node), so it runs everywhere and pins the
// rendered target code per the reproduce-before-fix contract.

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
  "namespace Typra.Cap;",
  "",
  "model Root {",
  "  id: string;",
  "}",
  "",
  "const LiveVectors = #[",
  '  #{ name: "structure", input: #{ payload: "hi" }, expected: "PONG", requires: #["provider:openai"] }',
  "];",
  "",
  "interface Live {",
  "  @vector(LiveVectors)",
  "  ping(payload: string): string;",
  "}",
  "",
].join("\n");

// Recursively locate the single harness file with the given basename.
function findFile(root: string, needle: string): string {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
      } else if (
        needle.includes("/")
          ? full.replace(/\\/g, "/").endsWith(needle)
          : entry === needle
      ) {
        return full;
      }
    }
  }
  throw new Error(`harness file ${needle} not found under ${root}`);
}

// Per-language harness filename plus the exact expression the generated code
// uses to load the runtime capability table (parallel to the waiver seam).
// `guardFile`, when set, is the runner module a relocated target hosts the
// requirement-guard messages in (the harness still loads the seam and carries
// the payload).
const TARGETS: Array<{
  name: string;
  file: string;
  seam: RegExp;
  guardFile?: string;
}> = [
  {
    name: "typescript",
    file: "vector-conformance.test.ts",
    seam: /adapterModule\.vectorCapabilities/,
    guardFile: "vector-runner.ts",
  },
  { name: "python", file: "test_vector_conformance.py", seam: /VECTOR_CAPABILITIES/, guardFile: "vector_runner.py" },
  { name: "go", file: "vector_conformance_test.go", seam: /vectoradapters\.VectorCapabilities/, guardFile: "vector_runner.go" },
  { name: "rust", file: "vector_conformance_test.rs", seam: /vector_adapters::capabilities\(\)/, guardFile: "vector_runner/mod.rs" },
  { name: "java", file: "VectorConformanceTests.java", seam: /\.capabilities\(\)/ },
  { name: "swift", file: "VectorConformanceTests.swift", seam: /\.capabilities\(\)/ },
  { name: "csharp", file: "VectorConformanceTests.cs", seam: /VectorAdapters\.Capabilities\(\)/, guardFile: "VectorRunner.cs" },
];

describe("@vector harness emits the requirement guard on every target", () => {
  it("loads the capability seam, emits the canonical skip reason, and hard-fails unknown tokens for all seven runtimes", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-cap-guard-emission-"));
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
          '    root-object: "Typra.Cap.Root"',
          '    root-namespace: "Typra.Cap"',
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
          '        vector-adapter-path: "typracap/vectoradapters"',
          "        format: false",
          "      - type: Rust",
          `        output-dir: ${yamlString(dir("rust"))}`,
          `        test-dir: ${yamlString(dir("rust-tests"))}`,
          '        vector-adapter-path: "vector_adapters.rs"',
          "        format: false",
          "      - type: Java",
          `        output-dir: ${yamlString(dir("java"))}`,
          `        test-dir: ${yamlString(dir("java-tests"))}`,
          '        package-name: "typra.cap"',
          '        vector-adapter-path: "typra.cap.adapters.VectorAdapters"',
          "        format: false",
          "      - type: Swift",
          `        output-dir: ${yamlString(dir("swift"))}`,
          `        test-dir: ${yamlString(dir("swift-tests"))}`,
          '        package-name: "TypraCap"',
          "        format: false",
          "      - type: CSharp",
          `        output-dir: ${yamlString(dir("csharp"))}`,
          `        test-dir: ${yamlString(dir("csharp-tests"))}`,
          '        vector-adapter-path: "Typra.Cap.Adapters"',
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
        // Relocated targets host the requirement-guard logic in a runner module;
        // the harness still loads the seam and carries the payload token.
        const guardSource = target.guardFile
          ? readFileSync(findFile(gen, target.guardFile), "utf8")
          : harness;
        assert.match(
          harness,
          target.seam,
          `${target.name} harness must load the VECTOR_CAPABILITIES seam`,
        );
        assert.match(
          guardSource,
          /requirement unavailable: /,
          `${target.name} harness must emit the canonical skip reason`,
        );
        assert.match(
          guardSource,
          /No capability predicate registered for requirement token/,
          `${target.name} harness must hard-fail an unregistered requirement token`,
        );
        assert.match(
          harness,
          /provider:openai/,
          `${target.name} harness must carry the author-declared requires token in its payload`,
        );
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
