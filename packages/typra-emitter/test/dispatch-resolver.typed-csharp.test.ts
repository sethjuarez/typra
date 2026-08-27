// Copyright (c) Microsoft. All rights reserved.

// Executable proof that the Part III typed @dispatch resolver (issue #282) is a
// COMPILE-TIME contract, not a runtime dictionary. We generate the committed
// `fixtures/dispatch-seam` spec for C#, then compile the EMITTED provider type +
// resolver switch (`RendererResolver.cs`) against consumer-authored providers:
//
//   * positive -> a provider that attaches every @dispatch slot compiles, and
//                 routing each committed vector's discriminator through
//                 `RendererResolver.Resolve` selects the typed IRenderer impl
//                 that reproduces `expected`                            => GREEN
//   * negative -> a provider that DROPS one slot (Mustache) fails to COMPILE
//                 (CS0535: does not implement interface member) — the missing
//                 attachment can never silently skip                   => BUILD RED
//
// Only the provider surface differs between the runs. A green positive and a
// red (compile-error) negative together prove the resolver's completeness is
// enforced by the type system — the strongest form of §5 control 2. The typed
// render also exercises §5 control 1 (correct route reproduces `expected`)
// through idiomatic, statically-typed call sites rather than a JSON interpreter.

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
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "dispatch-seam",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.DispatchSeam.Root";

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

type RunResult = { status: number; output: string };

function runDotnet(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): RunResult {
  try {
    const output = execFileSync("dotnet", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
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

// The consumer-authored, NON-emitted renderers + provider that satisfy the
// generated IRendererProvider. Each renderer understands only its own dialect's
// delimiter style (mustache `{{name}}`, jinja2 `{{ name }}`), read off the TYPED
// Agent/Inputs the emitted models produce — so a wrong slot leaves the template
// unsubstituted. Liquid is intentionally unimplemented (returns null) to model a
// valid-but-unattached variant.
const RENDERERS = [
  "#nullable enable",
  "using System.Text.RegularExpressions;",
  "using System.Threading.Tasks;",
  "using Typra.Fixtures;",
  "",
  "namespace Proof;",
  "",
  "internal static class Dialect",
  "{",
  "    public static string Render(Agent agent, Inputs inputs, Regex pattern) =>",
  "        pattern.Replace(agent.Template.Content, match =>",
  '            System.Convert.ToString(inputs.Values[match.Groups[1].Value]) ?? "");',
  "}",
  "",
  "internal sealed class MustacheRenderer : IRenderer",
  "{",
  "    public Task<string> RenderAsync(Agent agent, Inputs inputs) =>",
  '        Task.FromResult(Dialect.Render(agent, inputs, new Regex(@"\\{\\{(\\w+)\\}\\}")));',
  "}",
  "",
  "internal sealed class Jinja2Renderer : IRenderer",
  "{",
  "    public Task<string> RenderAsync(Agent agent, Inputs inputs) =>",
  '        Task.FromResult(Dialect.Render(agent, inputs, new Regex(@"\\{\\{ (\\w+) \\}\\}")));',
  "}",
  "",
].join("\n");

// FULL provider: every @dispatch slot attached (Liquid explicitly null).
const FULL_PROVIDER = [
  "#nullable enable",
  "using Typra.Fixtures;",
  "",
  "namespace Proof;",
  "",
  "internal sealed class RendererProvider : IRendererProvider",
  "{",
  "    public IRenderer? Mustache => new MustacheRenderer();",
  "    public IRenderer? Jinja2 => new Jinja2Renderer();",
  "    public IRenderer? Liquid => null;",
  "}",
  "",
].join("\n");

// MISSING-attachment provider: the Mustache slot is dropped. The generated
// IRendererProvider still declares it, so this cannot compile.
const PARTIAL_PROVIDER = [
  "#nullable enable",
  "using Typra.Fixtures;",
  "",
  "namespace Proof;",
  "",
  "internal sealed class RendererProvider : IRendererProvider",
  "{",
  "    public IRenderer? Jinja2 => new Jinja2Renderer();",
  "    public IRenderer? Liquid => null;",
  "}",
  "",
].join("\n");

// Console entry point: walk each committed vector's discriminator down the
// dispatch path, Resolve the typed impl from the provider, invoke it, and assert
// the typed result reproduces `expected`.
const PROGRAM = [
  "#nullable enable",
  "using System;",
  "using System.Collections.Generic;",
  "using System.IO;",
  "using System.Text.Json;",
  "using System.Threading.Tasks;",
  "using Typra.Fixtures;",
  "",
  "namespace Proof;",
  "",
  "internal static class Program",
  "{",
  "    private static async Task<int> Main(string[] args)",
  "    {",
  "        var json = File.ReadAllText(Environment.GetEnvironmentVariable(\"VECTORS\")!);",
  "        using var doc = JsonDocument.Parse(json);",
  "        var provider = new RendererProvider();",
  "        var failures = new List<string>();",
  "        foreach (var vector in doc.RootElement.EnumerateArray())",
  "        {",
  '            var name = vector.GetProperty("name").GetString()!;',
  '            var input = vector.GetProperty("input");',
  '            var expected = vector.GetProperty("expected").GetString();',
  '            var agent = Agent.FromJson(input.GetProperty("agent").GetRawText());',
  '            var inputs = Inputs.FromJson(input.GetProperty("inputs").GetRawText());',
  "            // Route via the TYPED discriminator surfaced by the shape Load path",
  "            // (Agent.Template.Format.Kind), not the raw JSON — this proves the",
  "            // behavioral resolver rides the same discriminator the shape does.",
  "            var kind = agent.Template.Format.Kind;",
  "            var renderer = RendererResolver.Resolve(kind, provider);",
  "            if (renderer is null)",
  "            {",
  '                failures.Add($"{name}: no impl attached for {kind}");',
  "                continue;",
  "            }",
  "            var got = await renderer.RenderAsync(agent, inputs);",
  "            if (got != expected)",
  '                failures.Add($"{name}: got \'{got}\' expected \'{expected}\'");',
  "            else",
  '                Console.WriteLine($"PASS {name}");',
  "        }",
  "        foreach (var failure in failures)",
  '            Console.Error.WriteLine($"FAIL {failure}");',
  "        return failures.Count == 0 ? 0 : 1;",
  "    }",
  "}",
  "",
].join("\n");

function proofCsproj(): string {
  return [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <PropertyGroup>",
    "    <OutputType>Exe</OutputType>",
    "    <TargetFramework>net10.0</TargetFramework>",
    "    <Nullable>enable</Nullable>",
    "    <ImplicitUsings>enable</ImplicitUsings>",
    "    <IsPackable>false</IsPackable>",
    "  </PropertyGroup>",
    "  <ItemGroup>",
    '    <PackageReference Include="YamlDotNet" Version="16.3.0" />',
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n");
}

describe("typed @dispatch resolver is a compile-time contract (C#)", () => {
  it("routes typed vectors green with a full provider; a missing slot fails to compile", async (t) => {
    if (!dotnetAvailable()) {
      t.skip("dotnet toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-typed-cs-"));
    const config = path.join(output, "tspconfig.yaml");
    const emitRoot = path.join(output, "generated");
    const csOut = path.join(emitRoot, "csharp");
    const csTestDir = path.join(csOut, "tests");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      // Compile the committed fixture spec for C# only. The programmatic
      // generate() API prunes to the object graph reachable from rootObject
      // (which omits the seam's Agent/Inputs models); the emitter's tsp-compile
      // path emits the full model set the typed resolver call sites need.
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
          "      - type: CSharp",
          `        output-dir: ${yamlString(csOut)}`,
          `        test-dir: ${yamlString(csTestDir)}`,
          '        namespace: "Typra.Fixtures"',
          "        format: false",
          '        protocol-scaffolds: "compile-only"',
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", FIXTURE, "--config", config],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const resolver = path.join(csOut, "RendererResolver.cs");

      // -- rendered-code lock: the emitted resolver is the twin of the shape ----
      // Load switch — a generated provider surface with one slot per variant.
      const resolverSrc = readFileSync(resolver, "utf8");
      assert.match(resolverSrc, /public interface IRendererProvider/);
      assert.match(resolverSrc, /IRenderer\? Mustache \{ get; \}/);
      assert.match(resolverSrc, /IRenderer\? Jinja2 \{ get; \}/);
      assert.match(resolverSrc, /IRenderer\? Liquid \{ get; \}/);
      assert.match(
        resolverSrc,
        /public static IRenderer\? Resolve\(string kind, IRendererProvider registry\)/,
      );
      assert.match(resolverSrc, /"mustache" => registry\.Mustache,/);
      // Closed dispatch: an unknown discriminator is a hard error, never null.
      assert.match(resolverSrc, /_ => throw new ArgumentException/);

      // Feed the proof the committed vectors that carry a scalar `expected`.
      const snapshot = JSON.parse(
        readFileSync(
          path.join(emitRoot, ".typra-generated", "vectors.json"),
          "utf8",
        ),
      ) as { vectors: { vector: Record<string, unknown> }[] };
      const vectors = snapshot.vectors
        .map((entry) => entry.vector)
        .filter((vector) => typeof vector.expected === "string");
      assert.ok(vectors.length >= 2, "fixture must carry routed vectors");

      const moduleDir = path.join(output, "proof");
      mkdirSync(moduleDir, { recursive: true });

      // Assemble a self-contained console project: the emitted models + IRenderer
      // seam and the emitted RendererResolver, compiled side by side with the
      // consumer-authored renderers/provider. The rest of the emitted tests/ tree
      // (xUnit suite, shared runner, adapter scaffolds) is deliberately excluded.
      for (const file of readdirSync(csOut)) {
        if (file.endsWith(".cs")) {
          copyFileSync(path.join(csOut, file), path.join(moduleDir, file));
        }
      }

      const vectorsFile = path.join(moduleDir, "vectors-data.json");
      writeFileSync(vectorsFile, JSON.stringify(vectors));
      writeFileSync(path.join(moduleDir, "Renderers.cs"), RENDERERS);
      writeFileSync(path.join(moduleDir, "Program.cs"), PROGRAM);
      writeFileSync(path.join(moduleDir, "Proof.csproj"), proofCsproj());

      // -- positive: full provider compiles and every vector routes to expected -
      writeFileSync(path.join(moduleDir, "Provider.cs"), FULL_PROVIDER);
      const green = runDotnet(["run", "-c", "Release"], moduleDir, {
        VECTORS: vectorsFile,
      });
      assert.equal(
        green.status,
        0,
        `typed resolver should route every vector green:\n${green.output}`,
      );
      assert.match(green.output, /PASS mustache-basic/);
      assert.match(green.output, /PASS jinja2-basic/);
      assert.doesNotMatch(green.output, /FAIL/);

      // -- negative control: drop the Mustache slot => cannot compile -----------
      writeFileSync(path.join(moduleDir, "Provider.cs"), PARTIAL_PROVIDER);
      const red = runDotnet(
        ["build", "--nologo", "-c", "Release"],
        moduleDir,
      );
      assert.notEqual(
        red.status,
        0,
        `a provider missing a @dispatch slot must fail to compile:\n${red.output}`,
      );
      // Require BOTH the specific diagnostic code AND the missing member: a bare
      // CS0535 elsewhere, or an unrelated "Mustache" mention, must not satisfy it.
      assert.match(
        red.output,
        /CS0535/,
        `the build must fail with CS0535 (unimplemented interface member):\n${red.output}`,
      );
      assert.match(
        red.output,
        /IRendererProvider\.Mustache/,
        `the missing member must be IRendererProvider.Mustache:\n${red.output}`,
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
