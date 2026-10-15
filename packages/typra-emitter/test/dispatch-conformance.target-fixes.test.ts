import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";

// Regression: language-target bugs that surface ONLY in GENERATED
// conformance / model output for a dispatched, coerce-union, optional seam
// (2.0.0 target fixes). The `dispatch-target-regression` fixture stands up a
// single seam that reproduces all four; this suite generates it in-process for
// the four affected targets and asserts the FIXED rendering — each assertion
// fails on the pre-fix emitter and passes on the fix.
//
//   Go#1   — a vector input carrying a ```python fence must be embedded as a Go
//            INTERPRETED (double-quoted) literal, not a backtick raw string the
//            fence would terminate.
//   Java#2 — a `Record<unknown>` op param must be FQN-qualified to
//            `java.util.Map<String, Object>` (the conformance class imports
//            nothing).
//   Swift#3 — an OPTIONAL `template?`/`model?` along the dispatch path must use
//            optional chaining so absence reaches the wildcard fallback.
//   Rust#4 — the coerce-union bare-string shorthand must canonicalize known
//            discriminator values and preserve unknown values in the wildcard.

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "features",
  "dispatch-target-regression",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.Features.DispatchTargetRegression.Root";

/** Recursively find the first file whose basename matches `name`. */
function findFile(root: string, name: string): string {
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      const hit = findFileOrNull(full, name);
      if (hit) return hit;
    } else if (entry === name) {
      return full;
    }
  }
  throw new Error(`${name} not found under ${root}`);
}

function findFileOrNull(root: string, name: string): string | null {
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      const hit = findFileOrNull(full, name);
      if (hit) return hit;
    } else if (entry === name) {
      return full;
    }
  }
  return null;
}

describe("language-target conformance/model regressions (2.0.0 target fixes)", () => {
  let output: string;
  let result: Awaited<ReturnType<typeof generate>>;

  before(async () => {
    output = mkdtempSync(path.join(tmpdir(), "typra-target-fixes-"));
    result = await generate({
      output,
      source: FIXTURE,
      rootObject: ROOT_OBJECT,
      targets: [
        "typescript",
        "python",
        "go",
        "csharp",
        "java",
        "swift",
        "rust",
      ],
      format: false,
      generateTests: true,
      deterministic: true,
    });
  });

  it("emits across every affected target", () => {
    assert.equal(
      result.success,
      true,
      `emit must succeed for the target-regression seam, got: ${result.errors?.join(
        "\n",
      )}`,
    );
  });

  it("Go#1: a ```python fence vector is embedded as an interpreted literal, not a raw string", () => {
    const src = readFileSync(
      findFile(path.join(output, "go"), "renderer_conformance_test.go"),
      "utf8",
    );
    // The fence payload switches to a double-quoted literal, so the fence
    // appears JSON-escaped (`\n` then triple backtick) INSIDE double quotes —
    // impossible in the pre-fix backtick raw-string form (which the fence would
    // terminate outright).
    assert.ok(
      src.includes('\\n```python'),
      "fence vector must be embedded as an escaped double-quoted Go literal",
    );
    assert.ok(
      src.includes('inputJSON := "'),
      "at least one vector must use the interpreted double-quoted literal form",
    );
    // Backtick-free payloads must still use the readable raw-string form — the
    // fix is selective, not a blanket switch to escaped literals.
    assert.ok(
      src.includes("inputJSON := `"),
      "backtick-free vectors must retain the Go raw-string literal form",
    );
  });

  it("Java#2: a Record<unknown> op param is FQN-qualified to java.util.Map", () => {
    const src = readFileSync(
      findFile(path.join(output, "java"), "RendererConformanceTests.java"),
      "utf8",
    );
    assert.ok(
      src.includes(
        'java.util.Map<String, Object> inputs = (java.util.Map<String, Object>) input.get("inputs");',
      ),
      "inputs param must be cast through the FQN java.util.Map",
    );
    assert.doesNotMatch(
      src,
      /(?<!java\.util\.)\bMap<String, Object> inputs/,
      "the conformance class imports nothing, so a bare Map<...> would not compile",
    );
  });

  it("Swift#3: optional template?/model? along the dispatch path are navigated safely", () => {
    const renderer = readFileSync(
      findFile(path.join(output, "swift"), "RendererConformanceTests.swift"),
      "utf8",
    );
    assert.ok(
      renderer.includes(
        '((try agent.template?.format.save())?["format_kind"] as? String) ?? ""',
      ),
      "an absent optional `template?` must route through wildcard fallback",
    );
    const processor = readFileSync(
      findFile(path.join(output, "swift"), "ProcessorConformanceTests.swift"),
      "utf8",
    );
    assert.ok(
      processor.includes(
        '((try agent.model?.save())?["model_provider"] as? String) ?? ""',
      ),
      "an absent optional `model?` must route through wildcard fallback",
    );
  });

  it("Swift scalar-coercion tests expect the canonical known variant", () => {
    const src = readFileSync(
      findFile(path.join(output, "swift"), "FormatConfigTests.swift"),
      "utf8",
    );
    assert.match(src, /if case \.mustacheFormat = instance/);
    assert.doesNotMatch(src, /if case \.customFormat = instance/);
  });

  it("Rust#4: coerce-union bare-string shorthand canonicalizes known variants and preserves unknown values", () => {
    const src = readFileSync(
      findFile(path.join(output, "rust"), "format_config.rs"),
      "utf8",
    );
    assert.match(src, /kind: match value\.as_str\(\) \{/);
    assert.match(src, /"jinja2" => FormatConfigKind::Jinja2Format/);
    assert.match(src, /"mustache" => FormatConfigKind::MustacheFormat/);
    assert.match(
      src,
      /_ => FormatConfigKind::CustomFormat \{ kind_name: value, raw: serde_json::Map::new\(\) \}/,
    );
    assert.doesNotMatch(
      src,
      /kind: value\.into\(\)/,
      "no `From<String>` exists for the *Kind enum, so `value.into()` must not be emitted",
    );
  });

  it("uses one lowering contract across all seven targets while keeping syntax local", () => {
    const ts = readFileSync(
      findFile(path.join(output, "typescript"), "renderer.conformance.test.ts"),
      "utf8",
    );
    assert.match(ts, /agent\?\.template\?\.format\?\.kind \?\? ""/);

    const python = readFileSync(
      findFile(path.join(output, "python"), "test_renderer_conformance.py"),
      "utf8",
    );
    assert.match(
      python,
      /getattr\(getattr\(getattr\(agent, "template", None\), "format", None\), "kind", None\)/,
    );
    assert.match(
      python,
      /from typra\.fixtures\.features\.dispatchtargetregression import Agent/,
      "model imports must remain in the semantic subpackage",
    );
    assert.match(
      python,
      /from typra\._renderer_resolver import resolve_renderer/,
      "an undecorated sub-namespace seam must import its root-emitted resolver from the package root",
    );

    const csharp = readFileSync(
      findFile(path.join(output, "csharp"), "RendererConformanceTests.cs"),
      "utf8",
    );
    assert.match(csharp, /agent\?\.Template\?\.Format\?\.Kind \?\? ""/);

    const java = readFileSync(
      findFile(path.join(output, "java"), "RendererConformanceTests.java"),
      "utf8",
    );
    assert.match(
      java,
      /agent\.template == null \|\| agent\.template\.format == null \? null : agent\.template\.format\.kind/,
    );

    const go = readFileSync(
      findFile(path.join(output, "go"), "renderer_conformance_test.go"),
      "utf8",
    );
    assert.ok(
      go.includes('if agent.Template == nil {\n\t\t\treturn ""'),
      "Go must guard an absent optional typed intermediate before dereferencing it",
    );
    assert.ok(
      go.includes(
        't.Fatalf("dispatch container %T does not implement generated Save"',
      ),
      "an unexpected non-serializable dispatch container must fail visibly",
    );
    assert.ok(go.includes('["format_kind"].(string)'));

    const rust = readFileSync(
      findFile(path.join(output, "rust"), "renderer_conformance_test.rs"),
      "utf8",
    );
    assert.match(rust, /\.get\("format_kind"\)/);

    const swift = readFileSync(
      findFile(path.join(output, "swift"), "RendererConformanceTests.swift"),
      "utf8",
    );
    assert.ok(swift.includes('["format_kind"] as? String) ?? ""'));

    const processorFiles = {
      typescript: readFileSync(
        findFile(
          path.join(output, "typescript"),
          "processor.conformance.test.ts",
        ),
        "utf8",
      ),
      python: readFileSync(
        findFile(path.join(output, "python"), "test_processor_conformance.py"),
        "utf8",
      ),
      go: readFileSync(
        findFile(path.join(output, "go"), "processor_conformance_test.go"),
        "utf8",
      ),
      csharp: readFileSync(
        findFile(path.join(output, "csharp"), "ProcessorConformanceTests.cs"),
        "utf8",
      ),
      java: readFileSync(
        findFile(path.join(output, "java"), "ProcessorResolver.java"),
        "utf8",
      ),
      rust: readFileSync(
        findFile(path.join(output, "rust"), "processor_conformance_test.rs"),
        "utf8",
      ),
      swift: readFileSync(
        findFile(path.join(output, "swift"), "ProcessorConformanceTests.swift"),
        "utf8",
      ),
    };
    assert.ok(
      processorFiles.typescript.includes('agent?.model?.provider ?? ""'),
    );
    assert.ok(
      processorFiles.python.includes(
        'getattr(getattr(agent, "model", None), "provider", None)',
      ),
    );
    assert.ok(processorFiles.go.includes('["model_provider"].(string)'));
    assert.ok(processorFiles.csharp.includes('agent?.Model?.Provider ?? ""'));
    assert.ok(processorFiles.java.includes('switch (provider == null ? "" : provider)'));
    assert.ok(processorFiles.rust.includes('.get("model_provider")'));
    assert.ok(processorFiles.rust.includes(".unwrap_or_default()"));
    assert.ok(
      processorFiles.swift.includes('["model_provider"] as? String) ?? ""'),
    );

    for (const [target, rootFile, agentFile, requiredMarker, collectionMarker] of [
      ["typescript", "root.ts", "agent.ts", "requiredModel", "templates"],
      ["python", "_Root.py", "_Agent.py", "required_model", "templates"],
      ["go", "root.go", "agent.go", "RequiredModel", "Templates"],
      ["csharp", "Root.cs", "Agent.cs", "RequiredModel", "Templates"],
      ["java", "Root.java", "Agent.java", "requiredModel", "templates"],
      ["rust", "root.rs", "agent.rs", "required_model", "templates"],
      ["swift", "root.swift", "agent.swift", "requiredModel", "templates"],
    ] as const) {
      assert.ok(
        readFileSync(findFile(path.join(output, target), rootFile), "utf8").includes(
          requiredMarker,
        ),
        `${target} must emit the required value-backed field`,
      );
      assert.ok(
        readFileSync(
          findFile(path.join(output, target), agentFile),
          "utf8",
        ).includes(collectionMarker),
        `${target} must emit the optional collection fields`,
      );
    }
  });

  it("Rust owns direct-root discriminator strings and safely unwraps optional operation roots", () => {
    const direct = readFileSync(
      findFile(path.join(output, "rust"), "direct_renderer_conformance_test.rs"),
      "utf8",
    );
    assert.match(
      direct,
      /let kind: String = \(\|\| -> Option<String> \{/,
      "the discriminator must be owned instead of borrowing from a temporary to_value result",
    );
    assert.match(direct, /let __dispatch_value = __dispatch_root\.to_value/);
    assert.match(direct, /resolve\(&kind, &provider\)/);

    const optional = readFileSync(
      findFile(
        path.join(output, "rust"),
        "optional_renderer_conformance_test.rs",
      ),
      "utf8",
    );
    assert.match(optional, /let __dispatch_root = agent\.as_ref\(\)\?;/);
    assert.match(
      optional,
      /let __dispatch_0 = __dispatch_root\.template\.as_ref\(\)\?;/,
    );
    assert.match(optional, /\.unwrap_or_default\(\);/);
  });

  it("Go executes direct-root dispatch with a typed base argument without hiding serialization failures", () => {
    const direct = readFileSync(
      findFile(
        path.join(output, "go"),
        "direct_renderer_conformance_test.go",
      ),
      "utf8",
    );
    assert.match(
      direct,
      /formatDispatchValue, err := fixtures\.LoadFormatConfig/,
      "the polymorphic loader result must remain available for dispatch",
    );
    assert.match(
      direct,
      /formatSerializable, ok := any\(formatDispatchValue\)\.\(interface \{[\s\S]*?Save\(\*fixtures\.SaveContext\) map\[string\]interface\{\}/,
      "a non-serializable dispatch root must still fail visibly",
    );
    assert.match(
      direct,
      /var format fixtures\.FormatConfig[\s\S]*?json\.Unmarshal\(formatBytes, &format\)/,
      "the seam call must receive its declared concrete base type",
    );
    assert.match(
      direct,
      /any\(formatDispatchValue\)\.\(interface \{[\s\S]*?ResolveDirectRenderer\(kind,/,
      "routing must read the discriminator from the loaded polymorphic value",
    );
    assert.match(direct, /actual != "direct:mustache"/);
    assert.match(direct, /actual != "direct:wildcard:liquid:gamma"/);
  });

  it("Java null-checks optional dispatch heads", () => {
    const optionalJava = readFileSync(
      findFile(
        path.join(output, "java"),
        "OptionalRendererConformanceTests.java",
      ),
      "utf8",
    );
    assert.match(
      optionalJava,
      /agent == null \|\| agent\.template == null/,
      "the optional operation head must be guarded before nested member access",
    );

  });
});
