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
      '    m["Echo.echo"] = VectorAdapter(asynchronous: echoInvoke)',
      '    m["Sum.sum"] = VectorAdapter(sync: sumInvoke)',
      '    m["Note.note"] = VectorAdapter(sync: noteInvoke)',
    ],
    "[:]",
  );
}

// Echo and Note only. Sum.sum is deliberately unimplemented.
function swiftEchoOnlyAdapter(waivers: string): string {
  return swiftAdapter(
    [
      '    m["Echo.echo"] = VectorAdapter(asynchronous: echoInvoke)',
      '    m["Note.note"] = VectorAdapter(sync: noteInvoke)',
    ],
    waivers,
  );
}

// -- @sync enforcement: a second spec with a @sync op and an async-default op --

const SYNC_SPEC = [
  'import "@typra/emitter";',
  "",
  "namespace Typra.SyncProof;",
  "",
  "model Root {",
  "  id: string;",
  "}",
  "",
  "const TagVectors = #[",
  '  #{ name: "basic", input: #{ label: "x" }, expected: "TAG:x" }',
  "];",
  "",
  "const NoteVectors = #[",
  '  #{ name: "basic", input: #{ text: "hi" }, expected: "hi!" }',
  "];",
  "",
  "interface Tag {",
  "  @sync",
  "  @vector(TagVectors)",
  "  tag(label: string): string;",
  "}",
  "",
  "interface Note {",
  "  @vector(NoteVectors)",
  "  note(text: string): string;",
  "}",
  "",
].join("\n");

const SWIFT_SYNC_INVOKES = [
  "  // A @sync op wired synchronously.",
  "  static func tagSync(_ input: Any?, _ ctx: VectorContext) throws -> Any? {",
  '    let label = (input as? [String: Any])?["label"] as? String ?? ""',
  '    return "TAG:" + label',
  "  }",
  "",
  "  // The same op wired asynchronously — the classification violation under test.",
  "  static func tagAsync(_ input: Any?, _ ctx: VectorContext) async throws -> Any? {",
  "    await Task.yield()",
  '    let label = (input as? [String: Any])?["label"] as? String ?? ""',
  '    return "TAG:" + label',
  "  }",
  "",
  "  // An async-default op wired asynchronously — permissive, must stay green.",
  "  static func noteAsync(_ input: Any?, _ ctx: VectorContext) async throws -> Any? {",
  "    await Task.yield()",
  '    let text = (input as? [String: Any])?["text"] as? String ?? ""',
  '    return text + "!"',
  "  }",
  "",
];

function swiftSyncAdapter(registrations: string[]): string {
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
    "  static func waivers() -> [String: String] { return [:] }",
    "  static func doubles() -> Any? { return nil }",
    "",
    ...SWIFT_SYNC_INVOKES,
    "}",
    "",
  ].join("\n");
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
      // The interpreter lives in the sibling runner module; the thin harness
      // only wires the seam.
      const swiftRunner = readFileSync(
        path.join(swiftTestDir, "VectorRunner.swift"),
        "utf8",
      );
      assert.match(swiftSuite, /VectorAdapters\.adapters\(\)/);
      assert.match(swiftRunner, /No vector adapter registered for/);
      assert.match(swiftSuite, /func testVector\d+\w*\(\) async throws/);
      assert.match(swiftRunner, /invokeAdapter\(adapter, input, ctx, sync: sync/);
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
      writeFileSync(
        path.join(testTargetDir, "VectorRunner.swift"),
        swiftRunner,
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

  // Executable RED negative for @sync enforcement on the Swift target. The same
  // generated suite drives two registries: one that honors @sync (Tag.tag wired
  // with the `sync:` initializer) and one that violates it (Tag.tag wired
  // `asynchronous:`). The violation must be a hard, distinct failure carrying the
  // classification message, while the async-default op (Note.note) stays green.
  it("enforces @sync: a @sync op wired async fails hard; async-default stays green", (t) => {
    if (!swiftAvailable()) {
      t.skip("swift toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-vector-swift-sync-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const swiftOut = path.join(output, "generated", "swift");
    const swiftTestDir = path.join(swiftOut, "Tests", "TypraSyncProofTests");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");

    try {
      writeFileSync(source, SYNC_SPEC);
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.SyncProof.Root"',
          '    root-namespace: "Typra.SyncProof"',
          "    emit-targets:",
          "      - type: Swift",
          `        output-dir: ${yamlString(swiftOut)}`,
          `        test-dir: ${yamlString(swiftTestDir)}`,
          '        package-name: "TypraSyncProof"',
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", source, "--config", config],
        { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );

      const swiftSuite = readFileSync(
        path.join(swiftTestDir, "VectorConformanceTests.swift"),
        "utf8",
      );
      const swiftRunner = readFileSync(
        path.join(swiftTestDir, "VectorRunner.swift"),
        "utf8",
      );
      // The runner carries the enum-tag classification guard.
      assert.match(swiftRunner, /if sync, case \.asynchronous = adapter\.invoke/);

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
        "public func typraSyncProofAnchor() {}\n",
      );
      writeFileSync(
        path.join(testTargetDir, "VectorConformanceTests.swift"),
        swiftSuite,
      );
      writeFileSync(
        path.join(testTargetDir, "VectorRunner.swift"),
        swiftRunner,
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

      // -- honoring @sync: Tag.tag sync, Note.note async => all green ----------
      const ok = run(
        swiftSyncAdapter([
          '    m["Tag.tag"] = VectorAdapter(sync: tagSync)',
          '    m["Note.note"] = VectorAdapter(asynchronous: noteAsync)',
        ]),
      );
      assert.equal(ok.status, 0, `@sync-honoring Swift suite should pass:\n${ok.output}`);
      assert.match(ok.output, /PASS Tag\.tag:basic/);
      assert.match(ok.output, /PASS Note\.note:basic/);
      assert.doesNotMatch(ok.output, /FAIL /);

      // -- violating @sync: Tag.tag wired async => hard, distinct failure ------
      const red = run(
        swiftSyncAdapter([
          '    m["Tag.tag"] = VectorAdapter(asynchronous: tagAsync)',
          '    m["Note.note"] = VectorAdapter(asynchronous: noteAsync)',
        ]),
      );
      assert.notEqual(red.status, 0, `@sync-violating Swift suite must fail:\n${red.output}`);
      assert.match(red.output, /FAIL Tag\.tag:basic/);
      assert.match(red.output, /operation is @sync but its adapter is registered/);
      assert.match(red.output, /PASS Note\.note:basic/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
