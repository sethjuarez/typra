// Copyright (c) Microsoft. All rights reserved.

// Executable proof that @vector behavioral conformance is an ENFORCED tier for
// the C# target, not a tautology. We compile one spec (Echo/Sum/Note) once, then
// replay the generated xUnit conformance suite against three runtime adapter
// registries:
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

function dotnetAvailable(): boolean {
  try {
    execFileSync("dotnet", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
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

const ADAPTER_NAMESPACE = "Typra.Proof.Adapters";

// -- runtime adapter registry authored the way a downstream runtime would ------

const CS_COMMON = [
  "#nullable enable",
  "using System;",
  "using System.Collections.Generic;",
  "using System.Text.Json.Nodes;",
  "using System.Threading.Tasks;",
  "",
  `namespace ${ADAPTER_NAMESPACE};`,
  "",
  "public sealed class VectorContext",
  "{",
  '    public string Contract { get; init; } = "";',
  '    public string Operation { get; init; } = "";',
  "    public JsonNode? Vector { get; init; }",
  "    public string? Provider { get; init; }",
  "    public string? TargetApi { get; init; }",
  "    public JsonNode? Doubles { get; init; }",
  '    public string BaseDir { get; init; } = "";',
  "}",
  "",
  "public sealed class VectorException : Exception",
  "{",
  "    public JsonNode? Payload { get; }",
  "    public VectorException(string message, JsonNode? payload = null)",
  "        : base(message) { Payload = payload; }",
  "}",
  "",
  "public sealed class VectorAdapter",
  "{",
  "    public required Func<JsonNode?, VectorContext, object?> Invoke { get; init; }",
  "    public Func<JsonNode?, VectorContext, JsonNode?>? Normalize { get; init; }",
  "}",
  "",
];

const CS_INVOKES = [
  "    private static JsonNode? EchoInvoke(JsonNode? input, VectorContext ctx)",
  "    {",
  '        var payload = (string?)input?["payload"] ?? "";',
  "        if (payload.Length == 0)",
  '            throw new VectorException("empty", new JsonObject { ["code"] = "empty" });',
  "        return JsonValue.Create(payload.ToUpperInvariant());",
  "    }",
  "",
  "    private static JsonNode? NoteInvoke(JsonNode? input, VectorContext ctx)",
  "    {",
  '        var text = (string?)input?["text"] ?? "";',
  '        return JsonValue.Create(text + "!");',
  "    }",
  "",
];

function csReferenceAdapter(): string {
  return [
    ...CS_COMMON,
    "public static class VectorAdapters",
    "{",
    ...CS_INVOKES,
    "    private static JsonNode? SumInvoke(JsonNode? input, VectorContext ctx)",
    "    {",
    "        long total = 0;",
    '        if (input?["values"] is JsonArray arr)',
    "            foreach (var v in arr) total += (long?)v ?? 0;",
    "        return JsonValue.Create(total);",
    "    }",
    "",
    "    public static IReadOnlyDictionary<string, VectorAdapter> Adapters() =>",
    "        new Dictionary<string, VectorAdapter>",
    "        {",
    '            ["Echo.echo"] = new VectorAdapter { Invoke = EchoInvoke },',
    '            ["Sum.sum"] = new VectorAdapter { Invoke = SumInvoke },',
    '            ["Note.note"] = new VectorAdapter { Invoke = NoteInvoke },',
    "        };",
    "",
    "    public static IReadOnlyDictionary<string, string> Waivers() =>",
    "        new Dictionary<string, string>();",
    "",
    "    public static JsonNode? Doubles() => new JsonObject();",
    "}",
    "",
  ].join("\n");
}

// Async adapters: Invoke returns Task<JsonNode?>. The value path resolves and the
// error path (Echo.echo:empty) faults with a VectorException the harness awaits.
function csAsyncReferenceAdapter(): string {
  return [
    ...CS_COMMON,
    "public static class VectorAdapters",
    "{",
    "    private static async Task<JsonNode?> EchoInvoke(JsonNode? input, VectorContext ctx)",
    "    {",
    "        await Task.Yield();",
    '        var payload = (string?)input?["payload"] ?? "";',
    "        if (payload.Length == 0)",
    '            throw new VectorException("empty", new JsonObject { ["code"] = "empty" });',
    "        return JsonValue.Create(payload.ToUpperInvariant());",
    "    }",
    "",
    "    private static async Task<JsonNode?> SumInvoke(JsonNode? input, VectorContext ctx)",
    "    {",
    "        await Task.Yield();",
    "        long total = 0;",
    '        if (input?["values"] is JsonArray arr)',
    "            foreach (var v in arr) total += (long?)v ?? 0;",
    "        return JsonValue.Create(total);",
    "    }",
    "",
    "    private static async Task<JsonNode?> NoteInvoke(JsonNode? input, VectorContext ctx)",
    "    {",
    "        await Task.Yield();",
    '        var text = (string?)input?["text"] ?? "";',
    '        return JsonValue.Create(text + "!");',
    "    }",
    "",
    "    public static IReadOnlyDictionary<string, VectorAdapter> Adapters() =>",
    "        new Dictionary<string, VectorAdapter>",
    "        {",
    '            ["Echo.echo"] = new VectorAdapter { Invoke = EchoInvoke },',
    '            ["Sum.sum"] = new VectorAdapter { Invoke = SumInvoke },',
    '            ["Note.note"] = new VectorAdapter { Invoke = NoteInvoke },',
    "        };",
    "",
    "    public static IReadOnlyDictionary<string, string> Waivers() =>",
    "        new Dictionary<string, string>();",
    "",
    "    public static JsonNode? Doubles() => new JsonObject();",
    "}",
    "",
  ].join("\n");
}

// Echo and Note only. Sum.sum is deliberately unimplemented (SumInvoke absent).
function csEchoOnlyAdapter(waiverEntry: string): string {
  const waivers = waiverEntry
    ? [
        "        new Dictionary<string, string>",
        "        {",
        `            ${waiverEntry}`,
        "        };",
      ]
    : ["        new Dictionary<string, string>();"];
  return [
    ...CS_COMMON,
    "public static class VectorAdapters",
    "{",
    ...CS_INVOKES,
    "    public static IReadOnlyDictionary<string, VectorAdapter> Adapters() =>",
    "        new Dictionary<string, VectorAdapter>",
    "        {",
    '            ["Echo.echo"] = new VectorAdapter { Invoke = EchoInvoke },',
    '            ["Note.note"] = new VectorAdapter { Invoke = NoteInvoke },',
    "        };",
    "",
    "    public static IReadOnlyDictionary<string, string> Waivers() =>",
    ...waivers,
    "",
    "    public static JsonNode? Doubles() => new JsonObject();",
    "}",
    "",
  ].join("\n");
}

type RunResult = { status: number; output: string };

function runDotnetTest(projectPath: string, artifacts: string): RunResult {
  try {
    const output = execFileSync(
      "dotnet",
      [
        "test",
        projectPath,
        "--nologo",
        "--verbosity",
        "quiet",
        "--logger",
        "console;verbosity=detailed",
        `-p:BaseOutputPath=${artifacts}${path.sep}bin${path.sep}`,
        `-p:BaseIntermediateOutputPath=${artifacts}${path.sep}obj${path.sep}`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
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

describe("@vector conformance is an enforced closed loop (C#)", () => {
  it("goes green with a reference adapter, skips with a waiver, and fails hard without one", (t) => {
    if (!dotnetAvailable()) {
      t.skip("dotnet toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-vector-cs-loop-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const csOut = path.join(output, "generated", "csharp");
    const csTestDir = path.join(output, "generated", "csharp-tests");
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
          "      - type: CSharp",
          `        output-dir: ${yamlString(csOut)}`,
          `        test-dir: ${yamlString(csTestDir)}`,
          `        vector-adapter-path: ${yamlString(ADAPTER_NAMESPACE)}`,
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
      const csSuite = readFileSync(
        path.join(csTestDir, "VectorConformanceTests.cs"),
        "utf8",
      );
      assert.match(csSuite, /using Typra\.Proof\.Adapters;/);
      assert.match(csSuite, /VectorAdapters\.Adapters\(\)/);
      assert.match(csSuite, /No vector adapter registered for/);
      assert.match(csSuite, /public async Task Vector\d+EchoEchoShout\(\)/);
      assert.match(csSuite, /public async Task Vector\d+SumSumBasic\(\)/);
      assert.match(csSuite, /public async Task Vector\d+NoteNoteBidi\(\)/);
      // The bidi control (U+202E) is embedded as an ASCII escape, never raw.
      assert.match(csSuite, /\\u202e/);
      assert.doesNotMatch(csSuite, /\u202e/);

      // Assemble a self-contained xUnit project: the generated suite plus the
      // runtime adapter file compiled side by side.
      const moduleDir = path.join(output, "module");
      const artifacts = path.join(output, "cs-artifacts");
      mkdirSync(moduleDir, { recursive: true });
      const projectPath = path.join(moduleDir, "Proof.csproj");
      writeFileSync(
        projectPath,
        [
          '<Project Sdk="Microsoft.NET.Sdk">',
          "  <PropertyGroup>",
          "    <TargetFramework>net10.0</TargetFramework>",
          "    <Nullable>enable</Nullable>",
          "    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
          "    <ImplicitUsings>enable</ImplicitUsings>",
          "    <IsTestProject>true</IsTestProject>",
          "    <IsPackable>false</IsPackable>",
          "  </PropertyGroup>",
          "  <ItemGroup>",
          '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />',
          '    <PackageReference Include="xunit" Version="2.9.3" />',
          '    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.4" />',
          "  </ItemGroup>",
          "</Project>",
          "",
        ].join("\n"),
      );
      writeFileSync(
        path.join(moduleDir, "VectorConformanceTests.cs"),
        csSuite,
      );

      const writeAdapter = (src: string): void => {
        writeFileSync(path.join(moduleDir, "Adapters.cs"), src);
      };

      // -- scenario 1: reference adapter => everything green --------------------
      writeAdapter(csReferenceAdapter());
      const green = runDotnetTest(projectPath, artifacts);
      assert.equal(
        green.status,
        0,
        `reference C# suite should pass:\n${green.output}`,
      );
      assert.match(green.output, /Total tests:\s+4/);
      assert.match(green.output, /Passed:\s+4/);
      assert.doesNotMatch(green.output, /Failed:/);
      assert.doesNotMatch(green.output, /SKIP Sum\.sum/);

      // -- scenario 2: Sum.sum unimplemented but explicitly waived => pass -----
      // xUnit v2 has no runtime skip, so a honored waiver is a passing test that
      // prints a visible SKIP marker (surfaced by the detailed console logger).
      writeAdapter(csEchoOnlyAdapter('["Sum.sum"] = "runtime pending",'));
      const waived = runDotnetTest(projectPath, artifacts);
      assert.equal(
        waived.status,
        0,
        `waived C# suite should pass with a visible skip:\n${waived.output}`,
      );
      assert.match(waived.output, /SKIP Sum\.sum:basic \(waived: runtime pending\)/);
      assert.match(waived.output, /Passed:\s+4/);
      assert.doesNotMatch(waived.output, /Failed:/);

      // -- scenario 3: Sum.sum unimplemented, NO waiver => hard failure ---------
      writeAdapter(csEchoOnlyAdapter(""));
      const red = runDotnetTest(projectPath, artifacts);
      assert.notEqual(red.status, 0, `unwaived C# suite must fail:\n${red.output}`);
      assert.match(red.output, /Failed:\s+1/);
      assert.match(red.output, /No vector adapter registered for Sum\.sum/);
      assert.doesNotMatch(red.output, /SKIP Sum\.sum/);

      // -- scenario 4: async adapters (Task<JsonNode?>) => everything green ------
      writeAdapter(csAsyncReferenceAdapter());
      const asyncGreen = runDotnetTest(projectPath, artifacts);
      assert.equal(
        asyncGreen.status,
        0,
        `async C# adapter suite should pass:\n${asyncGreen.output}`,
      );
      assert.match(asyncGreen.output, /Passed:\s+4/);
      assert.doesNotMatch(asyncGreen.output, /Failed:/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
