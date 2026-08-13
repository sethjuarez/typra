import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Model } from "@typespec/compiler";

import { TypeNode } from "../src/ir/ast.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { lowerFile } from "../src/ir/lower.js";
import { emitRustFile } from "../src/languages/rust/emitter.js";
import { RustExprVisitor } from "../src/languages/rust/visitor.js";

function model(name: string): TypeNode {
  const node = new TypeNode({} as Model, "");
  node.typeName = { namespace: "Typra.Fixtures", name };
  node.group = "pipeline";
  return node;
}

// Mirrors fixtures/features/protocols/main.tsp `OptionalSeam`: the seam carries
// nullability as the trailing "?" on the param/return type strings, exactly as
// native-op lowering (src/ir/callable.ts) now produces it.
function optionalSeam(): { port: TypeNode; types: TypeNode[] } {
  const sessionSummary = model("SessionSummary");
  const checkpoint = model("Checkpoint");
  const port = model("OptionalSeam");
  port.isProtocol = true;
  port.methods = [
    {
      name: "writeSummary",
      returns: "void",
      description: "",
      params: { summary: "SessionSummary?" },
      optional: false,
      sync: false,
      runtimeCancellable: false,
      atomic: false,
      nonFatal: false,
    },
    {
      name: "loadCheckpoint",
      returns: "Checkpoint?",
      description: "",
      params: { id: "string" },
      optional: false,
      sync: false,
      runtimeCancellable: false,
      atomic: false,
      nonFatal: false,
    },
    {
      name: "preRender",
      returns: "string",
      description: "",
      params: { prompt: "string" },
      optional: true,
      sync: true,
      runtimeCancellable: false,
      atomic: false,
      nonFatal: false,
    },
  ];
  return { port, types: [port, sessionSummary, checkpoint] };
}

describe("native-op optional/nullable lowering (Rust)", () => {
  it("carries optional params, nullable returns, and typed optional default bodies", () => {
    const { port, types } = optionalSeam();
    const registry = TypeRegistry.fromTypeGraph(types);
    const file = lowerFile(port, registry);
    const rust = emitRustFile(
      file,
      new RustExprVisitor(registry),
      new Set(),
      new Map(),
      {},
    );

    // GAP 1: `summary?: SessionSummary` keeps its optionality as `&Option<T>`.
    assert.match(
      rust,
      /async fn write_summary\(&self, summary: &Option<SessionSummary>\) -> Result<\(\), Box<dyn std::error::Error \+ Send \+ Sync>>;/,
    );

    // GAP 2: `Checkpoint | null` lowers to `Result<Option<Checkpoint>, ...>` and
    // never leaks raw union text or a phantom `null` import.
    assert.match(
      rust,
      /async fn load_checkpoint\(&self, id: &String\) -> Result<Option<Checkpoint>, Box<dyn std::error::Error \+ Send \+ Sync>>;/,
    );
    assert.doesNotMatch(rust, /Checkpoint \| null/);
    assert.doesNotMatch(rust, /use super::null::null;/);

    // GAP 3: an optional, value-returning `@sync` op diverges with
    // `unimplemented!()` rather than a type-incorrect `None` for its `String`.
    assert.match(
      rust,
      /fn pre_render\(&self, prompt: &String\) -> String \{\s*unimplemented!\("pre_render is an optional operation with no default"\)\s*\}/,
    );
    assert.doesNotMatch(rust, /-> String \{\s*None\s*\}/);
  });
});
