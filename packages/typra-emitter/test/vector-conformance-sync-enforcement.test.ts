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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

// Recursively locate a file by basename under `root`. Relocated targets host
// their runner module in different places (TS/Python: a sibling file in the
// test dir; Go: its own `vectorrunner` package under the output dir), so the
// guard lookup searches the whole generated tree instead of assuming a path.
function findFileRecursive(root: string, basename: string): string | undefined {
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) {
      const found = findFileRecursive(full, basename);
      if (found) return found;
    } else if (entry === basename) {
      return full;
    }
  }
  return undefined;
}

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
  // (Go documents its exemption instead). Relocated targets host the guard in
  // the shared runner module named by `guardFile`.
  guard: RegExp;
  // File the @sync enforcement guard lives in. Defaults to `file`; targets that
  // relocated their interpreter into a runner module point this at that module.
  guardFile?: string;
  // How the harness classifies the @sync op ('format') as sync and the
  // async-default op ('authorize') as async. Migrated targets thread the flag
  // as an emit-time call argument (no `sync` field leaks into embedded data);
  // legacy targets still embed a `sync:true`/`sync:false` entry field, so a
  // target without explicit patterns falls back to the embedded-data form.
  syncTrue?: RegExp;
  syncFalse?: RegExp;
}

const EMBEDDED_SYNC_TRUE = /"?operation"?:"format",[^]*?"?sync"?:true/;
const EMBEDDED_SYNC_FALSE = /"?operation"?:"authorize",[^]*?"?sync"?:false/;

const TARGETS: Target[] = [
  {
    type: "TypeScript",
    outputDir: "typescript",
    testDir: "typescript-tests",
    file: "vector-conformance.test.ts",
    guard: /entrySync && isAwaitable\(/,
    guardFile: "vector-runner.ts",
    syncTrue: /runVector\("[^"]*", "format", vector, true, seam\)/,
    syncFalse: /runVector\("[^"]*", "authorize", vector, false, seam\)/,
  },
  {
    type: "Python",
    outputDir: "python",
    testDir: "python-tests",
    file: "test_vector_conformance.py",
    guard: /_SyncViolation/,
    guardFile: "vector_runner.py",
    syncTrue: /run_vector\("[^"]*", "format", vector, True, _SEAM\)/,
    syncFalse: /run_vector\("[^"]*", "authorize", vector, False, _SEAM\)/,
  },
  {
    type: "CSharp",
    outputDir: "csharp",
    testDir: "csharp-tests",
    file: "VectorConformanceTests.cs",
    extra: ['        vector-adapter-path: "Typra.Proof.Adapters"'],
    guard: /sync && IsAwaitable\(/,
    syncTrue: /RunVector\("[^"]*", "format", vector, true\)/,
    syncFalse: /RunVector\("[^"]*", "authorize", vector, false\)/,
  },
  {
    type: "Go",
    outputDir: "go",
    testDir: "go-tests",
    file: "vector_conformance_test.go",
    extra: ['        vector-adapter-path: "typraproof/vectoradapters"'],
    guard: /@sync classification is not separately enforced/,
    guardFile: "vector_runner.go",
    // Go has no awaitable type, so it threads operation as a call argument with
    // no sync flag at all (enforcement is a no-op by construction). Assert both
    // operations are still emitted as per-vector call arguments.
    syncTrue: /vectorrunner\.RunVector\(t, "[^"]*", "format", vector, /,
    syncFalse: /vectorrunner\.RunVector\(t, "[^"]*", "authorize", vector, /,
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
    syncTrue: /runVector\("[^"]*", "format", vector, true\)/,
    syncFalse: /runVector\("[^"]*", "authorize", vector, false\)/,
  },
  {
    type: "Rust",
    outputDir: "rust",
    testDir: "rust-tests",
    file: "vector_conformance_test.rs",
    extra: ['        vector-adapter-path: "vector_adapters.rs"'],
    guard: /if let vector_adapters::Invoke::Async\(_\) = adapter\.invoke/,
    syncTrue: /vc_run_vector\("[^"]*", "format", vector, true\)/,
    syncFalse: /vc_run_vector\("[^"]*", "authorize", vector, false\)/,
  },
  {
    type: "Swift",
    outputDir: "swift",
    testDir: "swift-tests",
    file: "VectorConformanceTests.swift",
    extra: ['        package-name: "TypraProof"'],
    guard: /if sync, case \.asynchronous = adapter\.invoke/,
    syncTrue:
      /runVector\(contract: "[^"]*", operation: "format", vector: vector, sync: true\)/,
    syncFalse:
      /runVector\(contract: "[^"]*", operation: "authorize", vector: vector, sync: false\)/,
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

        // (a) the @sync op is classified sync:true, the async-default op
        // sync:false. Migrated targets thread the flag as a call argument
        // (`runVector(..., true)`); legacy targets embed a `sync` entry field.
        // TypeScript's payload is a real object literal, so prettier drops
        // quotes from identifier keys; the JSON-string targets keep quoted keys.
        const syncTrue = target.syncTrue ?? EMBEDDED_SYNC_TRUE;
        const syncFalse = target.syncFalse ?? EMBEDDED_SYNC_FALSE;
        assert.match(
          target.syncTrue ? suite : flat,
          syncTrue,
          `${target.type}: expected the @sync op 'format' to be classified sync:true`,
        );
        assert.match(
          target.syncFalse ? suite : flat,
          syncFalse,
          `${target.type}: expected async-default op 'authorize' to be classified sync:false`,
        );

        // (b) a native enforcement guard is present (Go documents its exemption).
        // Relocated targets host the guard in a shared runner module, which may
        // live outside the test dir (Go's `vectorrunner` package), so locate it
        // by basename across the whole generated tree.
        let guardSource = suite;
        if (target.guardFile) {
          const guardPath = findFileRecursive(
            path.join(output, "generated"),
            target.guardFile,
          );
          assert.ok(
            guardPath,
            `${target.type}: expected to find runner module ${target.guardFile}`,
          );
          guardSource = readFileSync(guardPath, "utf8");
        }
        assert.match(
          guardSource,
          target.guard,
          `${target.type}: expected a native @sync enforcement guard in the harness`,
        );
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
