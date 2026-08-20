// Copyright (c) Microsoft. All rights reserved.

// Executable proof that @vector behavioral conformance is an ENFORCED tier for
// the Swift target, not a tautology. We compile one spec (Echo/Sum/Note) once,
// then replay the generated XCTest conformance suite against three runtime
// adapter registries:
//
//   1. reference   -> every vector implemented           => GREEN
//   2. waived      -> one operation missing but waived    => GREEN, visible skip
//   3. incomplete  -> one operation missing, NO waiver    => RED (hard failure)
//
// If the loop were open (comparing vector data to itself), scenarios 2 and 3
// could never diverge from scenario 1. They do, so the loop is closed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function swiftAvailable(): boolean {
  try {
    execFileSync("swift", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
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
  "const EchoVectors = #[",
  '  #{ name: "shout", input: #{ payload: "hi" }, expected: "HI" },',
  '  #{ name: "empty", input: #{ payload: "" }, expectedError: #{ code: "empty" } }',
  "];",
  "",
  "const SumVectors = #[",
  '  #{ name: "basic", input: #{ values: #[1, 2, 3] }, expected: 6 }',
  "];",
  "",
  "const NoteVectors = #[",
  '  #{ name: "bidi", input: #{ text: "a\u202eb" }, expected: "a\u202eb!" }',
  "];",
  "",
  "interface Echo {",
  "  @vector(EchoVectors)",
  "  echo(payload: string): string;",
  "}",
  "",
  "interface Sum {",
  "  @vector(SumVectors)",
  "  sum(values: int32[]): int32;",
  "}",
  "",
  "interface Note {",
  "  @vector(NoteVectors)",
  "  note(text: string): string;",
  "}",
  "",
].join("\n");

// -- runtime adapter registry authored the way a downstream runtime would ------

const SWIFT_INVOKES = [
  "  static func echoInvoke(_ input: Any?, _ ctx: VectorContext) async throws -> Any? {",
  "    // Await on XCTest's runtime to prove an adapter may drive real async work.",
  "    await Task.yield()",
  '    let payload = (input as? [String: Any])?["payload"] as? String ?? ""',
  "    if payload.isEmpty {",
  '      throw VectorError("empty", payload: ["code": "empty"])',
  "    }",
  "    return payload.uppercased()",
  "  }",
  "",
  "  static func noteInvoke(_ input: Any?, _ ctx: VectorContext) throws -> Any? {",
  '    let text = (input as? [String: Any])?["text"] as? String ?? ""',
  '    return text + "!"',
  "  }",
  "",
  "  static func sumInvoke(_ input: Any?, _ ctx: VectorContext) throws -> Any? {",
  '    let values = (input as? [String: Any])?["values"] as? [Any] ?? []',
  "    var total = 0",
  "    for value in values {",
  "      if let number = value as? NSNumber { total += number.intValue }",
  "    }",
  "    return total",
  "  }",
  "",
];

function swiftAdapter(registrations: string[], waivers: string): string {
  return [
    "import Foundation",
    "",
    "enum VectorAdapters {",
    "  static func adapters() -> [String: VectorAdapter] {",
    "    var m: [String: VectorAdapter] = [:]",
    ...registrations,
    "    return m",
    "  }",
    "",
    `  static func waivers() -> [String: String] { return ${waivers} }`,
    "  static func doubles() -> Any? { return nil }",
    "",
    ...SWIFT_INVOKES,
    "}",
    "",
  ].join("\n");
}

function swiftReferenceAdapter(): string {
  return swiftAdapter(
    [
      '    m["Echo.echo"] = VectorAdapter(echoInvoke)',
      '    m["Sum.sum"] = VectorAdapter(sumInvoke)',
      '    m["Note.note"] = VectorAdapter(noteInvoke)',
    ],
    "[:]",
  );
}

// Echo and Note only. Sum.sum is deliberately unimplemented.
function swiftEchoOnlyAdapter(waivers: string): string {
  return swiftAdapter(
    [
      '    m["Echo.echo"] = VectorAdapter(echoInvoke)',
      '    m["Note.note"] = VectorAdapter(noteInvoke)',
    ],
    waivers,
  );
}

type RunResult = { status: number; output: string };

describe("@vector conformance is an enforced closed loop (Swift)", () => {
  it("goes green with a reference adapter, skips with a waiver, and fails hard without one", (t) => {
    if (!swiftAvailable()) {
      t.skip("swift toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-vector-swift-loop-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const swiftOut = path.join(output, "generated", "swift");
    const swiftTestDir = path.join(
      swiftOut,
      "Tests",
      "TypraProofTests",
    );
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");

    try {
      writeFileSync(source, SPEC);
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
          "      - type: Swift",
          `        output-dir: ${yamlString(swiftOut)}`,
          `        test-dir: ${yamlString(swiftTestDir)}`,
          '        package-name: "TypraProof"',
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", source, "--config", config],
        { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );

      // Sanity: the generated suite must invoke a runtime adapter registry.
      const swiftSuite = readFileSync(
        path.join(swiftTestDir, "VectorConformanceTests.swift"),
        "utf8",
      );
      assert.match(swiftSuite, /VectorAdapters\.adapters\(\)/);
      assert.match(swiftSuite, /No vector adapter registered for/);
      assert.match(swiftSuite, /func testVectorConformance\(\) async throws/);
      assert.match(swiftSuite, /try await adapter\.invoke\(input, ctx\)/);
      // The bidi control (U+202E) is embedded as an ASCII escape, never raw.
      assert.match(swiftSuite, /\\u\{202e\}/);
      assert.doesNotMatch(swiftSuite, /\u202e/);

      // Assemble a self-contained SwiftPM package with no external dependencies:
      // the generated suite plus the runtime adapter, compiled side by side.
      const pkgDir = path.join(output, "pkg");
      const testTargetDir = path.join(pkgDir, "Tests", "ProofTests");
      const libDir = path.join(pkgDir, "Sources", "Proof");
      mkdirSync(testTargetDir, { recursive: true });
      mkdirSync(libDir, { recursive: true });
      writeFileSync(
        path.join(pkgDir, "Package.swift"),
        [
          "// swift-tools-version: 5.9",
          "import PackageDescription",
          "",
          "let package = Package(",
          '  name: "Proof",',
          "  targets: [",
          '    .target(name: "Proof", path: "Sources/Proof"),',
          '    .testTarget(name: "ProofTests", dependencies: ["Proof"], path: "Tests/ProofTests"),',
          "  ]",
          ")",
          "",
        ].join("\n"),
      );
      writeFileSync(
        path.join(libDir, "Anchor.swift"),
        "public func typraProofAnchor() {}\n",
      );
      writeFileSync(
        path.join(testTargetDir, "VectorConformanceTests.swift"),
        swiftSuite,
      );

      const adapterPath = path.join(testTargetDir, "Adapters.swift");
      const run = (adapterSrc: string): RunResult => {
        writeFileSync(adapterPath, adapterSrc);
        try {
          const out = execFileSync("swift", ["test"], {
            cwd: pkgDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          return { status: 0, output: out };
        } catch (error) {
          const err = error as { status?: number; stdout?: string; stderr?: string };
          return {
            status: err.status ?? 1,
            output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
          };
        }
      };

      // -- scenario 1: reference adapter => everything green --------------------
      const green = run(swiftReferenceAdapter());
      assert.equal(green.status, 0, `reference Swift suite should pass:\n${green.output}`);
      assert.match(green.output, /PASS Echo\.echo:shout/);
      assert.match(green.output, /PASS Sum\.sum:basic/);
      assert.match(green.output, /PASS Note\.note:bidi/);
      assert.doesNotMatch(green.output, /FAIL /);
      assert.doesNotMatch(green.output, /SKIP /);

      // -- scenario 2: Sum.sum unimplemented but explicitly waived => pass ------
      const waived = run(swiftEchoOnlyAdapter('["Sum.sum": "runtime pending"]'));
      assert.equal(waived.status, 0, `waived Swift suite should pass:\n${waived.output}`);
      assert.match(waived.output, /SKIP Sum\.sum:basic \(waived: runtime pending\)/);
      assert.doesNotMatch(waived.output, /FAIL /);

      // -- scenario 3: Sum.sum unimplemented, NO waiver => hard failure ---------
      const red = run(swiftEchoOnlyAdapter("[:]"));
      assert.notEqual(red.status, 0, `unwaived Swift suite must fail:\n${red.output}`);
      assert.match(
        red.output,
        /FAIL Sum\.sum:basic: No vector adapter registered for Sum\.sum/,
      );
      assert.doesNotMatch(red.output, /SKIP Sum\.sum/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
