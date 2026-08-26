// Copyright (c) Microsoft. All rights reserved.

// Executable proof that the EMITTED per-interface @vector conformance suite for
// TypeScript (issue #282 §8) is a real, runnable, typed harness — not a stringly
// JSON interpreter. We generate the committed `fixtures/dispatch-seam` spec for
// TypeScript and drive the emitted `tests/renderer.conformance.test.ts` two ways:
//
//   * positive -> a consumer `vector-adapters` module that attaches every
//                 @dispatch slot lets each committed vector route its shape
//                 discriminator through the emitted `resolveRenderer`, invoke the
//                 typed seam, and reproduce `expected` (transpiled + run) => GREEN
//   * negative -> a consumer provider that DROPS one slot fails to TYPE-CHECK
//                 against the emitted `RendererProvider = Record<Kind, ...>`, so a
//                 missing attachment can never silently skip              => TYPE RED
//
// This is the TypeScript twin of `dispatch-conformance.typed-python.test.ts`: it
// proves the EMITTED conformance file (not a hand-written call site) runs green,
// and locks the compile-time completeness control at the consumer seam.

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

function transpile(code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

// Consumer-authored provider VALUE: each renderer understands only its own
// dialect's substitution braces (mustache `{{name}}`, jinja2 `{{ name }}`), so a
// wrong slot would leave the template unsubstituted. `liquid` is explicitly null
// to model a valid-but-unimplemented variant. This is the `vector-adapters`
// module the emitted conformance imports (`rendererProvider`).
const VECTOR_ADAPTERS_JS = [
  "function make(pattern) {",
  "  return {",
  "    async render(agent, inputs) {",
  "      return agent.template.content.replace(pattern, (_m, key) =>",
  '        String(inputs.values[key] ?? ""),',
  "      );",
  "    },",
  "  };",
  "}",
  "const rendererProvider = {",
  "  mustache: make(/\\{\\{(\\w+)\\}\\}/g),",
  "  jinja2: make(/\\{\\{ (\\w+) \\}\\}/g),",
  "  liquid: null,",
  "};",
  "module.exports = { rendererProvider };",
  "",
].join("\n");

// Thin jest-shim: register the emitted conformance suite's describe/it, run each
// test, and report PASS/FAIL. `expect(...).not.toBeNull()` and `.toEqual(...)`
// are the two matchers the emitted suite uses.
const POSITIVE_RUNNER = [
  "const suites = [];",
  "const tests = [];",
  "const failures = [];",
  "function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }",
  "globalThis.describe = (name, fn) => { suites.push(name); try { fn(); } finally { suites.pop(); } };",
  "globalThis.it = (name, fn) => { tests.push({ full: [...suites, name].join(' > '), fn }); };",
  "function matchers(actual, negated) {",
  "  const check = (ok, msg) => { if (ok === negated) throw new Error(msg); };",
  "  return {",
  "    get not() { return matchers(actual, !negated); },",
  "    toBeNull() { check(actual === null, 'toBeNull ' + String(actual)); },",
  "    toBeDefined() { check(actual !== undefined && actual !== null, 'toBeDefined'); },",
  "    toEqual(expected) { check(same(actual, expected), 'Expected ' + JSON.stringify(actual) + ' to equal ' + JSON.stringify(expected)); },",
  "  };",
  "}",
  "globalThis.expect = (actual) => matchers(actual, false);",
  "async function main() {",
  "  require('./renderer.conformance.test.js');",
  "  for (const t of tests) {",
  "    try { await t.fn(); console.log('PASS ' + t.full); }",
  "    catch (error) { failures.push(t.full); console.error('FAIL ' + t.full); console.error(error && error.message ? error.message : String(error)); }",
  "  }",
  "  if (failures.length > 0) process.exit(1);",
  "}",
  "main();",
  "",
].join("\n");

// Consumer provider that DROPS the `mustache` slot. The emitted
// `RendererProvider = Record<RendererKind, Renderer | null>` still requires it,
// so this cannot type-check (TS2741/TS2739/TS2740).
const PARTIAL_ADAPTERS_TS = [
  'import { RendererProvider } from "./renderer-resolver";',
  'import { Renderer } from "./renderer";',
  'const stub: Renderer = { async render() { return ""; } };',
  "export const rendererProvider: RendererProvider = {",
  "  jinja2: stub,",
  "  liquid: null,",
  "};",
  "",
].join("\n");

// Type-check a consumer provider against the REAL emitted resolver. Only the seam
// interface (`./renderer`) is stubbed; RendererKind + the Record provider are the
// emitted source, so the missing-slot error is the emitted contract's doing.
function typeCheckAdapters(resolverSrc: string, adaptersSrc: string): string[] {
  const files: Record<string, string> = {
    "renderer.ts":
      "export interface Renderer { render(agent: unknown, inputs: unknown): Promise<string>; }\n",
    "renderer-resolver.ts": resolverSrc,
    "vector-adapters.ts": adaptersSrc,
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

  const program = ts.createProgram(["vector-adapters.ts"], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => {
      const name = d.file ? path.basename(d.file.fileName) : "";
      return name === "vector-adapters.ts";
    })
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
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

describe("emitted typed @vector conformance is runnable (TypeScript)", () => {
  it("runs the emitted conformance green with a full provider; a dropped slot fails to type-check", () => {
    const output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-conf-ts-"));
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
          '        import-path: "../index"',
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

      const conformanceSrc = readFileSync(
        path.join(tsTestDir, "renderer.conformance.test.ts"),
        "utf8",
      );

      // -- rendered-code lock: the emitted conformance is typed, not stringly ---
      assert.match(
        conformanceSrc,
        /import \{ resolveRenderer \} from "\.\.\/renderer-resolver";/,
        "emitted conformance must import the resolver twin of the shape switch",
      );
      assert.match(
        conformanceSrc,
        /import \{ rendererProvider \} from "\.\/vector-adapters";/,
        "emitted conformance must import the consumer-authored provider VALUE",
      );
      assert.match(
        conformanceSrc,
        /const kind = agent\.template\.format\.kind;/,
        "emitted conformance must read the SAME typed discriminator the shape reads",
      );
      assert.match(
        conformanceSrc,
        /resolveRenderer\(kind, rendererProvider\)/,
        "emitted conformance must route through the resolver, not a JSON key",
      );
      assert.match(
        conformanceSrc,
        /await impl!\.render\(agent, inputs\)/,
        "emitted conformance must invoke the typed seam on the resolved impl",
      );

      // -- transpile the emitted library + conformance to CommonJS -------------
      for (const file of readdirSync(tsOut)) {
        if (file.endsWith(".ts")) {
          const src = readFileSync(path.join(tsOut, file), "utf8");
          writeFileSync(
            path.join(tsOut, `${path.basename(file, ".ts")}.js`),
            transpile(src),
          );
        }
      }
      writeFileSync(
        path.join(tsTestDir, "renderer.conformance.test.js"),
        transpile(conformanceSrc),
      );
      writeFileSync(
        path.join(tsTestDir, "vector-adapters.js"),
        VECTOR_ADAPTERS_JS,
      );
      writeFileSync(path.join(tsTestDir, "positive.js"), POSITIVE_RUNNER);
      writeFileSync(
        path.join(tsOut, "package.json"),
        JSON.stringify({ type: "commonjs" }, null, 2),
      );
      // The emitted context module imports `yaml` at top level; the typed routing
      // path only parses JSON, so a minimal shim satisfies the loader.
      const yamlShim = path.join(tsOut, "node_modules", "yaml");
      mkdirSync(yamlShim, { recursive: true });
      writeFileSync(
        path.join(yamlShim, "package.json"),
        JSON.stringify({ name: "yaml", version: "0.0.0", main: "index.js" }),
      );
      writeFileSync(
        path.join(yamlShim, "index.js"),
        'module.exports = { parse: () => ({}), stringify: () => "" };\n',
      );

      // -- positive control (§5 control 1): emitted conformance routes green ---
      const positive = runNode(tsTestDir, "positive.js");
      assert.equal(
        positive.status,
        0,
        `emitted conformance must route every vector green, got:\n${positive.output}`,
      );
      assert.match(
        positive.output,
        /PASS Renderer @vector conformance > mustache-basic/,
      );
      assert.match(
        positive.output,
        /PASS Renderer @vector conformance > jinja2-basic/,
      );
      assert.doesNotMatch(positive.output, /FAIL/);

      // -- negative control (§5 control 2): a dropped slot fails to type-check --
      const resolverSrc = readFileSync(
        path.join(tsOut, "renderer-resolver.ts"),
        "utf8",
      );
      const fullDiagnostics = typeCheckAdapters(resolverSrc, VECTOR_ADAPTERS_TS);
      assert.deepEqual(
        fullDiagnostics,
        [],
        `a provider attaching every slot must type-check, got:\n${fullDiagnostics.join("\n")}`,
      );
      const partialDiagnostics = typeCheckAdapters(
        resolverSrc,
        PARTIAL_ADAPTERS_TS,
      );
      assert.ok(
        partialDiagnostics.some((message) => /mustache/.test(message)),
        `dropping the mustache slot must fail to type-check, got:\n${partialDiagnostics.join("\n") || "<no diagnostics>"}`,
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});

// A fully-attached provider VALUE, annotated with the emitted RendererProvider so
// the type-check positive exercises the same Record the conformance imports.
const VECTOR_ADAPTERS_TS = [
  'import { RendererProvider } from "./renderer-resolver";',
  'import { Renderer } from "./renderer";',
  'const stub: Renderer = { async render() { return ""; } };',
  "export const rendererProvider: RendererProvider = {",
  "  mustache: stub,",
  "  jinja2: stub,",
  "  liquid: null,",
  "};",
  "",
].join("\n");
