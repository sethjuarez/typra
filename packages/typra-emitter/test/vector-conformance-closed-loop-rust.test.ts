// Copyright (c) Microsoft. All rights reserved.

// Executable proof that @vector behavioral conformance is an ENFORCED tier for
// the Rust target, not a tautology. We compile one spec (two contracts of
// differing character) once, then replay the generated `cargo test` conformance
// suite against three runtime adapter registries:
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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function cargoAvailable(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
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
  "    pub fn asynchronous<F, Fut>(invoke: F) -> Self",
  "    where",
  "        F: Fn(&Value, &Context) -> Fut + 'static,",
  "        Fut: Future<Output = Result<Value, VectorError>> + 'static,",
  "    {",
  "        Self {",
  "            invoke: Invoke::Async(Box::new(move |input, ctx| Box::pin(invoke(input, ctx)))),",
  "            normalize: None,",
  "        }",
  "    }",
  "}",
  "",
  "// Async adapter: an async fn that awaits inside the harness's live tokio",
  "// runtime, proving the adapter may drive real async work, not just a ready value.",
  "async fn echo_invoke(input: Value, _ctx: Context) -> Result<Value, VectorError> {",
  "    tokio::task::yield_now().await;",
  '    let payload = input.get("payload").and_then(|v| v.as_str()).unwrap_or("");',
  "    if payload.is_empty() {",
  "        return Err(VectorError {",
  '            message: "empty".to_string(),',
  '            payload: Some(json!({ "code": "empty" })),',
  "        });",
  "    }",
  "    Ok(Value::String(payload.to_uppercase()))",
  "}",
  "",
  "// Sync adapters: bare `fn`, no async ceremony, no boxing.",
  "fn sum_invoke(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {",
  '    let values = input.get("values").and_then(|v| v.as_array()).cloned().unwrap_or_default();',
  "    let total: i64 = values.iter().filter_map(|v| v.as_i64()).sum();",
  "    Ok(json!(total))",
  "}",
  "",
  "fn note_invoke(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {",
  '    let text = input.get("text").and_then(|v| v.as_str()).unwrap_or("");',
  '    Ok(Value::String(format!("{}!", text)))',
  "}",
  "",
  "pub fn doubles() -> Value {",
  "    json!({})",
  "}",
  "",
];

const RUST_REFERENCE_ADAPTER = [
  ...RUST_COMMON,
  "pub fn waivers() -> HashMap<&'static str, &'static str> {",
  "    HashMap::new()",
  "}",
  "",
  "pub fn adapters() -> HashMap<&'static str, Adapter> {",
  "    let mut map = HashMap::new();",
  '    map.insert("Echo.echo", Adapter::asynchronous(|input, ctx| echo_invoke(input.clone(), ctx.clone())));',
  '    map.insert("Sum.sum", Adapter::sync(sum_invoke));',
  '    map.insert("Note.note", Adapter::sync(note_invoke));',
  "    map",
  "}",
  "",
].join("\n");

// Echo only. Sum.sum is deliberately unimplemented. sum_invoke stays defined but
// unreferenced — the file's crate-level allow(dead_code) tolerates it.
function rustEchoOnlyAdapter(waiverInsert: string): string {
  const waiversBody = waiverInsert
    ? [
        "    let mut map = HashMap::new();",
        waiverInsert,
        "    map",
      ]
    : ["    HashMap::new()"];
  return [
    ...RUST_COMMON,
    "pub fn waivers() -> HashMap<&'static str, &'static str> {",
    ...waiversBody,
    "}",
    "",
    "pub fn adapters() -> HashMap<&'static str, Adapter> {",
    "    let mut map = HashMap::new();",
    '    map.insert("Echo.echo", Adapter::asynchronous(|input, ctx| echo_invoke(input.clone(), ctx.clone())));',
    '    map.insert("Note.note", Adapter::sync(note_invoke));',
    "    let _ = sum_invoke;",
    "    map",
    "}",
    "",
  ].join("\n");
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

const RUST_SYNC_COMMON = [
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
  "    pub fn asynchronous<F, Fut>(invoke: F) -> Self",
  "    where",
  "        F: Fn(&Value, &Context) -> Fut + 'static,",
  "        Fut: Future<Output = Result<Value, VectorError>> + 'static,",
  "    {",
  "        Self {",
  "            invoke: Invoke::Async(Box::new(move |input, ctx| Box::pin(invoke(input, ctx)))),",
  "            normalize: None,",
  "        }",
  "    }",
  "}",
  "",
  "// A @sync op wired synchronously: a bare `fn`.",
  "fn tag_sync(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {",
  '    let label = input.get("label").and_then(|v| v.as_str()).unwrap_or("");',
  '    Ok(Value::String(format!("TAG:{}", label)))',
  "}",
  "",
  "// The same op wired asynchronously — the classification violation under test.",
  "async fn tag_async(input: Value, _ctx: Context) -> Result<Value, VectorError> {",
  "    tokio::task::yield_now().await;",
  '    let label = input.get("label").and_then(|v| v.as_str()).unwrap_or("");',
  '    Ok(Value::String(format!("TAG:{}", label)))',
  "}",
  "",
  "// An async-default op wired asynchronously — permissive, must stay green.",
  "async fn note_async(input: Value, _ctx: Context) -> Result<Value, VectorError> {",
  "    tokio::task::yield_now().await;",
  '    let text = input.get("text").and_then(|v| v.as_str()).unwrap_or("");',
  '    Ok(Value::String(format!("{}!", text)))',
  "}",
  "",
  "pub fn doubles() -> Value {",
  "    json!({})",
  "}",
  "",
  "pub fn waivers() -> HashMap<&'static str, &'static str> {",
  "    HashMap::new()",
  "}",
  "",
];

// @sync honored: Tag.tag sync, Note.note async => all green.
const RUST_SYNC_OK_ADAPTER = [
  ...RUST_SYNC_COMMON,
  "pub fn adapters() -> HashMap<&'static str, Adapter> {",
  "    let mut map = HashMap::new();",
  '    map.insert("Tag.tag", Adapter::sync(tag_sync));',
  '    map.insert("Note.note", Adapter::asynchronous(|input, ctx| note_async(input.clone(), ctx.clone())));',
  "    let _ = tag_async;",
  "    map",
  "}",
  "",
].join("\n");

// @sync violated: Tag.tag registered Invoke::Async => hard classification failure.
const RUST_SYNC_VIOLATION_ADAPTER = [
  ...RUST_SYNC_COMMON,
  "pub fn adapters() -> HashMap<&'static str, Adapter> {",
  "    let mut map = HashMap::new();",
  '    map.insert("Tag.tag", Adapter::asynchronous(|input, ctx| tag_async(input.clone(), ctx.clone())));',
  '    map.insert("Note.note", Adapter::asynchronous(|input, ctx| note_async(input.clone(), ctx.clone())));',
  "    let _ = tag_sync;",
  "    map",
  "}",
  "",
].join("\n");

type RunResult = { status: number; output: string };

function runCargoTest(moduleDir: string, targetDir: string): RunResult {
  try {
    const output = execFileSync(
      "cargo",
      ["test", "--", "--nocapture"],
      {
        cwd: moduleDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          RUSTFLAGS: "-D warnings",
          CARGO_TARGET_DIR: targetDir,
        },
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

describe("@vector conformance is an enforced closed loop (Rust)", () => {
  it("goes green with a reference adapter, skips with a waiver, and fails hard without one", (t) => {
    if (!cargoAvailable()) {
      t.skip("cargo toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-vector-rust-loop-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const rustOut = path.join(output, "generated", "rust");
    const rustTestDir = path.join(output, "generated", "rust-tests");
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
          "      - type: Rust",
          `        output-dir: ${yamlString(rustOut)}`,
          `        test-dir: ${yamlString(rustTestDir)}`,
          '        vector-adapter-path: "vector_adapters.rs"',
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", source, "--config", config],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      // Sanity: the generated suite must actually include a runtime adapter
      // module, not compare vector data to itself. The interpreter now lives in
      // the sibling vector_runner module; the thin harness only wires the seam.
      const rustSuite = readFileSync(
        path.join(rustTestDir, "vector_conformance_test.rs"),
        "utf8",
      );
      const rustRunner = readFileSync(
        path.join(rustTestDir, "vector_runner", "mod.rs"),
        "utf8",
      );
      assert.match(rustSuite, /#\[path = "vector_adapters\.rs"\]/);
      assert.match(rustSuite, /mod vector_adapters;/);
      assert.match(rustSuite, /#\[path = "vector_runner\/mod\.rs"\]/);
      assert.match(rustSuite, /mod vector_runner;/);
      assert.match(rustSuite, /#\[tokio::test\]/);
      assert.match(rustSuite, /async fn test_vector_\d+_echo_echo_shout/);
      assert.match(rustSuite, /async fn test_vector_\d+_sum_sum_basic/);
      assert.match(rustSuite, /async fn test_vector_\d+_note_note_bidi/);
      assert.match(rustSuite, /vector_runner::vc_run_vector\(/);
      // The interpreter details moved to the runner module.
      assert.match(rustRunner, /No vector adapter registered for/);
      assert.match(rustRunner, /vc_invoke\(adapter, &input, &ctx\)\.await/);
      assert.match(rustRunner, /vector_adapters::Invoke::Async\(f\) => f\(input, ctx\)\.await/);
      // The bidi control (U+202E) must be embedded as an ASCII escape, never a
      // raw codepoint — Rust denies bidi controls even inside raw strings.
      assert.match(rustSuite, /\\u\{202e\}/);
      assert.doesNotMatch(rustSuite, /\u202e/);

      // Assemble a self-contained cargo project: an empty lib plus the generated
      // suite and the runtime adapter file side by side under tests/.
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
      writeFileSync(
        path.join(testsDir, "vector_conformance_test.rs"),
        rustSuite,
      );
      // The interpreter lives under tests/vector_runner/ so cargo never compiles
      // it as a standalone integration-test crate.
      mkdirSync(path.join(testsDir, "vector_runner"), { recursive: true });
      writeFileSync(
        path.join(testsDir, "vector_runner", "mod.rs"),
        rustRunner,
      );

      const writeAdapter = (src: string): void => {
        writeFileSync(path.join(testsDir, "vector_adapters.rs"), src);
      };

      // -- scenario 1: reference adapter => everything green --------------------
      writeAdapter(RUST_REFERENCE_ADAPTER);
      const green = runCargoTest(moduleDir, targetDir);
      assert.equal(
        green.status,
        0,
        `reference Rust suite should pass:\n${green.output}`,
      );
      assert.match(green.output, /test test_vector_\d+_echo_echo_shout \.\.\. ok/);
      assert.match(green.output, /test test_vector_\d+_sum_sum_basic \.\.\. ok/);
      assert.match(green.output, /test test_vector_\d+_note_note_bidi \.\.\. ok/);
      assert.doesNotMatch(green.output, /\bFAILED\b/);

      // -- scenario 2: Sum.sum unimplemented but explicitly waived => skip ------
      writeAdapter(
        rustEchoOnlyAdapter('    map.insert("Sum.sum", "runtime pending");'),
      );
      const waived = runCargoTest(moduleDir, targetDir);
      assert.equal(
        waived.status,
        0,
        `waived Rust suite should pass with a visible skip:\n${waived.output}`,
      );
      assert.match(waived.output, /SKIP Sum\.sum:basic \(waived: runtime pending\)/);
      assert.match(waived.output, /test test_vector_\d+_echo_echo_shout \.\.\. ok/);
      assert.doesNotMatch(waived.output, /\bFAILED\b/);

      // -- scenario 3: Sum.sum unimplemented, NO waiver => hard failure ---------
      writeAdapter(rustEchoOnlyAdapter(""));
      const red = runCargoTest(moduleDir, targetDir);
      assert.notEqual(red.status, 0, `unwaived Rust suite must fail:\n${red.output}`);
      assert.match(red.output, /test test_vector_\d+_sum_sum_basic \.\.\. FAILED/);
      assert.match(red.output, /No vector adapter registered for Sum\.sum/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  // Executable RED negative for @sync enforcement on the Rust target. The same
  // generated suite drives two registries: one that honors @sync (Tag.tag wired
  // Invoke::Sync) and one that violates it (Tag.tag wired Invoke::Async). The
  // violation must be a hard, distinct failure carrying the classification
  // message, while the async-default op (Note.note) stays green in both.
  it("enforces @sync: a @sync op wired async fails hard; async-default stays green", (t) => {
    if (!cargoAvailable()) {
      t.skip("cargo toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-vector-rust-sync-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const rustOut = path.join(output, "generated", "rust");
    const rustTestDir = path.join(output, "generated", "rust-tests");
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
          "      - type: Rust",
          `        output-dir: ${yamlString(rustOut)}`,
          `        test-dir: ${yamlString(rustTestDir)}`,
          '        vector-adapter-path: "vector_adapters.rs"',
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", source, "--config", config],
        { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );

      const rustSuite = readFileSync(
        path.join(rustTestDir, "vector_conformance_test.rs"),
        "utf8",
      );
      const rustRunner = readFileSync(
        path.join(rustTestDir, "vector_runner", "mod.rs"),
        "utf8",
      );
      // The suite wires the seam; the enum-tag classification guard lives in the
      // runner module it injects into.
      assert.match(rustSuite, /vector_runner::vc_run_vector\(/);
      assert.match(rustRunner, /vector_adapters::Invoke::Async\(_\) = adapter\.invoke/);

      const moduleDir = path.join(output, "module");
      const testsDir = path.join(moduleDir, "tests");
      const targetDir = path.join(output, "cargo-target");
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        path.join(moduleDir, "Cargo.toml"),
        [
          "[package]",
          'name = "typrasyncproof"',
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
      mkdirSync(path.join(testsDir, "vector_runner"), { recursive: true });
      writeFileSync(
        path.join(testsDir, "vector_runner", "mod.rs"),
        rustRunner,
      );

      const writeAdapter = (src: string): void => {
        writeFileSync(path.join(testsDir, "vector_adapters.rs"), src);
      };

      // -- honoring @sync: Tag.tag sync, Note.note async => all green ----------
      writeAdapter(RUST_SYNC_OK_ADAPTER);
      const ok = runCargoTest(moduleDir, targetDir);
      assert.equal(ok.status, 0, `@sync-honoring Rust suite should pass:\n${ok.output}`);
      assert.match(ok.output, /test test_vector_\d+_tag_tag_basic \.\.\. ok/);
      assert.match(ok.output, /test test_vector_\d+_note_note_basic \.\.\. ok/);
      assert.doesNotMatch(ok.output, /\bFAILED\b/);

      // -- violating @sync: Tag.tag wired async => hard, distinct failure ------
      writeAdapter(RUST_SYNC_VIOLATION_ADAPTER);
      const red = runCargoTest(moduleDir, targetDir);
      assert.notEqual(red.status, 0, `@sync-violating Rust suite must fail:\n${red.output}`);
      assert.match(red.output, /test test_vector_\d+_tag_tag_basic \.\.\. FAILED/);
      assert.match(red.output, /operation is @sync but its adapter is registered Invoke::Async/);
      assert.match(red.output, /test test_vector_\d+_note_note_basic \.\.\. ok/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
