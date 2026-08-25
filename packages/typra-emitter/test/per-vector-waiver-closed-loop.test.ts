// Copyright (c) Microsoft. All rights reserved.

// Executable proof that the #265 PER-VECTOR waiver gate is a real xfail/xpass
// mechanism on running targets — TypeScript, Python, Go, Rust, Swift, and Java —
// not just rendered text. (C# is covered by per-vector-waiver-closed-loop-csharp.)
//
// One spec: Echo with two vectors, "shout" (expects "HI") and "loud" (expects
// "LO"). The adapter is REGISTERED in every scenario, so this exercises the
// adapter-present path the per-vector lookup added. Three scenarios per target:
//
//   1. divergent + shout waived  -> GREEN, prints XFAIL Echo.echo:shout,
//                                   "loud" still passes normally.
//   2. correct  + shout waived   -> RED, prints XPASS (stale waiver must go).
//   3. divergent + NO waiver     -> RED (hard mismatch failure).
//
// If the loop were open, scenarios 1-3 could not diverge. They do, so the
// per-vector gate is genuinely enforced end to end.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import * as ts from "typescript";

const require = createRequire(import.meta.url);

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function toolAvailable(cmd: string, arg: string): boolean {
  try {
    execFileSync(cmd, [arg], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    // Only a missing executable (ENOENT) counts as "unavailable" → skip. If the
    // tool is installed but its version probe errors, that is a broken toolchain,
    // not an absent one; surface it instead of masquerading as a skip and
    // silently dropping the closed-loop proof (notably under CI).
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Recursively collect every .java file under a root (the emitted model/runtime
// tree, which carries the built-in TypraJson/TypraMaps the harness depends on).
function collectJavaSources(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".java"))
    .map((entry) => path.join(entry.parentPath, entry.name));
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
  '  #{ name: "loud", input: #{ payload: "lo" }, expected: "LO" }',
  "];",
  "",
  "interface Echo {",
  "  @vector(EchoVectors)",
  "  echo(payload: string): string;",
  "}",
  "",
].join("\n");

type RunResult = { status: number; output: string };

function compile(output: string, config: string, source: string): void {
  const compilerEntry = require.resolve("@typespec/compiler");
  const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
  const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
  writeFileSync(source, SPEC);
  writeFileSync(config, output);
  execFileSync(process.execPath, [tspCli, "compile", source, "--config", config], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function targetConfig(gen: string, target: string, extra: string[]): string {
  return [
    "emit:",
    '  - "@typra/emitter"',
    "options:",
    '  "@typra/emitter":',
    `    emitter-output-dir: ${yamlString(gen)}`,
    '    root-object: "Typra.Proof.Root"',
    '    root-namespace: "Typra.Proof"',
    "    emit-targets:",
    `      - type: ${target}`,
    ...extra,
    "        format: false",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

function tsEchoAdapter(divergent: boolean, waiver: string): string {
  const body = divergent
    ? '      if (input.payload === "hi") return input.payload;\n      return String(input.payload).toUpperCase();'
    : "      return String(input.payload).toUpperCase();";
  const waiverLine = waiver
    ? `export const vectorWaivers = { "Echo.echo:shout": ${JSON.stringify(waiver)} };`
    : "";
  return [
    "export const vectorAdapters = {",
    '  "Echo.echo": {',
    "    invoke(input) {",
    body,
    "    },",
    "  },",
    "};",
    waiverLine,
    "",
  ].join("\n");
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

function transpile(code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

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
    return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("per-vector @vector waivers are an enforced xfail/xpass gate (TypeScript)", () => {
  it("xfails a waived divergent vector, xpasses a stale waiver, fails an unwaived divergence", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-pv-ts-"));
    const gen = path.join(output, "generated");
    const tsDir = path.join(gen, "typescript-tests");
    try {
      compile(
        targetConfig(gen, "TypeScript", [
          `        output-dir: ${yamlString(path.join(gen, "typescript"))}`,
          `        test-dir: ${yamlString(tsDir)}`,
        ]),
        path.join(output, "tspconfig.yaml"),
        path.join(output, "main.tsp"),
      );

      const suite = readFileSync(path.join(tsDir, "vector-conformance.test.ts"), "utf8");
      writeFileSync(path.join(tsDir, "vector-conformance.test.js"), transpile(suite));
      const runner = readFileSync(path.join(tsDir, "vector-runner.ts"), "utf8");
      writeFileSync(path.join(tsDir, "vector-runner.js"), transpile(runner));
      writeFileSync(path.join(tsDir, "runner.js"), TS_RUNNER);
      writeFileSync(
        path.join(tsDir, "package.json"),
        JSON.stringify({ type: "commonjs" }, null, 2),
      );
      const writeAdapter = (src: string): void => {
        writeFileSync(path.join(tsDir, "vector-adapters.js"), transpile(src));
      };

      // 1: divergent for shout, shout waived => GREEN with XFAIL.
      writeAdapter(tsEchoAdapter(true, "known divergence"));
      const xfail = runNode(tsDir);
      assert.equal(xfail.status, 0, `waived divergence should xfail green:\n${xfail.output}`);
      assert.match(xfail.output, /XFAIL Echo\.echo:shout \(waived: known divergence\)/);
      assert.match(xfail.output, /PASS callable vector conformance > Echo\.echo:loud/);
      assert.doesNotMatch(xfail.output, /FAIL callable vector conformance/);

      // 2: adapter correct, waiver stale => RED with XPASS.
      writeAdapter(tsEchoAdapter(false, "known divergence"));
      const xpass = runNode(tsDir);
      assert.equal(xpass.status, 1, `stale waiver must xpass red:\n${xpass.output}`);
      assert.match(xpass.output, /XPASS Echo\.echo:shout/);
      assert.match(xpass.output, /FAIL callable vector conformance > Echo\.echo:shout/);

      // 3: divergent for shout, NO waiver => RED (hard mismatch).
      writeAdapter(tsEchoAdapter(true, ""));
      const red = runNode(tsDir);
      assert.equal(red.status, 1, `unwaived divergence must fail:\n${red.output}`);
      assert.match(red.output, /FAIL callable vector conformance > Echo\.echo:shout/);
      assert.doesNotMatch(red.output, /XFAIL Echo\.echo:shout/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function pyEchoAdapter(divergent: boolean, waiver: string): string {
  const body = divergent
    ? [
        '        value = payload.get("payload")',
        '        if value == "hi":',
        "            return value",
        "        return str(value).upper()",
      ]
    : ['        return str(payload.get("payload")).upper()'];
  const waiverLine = waiver
    ? `VECTOR_WAIVERS = {"Echo.echo:shout": ${JSON.stringify(waiver)}}`
    : "";
  return [
    "class _Echo:",
    "    def invoke(self, payload, context):",
    ...body,
    "",
    "",
    'VECTOR_ADAPTERS = {"Echo.echo": _Echo()}',
    waiverLine,
    "",
  ].join("\n");
}

function runPytest(dir: string): RunResult {
  const args = [
    "run", "--python", "3.12", "--with", "pytest", "--with", "pytest-asyncio",
    "python", "-m", "pytest", "test_vector_conformance.py", "-q", "-s",
    "-p", "no:cacheprovider",
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
    return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("per-vector @vector waivers are an enforced xfail/xpass gate (Python)", () => {
  it("xfails a waived divergent vector, xpasses a stale waiver, fails an unwaived divergence", (t) => {
    if (!toolAvailable("uv", "--version")) {
      t.skip("uv toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-pv-py-"));
    const gen = path.join(output, "generated");
    const pyDir = path.join(gen, "python-tests");
    try {
      compile(
        targetConfig(gen, "Python", [
          `        output-dir: ${yamlString(path.join(gen, "python"))}`,
          `        test-dir: ${yamlString(pyDir)}`,
        ]),
        path.join(output, "tspconfig.yaml"),
        path.join(output, "main.tsp"),
      );

      const writeAdapter = (src: string): void => {
        writeFileSync(path.join(pyDir, "vector_adapters.py"), src);
      };

      // 1: divergent for shout, shout waived => GREEN with XFAIL.
      writeAdapter(pyEchoAdapter(true, "known divergence"));
      const xfail = runPytest(pyDir);
      assert.equal(xfail.status, 0, `waived divergence should xfail green:\n${xfail.output}`);
      assert.match(xfail.output, /XFAIL Echo\.echo:shout \(waived: known divergence\)/);
      assert.match(xfail.output, /2 passed/);

      // 2: adapter correct, waiver stale => RED with XPASS.
      writeAdapter(pyEchoAdapter(false, "known divergence"));
      const xpass = runPytest(pyDir);
      assert.notEqual(xpass.status, 0, `stale waiver must xpass red:\n${xpass.output}`);
      assert.match(xpass.output, /XPASS Echo\.echo:shout/);
      assert.match(xpass.output, /1 failed/);

      // 3: divergent for shout, NO waiver => RED (hard mismatch).
      writeAdapter(pyEchoAdapter(true, ""));
      const red = runPytest(pyDir);
      assert.notEqual(red.status, 0, `unwaived divergence must fail:\n${red.output}`);
      assert.match(red.output, /1 failed/);
      assert.doesNotMatch(red.output, /XFAIL Echo\.echo:shout/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_COMMON = [
  "package vectoradapters",
  "",
  'import "strings"',
  "",
  "type Context struct {",
  "\tContract  string",
  "\tOperation string",
  "\tVector    map[string]any",
  "\tProvider  string",
  "\tTargetAPI string",
  "\tDoubles   map[string]any",
  "\tBaseDir   string",
  "}",
  "",
  "type Adapter struct {",
  "\tInvoke    func(input any, ctx Context) (any, error)",
  "\tNormalize func(value any, ctx Context) any",
  "}",
  "",
  "var VectorDoubles = map[string]any{}",
  "",
];

function goEchoAdapter(divergent: boolean, waiver: string): string {
  const invoke = divergent
    ? [
        "func echoInvoke(input any, _ Context) (any, error) {",
        "\tm, _ := input.(map[string]any)",
        '\tpayload, _ := m["payload"].(string)',
        '\tif payload == "hi" {',
        "\t\treturn payload, nil",
        "\t}",
        "\treturn strings.ToUpper(payload), nil",
        "}",
      ]
    : [
        "func echoInvoke(input any, _ Context) (any, error) {",
        "\tm, _ := input.(map[string]any)",
        '\tpayload, _ := m["payload"].(string)',
        "\treturn strings.ToUpper(payload), nil",
        "}",
      ];
  const waiverEntry = waiver ? `"Echo.echo:shout": ${JSON.stringify(waiver)}` : "";
  return [
    ...GO_COMMON,
    ...invoke,
    "",
    `var VectorWaivers = map[string]string{${waiverEntry}}`,
    "",
    "var VectorAdapters = map[string]Adapter{",
    '\t"Echo.echo": {Invoke: echoInvoke},',
    "}",
    "",
  ].join("\n");
}

function runGoTest(moduleDir: string): RunResult {
  try {
    const output = execFileSync("go", ["test", "-v", "-count=1", "./conformance/"], {
      cwd: moduleDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("per-vector @vector waivers are an enforced xfail/xpass gate (Go)", () => {
  it("xfails a waived divergent vector, xpasses a stale waiver, fails an unwaived divergence", (t) => {
    if (!toolAvailable("go", "version")) {
      t.skip("go toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-pv-go-"));
    const gen = path.join(output, "generated");
    const goTestDir = path.join(gen, "go-tests");
    try {
      compile(
        targetConfig(gen, "Go", [
          `        output-dir: ${yamlString(path.join(gen, "go"))}`,
          `        test-dir: ${yamlString(goTestDir)}`,
          '        import-path: "typraproof"',
          '        vector-adapter-path: "typraproof/vectoradapters"',
        ]),
        path.join(output, "tspconfig.yaml"),
        path.join(output, "main.tsp"),
      );

      const goSuite = readFileSync(path.join(goTestDir, "vector_conformance_test.go"), "utf8");
      const goRunner = readFileSync(
        path.join(gen, "go", "vectorrunner", "vector_runner.go"),
        "utf8",
      );
      const moduleDir = path.join(output, "module");
      const confDir = path.join(moduleDir, "conformance");
      const runnerDir = path.join(moduleDir, "vectorrunner");
      const adapterDir = path.join(moduleDir, "vectoradapters");
      mkdirSync(confDir, { recursive: true });
      mkdirSync(runnerDir, { recursive: true });
      mkdirSync(adapterDir, { recursive: true });
      writeFileSync(path.join(moduleDir, "go.mod"), "module typraproof\n\ngo 1.22\n");
      writeFileSync(path.join(confDir, "vector_conformance_test.go"), goSuite);
      writeFileSync(path.join(runnerDir, "vector_runner.go"), goRunner);
      const writeAdapter = (src: string): void => {
        writeFileSync(path.join(adapterDir, "adapters.go"), src);
      };

      // 1: divergent for shout, shout waived => GREEN with XFAIL.
      writeAdapter(goEchoAdapter(true, "known divergence"));
      const xfail = runGoTest(moduleDir);
      assert.equal(xfail.status, 0, `waived divergence should xfail green:\n${xfail.output}`);
      assert.match(xfail.output, /XFAIL Echo\.echo:shout \(waived: known divergence\)/);
      assert.match(xfail.output, /--- PASS: TestVector\d+EchoEchoLoud/);
      assert.doesNotMatch(xfail.output, /--- FAIL/);

      // 2: adapter correct, waiver stale => RED with XPASS.
      writeAdapter(goEchoAdapter(false, "known divergence"));
      const xpass = runGoTest(moduleDir);
      assert.equal(xpass.status, 1, `stale waiver must xpass red:\n${xpass.output}`);
      assert.match(xpass.output, /XPASS Echo\.echo:shout/);
      assert.match(xpass.output, /--- FAIL: TestVector\d+EchoEchoShout/);

      // 3: divergent for shout, NO waiver => RED (hard mismatch).
      writeAdapter(goEchoAdapter(true, ""));
      const red = runGoTest(moduleDir);
      assert.equal(red.status, 1, `unwaived divergence must fail:\n${red.output}`);
      assert.match(red.output, /--- FAIL: TestVector\d+EchoEchoShout/);
      assert.doesNotMatch(red.output, /XFAIL Echo\.echo:shout/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const RUST_COMMON = [
  "#![allow(dead_code, unused_variables, clippy::all)]",
  "",
  "use serde_json::{json, Value};",
  "use std::collections::HashMap;",
  "use std::future::Future;",
  "use std::pin::Pin;",
  "",
  "#[derive(Clone)]",
  "pub struct Context {",
  "    pub contract: String,",
  "    pub operation: String,",
  "    pub vector: Value,",
  "    pub provider: Option<String>,",
  "    pub target_api: Option<String>,",
  "    pub doubles: Value,",
  "    pub base_dir: String,",
  "}",
  "",
  "pub struct VectorError {",
  "    pub message: String,",
  "    pub payload: Option<Value>,",
  "}",
  "",
  "pub type BoxFuture = Pin<Box<dyn Future<Output = Result<Value, VectorError>>>>;",
  "",
  "pub enum Invoke {",
  "    Sync(fn(&Value, &Context) -> Result<Value, VectorError>),",
  "    Async(Box<dyn Fn(&Value, &Context) -> BoxFuture>),",
  "}",
  "",
  "pub struct Adapter {",
  "    pub invoke: Invoke,",
  "    pub normalize: Option<fn(&Value, &Context) -> Value>,",
  "}",
  "",
  "impl Adapter {",
  "    pub fn sync(invoke: fn(&Value, &Context) -> Result<Value, VectorError>) -> Self {",
  "        Self { invoke: Invoke::Sync(invoke), normalize: None }",
  "    }",
  "}",
  "",
  "pub fn doubles() -> Value {",
  "    json!({})",
  "}",
  "",
];

function rustEchoAdapter(divergent: boolean, waiver: string): string {
  const invoke = divergent
    ? [
        "fn echo_invoke(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {",
        '    let payload = input.get("payload").and_then(|v| v.as_str()).unwrap_or("");',
        '    if payload == "hi" {',
        "        return Ok(Value::String(payload.to_string()));",
        "    }",
        "    Ok(Value::String(payload.to_uppercase()))",
        "}",
      ]
    : [
        "fn echo_invoke(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {",
        '    let payload = input.get("payload").and_then(|v| v.as_str()).unwrap_or("");',
        "    Ok(Value::String(payload.to_uppercase()))",
        "}",
      ];
  const waiversBody = waiver
    ? [
        "    let mut map = HashMap::new();",
        `    map.insert("Echo.echo:shout", ${JSON.stringify(waiver)});`,
        "    map",
      ]
    : ["    HashMap::new()"];
  return [
    ...RUST_COMMON,
    ...invoke,
    "",
    "pub fn waivers() -> HashMap<&'static str, &'static str> {",
    ...waiversBody,
    "}",
    "",
    "pub fn adapters() -> HashMap<&'static str, Adapter> {",
    "    let mut map = HashMap::new();",
    '    map.insert("Echo.echo", Adapter::sync(echo_invoke));',
    "    map",
    "}",
    "",
  ].join("\n");
}

function runCargoTest(moduleDir: string, targetDir: string): RunResult {
  try {
    const output = execFileSync("cargo", ["test", "--", "--nocapture"], {
      cwd: moduleDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RUSTFLAGS: "-D warnings", CARGO_TARGET_DIR: targetDir },
    });
    return { status: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("per-vector @vector waivers are an enforced xfail/xpass gate (Rust)", () => {
  it("xfails a waived divergent vector, xpasses a stale waiver, fails an unwaived divergence", (t) => {
    if (!toolAvailable("cargo", "--version")) {
      t.skip("cargo toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-pv-rust-"));
    const gen = path.join(output, "generated");
    const rustTestDir = path.join(gen, "rust-tests");
    try {
      compile(
        targetConfig(gen, "Rust", [
          `        output-dir: ${yamlString(path.join(gen, "rust"))}`,
          `        test-dir: ${yamlString(rustTestDir)}`,
          '        vector-adapter-path: "vector_adapters.rs"',
        ]),
        path.join(output, "tspconfig.yaml"),
        path.join(output, "main.tsp"),
      );

      const rustSuite = readFileSync(path.join(rustTestDir, "vector_conformance_test.rs"), "utf8");
      const moduleDir = path.join(output, "module");
      const testsDir = path.join(moduleDir, "tests");
      const targetDir = path.join(output, "cargo-target");
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        path.join(moduleDir, "Cargo.toml"),
        [
          "[package]",
          'name = "typraproof"',
          'version = "0.0.0"',
          'edition = "2021"',
          "",
          "[lib]",
          'path = "lib.rs"',
          "",
          "[dependencies]",
          'serde_json = "1"',
          "",
          "[dev-dependencies]",
          'tokio = { version = "1", features = ["macros", "rt"] }',
          "",
        ].join("\n"),
      );
      writeFileSync(path.join(moduleDir, "lib.rs"), "");
      writeFileSync(path.join(testsDir, "vector_conformance_test.rs"), rustSuite);
      const writeAdapter = (src: string): void => {
        writeFileSync(path.join(testsDir, "vector_adapters.rs"), src);
      };

      // 1: divergent for shout, shout waived => GREEN with XFAIL.
      writeAdapter(rustEchoAdapter(true, "known divergence"));
      const xfail = runCargoTest(moduleDir, targetDir);
      assert.equal(xfail.status, 0, `waived divergence should xfail green:\n${xfail.output}`);
      assert.match(xfail.output, /XFAIL Echo\.echo:shout \(waived: known divergence\)/);
      assert.match(xfail.output, /test test_vector_\d+_echo_echo_loud \.\.\. ok/);
      assert.doesNotMatch(xfail.output, /\bFAILED\b/);

      // 2: adapter correct, waiver stale => RED with XPASS.
      writeAdapter(rustEchoAdapter(false, "known divergence"));
      const xpass = runCargoTest(moduleDir, targetDir);
      assert.notEqual(xpass.status, 0, `stale waiver must xpass red:\n${xpass.output}`);
      assert.match(xpass.output, /XPASS Echo\.echo:shout/);
      assert.match(xpass.output, /test test_vector_\d+_echo_echo_shout \.\.\. FAILED/);

      // 3: divergent for shout, NO waiver => RED (hard mismatch).
      writeAdapter(rustEchoAdapter(true, ""));
      const red = runCargoTest(moduleDir, targetDir);
      assert.notEqual(red.status, 0, `unwaived divergence must fail:\n${red.output}`);
      assert.match(red.output, /test test_vector_\d+_echo_echo_shout \.\.\. FAILED/);
      assert.doesNotMatch(red.output, /XFAIL Echo\.echo:shout/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Swift
// ---------------------------------------------------------------------------

function swiftEchoAdapter(divergent: boolean, waivers: string): string {
  const body = divergent
    ? ['    if payload == "hi" { return payload }', "    return payload.uppercased()"]
    : ["    return payload.uppercased()"];
  return [
    "import Foundation",
    "",
    "enum VectorAdapters {",
    "  static func adapters() -> [String: VectorAdapter] {",
    "    var m: [String: VectorAdapter] = [:]",
    // Echo is async-default, so a sync adapter is permitted (permissive path).
    '    m["Echo.echo"] = VectorAdapter(sync: echoInvoke)',
    "    return m",
    "  }",
    "",
    `  static func waivers() -> [String: String] { return ${waivers} }`,
    "  static func doubles() -> Any? { return nil }",
    "",
    "  static func echoInvoke(_ input: Any?, _ ctx: VectorContext) throws -> Any? {",
    '    let payload = (input as? [String: Any])?["payload"] as? String ?? ""',
    ...body,
    "  }",
    "}",
    "",
  ].join("\n");
}

describe("per-vector @vector waivers are an enforced xfail/xpass gate (Swift)", () => {
  it("xfails a waived divergent vector, xpasses a stale waiver, fails an unwaived divergence", (t) => {
    if (!toolAvailable("swift", "--version")) {
      t.skip("swift toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-pv-swift-"));
    const gen = path.join(output, "generated");
    const swiftOut = path.join(gen, "swift");
    const swiftTestDir = path.join(swiftOut, "Tests", "TypraProofTests");
    try {
      compile(
        targetConfig(gen, "Swift", [
          `        output-dir: ${yamlString(swiftOut)}`,
          `        test-dir: ${yamlString(swiftTestDir)}`,
          '        package-name: "TypraProof"',
        ]),
        path.join(output, "tspconfig.yaml"),
        path.join(output, "main.tsp"),
      );

      const swiftSuite = readFileSync(
        path.join(swiftTestDir, "VectorConformanceTests.swift"),
        "utf8",
      );

      // Assemble a self-contained SwiftPM package: the generated suite plus the
      // runtime adapter, compiled side by side with no external dependencies.
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
      writeFileSync(path.join(libDir, "Anchor.swift"), "public func typraProofAnchor() {}\n");
      writeFileSync(path.join(testTargetDir, "VectorConformanceTests.swift"), swiftSuite);

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
          return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
        }
      };

      // 1: divergent for shout, shout waived => GREEN with XFAIL.
      const xfail = run(swiftEchoAdapter(true, '["Echo.echo:shout": "known divergence"]'));
      assert.equal(xfail.status, 0, `waived divergence should xfail green:\n${xfail.output}`);
      assert.match(xfail.output, /XFAIL Echo\.echo:shout \(waived: known divergence\)/);
      assert.match(xfail.output, /PASS Echo\.echo:loud/);
      // XFAIL contains the substring "FAIL ", so match a FAIL only at line start.
      assert.doesNotMatch(xfail.output, /^FAIL /m);

      // 2: adapter correct, waiver stale => RED with XPASS.
      const xpass = run(swiftEchoAdapter(false, '["Echo.echo:shout": "known divergence"]'));
      assert.notEqual(xpass.status, 0, `stale waiver must xpass red:\n${xpass.output}`);
      assert.match(xpass.output, /XPASS Echo\.echo:shout/);

      // 3: divergent for shout, NO waiver => RED (hard mismatch).
      const red = run(swiftEchoAdapter(true, "[:]"));
      assert.notEqual(red.status, 0, `unwaived divergence must fail:\n${red.output}`);
      assert.match(red.output, /^FAIL Echo\.echo:shout:/m);
      assert.doesNotMatch(red.output, /XFAIL Echo\.echo:shout/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

function javaEchoAdapter(divergent: boolean, waiverEntries: string[]): string {
  const body = divergent
    ? [
        '    if (payload.equals("hi")) { return payload; }',
        "    return payload.toUpperCase(Locale.ROOT);",
      ]
    : ["    return payload.toUpperCase(Locale.ROOT);"];
  return [
    "package typra.proof.adapters;",
    "",
    "import java.util.HashMap;",
    "import java.util.Locale;",
    "import java.util.Map;",
    "import typra.proof.VectorConformanceTests.VectorAdapter;",
    "import typra.proof.VectorConformanceTests.VectorContext;",
    "",
    "public final class VectorAdapters {",
    "  private VectorAdapters() { }",
    "",
    "  private static Object field(Object value, String key) {",
    "    return value instanceof Map<?, ?> map ? map.get(key) : null;",
    "  }",
    "",
    "  // Sync adapter (plain Object return): Echo is async-default, so a synchronous",
    "  // adapter is permitted. Diverges only for the \"hi\" payload when `divergent`.",
    "  private static Object echoInvoke(Object input, VectorContext ctx) {",
    '    Object raw = field(input, "payload");',
    '    String payload = raw instanceof String s ? s : "";',
    ...body,
    "  }",
    "",
    "  public static Map<String, VectorAdapter> adapters() {",
    "    Map<String, VectorAdapter> m = new HashMap<>();",
    '    m.put("Echo.echo", new VectorAdapter(VectorAdapters::echoInvoke));',
    "    return m;",
    "  }",
    "",
    "  public static Map<String, String> waivers() {",
    "    Map<String, String> w = new HashMap<>();",
    ...waiverEntries,
    "    return w;",
    "  }",
    "",
    "  public static Object doubles() { return null; }",
    "}",
    "",
  ].join("\n");
}

describe("per-vector @vector waivers are an enforced xfail/xpass gate (Java)", () => {
  it("xfails a waived divergent vector, xpasses a stale waiver, fails an unwaived divergence", (t) => {
    if (!toolAvailable("javac", "-version") || !toolAvailable("java", "-version")) {
      t.skip("java toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-pv-java-"));
    const gen = path.join(output, "generated");
    const javaOut = path.join(gen, "java");
    const javaTestDir = path.join(gen, "java-tests");
    try {
      compile(
        targetConfig(gen, "Java", [
          `        output-dir: ${yamlString(javaOut)}`,
          `        test-dir: ${yamlString(javaTestDir)}`,
          '        package-name: "typra.proof"',
          '        native-serialization: "none"',
          `        vector-adapter-path: ${yamlString("typra.proof.adapters.VectorAdapters")}`,
        ]),
        path.join(output, "tspconfig.yaml"),
        path.join(output, "main.tsp"),
      );

      // Compile the emitted model/runtime tree (built-in TypraJson/TypraMaps), the
      // generated harness, the runtime adapter, and a tiny Main that drives run().
      const modelSources = collectJavaSources(javaOut);
      const harnessPath = path.join(javaTestDir, "VectorConformanceTests.java");
      const srcDir = path.join(output, "src");
      const classesDir = path.join(output, "classes");
      mkdirSync(srcDir, { recursive: true });
      const mainPath = path.join(srcDir, "Main.java");
      writeFileSync(
        mainPath,
        [
          "public final class Main {",
          "  public static void main(String[] args) {",
          "    try {",
          "      typra.proof.VectorConformanceTests.run();",
          '      System.out.println("SUITE OK");',
          "    } catch (Throwable t) {",
          '      System.out.println("SUITE FAILED: " + t.getMessage());',
          "      System.exit(1);",
          "    }",
          "  }",
          "}",
          "",
        ].join("\n"),
      );

      const adapterPath = path.join(srcDir, "VectorAdapters.java");
      const run = (adapterSrc: string): RunResult => {
        writeFileSync(adapterPath, adapterSrc);
        rmSync(classesDir, { recursive: true, force: true });
        mkdirSync(classesDir, { recursive: true });
        const sources = [...modelSources, harnessPath, adapterPath, mainPath];
        try {
          execFileSync("javac", ["-Xlint:all", "-Werror", "-d", classesDir, ...sources], {
            cwd: output,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          const err = error as { stdout?: string; stderr?: string };
          return { status: 1, output: `javac failed:\n${err.stdout ?? ""}${err.stderr ?? ""}` };
        }
        try {
          const out = execFileSync("java", ["-cp", classesDir, "Main"], {
            cwd: output,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          return { status: 0, output: out };
        } catch (error) {
          const err = error as { status?: number; stdout?: string; stderr?: string };
          return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
        }
      };

      // 1: divergent for shout, shout waived => GREEN with XFAIL.
      const xfail = run(javaEchoAdapter(true, ['    w.put("Echo.echo:shout", "known divergence");']));
      assert.equal(xfail.status, 0, `waived divergence should xfail green:\n${xfail.output}`);
      assert.match(xfail.output, /SUITE OK/);
      assert.match(xfail.output, /XFAIL Echo\.echo:shout \(waived: known divergence\)/);
      assert.match(xfail.output, /PASS Echo\.echo:loud/);
      // XFAIL contains the substring "FAIL ", so match a FAIL only at line start.
      assert.doesNotMatch(xfail.output, /^FAIL /m);

      // 2: adapter correct, waiver stale => RED with XPASS.
      const xpass = run(javaEchoAdapter(false, ['    w.put("Echo.echo:shout", "known divergence");']));
      assert.notEqual(xpass.status, 0, `stale waiver must xpass red:\n${xpass.output}`);
      assert.match(xpass.output, /XPASS Echo\.echo:shout/);
      assert.match(xpass.output, /SUITE FAILED/);

      // 3: divergent for shout, NO waiver => RED (hard mismatch).
      const red = run(javaEchoAdapter(true, []));
      assert.notEqual(red.status, 0, `unwaived divergence must fail:\n${red.output}`);
      assert.match(red.output, /^FAIL Echo\.echo:shout:/m);
      assert.doesNotMatch(red.output, /XFAIL Echo\.echo:shout/);
      assert.match(red.output, /SUITE FAILED/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
