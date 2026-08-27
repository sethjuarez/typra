// Copyright (c) Microsoft. All rights reserved.

// Executable proof that the Part III typed @dispatch resolver (issue #282) is a
// COMPILE-TIME contract in TypeScript, not a runtime dictionary. We generate the
// committed `fixtures/dispatch-seam` spec for TypeScript, then exercise the
// EMITTED provider type + resolve switch (`renderer-resolver.ts`) two ways:
//
//   * positive -> a provider that attaches every @dispatch slot routes each
//                 committed vector's discriminator through `resolveRenderer`,
//                 selecting the typed Renderer impl that reproduces `expected`
//                 (transpiled + run on node)                            => GREEN
//   * negative -> a provider that DROPS one slot fails to TYPE-CHECK: the emitted
//                 `RendererProvider = Record<RendererKind, Renderer | null>`
//                 makes the missing key a compile error (TS2741/TS2740), so a
//                 missing attachment can never silently skip             => TYPE RED
//
// A green positive and a red (type-error) negative together prove the resolver's
// completeness is enforced by the type system — the TypeScript form of §5
// control 2. The positive run also exercises §5 control 1 (correct route
// reproduces `expected`) through idiomatic, statically-typed call sites rather
// than a JSON interpreter.

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
import { tmpdir } from "node:os";

import * as ts from "typescript";

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

// Consumer-authored renderers: each understands only its own dialect's
// substitution braces (mustache `{{name}}`, jinja2 `{{ name }}`), so a wrong
// slot leaves the template unsubstituted.
const RENDERERS = [
  'const { MustacheRenderer, Jinja2Renderer } = (function () {',
  "  function make(pattern) {",
  "    return {",
  "      async render(agent, inputs) {",
  "        return agent.template.content.replace(pattern, (_, key) =>",
  '          String(inputs.values[key] ?? ""),',
  "        );",
  "      },",
  "    };",
  "  }",
  "  return {",
  "    MustacheRenderer: () => make(/\\{\\{(\\w+)\\}\\}/g),",
  "    Jinja2Renderer: () => make(/\\{\\{ (\\w+) \\}\\}/g),",
  "  };",
  "})();",
  "",
  "module.exports = { MustacheRenderer, Jinja2Renderer };",
  "",
].join("\n");

// FULL provider: every @dispatch slot attached (liquid explicitly null to model
// a valid-but-unimplemented variant).
const PROVIDER = [
  'const { MustacheRenderer, Jinja2Renderer } = require("./renderers");',
  "const provider = {",
  "  mustache: MustacheRenderer(),",
  "  jinja2: Jinja2Renderer(),",
  "  liquid: null,",
  "};",
  "module.exports = { provider };",
  "",
].join("\n");

// Node runner: walk each committed vector's discriminator down the dispatch path
// on the TYPED Agent graph (agent.template.format.kind — the same `kind` the
// shape's own discriminator switch keys on), resolve the typed impl from the
// provider, invoke it, and assert the typed result reproduces `expected`.
const RUNNER = [
  'const fs = require("fs");',
  'const { Agent } = require("./agent");',
  'const { Inputs } = require("./inputs");',
  'const { resolveRenderer } = require("./renderer-resolver");',
  'const { provider } = require("./provider");',
  "async function main() {",
  '  const vectors = JSON.parse(fs.readFileSync(process.env.VECTORS, "utf8"));',
  "  const failures = [];",
  "  for (const vector of vectors) {",
  "    const name = vector.name;",
  "    const agent = Agent.load(vector.input.agent);",
  "    const inputs = Inputs.load(vector.input.inputs);",
  "    const kind = agent.template.format.kind;",
  "    const renderer = resolveRenderer(kind, provider);",
  "    if (!renderer) {",
  "      failures.push(name + ': no impl attached for ' + kind);",
  "      continue;",
  "    }",
  "    const got = await renderer.render(agent, inputs);",
  "    if (got !== vector.expected)",
  "      failures.push(name + \": got '\" + got + \"' expected '\" + vector.expected + \"'\");",
  '    else console.log("PASS " + name);',
  "  }",
  '  for (const f of failures) console.error("FAIL " + f);',
  "  if (failures.length > 0) process.exit(1);",
  "}",
  "main();",
  "",
].join("\n");

// Consumer providers used ONLY for the compile-time control. FULL satisfies every
// Record key; PARTIAL drops the `mustache` slot, which the emitted
// `RendererProvider` Record still requires — so PARTIAL cannot type-check.
const FULL_PROVIDER_TS = [
  'import { RendererProvider } from "./renderer-resolver";',
  'import { Renderer } from "./renderer";',
  "const stub: Renderer = { async render() { return \"\"; } };",
  "export const provider: RendererProvider = {",
  "  mustache: stub,",
  "  jinja2: stub,",
  "  liquid: null,",
  "};",
  "",
].join("\n");

const PARTIAL_PROVIDER_TS = [
  'import { RendererProvider } from "./renderer-resolver";',
  'import { Renderer } from "./renderer";',
  "const stub: Renderer = { async render() { return \"\"; } };",
  "export const provider: RendererProvider = {",
  "  jinja2: stub,",
  "  liquid: null,",
  "};",
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

// Type-check the emitted resolver + a consumer provider in isolation. Only the
// resolver's own dependency (`./renderer`) is stubbed; everything the control
// hinges on — RendererKind, the Record provider — is the REAL emitted source.
function typeCheckProvider(resolverSrc: string, providerSrc: string): string[] {
  const files: Record<string, string> = {
    "renderer.ts":
      "export interface Renderer { render(agent: unknown, inputs: unknown): Promise<string>; }\n",
    "renderer-resolver.ts": resolverSrc,
    "provider.ts": providerSrc,
  };
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const base = path.basename(fileName);
    if (files[base] !== undefined) {
      return ts.createSourceFile(fileName, files[base], languageVersion, true);
    }
    return originalGetSourceFile(
      fileName,
      languageVersion,
      onError,
      shouldCreate,
    );
  };
  host.fileExists = (fileName) =>
    files[path.basename(fileName)] !== undefined || ts.sys.fileExists(fileName);
  host.readFile = (fileName) =>
    files[path.basename(fileName)] ?? ts.sys.readFile(fileName);

  const program = ts.createProgram(["provider.ts"], options, host);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => {
      const name = d.file ? path.basename(d.file.fileName) : "";
      return name === "provider.ts";
    })
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  return diagnostics;
}

type RunResult = { status: number; output: string };

function runNode(dir: string, vectorsFile: string): RunResult {
  try {
    const output = execFileSync(process.execPath, ["runner.js"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, VECTORS: vectorsFile },
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

describe("typed @dispatch resolver is a compile-time contract (TypeScript)", () => {
  it("routes typed vectors green with a full provider; a missing slot fails to type-check", () => {
    const output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-typed-ts-"));
    const emitRoot = path.join(output, "generated");
    const tsOut = path.join(emitRoot, "typescript");
    const tsTestDir = path.join(tsOut, "tests");
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
          "      - type: TypeScript",
          `        output-dir: ${yamlString(tsOut)}`,
          `        test-dir: ${yamlString(tsTestDir)}`,
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

      const resolver = path.join(tsOut, "renderer-resolver.ts");
      const resolverSrc = readFileSync(resolver, "utf8");

      // -- rendered-code lock: the emitted resolver is the twin of the shape ----
      // discriminator switch — a generated provider Record with one key per
      // variant plus a switch that throws on an unknown discriminator.
      assert.match(
        resolverSrc,
        /export type RendererKind = "mustache" \| "jinja2" \| "liquid";/,
      );
      assert.match(
        resolverSrc,
        /export type RendererProvider = Record<RendererKind, Renderer \| null>;/,
      );
      assert.match(
        resolverSrc,
        /export function resolveRenderer\(\s*kind: string,\s*registry: RendererProvider,\s*\): Renderer \| null/,
      );
      assert.match(resolverSrc, /case "mustache":/);
      // Closed dispatch: an unknown discriminator is a hard error, never null.
      assert.match(resolverSrc, /throw new Error\(/);

      // -- compile-time control (§5 control 2) --------------------------------
      const fullDiagnostics = typeCheckProvider(resolverSrc, FULL_PROVIDER_TS);
      assert.deepEqual(
        fullDiagnostics,
        [],
        `a provider attaching every slot must type-check, got:\n${fullDiagnostics.join("\n")}`,
      );
      const partialDiagnostics = typeCheckProvider(
        resolverSrc,
        PARTIAL_PROVIDER_TS,
      );
      assert.ok(
        partialDiagnostics.some((message) => /mustache/.test(message)),
        `dropping the mustache slot must fail to type-check, got:\n${partialDiagnostics.join("\n") || "<no diagnostics>"}`,
      );

      // -- runtime positive control (§5 control 1) ----------------------------
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

      const runDir = path.join(output, "run");
      mkdirSync(runDir, { recursive: true });
      // Transpile the emitted library modules (models + seam + resolver) to
      // CommonJS beside the consumer renderers/provider and the runner. The
      // emitted tests/ tree is deliberately excluded.
      for (const file of readdirSync(tsOut)) {
        if (file.endsWith(".ts")) {
          const src = readFileSync(path.join(tsOut, file), "utf8");
          const jsName = `${path.basename(file, ".ts")}.js`;
          writeFileSync(path.join(runDir, jsName), transpile(src));
        }
      }
      writeFileSync(path.join(runDir, "renderers.js"), RENDERERS);
      writeFileSync(path.join(runDir, "provider.js"), PROVIDER);
      writeFileSync(path.join(runDir, "runner.js"), RUNNER);
      // The emitted context module imports `yaml` at top level, but the typed
      // routing path only ever parses JSON. A minimal shim satisfies the loader
      // without pulling a dependency into the isolated run dir.
      const yamlShim = path.join(runDir, "node_modules", "yaml");
      mkdirSync(yamlShim, { recursive: true });
      writeFileSync(
        path.join(yamlShim, "package.json"),
        JSON.stringify({ name: "yaml", version: "0.0.0", main: "index.js" }),
      );
      writeFileSync(
        path.join(yamlShim, "index.js"),
        "module.exports = { parse: () => ({}), stringify: () => \"\" };\n",
      );
      const vectorsFile = path.join(runDir, "vectors-data.json");
      writeFileSync(vectorsFile, JSON.stringify(vectors));

      const result = runNode(runDir, vectorsFile);
      assert.equal(
        result.status,
        0,
        `typed routing must reproduce every vector's expected, got:\n${result.output}`,
      );
      for (const vector of vectors) {
        assert.match(result.output, new RegExp(`PASS ${vector.name as string}`));
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
