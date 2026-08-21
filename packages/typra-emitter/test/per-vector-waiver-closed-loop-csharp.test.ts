// Copyright (c) Microsoft. All rights reserved.

// Executable proof that the #265 PER-VECTOR waiver gate is a real xfail/xpass
// mechanism on a running target, not just rendered text. We compile one spec
// (Echo with two vectors: "shout" and "loud", both expecting an uppercased
// payload) once, then replay the generated xUnit conformance suite against a
// registered Echo.echo adapter under three registries:
//
//   1. divergent + waived   -> the adapter is wrong for ONLY the "shout"
//                              vector, which is waived per-vector => GREEN,
//                              prints XFAIL Echo.echo:shout, "loud" still passes.
//   2. correct + stale waiver-> the adapter is now right for "shout" but the
//                              per-vector waiver is still present => RED,
//                              prints XPASS so the stale waiver is removed.
//   3. divergent + NO waiver -> the adapter is wrong for "shout" and nothing
//                              waives it => RED (hard mismatch failure).
//
// The adapter is REGISTERED in all three, so this exercises the adapter-present
// path the per-vector lookup added — distinct from the operation-level waiver
// (missing-adapter) path proven by vector-conformance-closed-loop-csharp.

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
  '  #{ name: "loud", input: #{ payload: "lo" }, expected: "LO" }',
  "];",
  "",
  "interface Echo {",
  "  @vector(EchoVectors)",
  "  echo(payload: string): string;",
  "}",
  "",
].join("\n");

const ADAPTER_NAMESPACE = "Typra.Proof.Adapters";

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

// `divergent` true => the "hi" payload is returned unchanged (wrong for the
// "shout" vector, whose expected is "HI"); "lo" is still uppercased so the
// "loud" vector always passes. `divergent` false => both are uppercased, so
// every vector passes.
function csEchoAdapter(divergent: boolean, waiverEntry: string): string {
  const invokeBody = divergent
    ? [
        '        var payload = (string?)input?["payload"] ?? "";',
        '        if (payload == "hi") return JsonValue.Create(payload);',
        "        return JsonValue.Create(payload.ToUpperInvariant());",
      ]
    : [
        '        var payload = (string?)input?["payload"] ?? "";',
        "        return JsonValue.Create(payload.ToUpperInvariant());",
      ];
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
    "    private static JsonNode? EchoInvoke(JsonNode? input, VectorContext ctx)",
    "    {",
    ...invokeBody,
    "    }",
    "",
    "    public static IReadOnlyDictionary<string, VectorAdapter> Adapters() =>",
    "        new Dictionary<string, VectorAdapter>",
    "        {",
    '            ["Echo.echo"] = new VectorAdapter { Invoke = EchoInvoke },',
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

describe("per-vector @vector waivers are an enforced xfail/xpass gate (C#)", () => {
  it("xfails a waived divergent vector, xpasses a stale waiver, fails an unwaived divergence", (t) => {
    if (!dotnetAvailable()) {
      t.skip("dotnet toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-per-vector-cs-"));
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

      const csSuite = readFileSync(
        path.join(csTestDir, "VectorConformanceTests.cs"),
        "utf8",
      );
      assert.match(csSuite, /VectorAdapters\.Adapters\(\)/);
      assert.match(csSuite, /XFAIL \{vectorId\}/);
      assert.match(csSuite, /waived vector unexpectedly passed/);

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
      writeFileSync(path.join(moduleDir, "VectorConformanceTests.cs"), csSuite);

      const writeAdapter = (src: string): void => {
        writeFileSync(path.join(moduleDir, "Adapters.cs"), src);
      };

      // -- scenario 1: divergent-for-shout, shout waived => GREEN with XFAIL ----
      writeAdapter(csEchoAdapter(true, '["Echo.echo:shout"] = "known divergence",'));
      const xfail = runDotnetTest(projectPath, artifacts);
      assert.equal(
        xfail.status,
        0,
        `waived divergent vector should xfail green:\n${xfail.output}`,
      );
      assert.match(xfail.output, /XFAIL Echo\.echo:shout \(waived: known divergence\)/);
      assert.match(xfail.output, /Passed:\s+2/);
      assert.doesNotMatch(xfail.output, /Failed:/);

      // -- scenario 2: adapter now correct, waiver stale => RED with XPASS ------
      writeAdapter(csEchoAdapter(false, '["Echo.echo:shout"] = "known divergence",'));
      const xpass = runDotnetTest(projectPath, artifacts);
      assert.notEqual(
        xpass.status,
        0,
        `stale waiver on a now-passing vector must xpass red:\n${xpass.output}`,
      );
      assert.match(xpass.output, /XPASS Echo\.echo:shout/);
      assert.match(xpass.output, /Failed:\s+1/);

      // -- scenario 3: divergent-for-shout, NO waiver => RED (hard mismatch) ----
      writeAdapter(csEchoAdapter(true, ""));
      const red = runDotnetTest(projectPath, artifacts);
      assert.notEqual(
        red.status,
        0,
        `unwaived divergence must fail hard:\n${red.output}`,
      );
      assert.match(red.output, /Failed:\s+1/);
      assert.doesNotMatch(red.output, /XFAIL Echo\.echo:shout/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
