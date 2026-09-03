import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";

import { generate } from "../src/generate.js";

// Regression (prompty#511 static-target sweep): the Rust driver emitted a
// type's collection-field `save_<field>` / `load_<field>` helpers
// UNCONDITIONALLY, even when the owning type was NOT in a `@serializable`
// closure. Those helpers are consumed ONLY by `to_value` / `load_from_value`
// (both correctly gated on `type.serialized`) and they call the ELEMENT type's
// `to_value` / `load_from_value`. So for a non-serializable type holding a
// `Vec<NonSerializable>`, the emitter produced dead helpers that referenced the
// element type's now-pruned serializers -> Rust E0599, breaking `cargo build`.
//
// This is the exact shape the parent hit: `ValidationResult` (reachable only via
// an authored reference harness, hence out of every @serializable closure) still
// emitted `save_errors` / `load_errors` calling `ValidationError::to_value` /
// `load_from_value`, while `validation_error.rs` had those methods pruned.
//
// The fix gates collection-helper emission on `type.serialized`, matching C# and
// Swift (which already gate) and the load/save surface itself. This suite renders
// Rust for a non-serializable parent with a collection of a non-serializable
// element and asserts the parent emits NO serialization helper and NO reference
// to the element's pruned serializers. Red-first: pre-fix the parent's
// `validation_result.rs` contains `fn save_errors` + `ValidationError::load_from_value`.

const SPEC = `import "@typra/emitter";
namespace Typra.Fixtures.Test.CollectionGate;

@doc("Element type that is NOT reachable from any serializable root or seam.")
model ValidationError {
  @doc("Human-readable message.")
  message: string;

  @doc("Machine code.")
  code: string;
}

@doc("Parent holding a collection of the element type; itself non-serializable.")
model ValidationResult {
  @doc("Whether validation passed.")
  valid: boolean;

  @doc("Errors, a collection of a non-serializable element type.")
  errors?: ValidationError[];
}

@doc("Serializable root that does NOT reference ValidationResult, so the closure never reaches it.")
@serializable
model Root {
  @doc("A scalar only; nothing here reaches ValidationResult.")
  name: string;
}
`;

describe("Rust gates collection-field helpers on serializability (prompty#511)", () => {
  let specDir: string;
  let output: string;
  let result: Awaited<ReturnType<typeof generate>>;

  before(async () => {
    // The temp spec must live under the package root so `import "@typra/emitter"`
    // resolves against this package's own node_modules link.
    specDir = mkdtempSync(path.join(process.cwd(), ".tmp-coll-gate-"));
    output = mkdtempSync(path.join(process.cwd(), ".tmp-coll-gate-out-"));
    writeFileSync(path.join(specDir, "main.tsp"), SPEC, "utf8");
    result = await generate({
      output,
      source: path.join(specDir, "main.tsp"),
      rootObject: "Typra.Fixtures.Test.CollectionGate.Root",
      targets: ["rust"],
      format: false,
      generateTests: false,
      deterministic: true,
    });
  });

  after(() => {
    for (const dir of [specDir, output]) {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  const readRust = (basename: string): string => {
    const rustRoot = path.join(output, "rust");
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === basename) found.push(full);
      }
    };
    walk(rustRoot);
    assert.equal(
      found.length,
      1,
      `expected exactly one ${basename}, found ${found.length}`,
    );
    return readFileSync(found[0], "utf8");
  };

  it("emits Rust successfully", () => {
    assert.equal(
      result.success,
      true,
      `emit must succeed, got: ${result.errors?.join("\n")}`,
    );
  });

  it("non-serializable parent emits NO collection save/load helpers", () => {
    const src = readRust("validation_result.rs");
    assert.doesNotMatch(
      src,
      /fn (save|load)_errors\b/,
      `validation_result.rs must not emit collection helpers when the type is not serialized:\n${src}`,
    );
  });

  it("non-serializable parent has NO reference to the element's pruned serializers", () => {
    const src = readRust("validation_result.rs");
    // The element's own `to_value` / `load_from_value` are pruned (it is not
    // serializable); the parent must not reference them. `validate_input_at`
    // (validation, always emitted) is fine and intentionally not matched here.
    assert.doesNotMatch(
      src,
      /ValidationError::(to_value|load_from_value)\b/,
      `validation_result.rs must not call the pruned element serializers:\n${src}`,
    );
  });

  it("the non-serializable element itself has no to_value/load_from_value (sanity: it really is pruned)", () => {
    const src = readRust("validation_error.rs");
    assert.doesNotMatch(
      src,
      /pub fn (to_value|load_from_value)\b/,
      `validation_error.rs should have serializers pruned (it is not in any @serializable closure):\n${src}`,
    );
  });
});
