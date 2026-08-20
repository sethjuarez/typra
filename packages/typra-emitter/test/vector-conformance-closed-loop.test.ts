// Copyright (c) Microsoft. All rights reserved.

// Executable proof that @vector behavioral conformance is an ENFORCED tier, not
// a tautology. We compile one spec (two contracts of differing character, two
// target languages) once, then replay the generated conformance suites against
// three runtime adapter registries:
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import * as ts from "typescript";

const require = createRequire(import.meta.url);

function yamlString(value: string): string {
  return JSON.stringify(value);
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
].join("\n");

// -- runtime adapter registries authored the way a downstream runtime would ----

const TS_REFERENCE_ADAPTER = [
  "export const vectorAdapters = {",
  '  "Echo.echo": {',
  "    invoke(input) {",
  "      const payload = input.payload;",
  '      if (payload === "") {',
  '        const error = new Error("empty");',
  '        error.typraVector = { code: "empty" };',
  "        throw error;",
  "      }",
  "      return String(payload).toUpperCase();",
  "    },",
  "  },",
  '  "Sum.sum": {',
  "    invoke(input) {",
  "      return input.values.reduce((total, value) => total + value, 0);",
  "    },",
  "  },",
  "};",
  "",
].join("\n");

// Echo only. Sum.sum is deliberately unimplemented.
const TS_ECHO_ONLY_ADAPTER = [
  "export const vectorAdapters = {",
  '  "Echo.echo": {',
  "    invoke(input) {",
  "      const payload = input.payload;",
  '      if (payload === "") {',
  '        const error = new Error("empty");',
  '        error.typraVector = { code: "empty" };',
  "        throw error;",
  "      }",
  "      return String(payload).toUpperCase();",
  "    },",
  "  },",
  "};",
  "VECTOR_WAIVER_PLACEHOLDER",
  "",
].join("\n");

const PY_REFERENCE_ADAPTER = [
  "class _Echo:",
  "    def invoke(self, payload, context):",
  '        value = payload.get("payload")',
  '        if value == "":',
  '            error = RuntimeError("empty")',
  '            error.typra_vector = {"code": "empty"}',
  "            raise error",
  "        return str(value).upper()",
  "",
  "",
  "class _Sum:",
  "    def invoke(self, payload, context):",
  '        return sum(payload["values"])',
  "",
  "",
  'VECTOR_ADAPTERS = {"Echo.echo": _Echo(), "Sum.sum": _Sum()}',
  "",
].join("\n");

const PY_ECHO_ONLY_ADAPTER = [
  "class _Echo:",
  "    def invoke(self, payload, context):",
  '        value = payload.get("payload")',
  '        if value == "":',
  '            error = RuntimeError("empty")',
  '            error.typra_vector = {"code": "empty"}',
  "            raise error",
  "        return str(value).upper()",
  "",
  "",
  'VECTOR_ADAPTERS = {"Echo.echo": _Echo()}',
  "VECTOR_WAIVER_PLACEHOLDER",
  "",
].join("\n");

// Async adapters — invoke() returns an awaitable. Exercises the await-if-awaitable
// unwrap on both the value path (resolves) and the error path (rejects/raises).
const TS_ASYNC_REFERENCE_ADAPTER = [
  "export const vectorAdapters = {",
  '  "Echo.echo": {',
  "    async invoke(input) {",
  "      const payload = input.payload;",
  '      if (payload === "") {',
  '        const error = new Error("empty");',
  '        error.typraVector = { code: "empty" };',
  "        throw error;",
  "      }",
  "      return String(payload).toUpperCase();",
  "    },",
  "  },",
  '  "Sum.sum": {',
  "    invoke(input) {",
  "      return Promise.resolve(input.values.reduce((total, value) => total + value, 0));",
  "    },",
  "  },",
  "};",
  "",
].join("\n");

const PY_ASYNC_REFERENCE_ADAPTER = [
  "class _Echo:",
  "    async def invoke(self, payload, context):",
  '        value = payload.get("payload")',
  '        if value == "":',
  '            error = RuntimeError("empty")',
  '            error.typra_vector = {"code": "empty"}',
  "            raise error",
  "        return str(value).upper()",
  "",
  "",
  "class _Sum:",
  "    async def invoke(self, payload, context):",
  '        return sum(payload["values"])',
  "",
  "",
  'VECTOR_ADAPTERS = {"Echo.echo": _Echo(), "Sum.sum": _Sum()}',
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

describe("@vector conformance is an enforced closed loop", () => {
  it("goes green with a reference adapter, skips with a waiver, and fails hard without one", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-vector-loop-"));
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
          '    root-object: "Typra.Proof.Root"',
          '    root-namespace: "Typra.Proof"',
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

      // Sanity: the generated suite must actually invoke a runtime adapter, not
      // compare vector data to itself.
      const tsSuite = readFileSync(
        path.join(tsDir, "vector-conformance.test.ts"),
        "utf8",
      );
      assert.match(tsSuite, /adapter\.invoke\(input, context\)/);
      assert.match(tsSuite, /No vector adapter registered for/);
      const pySuite = readFileSync(
        path.join(pyDir, "test_vector_conformance.py"),
        "utf8",
      );
      assert.match(pySuite, /_ADAPTER_MODULE = importlib\.import_module/);
      assert.match(pySuite, /def test_vector_0_/);

      // Compile the TS suite + runner once; only the adapter module changes.
      writeFileSync(
        path.join(tsDir, "vector-conformance.test.js"),
        transpile(tsSuite),
      );
      writeFileSync(path.join(tsDir, "runner.js"), TS_RUNNER);
      // The package declares "type": "module"; force CommonJS for these emitted
      // .js files so the shim's require() works (mirrors validate-fixtures).
      writeFileSync(
        path.join(tsDir, "package.json"),
        JSON.stringify({ type: "commonjs" }, null, 2),
      );

      const writeTsAdapter = (source_: string): void => {
        writeFileSync(
          path.join(tsDir, "vector-adapters.js"),
          transpile(source_),
        );
      };
      const writePyAdapter = (source_: string): void => {
        writeFileSync(path.join(pyDir, "vector_adapters.py"), source_);
      };

      // -- scenario 1: reference adapter => everything green --------------------
      writeTsAdapter(TS_REFERENCE_ADAPTER);
      const tsGreen = runNode(tsDir);
      assert.equal(
        tsGreen.status,
        0,
        `reference TS suite should pass:\n${tsGreen.output}`,
      );
      assert.match(tsGreen.output, /PASS callable vector conformance > Echo\.echo:shout/);
      assert.match(tsGreen.output, /PASS callable vector conformance > Echo\.echo:empty/);
      assert.match(tsGreen.output, /PASS callable vector conformance > Sum\.sum:basic/);
      assert.doesNotMatch(tsGreen.output, /FAIL/);

      writePyAdapter(PY_REFERENCE_ADAPTER);
      const pyGreen = runPytest(pyDir);
      assert.equal(
        pyGreen.status,
        0,
        `reference Python suite should pass:\n${pyGreen.output}`,
      );
      assert.match(pyGreen.output, /3 passed/);

      // -- scenario 2: Sum.sum unimplemented but explicitly waived => skip ------
      writeTsAdapter(
        TS_ECHO_ONLY_ADAPTER.replace(
          "VECTOR_WAIVER_PLACEHOLDER",
          'export const vectorWaivers = { "Sum.sum": "runtime pending" };',
        ),
      );
      const tsWaived = runNode(tsDir);
      assert.equal(
        tsWaived.status,
        0,
        `waived TS suite should pass with a visible skip:\n${tsWaived.output}`,
      );
      assert.match(tsWaived.output, /SKIP Sum\.sum:basic \(waived: runtime pending\)/);
      assert.match(tsWaived.output, /PASS callable vector conformance > Echo\.echo:shout/);
      assert.doesNotMatch(tsWaived.output, /FAIL/);

      writePyAdapter(
        PY_ECHO_ONLY_ADAPTER.replace(
          "VECTOR_WAIVER_PLACEHOLDER",
          'VECTOR_WAIVERS = {"Sum.sum": "runtime pending"}',
        ),
      );
      const pyWaived = runPytest(pyDir);
      assert.equal(
        pyWaived.status,
        0,
        `waived Python suite should pass with a skip:\n${pyWaived.output}`,
      );
      assert.match(pyWaived.output, /1 skipped/);

      // -- scenario 3: Sum.sum unimplemented, NO waiver => hard failure ---------
      writeTsAdapter(
        TS_ECHO_ONLY_ADAPTER.replace("VECTOR_WAIVER_PLACEHOLDER", ""),
      );
      const tsRed = runNode(tsDir);
      assert.equal(
        tsRed.status,
        1,
        `unwaived TS suite must fail:\n${tsRed.output}`,
      );
      assert.match(tsRed.output, /FAIL callable vector conformance > Sum\.sum:basic/);
      assert.match(tsRed.output, /No vector adapter registered for Sum\.sum/);

      writePyAdapter(
        PY_ECHO_ONLY_ADAPTER.replace("VECTOR_WAIVER_PLACEHOLDER", ""),
      );
      const pyRed = runPytest(pyDir);
      assert.notEqual(
        pyRed.status,
        0,
        `unwaived Python suite must fail:\n${pyRed.output}`,
      );
      assert.match(pyRed.output, /No vector adapter registered for Sum\.sum/);

      // -- scenario 4: async adapters (awaitable invoke) => everything green ----
      // The exact same generated suite drives adapters whose invoke() returns an
      // awaitable: the value path resolves, and the error path (Echo.echo:empty)
      // rejects and is matched against expectedError just like the sync path.
      writeTsAdapter(TS_ASYNC_REFERENCE_ADAPTER);
      const tsAsync = runNode(tsDir);
      assert.equal(
        tsAsync.status,
        0,
        `async TS adapter suite should pass:\n${tsAsync.output}`,
      );
      assert.match(tsAsync.output, /PASS callable vector conformance > Echo\.echo:shout/);
      assert.match(tsAsync.output, /PASS callable vector conformance > Echo\.echo:empty/);
      assert.match(tsAsync.output, /PASS callable vector conformance > Sum\.sum:basic/);
      assert.doesNotMatch(tsAsync.output, /FAIL/);

      writePyAdapter(PY_ASYNC_REFERENCE_ADAPTER);
      const pyAsync = runPytest(pyDir);
      assert.equal(
        pyAsync.status,
        0,
        `async Python adapter suite should pass:\n${pyAsync.output}`,
      );
      assert.match(pyAsync.output, /3 passed/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  // Executable RED negative for @sync classification enforcement. The SAME
  // generated suite drives two registries: one that honors @sync (Tag.tag wired
  // synchronously) and one that violates it (Tag.tag wired async). The violation
  // must be a hard, distinct failure, while the async-default op (Note.note)
  // stays green in both — proving @sync is enforced, not advisory, and that
  // async-default remains permissive.
  it("enforces @sync: a @sync op wired async fails hard; async-default stays green", () => {
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

    const TS_SYNC_OK = [
      "export const vectorAdapters = {",
      '  "Tag.tag": { invoke(input) { return "TAG:" + input.label; } },',
      '  "Note.note": { async invoke(input) { return input.text + "!"; } },',
      "};",
      "",
    ].join("\n");

    const TS_SYNC_VIOLATION = [
      "export const vectorAdapters = {",
      '  "Tag.tag": { async invoke(input) { return "TAG:" + input.label; } },',
      '  "Note.note": { async invoke(input) { return input.text + "!"; } },',
      "};",
      "",
    ].join("\n");

    const PY_SYNC_OK = [
      "class _Tag:",
      "    def invoke(self, payload, context):",
      '        return "TAG:" + payload["label"]',
      "",
      "",
      "class _Note:",
      "    async def invoke(self, payload, context):",
      '        return payload["text"] + "!"',
      "",
      "",
      'VECTOR_ADAPTERS = {"Tag.tag": _Tag(), "Note.note": _Note()}',
      "",
    ].join("\n");

    const PY_SYNC_VIOLATION = [
      "class _Tag:",
      "    async def invoke(self, payload, context):",
      '        return "TAG:" + payload["label"]',
      "",
      "",
      "class _Note:",
      "    async def invoke(self, payload, context):",
      '        return payload["text"] + "!"',
      "",
      "",
      'VECTOR_ADAPTERS = {"Tag.tag": _Tag(), "Note.note": _Note()}',
      "",
    ].join("\n");

    const output = mkdtempSync(path.join(process.cwd(), "tmp-vector-sync-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const tsDir = path.join(output, "generated", "typescript-tests");
    const pyDir = path.join(output, "generated", "python-tests");
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
      // The generated suite must carry the @sync flag and the enforcement guard.
      assert.match(tsSuite, /entry\.sync && isAwaitable/);
      writeFileSync(
        path.join(tsDir, "vector-conformance.test.js"),
        transpile(tsSuite),
      );
      writeFileSync(path.join(tsDir, "runner.js"), TS_RUNNER);
      writeFileSync(
        path.join(tsDir, "package.json"),
        JSON.stringify({ type: "commonjs" }, null, 2),
      );

      const writeTsAdapter = (source_: string): void => {
        writeFileSync(path.join(tsDir, "vector-adapters.js"), transpile(source_));
      };
      const writePyAdapter = (source_: string): void => {
        writeFileSync(path.join(pyDir, "vector_adapters.py"), source_);
      };

      // -- honoring @sync: Tag.tag sync, Note.note async => all green ----------
      writeTsAdapter(TS_SYNC_OK);
      const tsOk = runNode(tsDir);
      assert.equal(tsOk.status, 0, `@sync-honoring TS suite should pass:\n${tsOk.output}`);
      assert.match(tsOk.output, /PASS callable vector conformance > Tag\.tag:basic/);
      assert.match(tsOk.output, /PASS callable vector conformance > Note\.note:basic/);
      assert.doesNotMatch(tsOk.output, /FAIL/);

      writePyAdapter(PY_SYNC_OK);
      const pyOk = runPytest(pyDir);
      assert.equal(pyOk.status, 0, `@sync-honoring Python suite should pass:\n${pyOk.output}`);
      assert.match(pyOk.output, /2 passed/);

      // -- violating @sync: Tag.tag wired async => hard, distinct failure ------
      // Note.note (async-default) stays green, proving permissive async-default.
      writeTsAdapter(TS_SYNC_VIOLATION);
      const tsBad = runNode(tsDir);
      assert.equal(tsBad.status, 1, `@sync-violating TS suite must fail:\n${tsBad.output}`);
      assert.match(tsBad.output, /FAIL callable vector conformance > Tag\.tag:basic/);
      assert.match(tsBad.output, /operation is @sync but its adapter returned an/);
      assert.match(tsBad.output, /PASS callable vector conformance > Note\.note:basic/);

      writePyAdapter(PY_SYNC_VIOLATION);
      const pyBad = runPytest(pyDir);
      assert.notEqual(pyBad.status, 0, `@sync-violating Python suite must fail:\n${pyBad.output}`);
      assert.match(pyBad.output, /operation is @sync but its adapter/);
      assert.match(pyBad.output, /1 failed, 1 passed/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
