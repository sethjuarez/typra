// Copyright (c) Microsoft. All rights reserved.

// Executable proof that Part II-B moved @dispatch routing into the EMITTED code.
//
// The sibling `dispatch-seam.conformance.test.ts` (Part II-A) performs the
// dispatch itself, in-process, from the recorded path — it proves the resolved
// path is correct but never runs emitted glue. This file compiles the committed
// `fixtures/dispatch-seam` spec, then drives the *generated* vector-runner and
// vector-conformance harness against a runtime registry keyed by discriminator
// value:
//
//   * positive   -> the emitted harness passes the resolved dispatch path; each
//                   committed vector routes to its own dialect renderer and
//                   reproduces `expected`                              => GREEN
//   * negative   -> the SAME registry and SAME vectors driven through the SAME
//                   emitted runner with a WRONG path (`agent.name`) misroute to
//                   a decoy and diverge from `expected`                => RED
//
// Only the dispatch path differs between the two runs, so a green positive and a
// red negative together prove the emitted routing is load-bearing, not cosmetic.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import * as ts from "typescript";

import { generate } from "../src/generate.js";

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "dispatch-seam",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.DispatchSeam.Root";

// Runtime-authored registry, keyed by `Contract.operation#<discriminatorValue>`
// exactly as the emitted runner resolves it. Each renderer understands ONLY its
// own dialect's delimiter style, so routing to the wrong key leaves the template
// unsubstituted (output !== expected). The `#greeter` decoy is what the negative
// control's wrong path (`agent.name` === "greeter") resolves to.
const TS_DISPATCH_ADAPTER = [
  "function render(regex, input) {",
  "  const content = input.agent.template.content;",
  "  const values = input.inputs.values;",
  "  return content.replace(regex, (_m, key) => String(values[key]));",
  "}",
  "export const vectorAdapters = {",
  '  "Renderer.render#mustache": {',
  "    invoke(input) { return render(/\\{\\{(\\w+)\\}\\}/g, input); },",
  "  },",
  '  "Renderer.render#jinja2": {',
  "    invoke(input) { return render(/\\{\\{ (\\w+) \\}\\}/g, input); },",
  "  },",
  '  "Renderer.render#greeter": {',
  '    invoke() { return "MISROUTED"; },',
  "  },",
  "};",
  "",
].join("\n");

// Thin jest-shim: run the emitted harness (which passes the resolved dispatch
// path) and report PASS/FAIL per vector.
const TS_POSITIVE_RUNNER = [
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

// Negative control: drive the SAME emitted runner + registry, but replay each
// committed vector with a WRONG dispatch path. Every vector must misroute to the
// decoy and diverge from `expected` (the runner throws on mismatch).
const TS_NEGATIVE_RUNNER = [
  "const { runVector } = require('./vector-runner.js');",
  "const mod = require('./vector-adapters.js');",
  "const adapters = mod.vectorAdapters ?? mod.default ?? {};",
  "const seam = { adapters, waivers: {}, doubles: {}, baseDir: __dirname };",
  "const vectors = require('./vectors-data.json');",
  "async function main() {",
  "  for (const vector of vectors) {",
  "    try {",
  "      await runVector('Renderer', 'render', vector, false, seam, { path: 'agent.name' });",
  "      console.log('ROUTED ' + vector.name);",
  "    } catch (error) {",
  "      console.log('MISROUTE ' + vector.name);",
  "    }",
  "  }",
  "}",
  "main();",
  "",
].join("\n");

// -- Python: same registry, keyed by discriminator value ---------------------

const PY_DISPATCH_ADAPTER = [
  "import re",
  "",
  "",
  "def _render(pattern, input):",
  '    content = input["agent"]["template"]["content"]',
  '    values = input["inputs"]["values"]',
  "    return re.sub(pattern, lambda m: str(values[m.group(1)]), content)",
  "",
  "",
  "class _Mustache:",
  "    def invoke(self, input, context):",
  '        return _render(r"\\{\\{(\\w+)\\}\\}", input)',
  "",
  "",
  "class _Jinja2:",
  "    def invoke(self, input, context):",
  '        return _render(r"\\{\\{ (\\w+) \\}\\}", input)',
  "",
  "",
  "class _Decoy:",
  "    def invoke(self, input, context):",
  '        return "MISROUTED"',
  "",
  "",
  "VECTOR_ADAPTERS = {",
  '    "Renderer.render#mustache": _Mustache(),',
  '    "Renderer.render#jinja2": _Jinja2(),',
  '    "Renderer.render#greeter": _Decoy(),',
  "}",
  "",
].join("\n");

const PY_NEGATIVE_RUNNER = [
  "import asyncio",
  "import json",
  "import os",
  "",
  "from vector_runner import run_vector",
  "import vector_adapters as mod",
  "",
  "seam = {",
  '    "adapters": mod.VECTOR_ADAPTERS,',
  '    "waivers": {},',
  '    "doubles": {},',
  '    "base_dir": os.path.dirname(os.path.abspath(__file__)),',
  "}",
  'with open("vectors-data.json", "r", encoding="utf-8") as handle:',
  "    vectors = json.load(handle)",
  "",
  "",
  "async def main():",
  "    for vector in vectors:",
  "        try:",
  '            await run_vector("Renderer", "render", vector, False, seam, dispatch={"path": "agent.name"})',
  '            print("ROUTED " + vector["name"])',
  "        except Exception:",
  '            print("MISROUTE " + vector["name"])',
  "",
  "",
  "asyncio.run(main())",
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

type RunResult = { status: number; output: string };

function runNode(dir: string, entry: string): RunResult {
  try {
    const output = execFileSync(process.execPath, [entry], {
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

function runUv(dir: string, args: string[]): RunResult {
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

function uvAvailable(): boolean {
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("@dispatch routing is emitted and load-bearing (Part II-B)", () => {
  it("routes committed vectors through the emitted harness; a wrong path misroutes", async () => {
    const output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-emit-"));
    try {
      const result = await generate({
        output,
        source: FIXTURE,
        rootObject: ROOT_OBJECT,
        targets: ["typescript", "python"],
        format: false,
        generateTests: true,
        deterministic: true,
      });
      assert.equal(result.success, true, result.errors?.join("\n"));

      const testDir = path.join(output, "typescript", "tests");
      const harness = readFileSync(
        path.join(testDir, "vector-conformance.test.ts"),
        "utf8",
      );
      const runner = readFileSync(
        path.join(testDir, "vector-runner.ts"),
        "utf8",
      );

      // -- rendered-code lock: the emitted glue actually dispatches by path -----
      assert.match(
        harness,
        /\{ path: "agent\.template\.format\.kind" \}/,
        "emitted harness must pass the resolved @dispatch access path",
      );
      assert.match(
        runner,
        /function resolveDispatchKey\(/,
        "emitted runner must define the discriminator path walker",
      );
      assert.match(
        runner,
        /\$\{operationKey\}#\$\{dispatchKey\}/,
        "emitted runner must look up a per-discriminator composite key",
      );

      // -- compile the emitted runner + harness once ---------------------------
      writeFileSync(
        path.join(testDir, "vector-conformance.test.js"),
        transpile(harness),
      );
      writeFileSync(
        path.join(testDir, "vector-runner.js"),
        transpile(runner),
      );
      writeFileSync(
        path.join(testDir, "vector-adapters.js"),
        transpile(TS_DISPATCH_ADAPTER),
      );
      writeFileSync(path.join(testDir, "positive.js"), TS_POSITIVE_RUNNER);
      writeFileSync(path.join(testDir, "negative.js"), TS_NEGATIVE_RUNNER);
      writeFileSync(
        path.join(testDir, "package.json"),
        JSON.stringify({ type: "commonjs" }, null, 2),
      );

      // Feed the negative driver the committed vectors from the emitted snapshot.
      const snapshot = JSON.parse(
        readFileSync(
          path.join(output, ".typra-generated", "vectors.json"),
          "utf8",
        ),
      ) as { vectors: { vector: Record<string, unknown> }[] };
      writeFileSync(
        path.join(testDir, "vectors-data.json"),
        JSON.stringify(snapshot.vectors.map((entry) => entry.vector)),
      );

      // -- positive: correct path routes each dialect to its own renderer ------
      const positive = runNode(testDir, "positive.js");
      assert.equal(
        positive.status,
        0,
        `dispatched harness should route green:\n${positive.output}`,
      );
      assert.match(
        positive.output,
        /PASS callable vector conformance > Renderer\.render:mustache-basic/,
      );
      assert.match(
        positive.output,
        /PASS callable vector conformance > Renderer\.render:jinja2-basic/,
      );
      assert.doesNotMatch(positive.output, /FAIL/);

      // -- negative control: wrong path misroutes both vectors to the decoy ----
      const negative = runNode(testDir, "negative.js");
      assert.match(
        negative.output,
        /MISROUTE mustache-basic/,
        "a wrong dispatch path must misroute mustache-basic",
      );
      assert.match(
        negative.output,
        /MISROUTE jinja2-basic/,
        "a wrong dispatch path must misroute jinja2-basic",
      );
      assert.doesNotMatch(
        negative.output,
        /ROUTED/,
        "no vector may reproduce `expected` under a wrong dispatch path",
      );

      // == Python: mirror the routing proof against the emitted Python harness ==
      const pyTestDir = path.join(output, "python", "tests");
      const pyHarness = readFileSync(
        path.join(pyTestDir, "test_vector_conformance.py"),
        "utf8",
      );
      const pyRunner = readFileSync(
        path.join(pyTestDir, "vector_runner.py"),
        "utf8",
      );

      // -- rendered-code lock ---------------------------------------------------
      assert.match(
        pyHarness,
        /dispatch=\{"path": "agent\.template\.format\.kind"\}/,
        "emitted Python harness must pass the resolved @dispatch access path",
      );
      assert.match(
        pyRunner,
        /def _resolve_dispatch_key\(/,
        "emitted Python runner must define the discriminator path walker",
      );
      assert.match(
        pyRunner,
        /\{operation_key\}#\{dispatch_key\}/,
        "emitted Python runner must look up a per-discriminator composite key",
      );

      if (uvAvailable()) {
        writeFileSync(
          path.join(pyTestDir, "vector_adapters.py"),
          PY_DISPATCH_ADAPTER,
        );
        writeFileSync(path.join(pyTestDir, "negative.py"), PY_NEGATIVE_RUNNER);
        writeFileSync(
          path.join(pyTestDir, "vectors-data.json"),
          JSON.stringify(snapshot.vectors.map((entry) => entry.vector)),
        );

        // -- positive: emitted harness routes both dialects green ---------------
        const pyPositive = runUv(pyTestDir, [
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
        ]);
        assert.equal(
          pyPositive.status,
          0,
          `dispatched Python harness should route green:\n${pyPositive.output}`,
        );
        assert.match(pyPositive.output, /2 passed/);

        // -- negative control: wrong path misroutes both vectors ----------------
        const pyNegative = runUv(pyTestDir, [
          "run",
          "--python",
          "3.12",
          "--with",
          "pytest",
          "python",
          "negative.py",
        ]);
        assert.match(
          pyNegative.output,
          /MISROUTE mustache-basic/,
          "a wrong dispatch path must misroute mustache-basic (Python)",
        );
        assert.match(
          pyNegative.output,
          /MISROUTE jinja2-basic/,
          "a wrong dispatch path must misroute jinja2-basic (Python)",
        );
        assert.doesNotMatch(
          pyNegative.output,
          /ROUTED/,
          "no Python vector may reproduce `expected` under a wrong dispatch path",
        );
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  // Rendered-code lock for the five targets not driven end-to-end above
  // (TS + Python are proven runnable). Each emitted runner must define the
  // discriminator path-walker and look up a per-discriminator composite key,
  // and each emitted harness must pass the resolved @dispatch access path.
  it("emits @dispatch routing glue for every runtime target", async () => {
    const output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-render-"));
    try {
      const result = await generate({
        output,
        source: FIXTURE,
        rootObject: ROOT_OBJECT,
        targets: [
          "typescript",
          "python",
          "go",
          "java",
          "csharp",
          "rust",
          "swift",
        ],
        format: false,
        generateTests: true,
        deterministic: true,
      });
      assert.equal(result.success, true, result.errors?.join("\n"));

      const read = (...parts: string[]): string =>
        readFileSync(path.join(output, ...parts), "utf8");

      const PATH = "agent.template.format.kind";
      type LangLock = {
        runner: string;
        harness: string;
        helper: RegExp;
        composite: RegExp;
        harnessArg: string;
      };
      const locks: LangLock[] = [
        {
          runner: path.join("typescript", "tests", "vector-runner.ts"),
          harness: path.join("typescript", "tests", "vector-conformance.test.ts"),
          helper: /function resolveDispatchKey\(/,
          composite: /\$\{operationKey\}#\$\{dispatchKey\}/,
          harnessArg: `{ path: "${PATH}" }`,
        },
        {
          runner: path.join("python", "tests", "vector_runner.py"),
          harness: path.join("python", "tests", "test_vector_conformance.py"),
          helper: /def _resolve_dispatch_key\(/,
          composite: /\{operation_key\}#\{dispatch_key\}/,
          harnessArg: `dispatch={"path": "${PATH}"}`,
        },
        {
          runner: path.join("go", "vectorrunner", "vector_runner.go"),
          harness: path.join("go", "tests", "vector_conformance_test.go"),
          helper: /func resolveDispatchKey\(/,
          composite: /operationKey\+"#"\+dispatchKey|operationKey \+ "#" \+ dispatchKey/,
          harnessArg: `, "${PATH}")`,
        },
        {
          runner: path.join("java", "tests", "VectorRunner.java"),
          harness: path.join("java", "tests", "VectorConformanceTests.java"),
          helper: /private static String resolveDispatchKey\(/,
          composite: /operationKey \+ "#" \+ dispatchKey/,
          harnessArg: `, "${PATH}")`,
        },
        {
          runner: path.join("rust", "tests", "vector_runner", "mod.rs"),
          harness: path.join("rust", "tests", "vector_conformance_test.rs"),
          helper: /fn vc_resolve_dispatch_key\(/,
          composite: /\{\}#\{\}", operation_key, dispatch_key/,
          harnessArg: `Some("${PATH}")`,
        },
        {
          runner: path.join("swift", "tests", "VectorRunner.swift"),
          harness: path.join("swift", "tests", "VectorConformanceTests.swift"),
          helper: /func resolveDispatchKey\(/,
          composite: /\\\(operationKey\)#\\\(dispatchKey\)/,
          harnessArg: `dispatchPath: "${PATH}"`,
        },
      ];

      for (const lock of locks) {
        const runner = read(lock.runner);
        const harness = read(lock.harness);
        assert.match(
          runner,
          lock.helper,
          `${lock.runner} must define the @dispatch discriminator path walker`,
        );
        assert.match(
          runner,
          lock.composite,
          `${lock.runner} must look up a per-discriminator composite key`,
        );
        assert.ok(
          harness.includes(lock.harnessArg),
          `${lock.harness} must pass the resolved @dispatch access path (${lock.harnessArg})`,
        );
      }

      // Part III §8: languages migrated to the TYPED resolver rail no longer emit
      // the stringly VectorRunner/VectorConformanceTests monolith for an
      // all-dispatched fixture. Instead they emit a per-interface, typed
      // conformance suite that ROUTES THROUGH the emitted resolver against a
      // consumer-attached provider — the same discriminator the shape reads,
      // now enforced by the compiler rather than a JSON dictionary.
      type TypedLock = {
        conformance: string;
        mustInclude: RegExp[];
        retired: string[];
      };
      const typedLocks: TypedLock[] = [
        {
          conformance: path.join(
            "csharp",
            "tests",
            "RendererConformanceTests.cs",
          ),
          mustInclude: [
            // consumes the emitted resolver, not a stringly composite key
            /RendererResolver\.Resolve\(kind, Provider\(\)\)/,
            // reads the SAME typed discriminator the shape Load switch reads
            /var kind = agent\.Template\.Format\.Kind;/,
            // invokes the typed seam method on the resolved impl
            /await impl!\.RenderAsync\(agent, inputs\)/,
            // provider VALUE is consumer-authored outside the conformance tree
            /VectorProviders\.Renderer\(\)/,
          ],
          retired: [
            path.join("csharp", "tests", "VectorConformanceTests.cs"),
            path.join("csharp", "tests", "VectorRunner.cs"),
          ],
        },
      ];

      for (const lock of typedLocks) {
        const conformance = read(lock.conformance);
        for (const pattern of lock.mustInclude) {
          assert.match(
            conformance,
            pattern,
            `${lock.conformance} must route through the typed resolver rail (${pattern})`,
          );
        }
        for (const retired of lock.retired) {
          assert.ok(
            !existsSync(path.join(output, retired)),
            `${retired} must NOT be emitted once the seam is fully dispatched (typed rail retires the stringly monolith)`,
          );
        }
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
