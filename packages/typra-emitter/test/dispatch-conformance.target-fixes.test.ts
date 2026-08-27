import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";

// Regression: FOUR language-target bugs that surface ONLY in GENERATED
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
//   Swift#3 — an OPTIONAL `template?`/`model?` along the dispatch path must be
//            force-unwrapped: `agent.template!.format` / `agent.model!`.
//   Rust#4 — the coerce-union bare-string shorthand must route the discriminator
//            through the `CustomFormat { kind_name, raw }` fallback arm, not
//            `value.into()` (no `From<String>` exists for the `*Kind` enum).

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
      targets: ["go", "java", "swift", "rust"],
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

  it("Swift#3: optional template?/model? along the dispatch path are force-unwrapped", () => {
    const renderer = readFileSync(
      findFile(path.join(output, "swift"), "RendererConformanceTests.swift"),
      "utf8",
    );
    assert.ok(
      renderer.includes("(agent.template!.format.save())"),
      "optional `template?` must be unwrapped to reach the union's save()",
    );
    const processor = readFileSync(
      findFile(path.join(output, "swift"), "ProcessorConformanceTests.swift"),
      "utf8",
    );
    assert.ok(
      processor.includes("(agent.model!.save())"),
      "optional `model?` must be unwrapped to reach the union's save()",
    );
  });

  it("Rust#4: coerce-union bare-string shorthand routes through the CustomFormat fallback, not value.into()", () => {
    const src = readFileSync(
      findFile(path.join(output, "rust"), "format_config.rs"),
      "utf8",
    );
    assert.ok(
      src.includes(
        "kind: FormatConfigKind::CustomFormat { kind_name: value, raw: serde_json::Map::new() }",
      ),
      "the bare-string discriminator must construct the CustomFormat fallback variant",
    );
    assert.doesNotMatch(
      src,
      /kind: value\.into\(\)/,
      "no `From<String>` exists for the *Kind enum, so `value.into()` must not be emitted",
    );
  });
});
