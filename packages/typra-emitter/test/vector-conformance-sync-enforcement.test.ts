// Copyright (c) Microsoft. All rights reserved.

// Cross-target proof that `@sync` classification is threaded into every
// generated @vector conformance harness AND that each target emits its
// language-native enforcement guard. This is the static half of the
// reproduce-before-fix contract for enforced classification: a single spec
// carrying one `@sync` op (`Port.format`) and one async-default op
// (`Port.authorize`) is emitted to all code targets at once, and each harness
// is asserted to (a) carry `sync: true` for the sync op and `sync: false` for
// the async-default op in its embedded payload, and (b) contain the guard that
// rejects a @sync adapter which returns an awaitable. Go is the one exemption:
// it has no awaitable type, so it documents the exemption instead of guarding.
//
// The executable half (a @sync op wired async actually FAILS at run time) lives
// in the language closed-loop tests; the sync happy-path runs green across all
// six runtimes in validate-fixtures via the canonical-ports `format` op.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function yamlString(value: string): string {
  return JSON.stringify(value);
}

// Collapse the payload literal to a quote/whitespace-neutral form so one value
// assertion works whether the target embeds JSON raw (TypeScript, Python) or as
// a backslash-escaped string literal (`\"` in C#/Rust/Swift/Java/Go).
function flatten(suite: string): string {
  return suite.replace(/\\/g, "").replace(/\s+/g, "");
}

const SPEC = [
  'import "@typra/emitter";',
  "",
  "namespace Typra.Proof;",
  "",
  "model Root {",
  "  id: string;",
  "}",
  "",
  "model Message {",
  "  text: string;",
  "}",
  "",
  "model Decision {",
  "  approved: boolean;",
  "}",
  "",
  "interface Port {",
  "  @sync",
  "  @vector(#{",
  '    name: "passthrough",',
  '    stage: "callable",',
  '    input: #{ messages: #[#{ text: "a" }] },',
  '    expected: #[#{ text: "a" }]',
  "  })",
  "  format(messages: Message[]): Message[];",
  "",
  "  @vector(#{",
  '    name: "grant",',
  '    stage: "callable",',
  '    input: #{ id: "req-1" },',
  '    expected: #{ approved: true }',
  "  })",
  "  authorize(id: string): Decision;",
  "}",
  "",
].join("\n");

interface Target {
  type: string;
  outputDir: string;
  testDir: string;
  file: string;
  extra?: string[];
  // Guard proving the harness rejects a @sync adapter that returns an awaitable
  // (Go documents its exemption instead).
  guard: RegExp;
}

const TARGETS: Target[] = [
  {
    type: "TypeScript",
    outputDir: "typescript",
    testDir: "typescript-tests",
    file: "vector-conformance.test.ts",
    guard: /entry\.sync && isAwaitable\(/,
  },
  {
    type: "Python",
    outputDir: "python",
    testDir: "python-tests",
    file: "test_vector_conformance.py",
    guard: /_SyncViolation/,
  },
  {
    type: "CSharp",
    outputDir: "csharp",
    testDir: "csharp-tests",
    file: "VectorConformanceTests.cs",
    extra: ['        vector-adapter-path: "Typra.Proof.Adapters"'],
    guard: /sync && IsAwaitable\(/,
  },
  {
    type: "Go",
    outputDir: "go",
    testDir: "go-tests",
    file: "vector_conformance_test.go",
    extra: ['        vector-adapter-path: "typraproof/vectoradapters"'],
    guard: /@sync classification is not separately enforced/,
  },
  {
    type: "Java",
    outputDir: "java",
    testDir: "java-tests",
    file: "VectorConformanceTests.java",
    extra: [
      '        package-name: "typra.proof"',
      '        native-serialization: "jackson"',
      '        vector-adapter-path: "typra.proof.VectorAdapters"',
    ],
    guard: /sync && isAwaitable\(/,
  },
  {
    type: "Rust",
    outputDir: "rust",
    testDir: "rust-tests",
    file: "vector_conformance_test.rs",
    extra: ['        vector-adapter-path: "vector_adapters.rs"'],
    guard: /if let vector_adapters::Invoke::Async\(_\) = adapter\.invoke/,
  },
  {
    type: "Swift",
    outputDir: "swift",
    testDir: "swift-tests",
    file: "VectorConformanceTests.swift",
    extra: ['        package-name: "TypraProof"'],
    guard: /if sync, case \.asynchronous = adapter\.invoke/,
  },
];

describe("@sync classification is threaded and enforced across all targets", () => {
  it("emits the sync flag and a native enforcement guard in every harness", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-sync-enforce-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");

    const resolved = TARGETS.map((t) => ({
      target: t,
      outDir: path.join(output, "generated", t.outputDir),
      testDir: path.join(output, "generated", t.testDir),
    }));

    try {
      writeFileSync(source, SPEC);
      const targetBlocks = resolved.flatMap(({ target, outDir, testDir }) => [
        `      - type: ${target.type}`,
        `        output-dir: ${yamlString(outDir)}`,
        `        test-dir: ${yamlString(testDir)}`,
        "        format: false",
        ...(target.extra ?? []),
      ]);
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.Proof.Root"',
          '    root-namespace: "Typra.Proof"',
          "    emit-targets:",
          ...targetBlocks,
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", source, "--config", config],
        { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );

      for (const { target, testDir } of resolved) {
        const suite = readFileSync(path.join(testDir, target.file), "utf8");
        const flat = flatten(suite);

        // (a) the @sync op is classified sync:true, the async-default op sync:false.
        // TypeScript's payload is a real object literal, so prettier drops quotes
        // from its identifier keys; the other targets embed it as a JSON string
        // (quoted keys). Accept either so one assertion covers every target.
        assert.match(
          flat,
          /"?operation"?:"format",[^]*?"?sync"?:true/,
          `${target.type}: expected the @sync op 'format' to be classified sync:true`,
        );
        assert.match(
          flat,
          /"?operation"?:"authorize",[^]*?"?sync"?:false/,
          `${target.type}: expected async-default op 'authorize' to be classified sync:false`,
        );

        // (b) a native enforcement guard is present (Go documents its exemption)
        assert.match(
          suite,
          target.guard,
          `${target.type}: expected a native @sync enforcement guard in the harness`,
        );
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
