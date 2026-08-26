// Copyright (c) Microsoft. All rights reserved.

// Executable proof that the Part III typed @dispatch resolver (issue #282) is a
// COMPILE-TIME contract on the Rust target, not a runtime dictionary. We compile
// the committed `fixtures/dispatch-seam` spec for Rust, then compile the EMITTED
// provider trait + resolver fn (`renderer_resolver.rs`, a real library module
// re-exported by the generated `mod.rs`) against consumer-authored renderers:
//
//   * positive -> a provider that attaches every @dispatch slot compiles, and
//                 routing each committed vector's discriminator through
//                 `renderer_resolver::resolve` selects the typed `dyn Renderer`
//                 impl that reproduces `expected`                        => GREEN
//   * negative -> a provider that DROPS one slot (mustache) fails to COMPILE
//                 (E0046: not all trait items implemented) — the missing
//                 attachment can never silently skip                     => BUILD RED
//
// Only the provider surface differs between the runs. A green positive and a
// red (compile-error) negative together prove the resolver's completeness is
// enforced by the type system — the strongest form of §5 control 2. The typed
// render also exercises §5 control 1 (correct route reproduces `expected`)
// through idiomatic, statically-typed call sites rather than a JSON interpreter.
//
// NOTE on the Rust typed route: the emitter types `Template.format` as a raw
// `serde_json::Value` (unlike C#, which surfaces a typed `TemplateFormat`), so
// the discriminator is read from that typed field. The resolver still rides the
// exact `kind` the shape's own discriminator match keys on.

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

function cargoAvailable(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

type RunResult = { status: number; output: string };

function runCargo(
  args: string[],
  moduleDir: string,
  targetDir: string,
): RunResult {
  try {
    const output = execFileSync("cargo", args, {
      cwd: moduleDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RUSTFLAGS: "-D warnings",
        CARGO_TARGET_DIR: targetDir,
      },
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

const CRATE = "typradispatchproof";

function proofCargoToml(): string {
  return [
    "[package]",
    `name = "${CRATE}"`,
    'version = "0.0.0"',
    'edition = "2021"',
    "",
    "[lib]",
    'path = "lib.rs"',
    "",
    "[dependencies]",
    'serde = "1"',
    'serde_json = "1"',
    'serde_yaml = "0.9"',
    'async-trait = "0.1"',
    "",
    "[dev-dependencies]",
    'tokio = { version = "1", features = ["macros", "rt"] }',
    "",
  ].join("\n");
}

// The consumer-authored, NON-emitted renderers + provider that satisfy the
// generated `RendererProvider`. Each renderer understands only its own dialect's
// delimiter style (mustache `{{name}}`, jinja2 `{{ name }}`), read off the TYPED
// Agent/Inputs the emitted models produce — so a wrong slot leaves the template
// unsubstituted. Liquid is intentionally unimplemented (returns None) to model a
// valid-but-unattached variant.
const RENDERERS = [
  "use async_trait::async_trait;",
  `use ${CRATE}::model::{Agent, Inputs, Renderer};`,
  "",
  "fn substitute(content: &str, values: &serde_json::Value, open: &str, close: &str) -> String {",
  "    let mut out = content.to_string();",
  "    if let Some(map) = values.as_object() {",
  "        for (key, value) in map {",
  "            let rendered = value",
  "                .as_str()",
  "                .map(|s| s.to_string())",
  "                .unwrap_or_else(|| value.to_string());",
  '            let token = format!("{}{}{}", open, key, close);',
  "            out = out.replace(&token, &rendered);",
  "        }",
  "    }",
  "    out",
  "}",
  "",
  "pub struct MustacheRenderer;",
  "",
  "#[async_trait]",
  "impl Renderer for MustacheRenderer {",
  "    async fn render(",
  "        &self,",
  "        agent: &Agent,",
  "        inputs: &Inputs,",
  "    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {",
  '        Ok(substitute(&agent.template.content, &inputs.values, "{{", "}}"))',
  "    }",
  "}",
  "",
  "pub struct Jinja2Renderer;",
  "",
  "#[async_trait]",
  "impl Renderer for Jinja2Renderer {",
  "    async fn render(",
  "        &self,",
  "        agent: &Agent,",
  "        inputs: &Inputs,",
  "    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {",
  '        Ok(substitute(&agent.template.content, &inputs.values, "{{ ", " }}"))',
  "    }",
  "}",
  "",
].join("\n");

// FULL provider: every @dispatch slot attached (liquid explicitly None).
function fullProviderAndTest(
  vectors: { name: string; agent: string; inputs: string; expected: string }[],
): string {
  const rows = vectors
    .map(
      (v) =>
        `    (${JSON.stringify(v.name)}, r#"${v.agent}"#, r#"${v.inputs}"#, ${JSON.stringify(
          v.expected,
        )}),`,
    )
    .join("\n");
  return [
    "#[path = \"renderers.rs\"]",
    "mod renderers;",
    "",
    `use ${CRATE}::model::{Agent, Inputs, LoadContext, Renderer};`,
    `use ${CRATE}::model::renderer_resolver::{self, RendererProvider};`,
    "use renderers::{Jinja2Renderer, MustacheRenderer};",
    "",
    "// Attaches every @dispatch slot; liquid is a valid-but-unimplemented variant.",
    "struct FullProvider {",
    "    mustache: MustacheRenderer,",
    "    jinja2: Jinja2Renderer,",
    "}",
    "",
    "impl RendererProvider for FullProvider {",
    "    fn mustache(&self) -> Option<&dyn Renderer> {",
    "        Some(&self.mustache)",
    "    }",
    "    fn jinja2(&self) -> Option<&dyn Renderer> {",
    "        Some(&self.jinja2)",
    "    }",
    "    fn liquid(&self) -> Option<&dyn Renderer> {",
    "        None",
    "    }",
    "}",
    "",
    "const VECTORS: &[(&str, &str, &str, &str)] = &[",
    rows,
    "];",
    "",
    "#[tokio::test]",
    "async fn typed_resolver_routes_every_vector() {",
    "    let ctx = LoadContext::default();",
    "    let provider = FullProvider {",
    "        mustache: MustacheRenderer,",
    "        jinja2: Jinja2Renderer,",
    "    };",
    "    for (name, agent_json, inputs_json, expected) in VECTORS {",
    "        let agent = Agent::from_json(agent_json, &ctx).expect(\"agent parses\");",
    "        let inputs = Inputs::from_json(inputs_json, &ctx).expect(\"inputs parse\");",
    "        // Route via the discriminator on the TYPED Agent graph, the same",
    "        // `kind` the shape's own discriminator match keys on.",
    "        let kind = agent",
    "            .template",
    "            .format",
    '            .get("kind")',
    "            .and_then(|v| v.as_str())",
    '            .expect("discriminator present");',
    "        let renderer = renderer_resolver::resolve(kind, &provider)",
    "            .unwrap_or_else(|| panic!(\"{name}: no impl attached for {kind}\"));",
    "        let got = renderer.render(&agent, &inputs).await.expect(\"render\");",
    "        assert_eq!(&got, expected, \"vector {name} misrouted\");",
    "    }",
    "}",
    "",
  ].join("\n");
}

// MISSING-attachment provider: the mustache slot is dropped. The generated
// RendererProvider trait still declares it, so this cannot compile (E0046).
function partialProviderTest(): string {
  return [
    `use ${CRATE}::model::Renderer;`,
    `use ${CRATE}::model::renderer_resolver::RendererProvider;`,
    "",
    "struct PartialProvider;",
    "",
    "impl RendererProvider for PartialProvider {",
    "    fn jinja2(&self) -> Option<&dyn Renderer> {",
    "        None",
    "    }",
    "    fn liquid(&self) -> Option<&dyn Renderer> {",
    "        None",
    "    }",
    "}",
    "",
    "#[test]",
    "fn partial_provider_is_rejected() {",
    "    let _ = PartialProvider;",
    "}",
    "",
  ].join("\n");
}

describe("typed @dispatch resolver is a compile-time contract (Rust)", () => {
  it("routes typed vectors green with a full provider; a missing slot fails to compile", (t) => {
    if (!cargoAvailable()) {
      t.skip("cargo toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-dispatch-typed-rust-"));
    const config = path.join(output, "tspconfig.yaml");
    const emitRoot = path.join(output, "generated");
    const rustOut = path.join(emitRoot, "rust");
    const rustTestDir = path.join(emitRoot, "rust-tests");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      // Compile the committed fixture spec for Rust only. The programmatic
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
          "      - type: Rust",
          `        output-dir: ${yamlString(rustOut)}`,
          `        test-dir: ${yamlString(rustTestDir)}`,
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

      const resolver = path.join(rustOut, "renderer_resolver.rs");

      // -- rendered-code lock: the emitted resolver is the twin of the shape ----
      // discriminator match — a generated provider trait with one method per
      // variant plus a `resolve` fn keyed on the same `kind`.
      const resolverSrc = readFileSync(resolver, "utf8");
      assert.match(resolverSrc, /pub trait RendererProvider/);
      assert.match(resolverSrc, /fn mustache\(&self\) -> Option<&dyn Renderer>;/);
      assert.match(resolverSrc, /fn jinja2\(&self\) -> Option<&dyn Renderer>;/);
      assert.match(resolverSrc, /fn liquid\(&self\) -> Option<&dyn Renderer>;/);
      assert.match(
        resolverSrc,
        /pub fn resolve<'a>\(kind: &str, provider: &'a dyn RendererProvider\) -> Option<&'a dyn Renderer>/,
      );
      assert.match(resolverSrc, /"mustache" => provider\.mustache\(\),/);
      // Closed dispatch: an unknown discriminator is a hard error, never None.
      assert.match(resolverSrc, /other => panic!/);

      // The generated mod.rs declares the resolver as a library module WITHOUT a
      // glob re-export — two dispatched seams would otherwise collide on `resolve`
      // (ambiguous_glob_reexports). Consumers reach it via the qualified path
      // `renderer_resolver::resolve`.
      const modSrc = readFileSync(path.join(rustOut, "mod.rs"), "utf8");
      assert.match(modSrc, /pub mod renderer_resolver;/);
      assert.doesNotMatch(modSrc, /pub use renderer_resolver::/);

      // Feed the proof the committed vectors that carry a scalar `expected`.
      const snapshot = JSON.parse(
        readFileSync(
          path.join(emitRoot, ".typra-generated", "vectors.json"),
          "utf8",
        ),
      ) as { vectors: { vector: Record<string, unknown> }[] };
      const vectors = snapshot.vectors
        .map((entry) => entry.vector)
        .filter((vector) => typeof vector.expected === "string")
        .map((vector) => {
          const input = vector.input as {
            agent: unknown;
            inputs: unknown;
          };
          return {
            name: vector.name as string,
            agent: JSON.stringify(input.agent),
            inputs: JSON.stringify(input.inputs),
            expected: vector.expected as string,
          };
        });
      assert.ok(vectors.length >= 2, "fixture must carry routed vectors");

      // Assemble a self-contained cargo crate: the emitted model library (which
      // now carries the RendererProvider trait + resolver fn) plus consumer
      // renderers and provider under tests/.
      const moduleDir = path.join(output, "module");
      const modelDir = path.join(moduleDir, "model");
      const testsDir = path.join(moduleDir, "tests");
      const targetDir = path.join(output, "cargo-target");
      mkdirSync(modelDir, { recursive: true });
      mkdirSync(testsDir, { recursive: true });

      for (const file of readdirSync(rustOut)) {
        if (file.endsWith(".rs")) {
          copyFileSync(path.join(rustOut, file), path.join(modelDir, file));
        }
      }

      writeFileSync(path.join(moduleDir, "Cargo.toml"), proofCargoToml());
      writeFileSync(path.join(moduleDir, "lib.rs"), "pub mod model;\n");
      writeFileSync(path.join(testsDir, "renderers.rs"), RENDERERS);

      // -- positive: full provider compiles and every vector routes to expected -
      writeFileSync(
        path.join(testsDir, "proof.rs"),
        fullProviderAndTest(vectors),
      );
      const green = runCargo(["test", "--", "--nocapture"], moduleDir, targetDir);
      assert.equal(
        green.status,
        0,
        `typed resolver should route every vector green:\n${green.output}`,
      );
      assert.match(
        green.output,
        /test typed_resolver_routes_every_vector \.\.\. ok/,
      );
      assert.doesNotMatch(green.output, /\bFAILED\b/);

      // -- negative control: drop the mustache slot => cannot compile -----------
      // Replace the positive test with a minimal partial-provider impl so the
      // ONLY error is the missing trait item.
      rmSync(path.join(testsDir, "proof.rs"), { force: true });
      rmSync(path.join(testsDir, "renderers.rs"), { force: true });
      writeFileSync(path.join(testsDir, "proof.rs"), partialProviderTest());
      const red = runCargo(["test", "--no-run"], moduleDir, targetDir);
      assert.notEqual(
        red.status,
        0,
        `a provider missing a @dispatch slot must fail to compile:\n${red.output}`,
      );
      // Require BOTH the specific diagnostic code AND the missing member: a bare
      // E0046 elsewhere, or an unrelated "mustache" mention, must not satisfy it.
      assert.match(
        red.output,
        /E0046/,
        `the build must fail with E0046 (unimplemented trait item):\n${red.output}`,
      );
      assert.match(
        red.output,
        /mustache/,
        `the missing member must be \`mustache\`:\n${red.output}`,
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
