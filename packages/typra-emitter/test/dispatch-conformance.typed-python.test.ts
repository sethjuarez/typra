// Copyright (c) Microsoft. All rights reserved.

// Executable proof that the Part III TYPED per-interface @vector conformance
// (issue #282 §8) is REAL for the runtime-enforced Python target: we compile the
// committed `fixtures/dispatch-seam` spec, then RUN the emitted
// `tests/test_renderer_conformance.py` verbatim — the observable deliverable, not
// a hand-written twin — against a consumer-authored `renderer_provider` conftest
// fixture:
//
//   * positive (control 1) -> a conftest that attaches every @dispatch slot lets
//                 each emitted test route its vector through resolve_renderer to
//                 the typed impl that reproduces `expected`               => PASS
//   * negative (control 2) -> a conftest whose provider DROPS the mustache slot
//                 makes new_renderer_provider raise at fixture setup, so pytest
//                 reports an error naming the missing variant — the forgotten
//                 attachment can never silently skip                      => ERROR
//
// Together these prove the emitted typed conformance file compiles, imports the
// emitted models + resolver, and enforces the provider contract at runtime.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "dispatch-seam",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.DispatchSeam.Root";
// The emitted conformance imports `from fixtures import ...`; the package on
// PYTHONPATH must therefore be named after the fixture's namespace projection.
const PACKAGE = "fixtures";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function uvAvailable(): boolean {
  try {
    execFileSync("uv", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

type RunResult = { status: number; output: string };

function runPytest(dir: string, pythonPath: string): RunResult {
  try {
    const output = execFileSync(
      "uv",
      [
        "run",
        "--python",
        "3.12",
        "--with",
        "pytest",
        "--with",
        "PyYAML",
        "python",
        "-m",
        "pytest",
        "tests",
        "-q",
        "-p",
        "no:cacheprovider",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONPATH: pythonPath },
      },
    );
    return { status: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

// A consumer conftest that attaches every @dispatch slot through the emitted
// collection guard. The renderers are authored OUTSIDE the emitted tree; each
// understands only its own dialect delimiter, read off the TYPED Agent/Inputs.
function conftest(includeMustache: boolean): string {
  const slots = [
    ...(includeMustache ? ["            'mustache': MustacheRenderer(),"] : []),
    "            'jinja2': Jinja2Renderer(),",
    "            'liquid': None,",
  ];
  return [
    "import pytest",
    "",
    `from ${PACKAGE}._renderer_resolver import new_renderer_provider`,
    "",
    "",
    "def substitute(content, values, open_tok, close_tok):",
    "    out = content",
    "    for key, value in values.items():",
    "        out = out.replace(f'{open_tok}{key}{close_tok}', str(value))",
    "    return out",
    "",
    "",
    "class MustacheRenderer:",
    "    def render(self, agent, inputs):",
    "        return substitute(agent.template.content, inputs.values, '{{', '}}')",
    "",
    "",
    "class Jinja2Renderer:",
    "    def render(self, agent, inputs):",
    "        return substitute(agent.template.content, inputs.values, '{{ ', ' }}')",
    "",
    "",
    "@pytest.fixture",
    "def renderer_provider():",
    "    return new_renderer_provider(",
    "        {",
    ...slots,
    "        }",
    "    )",
    "",
  ].join("\n");
}

describe("typed per-interface @vector conformance runs green (Python, issue #282 §8)", () => {
  it("routes the emitted conformance file green; a dropped slot errors at collection", (t) => {
    if (!uvAvailable()) {
      t.skip("uv toolchain not available");
      return;
    }

    const output = mkdtempSync(
      path.join(process.cwd(), "tmp-dispatch-conf-py-"),
    );
    const emitRoot = path.join(output, "generated");
    const pyOut = path.join(emitRoot, "python");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(emitRoot)}`,
          `    root-object: ${yamlString(ROOT_OBJECT)}`,
          "    deterministic-output: true",
          "    emit-targets:",
          "      - type: Python",
          `        output-dir: ${yamlString(pyOut)}`,
          `        test-dir: ${yamlString(path.join(pyOut, "tests"))}`,
          '        import-path: "fixtures"',
          "        format: false",
          '        protocol-scaffolds: "compile-only"',
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", FIXTURE, "--config", config],
        { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );

      const conformance = path.join(
        pyOut,
        "tests",
        "test_renderer_conformance.py",
      );
      const conformanceSrc = readFileSync(conformance, "utf8");
      // The emitted file is typed: it imports the emitted models + resolver and
      // routes on the same discriminator the shape load switch reads.
      assert.match(conformanceSrc, /from fixtures import Agent, Inputs/);
      assert.match(
        conformanceSrc,
        /from fixtures\._renderer_resolver import resolve_renderer/,
      );
      assert.match(conformanceSrc, /kind = agent\.template\.format\.kind/);
      assert.match(
        conformanceSrc,
        /impl = resolve_renderer\(kind, renderer_provider\)/,
      );

      // Assemble a runnable module: the emitted library as an importable package
      // named `fixtures`, plus the EMITTED conformance file under tests/.
      const moduleDir = path.join(output, "module");
      const pkgDir = path.join(moduleDir, PACKAGE);
      const testsDir = path.join(moduleDir, "tests");
      mkdirSync(pkgDir, { recursive: true });
      mkdirSync(testsDir, { recursive: true });
      for (const entry of readdirSync(pyOut)) {
        const src = path.join(pyOut, entry);
        if (statSync(src).isFile()) {
          copyFileSync(src, path.join(pkgDir, entry));
        }
      }
      copyFileSync(
        conformance,
        path.join(testsDir, "test_renderer_conformance.py"),
      );

      const pythonPath = `${moduleDir}${path.delimiter}${testsDir}`;

      // -- positive (control 1) -------------------------------------------------
      writeFileSync(path.join(testsDir, "conftest.py"), conftest(true));
      const green = runPytest(moduleDir, pythonPath);
      assert.equal(
        green.status,
        0,
        `emitted typed conformance should pass:\n${green.output}`,
      );
      assert.match(green.output, /2 passed/);
      assert.doesNotMatch(green.output, /failed/);

      // -- negative (control 2) -------------------------------------------------
      // Drop the mustache slot: new_renderer_provider raises at fixture setup, so
      // the emitted tests error at collection/setup rather than silently skip.
      writeFileSync(path.join(testsDir, "conftest.py"), conftest(false));
      const dropped = runPytest(moduleDir, pythonPath);
      assert.notEqual(
        dropped.status,
        0,
        `a dropped provider slot must fail, not skip:\n${dropped.output}`,
      );
      assert.match(dropped.output, /mustache/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
