import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";

// Regression: TWO further language-target bugs that surface ONLY in GENERATED
// conformance / model output for a dispatched, coerce-union, OPTIONAL seam
// (2.0.1 target fixes). The 2.0.0 pass fixed the Swift discriminator accessor
// and the Go SEAM accessor, but the same reshape was not propagated to every
// conformance-test generator:
//
//   Rust#1 — the per-interface conformance discriminator accessor must unwrap an
//            OPTIONAL intermediate along the dispatch path
//            (`agent.template.as_ref().expect("template present").format`,
//            `agent.model.as_ref().expect("model present")`) — the twin of the
//            Swift `!` force-unwrap. `agent.template` is `Option<Template>`, so a
//            bare `.format` is E0609 (no field on `Option`).
//   Go#2   — the per-MODEL conformance field-assertion generator must read a
//            coerce-union discriminator off the LOWERED `interface{}` field via a
//            type-assert to the Save interface (the twin of the seam accessor and
//            the union's own Save switch), not a direct `.Format.Kind` field
//            access that does not compile against `interface{}`.
//
// The `dispatch-target-regression` fixture reproduces both: `Agent.template?` is
// optional (Rust#1), and its @sample pins `template.format` as the coerce-union
// bare-string shorthand so the per-model conformance reads the discriminator off
// the lowered `interface{}` field (Go#2). Each assertion fails on the pre-fix
// emitter and passes on the fix.

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

describe("optional/coerce-union conformance regressions (2.0.1 target fixes)", () => {
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
    // `agent.template` is `Option<Template>`: it must be unwrapped with
    // `.as_ref().expect(...)` before `.format` (else E0609 on `Option`).
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
    // `agent.model` is itself the OPTIONAL union (`Option<serde_json::Value>`),
    // so the unwrap applies even when the optional field is the terminal segment.
    assert.ok(
      processor.includes('agent.model.as_ref().expect("model present")'),
      "optional `model?` must be unwrapped to reach the union",
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
