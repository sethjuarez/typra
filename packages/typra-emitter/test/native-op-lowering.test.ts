import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Model } from "@typespec/compiler";

import { TypeNode } from "../src/ir/ast.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { lowerFile, lowerType } from "../src/ir/lower.js";
import { emitCSharpClass } from "../src/languages/csharp/emitter.js";
import { CSharpExprVisitor } from "../src/languages/csharp/visitor.js";
import { emitGoFileContent } from "../src/languages/go/emitter.js";
import { GoExprVisitor } from "../src/languages/go/visitor.js";
import { emitPythonFile } from "../src/languages/python/emitter.js";
import { PythonExprVisitor } from "../src/languages/python/visitor.js";
import { emitRustFile } from "../src/languages/rust/emitter.js";
import { RustExprVisitor } from "../src/languages/rust/visitor.js";
import { emitTypeScriptFile } from "../src/languages/typescript/emitter.js";
import { TypeScriptExprVisitor } from "../src/languages/typescript/visitor.js";

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

describe("native-op optional/nullable lowering", () => {
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

  it("carries optional/nullable through every non-Rust backend seam", () => {
    const { port, types } = optionalSeam();
    const registry = TypeRegistry.fromTypeGraph(types);
    const file = lowerFile(port, registry);
    const decl = lowerType(port, registry, new Set());

    // Go: nullable is a pointer on both the optional param and the nullable
    // return; the value-returning optional op has no default body in an
    // interface, so GAP 3 cannot arise here.
    const go = emitGoFileContent(
      file.types,
      "fixtures",
      new GoExprVisitor(registry),
      new Set(),
    );
    assert.match(go, /WriteSummary\(summary \*SessionSummary\) error/);
    assert.match(go, /LoadCheckpoint\(id string\) \(\*Checkpoint, error\)/);

    // Python: `| None` on both, and the optional value-returning op diverges
    // with `raise NotImplementedError` rather than a type-incorrect `return
    // None` (the GAP 3 analog to Rust's `unimplemented!()`).
    const python = emitPythonFile(file, new PythonExprVisitor(registry), "pipeline", {});
    assert.match(
      python,
      /def write_summary\(self, summary: SessionSummary \| None\) -> None:/,
    );
    assert.match(
      python,
      /def load_checkpoint\(self, id: str\) -> Checkpoint \| None:/,
    );
    assert.match(
      python,
      /def pre_render\(self, prompt: str\) -> str:\s*raise NotImplementedError/,
    );
    assert.doesNotMatch(python, /def pre_render\(self, prompt: str\) -> str:\s*return None/);

    // TypeScript: `| null` on both; the optional op is modeled by an optional
    // method (`preRender?`), so there is no type-incorrect default body.
    const ts = emitTypeScriptFile(file, new TypeScriptExprVisitor(registry));
    assert.match(ts, /writeSummary\(summary: SessionSummary \| null\): Promise<void>;/);
    assert.match(ts, /loadCheckpoint\(id: string\): Promise<Checkpoint \| null>;/);
    assert.match(ts, /preRender\?\(prompt: string\): string;/);

    // C#: `?` nullable on both the optional param and the nullable return.
    const csharp = emitCSharpClass(
      decl,
      "Typra.Fixtures",
      new CSharpExprVisitor(registry),
      [decl],
      () => undefined,
    );
    assert.match(csharp, /Task WriteSummaryAsync\(SessionSummary\? summary\);/);
    assert.match(csharp, /Task<Checkpoint\?> LoadCheckpointAsync\(string id\);/);
  });
});
