// Copyright (c) Microsoft. All rights reserved.

// Executable proof that the Part III typed @dispatch resolver (issue #282) is an
// ENFORCED contract on the Python target. Python cannot check Protocol-set
// completeness at import/collection time, so the resolver's completeness guard
// is RUNTIME: the emitted `new_renderer_provider` collection constructor raises
// when a consumer omits a @dispatch variant key, and `resolve_renderer` is the
// behavioral twin of the shape discriminator load switch (`_TemplateFormat`'s
// `load_kind`). We compile the committed `fixtures/dispatch-seam` spec for
// Python, then exercise the EMITTED provider + resolver
// (`_renderer_resolver.py`, a real library module) via a pytest suite whose
// provider is built through a conftest fixture:
//
//   * positive -> the conftest `full_provider` fixture attaches every @dispatch
//                 slot (liquid explicitly None, a valid-but-unimplemented
//                 variant); routing each committed vector's discriminator
//                 through resolve_renderer selects the typed Renderer impl that
//                 reproduces `expected`                                    => PASS
//   * negative -> new_renderer_provider called with a mapping that DROPS one
//                 slot (mustache) raises ValueError naming the missing variant
//                 — the forgotten attachment can never silently skip, it fails
//                 loudly at collection                                      => PASS
//                 (the guard's ValueError is what pytest.raises asserts)
//
// A green positive and a negative that asserts the collection error together
// prove issue #282 section 5 control 2 for a runtime-enforced target: a missing
// provider slot errors at collection, never a silent miss. The typed render
// also exercises control 1 (correct route reproduces `expected`) through
// idiomatic, typed Python call sites rather than a JSON interpreter.

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
const PACKAGE = "dispatch_fixtures";

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

function runUv(dir: string, args: string[], pythonPath: string): RunResult {
  try {
    const output = execFileSync("uv", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONPATH: pythonPath },
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

// The consumer-authored, NON-emitted renderers + a conftest fixture that builds
// the provider through the emitted collection guard. Each renderer understands
// only its own dialect's delimiter style (mustache `{{name}}`, jinja2
// `{{ name }}`), read off the TYPED Agent/Inputs the emitted models produce.
const CONFTEST = [
  "import pytest",
  "",
  `from ${PACKAGE}._Agent import Agent`,
  `from ${PACKAGE}._Inputs import Inputs`,
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
  "    def render(self, agent: Agent, inputs: Inputs) -> str:",
  "        return substitute(agent.template.content, inputs.values, '{{', '}}')",
  "",
  "",
  "class Jinja2Renderer:",
  "    def render(self, agent: Agent, inputs: Inputs) -> str:",
  "        return substitute(agent.template.content, inputs.values, '{{ ', ' }}')",
  "",
  "",
  "@pytest.fixture",
  "def full_provider():",
  "    # Attaches every @dispatch slot; liquid is a valid-but-unimplemented",
  "    # variant (None) the resolver returns for the caller to skip explicitly.",
  "    return new_renderer_provider(",
  "        {",
  "            'mustache': MustacheRenderer(),",
  "            'jinja2': Jinja2Renderer(),",
  "            'liquid': None,",
  "        }",
  "    )",
  "",
].join("\n");

const TEST = [
  "import json",
  "import pathlib",
  "",
  "import pytest",
  "",
  `from ${PACKAGE}._Agent import Agent`,
  `from ${PACKAGE}._Inputs import Inputs`,
  `from ${PACKAGE}._renderer_resolver import (`,
  "    new_renderer_provider,",
  "    resolve_renderer,",
  ")",
  "",
  "from conftest import Jinja2Renderer",
  "",
  "VECTORS = json.loads(",
  "    (pathlib.Path(__file__).parent / 'vectors-data.json').read_text()",
  ")",
  "",
  "",
  "# Positive (control 1): a complete provider routes every committed vector",
  "# through the typed resolver to the impl that reproduces `expected`.",
  "@pytest.mark.parametrize('vector', VECTORS, ids=[v['name'] for v in VECTORS])",
  "def test_typed_resolver_routes_every_vector(full_provider, vector):",
  "    agent = Agent.load(vector['input']['agent'])",
  "    inputs = Inputs.load(vector['input']['inputs'])",
  "    # Route on the discriminator on the TYPED Agent graph, the same `kind`",
  "    # the shape's own discriminator load switch keys on.",
  "    kind = agent.template.format.kind",
  "    renderer = resolve_renderer(kind, full_provider)",
  "    assert renderer is not None, f'{vector[\"name\"]}: no impl attached for {kind}'",
  "    assert renderer.render(agent, inputs) == vector['expected']",
  "",
  "",
  "# Negative (RUNTIME control 2): a provider mapping that omits the mustache slot",
  "# must fail at collection with a ValueError naming the missing variant. The",
  "# forgotten attachment can never silently skip.",
  "def test_missing_attachment_is_collection_error():",
  "    with pytest.raises(ValueError, match='mustache'):",
  "        new_renderer_provider({'jinja2': Jinja2Renderer(), 'liquid': None})",
  "",
  "",
  "# Unknown-discriminator control: a closed dispatch resolves an unknown kind to",
  "# a hard error, the twin of the shape load switch's else arm.",
  "def test_unknown_discriminator_errors(full_provider):",
  "    with pytest.raises(ValueError):",
  "        resolve_renderer('handlebars', full_provider)",
  "",
].join("\n");

describe("typed @dispatch resolver is a runtime-enforced contract (Python)", () => {
  it("routes typed vectors green; a missing provider slot errors at collection", (t) => {
    if (!uvAvailable()) {
      t.skip("uv toolchain not available");
      return;
    }

    const output = mkdtempSync(
      path.join(process.cwd(), "tmp-dispatch-typed-py-"),
    );
    const config = path.join(output, "tspconfig.yaml");
    const emitRoot = path.join(output, "generated");
    const pyOut = path.join(emitRoot, "python");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      // Compile the committed fixture spec for Python only. The emitter's
      // tsp-compile path emits the full model set the resolver call sites need.
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
          "        format: false",
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

      const resolver = path.join(pyOut, "_renderer_resolver.py");

      // -- rendered-code lock: the emitted resolver is the twin of the shape ----
      // discriminator load switch — a generated provider dataclass with one slot
      // per variant, a runtime completeness guard, and a resolve_renderer switch
      // keyed on the same `kind`.
      const resolverSrc = readFileSync(resolver, "utf8");
      assert.match(resolverSrc, /class RendererProvider/);
      assert.match(resolverSrc, /mustache: Renderer \| None\b/);
      assert.match(resolverSrc, /jinja2: Renderer \| None\b/);
      assert.match(resolverSrc, /liquid: Renderer \| None\b/);
      assert.match(
        resolverSrc,
        /def new_renderer_provider\(impls: Mapping\[str, Renderer \| None\]\) -> RendererProvider/,
      );
      assert.match(resolverSrc, /is missing @dispatch variant/);
      assert.match(
        resolverSrc,
        /def resolve_renderer\(kind: str, provider: RendererProvider\) -> Renderer \| None/,
      );
      assert.match(resolverSrc, /if kind == "mustache":\s*\n\s*return provider\.mustache/);
      // Closed dispatch: an unknown discriminator is a hard error, never a
      // silent None miss.
      assert.match(
        resolverSrc,
        /Unknown Renderer discriminator field 'kind' value/,
      );

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

      // Assemble a self-contained module: the emitted model library (which now
      // carries _renderer_resolver.py) as an importable package, plus the
      // consumer conftest + pytest suite under tests/.
      const moduleDir = path.join(output, "module");
      const pkgDir = path.join(moduleDir, PACKAGE);
      const testsDir = path.join(moduleDir, "tests");
      mkdirSync(pkgDir, { recursive: true });
      mkdirSync(testsDir, { recursive: true });

      // Copy the emitted library files (the package root only — the emitted
      // tests/ subtree is not part of the consumer's importable library).
      for (const entry of readdirSync(pyOut)) {
        const src = path.join(pyOut, entry);
        if (statSync(src).isFile()) {
          copyFileSync(src, path.join(pkgDir, entry));
        }
      }

      writeFileSync(path.join(testsDir, "conftest.py"), CONFTEST);
      writeFileSync(path.join(testsDir, "test_dispatch.py"), TEST);
      writeFileSync(
        path.join(testsDir, "vectors-data.json"),
        JSON.stringify(vectors),
      );

      const pythonPath = `${moduleDir}${path.delimiter}${testsDir}`;
      const result = runUv(
        moduleDir,
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
        pythonPath,
      );
      assert.equal(
        result.status,
        0,
        `typed Python resolver proof should pass:\n${result.output}`,
      );
      assert.match(result.output, /4 passed/);
      assert.doesNotMatch(result.output, /failed/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
