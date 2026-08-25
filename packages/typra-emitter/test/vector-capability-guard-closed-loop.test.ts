// Copyright (c) Microsoft. All rights reserved.

// Executable proof that the generated requirement guard is a real, enforced
// third axis — distinct from both a passing adapter and a waiver. We compile one
// spec whose single vector declares `requires: ["provider:live"]`, generate the
// TypeScript and Python conformance suites once, then replay them against three
// runtime capability registries:
//
//   1. present  -> predicate returns true    => adapter runs => GREEN
//   2. absent   -> predicate returns false    => clean SKIP (requirement
//                                                 unavailable) BEFORE invoke
//   3. unknown  -> NO predicate registered     => hard failure (never skip
//                                                 silently)
//
// If the guard were a no-op, scenarios 2 and 3 could not diverge from 1. They
// do, so the guard is closed: an absent capability self-skips and a typo'd
// token fails hard.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as ts from "typescript";

const require = createRequire(import.meta.url);

function yamlString(value: string): string {
  return JSON.stringify(value);
}

const SPEC = [
  'import "@typra/emitter";',
  "",
  "namespace Typra.CapProof;",
  "",
  "model Root {",
  "  id: string;",
  "}",
  "",
  "const LiveVectors = #[",
  '  #{ name: "structure", input: #{ payload: "hi" }, expected: "PONG", requires: #["provider:live"] }',
  "];",
  "",
  "interface Live {",
  "  @vector(LiveVectors)",
  "  ping(payload: string): string;",
  "}",
  "",
].join("\n");

// -- runtime capability registries authored the way a downstream runtime would -

const TS_ADAPTER = [
  "export const vectorAdapters = {",
  '  "Live.ping": { invoke() { return "PONG"; } },',
  "};",
  "CAPABILITIES_PLACEHOLDER",
  "",
].join("\n");

const PY_ADAPTER = [
  "class _Live:",
  "    def invoke(self, payload, context):",
  '        return "PONG"',
  "",
  "",
  'VECTOR_ADAPTERS = {"Live.ping": _Live()}',
  "CAPABILITIES_PLACEHOLDER",
  "",
].join("\n");

function transpile(code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

const TS_RUNNER = [
  "const suites = [];",
  "const tests = [];",
  "const failures = [];",
  "function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }",
  "globalThis.describe = (name, fn) => { suites.push(name); try { fn(); } finally { suites.pop(); } };",
  "globalThis.it = (name, fn) => { tests.push({ full: [...suites, name].join(' > '), fn }); };",
  "globalThis.expect = (actual) => ({",
  "  toBeDefined() { if (actual === undefined || actual === null) throw new Error('not defined'); },",
  "  toBe(expected) { if (actual !== expected) throw new Error('Expected ' + String(actual) + ' to be ' + String(expected)); },",
  "  toEqual(expected) { if (!same(actual, expected)) throw new Error('Expected ' + JSON.stringify(actual) + ' to equal ' + JSON.stringify(expected)); },",
  "  toBeInstanceOf(expected) { if (!(actual instanceof expected)) throw new Error('not instance'); },",
  "});",
  "async function main() {",
  "  require('./vector-conformance.test.js');",
  "  for (const t of tests) {",
  "    try { await t.fn(); console.log('PASS ' + t.full); }",
  "    catch (error) { failures.push(t.full); console.error('FAIL ' + t.full); console.error(error && error.message ? error.message : String(error)); }",
  "  }",
  "  if (failures.length > 0) process.exit(1);",
  "}",
  "main();",
  "",
].join("\n");

type RunResult = { status: number; output: string };

function runNode(dir: string): RunResult {
  try {
    const output = execFileSync(process.execPath, ["runner.js"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

function runPytest(dir: string): RunResult {
  const args = [
    "run",
    "--python",
    "3.12",
    "--with",
    "pytest",
    "--with",
    "pytest-asyncio",
    "python",
    "-m",
    "pytest",
    "test_vector_conformance.py",
    "-q",
    "-p",
    "no:cacheprovider",
  ];
  try {
    const output = execFileSync("uv", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

describe("@vector requirement guard is an enforced closed loop", () => {
  it("runs when the capability is present, skips when absent, and fails hard on an unknown token", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-vector-cap-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const tsDir = path.join(output, "generated", "typescript-tests");
    const pyDir = path.join(output, "generated", "python-tests");
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
          '    root-object: "Typra.CapProof.Root"',
          '    root-namespace: "Typra.CapProof"',
          "    emit-targets:",
          "      - type: TypeScript",
          `        output-dir: ${yamlString(path.join(output, "generated", "typescript"))}`,
          `        test-dir: ${yamlString(tsDir)}`,
          "        format: false",
          "      - type: Python",
          `        output-dir: ${yamlString(path.join(output, "generated", "python"))}`,
          `        test-dir: ${yamlString(pyDir)}`,
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", source, "--config", config],
        { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );

      const tsSuite = readFileSync(
        path.join(tsDir, "vector-conformance.test.ts"),
        "utf8",
      );
      // The generated suite must carry the guard: the canonical skip reason, the
      // hard-fail for an unregistered token, and the capabilities seam load.
      assert.match(tsSuite, /requirement unavailable: /);
      assert.match(tsSuite, /No capability predicate registered for requirement token/);
      assert.match(tsSuite, /adapterModule\.vectorCapabilities/);

      writeFileSync(
        path.join(tsDir, "vector-conformance.test.js"),
        transpile(tsSuite),
      );
      writeFileSync(path.join(tsDir, "runner.js"), TS_RUNNER);
      writeFileSync(
        path.join(tsDir, "package.json"),
        JSON.stringify({ type: "commonjs" }, null, 2),
      );

      const pySuite = readFileSync(
        path.join(pyDir, "test_vector_conformance.py"),
        "utf8",
      );
      assert.match(pySuite, /VECTOR_CAPABILITIES/);
      assert.match(pySuite, /requirement unavailable: /);

      const writeTsAdapter = (source_: string): void => {
        writeFileSync(path.join(tsDir, "vector-adapters.js"), transpile(source_));
      };
      const writePyAdapter = (source_: string): void => {
        writeFileSync(path.join(pyDir, "vector_adapters.py"), source_);
      };

      // -- scenario 1: capability present => adapter runs => green -------------
      writeTsAdapter(
        TS_ADAPTER.replace(
          "CAPABILITIES_PLACEHOLDER",
          "export const vectorCapabilities = { \"provider:live\": () => true };",
        ),
      );
      const tsPresent = runNode(tsDir);
      assert.equal(
        tsPresent.status,
        0,
        `present-capability TS suite should pass:\n${tsPresent.output}`,
      );
      assert.match(
        tsPresent.output,
        /PASS callable vector conformance > Live\.ping:structure/,
      );
      assert.doesNotMatch(tsPresent.output, /FAIL/);
      assert.doesNotMatch(tsPresent.output, /SKIP/);

      writePyAdapter(
        PY_ADAPTER.replace(
          "CAPABILITIES_PLACEHOLDER",
          'VECTOR_CAPABILITIES = {"provider:live": lambda ctx: True}',
        ),
      );
      const pyPresent = runPytest(pyDir);
      assert.equal(
        pyPresent.status,
        0,
        `present-capability Python suite should pass:\n${pyPresent.output}`,
      );
      assert.match(pyPresent.output, /1 passed/);

      // -- scenario 2: capability absent => clean skip before invoke ----------
      writeTsAdapter(
        TS_ADAPTER.replace(
          "CAPABILITIES_PLACEHOLDER",
          "export const vectorCapabilities = { \"provider:live\": () => false };",
        ),
      );
      const tsAbsent = runNode(tsDir);
      assert.equal(
        tsAbsent.status,
        0,
        `absent-capability TS suite should pass with a skip:\n${tsAbsent.output}`,
      );
      assert.match(
        tsAbsent.output,
        /SKIP Live\.ping:structure \(requirement unavailable: provider:live\)/,
      );
      assert.doesNotMatch(tsAbsent.output, /FAIL/);

      writePyAdapter(
        PY_ADAPTER.replace(
          "CAPABILITIES_PLACEHOLDER",
          'VECTOR_CAPABILITIES = {"provider:live": lambda ctx: False}',
        ),
      );
      const pyAbsent = runPytest(pyDir);
      assert.equal(
        pyAbsent.status,
        0,
        `absent-capability Python suite should skip:\n${pyAbsent.output}`,
      );
      assert.match(pyAbsent.output, /1 skipped/);

      // -- scenario 3: unknown token (no predicate) => hard failure -----------
      writeTsAdapter(
        TS_ADAPTER.replace(
          "CAPABILITIES_PLACEHOLDER",
          "export const vectorCapabilities = {};",
        ),
      );
      const tsUnknown = runNode(tsDir);
      assert.equal(
        tsUnknown.status,
        1,
        `unknown-token TS suite must fail hard:\n${tsUnknown.output}`,
      );
      assert.match(
        tsUnknown.output,
        /No capability predicate registered for requirement token "provider:live"/,
      );

      writePyAdapter(
        PY_ADAPTER.replace(
          "CAPABILITIES_PLACEHOLDER",
          "VECTOR_CAPABILITIES = {}",
        ),
      );
      const pyUnknown = runPytest(pyDir);
      assert.notEqual(
        pyUnknown.status,
        0,
        `unknown-token Python suite must fail hard:\n${pyUnknown.output}`,
      );
      assert.match(
        pyUnknown.output,
        /No capability predicate registered for requirement token "provider:live"/,
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
