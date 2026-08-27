import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";

// Regression: language-target bugs that surface ONLY in GENERATED conformance /
// model output for a dispatched, coerce-union, OPTIONAL seam. The 2.0.0 pass fixed
// the Swift discriminator accessor and the Go SEAM accessor; 2.0.1 ported the
// optional-intermediate unwrap to Rust and the coerce-union read to the Go model
// conformance; 2.0.2 corrects the Rust unwrap to be LOWERING-aware and expands the
// value-backed coerce shorthand on load:
//
//   Rust#1 — the per-interface conformance discriminator accessor unwraps an
//            OPTIONAL intermediate only when its LOWERED type is `Option<T>`. A
//            typed-struct optional (`agent.template?: Template`) keeps the
//            `.as_ref().expect(...)` unwrap; a VALUE-BACKED optional coerce union
//            (`agent.model?: Model | string`) lowers to a bare `serde_json::Value`
//            (Rust drops the `Option`), so it must be read directly —
//            `agent.model.get("provider")`, never `.as_ref()` (E0599). (2.0.2 BUG3)
//   Go#2   — the per-MODEL conformance field-assertion generator must read a
//            coerce-union discriminator off the LOWERED `interface{}` field via a
//            type-assert to the Save interface (the twin of the seam accessor and
//            the union's own Save switch), not a direct `.Format.Kind` field
//            access that does not compile against `interface{}`.
//   Load#3 — a value-backed coerce union stores a bare `serde_json::Value`, so its
//            load path must expand a bare-string shorthand (`model: "gpt-4"` →
//            `{"id":"gpt-4"}`, `format: "mustache"` → `{"kind":"mustache"}`)
//            through the referenced type's string `@coerce` template, matching the
//            typed-child hydration every other runtime performs on load. (2.0.2)
//
// The `dispatch-target-regression` fixture reproduces all: `Agent.template?` is a
// typed-struct optional and `Agent.model?` a value-backed optional (Rust#1); its
// @sample pins `template.format`/`model` as coerce-union bare-string shorthands so
// the per-model conformance reads the discriminator off the lowered `interface{}`
// field (Go#2) and the load path exercises the shorthand expansion (Load#3).

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "features",
  "dispatch-target-regression",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.Features.DispatchTargetRegression.Root";

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

/** Recursively find the first file whose basename matches `name`. */
function findFile(root: string, name: string): string {
  const hit = findFileOrNull(root, name);
  if (!hit) throw new Error(`${name} not found under ${root}`);
  return hit;
}

describe("optional/coerce-union conformance regressions (2.0.1/2.0.2 target fixes)", () => {
  let output: string;
  let result: Awaited<ReturnType<typeof generate>>;

  before(async () => {
    output = mkdtempSync(path.join(tmpdir(), "typra-optional-coerce-fixes-"));
    result = await generate({
      output,
      source: FIXTURE,
      rootObject: ROOT_OBJECT,
      targets: ["go", "rust"],
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

  it("Rust#1: an optional intermediate along the dispatch path is unwrapped before the union read", () => {
    const renderer = readFileSync(
      findFile(path.join(output, "rust"), "renderer_conformance_test.rs"),
      "utf8",
    );
    // `agent.template` is `Option<Template>` (a TYPED struct): it must be unwrapped
    // with `.as_ref().expect(...)` before `.format` (else E0609 on `Option`).
    assert.ok(
      renderer.includes(
        'agent.template.as_ref().expect("template present").format',
      ),
      "optional `template?` must be unwrapped to reach the union field",
    );
    assert.doesNotMatch(
      renderer,
      /agent\.template\s*\n\s*\.get\(/,
      "the pre-fix bare `agent.template\\n.get(...)` must not be emitted",
    );

    const processor = readFileSync(
      findFile(path.join(output, "rust"), "processor_conformance_test.rs"),
      "utf8",
    );
    // `agent.model` is a VALUE-BACKED optional coerce union: Rust drops the
    // `Option` (bare `serde_json::Value`, `Value::Null` is the absent sentinel),
    // so the discriminator must be read DIRECTLY off the Value — `.as_ref()` on a
    // bare `serde_json::Value` is E0599 (2.0.2 BUG3). The unwrap is gated on the
    // LOWERED type being `Option<T>`, not on schema optionality.
    assert.match(
      processor,
      /agent\.model\s*\n?\s*\.get\("provider"\)/,
      "value-backed optional `model?` must read the discriminator directly off the Value",
    );
    assert.doesNotMatch(
      processor,
      /agent\.model\.as_ref\(\)/,
      "a bare `serde_json::Value` has no `.as_ref()` — the unwrap must be skipped",
    );
  });

  it("2.0.2 load-coerce: a value-backed coerce union expands its bare-string shorthand on load", () => {
    // The value-backed coerce union lowers to a bare `serde_json::Value`; unlike
    // every other runtime it would otherwise store the raw shorthand string. The
    // load path must expand it through the referenced type's string `@coerce`
    // template so `load_from_value` yields the canonical object on every runtime.
    const agent = readFileSync(
      findFile(path.join(output, "rust"), "agent.rs"),
      "utf8",
    );
    // Model coerces the bare id → `{ "id": <value> }` (NOT the `provider` discriminator).
    assert.match(
      agent,
      /model:\s*value\.get\("model"\)\.map\(\|v\|\s*if let Some\(s\) = v\.as_str\(\) \{ serde_json::json!\(\{ "id": s \}\)/,
      "`model: \"gpt-4\"` must expand to `{ \"id\": \"gpt-4\" }` on load",
    );

    const template = readFileSync(
      findFile(path.join(output, "rust"), "template.rs"),
      "utf8",
    );
    // FormatConfig coerces the bare dialect → `{ "kind": <value> }` (IS the discriminator).
    assert.match(
      template,
      /format:\s*value\.get\("format"\)\.map\(\|v\|\s*if let Some\(s\) = v\.as_str\(\) \{ serde_json::json!\(\{ "kind": s \}\)/,
      "`format: \"mustache\"` must expand to `{ \"kind\": \"mustache\" }` on load",
    );
  });

  it("Go#2: a coerce-union discriminator is read off the interface{} field via Save, not a direct .Kind", () => {
    const src = readFileSync(
      findFile(path.join(output, "go"), "agent_test.go"),
      "utf8",
    );
    // The coerce-union `Format` lowers to `interface{}`: the discriminator must be
    // read off the serialized form, mirroring the seam accessor + the union's Save
    // switch, never a `.Format.Kind` that does not compile against `interface{}`.
    assert.ok(
      src.includes("instance.Template.Format.(interface {"),
      "the coerce-union field must be type-asserted to the Save interface",
    );
    assert.ok(
      src.includes('.Save(') && src.includes('["kind"].(string)'),
      "the discriminator must be read off the Save map by its wire key",
    );
    assert.doesNotMatch(
      src,
      /\b(?:instance|reloaded)\.Template\.Format\.Kind\b/,
      "a direct `.Format.Kind` field access does not compile against interface{}",
    );
  });
});
