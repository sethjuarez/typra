// Copyright (c) Microsoft. All rights reserved.

// Executable proof that @vector behavioral conformance is an ENFORCED tier for
// the Go target, not a tautology. We compile one spec (two contracts of
// differing character) once, then replay the generated `go test` conformance
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

function goAvailable(): boolean {
  try {
    execFileSync("go", ["version"], { stdio: ["ignore", "pipe", "pipe"] });
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

// -- runtime adapter registry authored the way a downstream runtime would ------

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
  "type vectorError struct {",
  "\tmessage string",
  "\tpayload any",
  "}",
  "",
  "func (e *vectorError) Error() string   { return e.message }",
  "func (e *vectorError) TypraVector() any { return e.payload }",
  "",
  "var VectorDoubles = map[string]any{}",
  "",
  "func echoInvoke(input any, _ Context) (any, error) {",
  "\tm, _ := input.(map[string]any)",
  '\tpayload, _ := m["payload"].(string)',
  '\tif payload == "" {',
  '\t\treturn nil, &vectorError{message: "empty", payload: map[string]any{"code": "empty"}}',
  "\t}",
  "\treturn strings.ToUpper(payload), nil",
  "}",
  "",
  "func sumInvoke(input any, _ Context) (any, error) {",
  "\tm, _ := input.(map[string]any)",
  '\tvalues, _ := m["values"].([]any)',
  "\ttotal := 0.0",
  "\tfor _, v := range values {",
  "\t\tf, _ := v.(float64)",
  "\t\ttotal += f",
  "\t}",
  "\treturn total, nil",
  "}",
  "",
];

const GO_REFERENCE_ADAPTER = [
  ...GO_COMMON,
  "var VectorWaivers = map[string]string{}",
  "",
  "var VectorAdapters = map[string]Adapter{",
  '\t"Echo.echo": {Invoke: echoInvoke},',
  '\t"Sum.sum":   {Invoke: sumInvoke},',
  "}",
  "",
].join("\n");

// Echo only. Sum.sum is deliberately unimplemented. sumInvoke stays defined but
// unreferenced — Go permits unused package-level functions.
function goEchoOnlyAdapter(waiverEntry: string): string {
  return [
    ...GO_COMMON,
    `var VectorWaivers = map[string]string{${waiverEntry}}`,
    "",
    "var _ = sumInvoke",
    "",
    "var VectorAdapters = map[string]Adapter{",
    '\t"Echo.echo": {Invoke: echoInvoke},',
    "}",
    "",
  ].join("\n");
}

type RunResult = { status: number; output: string };

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
    return {
      status: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

describe("@vector conformance is an enforced closed loop (Go)", () => {
  it("goes green with a reference adapter, skips with a waiver, and fails hard without one", (t) => {
    if (!goAvailable()) {
      t.skip("go toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-vector-go-loop-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const goOut = path.join(output, "generated", "go");
    const goTestDir = path.join(output, "generated", "go-tests");
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
          "      - type: Go",
          `        output-dir: ${yamlString(goOut)}`,
          `        test-dir: ${yamlString(goTestDir)}`,
          '        import-path: "typraproof"',
          '        vector-adapter-path: "typraproof/vectoradapters"',
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

      // Sanity: the generated suite must actually invoke a runtime adapter, not
      // compare vector data to itself.
      const goSuite = readFileSync(
        path.join(goTestDir, "vector_conformance_test.go"),
        "utf8",
      );
      assert.match(goSuite, /vectoradapters\.VectorAdapters\[operationKey\]/);
      assert.match(goSuite, /No vector adapter registered for/);
      assert.match(goSuite, /func TestVector0/);

      // Assemble a self-contained module: the generated suite alone in
      // conformance/, the runtime adapter package in vectoradapters/.
      const moduleDir = path.join(output, "module");
      const confDir = path.join(moduleDir, "conformance");
      const adapterDir = path.join(moduleDir, "vectoradapters");
      mkdirSync(confDir, { recursive: true });
      mkdirSync(adapterDir, { recursive: true });
      writeFileSync(
        path.join(moduleDir, "go.mod"),
        "module typraproof\n\ngo 1.22\n",
      );
      writeFileSync(
        path.join(confDir, "vector_conformance_test.go"),
        goSuite,
      );

      const writeAdapter = (src: string): void => {
        writeFileSync(path.join(adapterDir, "adapters.go"), src);
      };

      // -- scenario 1: reference adapter => everything green --------------------
      writeAdapter(GO_REFERENCE_ADAPTER);
      const green = runGoTest(moduleDir);
      assert.equal(
        green.status,
        0,
        `reference Go suite should pass:\n${green.output}`,
      );
      assert.match(green.output, /--- PASS: TestVector\d+EchoEcho/);
      assert.match(green.output, /--- PASS: TestVector\d+SumSum/);
      assert.doesNotMatch(green.output, /--- FAIL/);

      // -- scenario 2: Sum.sum unimplemented but explicitly waived => skip ------
      writeAdapter(goEchoOnlyAdapter('"Sum.sum": "runtime pending"'));
      const waived = runGoTest(moduleDir);
      assert.equal(
        waived.status,
        0,
        `waived Go suite should pass with a visible skip:\n${waived.output}`,
      );
      assert.match(waived.output, /--- SKIP: TestVector\d+SumSum/);
      assert.match(waived.output, /waived: runtime pending/);
      assert.match(waived.output, /--- PASS: TestVector\d+EchoEcho/);
      assert.doesNotMatch(waived.output, /--- FAIL/);

      // -- scenario 3: Sum.sum unimplemented, NO waiver => hard failure ---------
      writeAdapter(goEchoOnlyAdapter(""));
      const red = runGoTest(moduleDir);
      assert.equal(red.status, 1, `unwaived Go suite must fail:\n${red.output}`);
      assert.match(red.output, /--- FAIL: TestVector\d+SumSum/);
      assert.match(red.output, /No vector adapter registered for Sum\.sum/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
