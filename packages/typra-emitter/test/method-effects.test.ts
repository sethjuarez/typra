import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Model } from "@typespec/compiler";

import { buildExportSurfaceSnapshot } from "../src/contract-surface.js";
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

function canonicalPort(): { port: TypeNode; types: TypeNode[] } {
  const request = model("Request");
  const decision = model("Decision");
  const event = model("Event");
  const checkpoint = model("Checkpoint");
  const commit = model("Commit");
  const message = model("Message");
  const port = model("CanonicalEnginePort");
  port.isProtocol = true;
  port.methods = [
    {
      name: "authorize",
      returns: "Decision",
      description: "",
      params: { request: "Request" },
      optional: false,
      sync: false,
      runtimeCancellable: true,
      atomic: false,
      nonFatal: false,
    },
    {
      name: "append",
      returns: "void",
      description: "",
      params: { event: "Event" },
      optional: false,
      sync: false,
      runtimeCancellable: false,
      atomic: false,
      nonFatal: false,
    },
    {
      name: "appendWithCheckpoint",
      returns: "void",
      description: "",
      params: { events: "Event[]", checkpoint: "Checkpoint" },
      optional: false,
      sync: false,
      runtimeCancellable: false,
      atomic: true,
      nonFatal: false,
    },
    {
      name: "afterCommit",
      returns: "void",
      description: "",
      params: { effectId: "string", commit: "Commit" },
      optional: false,
      sync: false,
      runtimeCancellable: true,
      atomic: false,
      nonFatal: true,
    },
    {
      name: "format",
      returns: "Message[]",
      description: "",
      params: { value: "unknown" },
      optional: false,
      sync: true,
      runtimeCancellable: false,
      atomic: false,
      nonFatal: false,
    },
  ];
  return { port, types: [port, request, decision, event, checkpoint, commit, message] };
}

describe("@method effect metadata", () => {
  it("emits exact native cancellation signatures without changing void behavior", () => {
    const { port, types } = canonicalPort();
    const registry = TypeRegistry.fromTypeGraph(types);
    const file = lowerFile(port, registry);
    const decl = lowerType(port, registry, new Set());

    const csharp = emitCSharpClass(
      decl,
      "Typra.Fixtures",
      new CSharpExprVisitor(registry),
      [decl],
      () => undefined,
    );
    assert.match(csharp, /Task<Decision> AuthorizeAsync\(Request request, CancellationToken cancellationToken = default\);/);
    assert.match(csharp, /Task AppendAsync\(Event @event\);/);
    assert.match(csharp, /Task AppendWithCheckpointAsync\(List<Event> events, Checkpoint checkpoint\);/);
    assert.match(csharp, /Task AfterCommitAsync\(string effectId, Commit commit, CancellationToken cancellationToken = default\);/);
    assert.match(csharp, /List<Message> Format\(object value\);/);

    const go = emitGoFileContent(file.types, "fixtures", new GoExprVisitor(registry), new Set());
    assert.match(go, /Authorize\(ctx context\.Context, request Request\) \(Decision, error\)/);
    assert.match(go, /Append\(event Event\) error/);
    assert.match(go, /AppendWithCheckpoint\(events \[\]Event, checkpoint Checkpoint\) error/);
    assert.match(go, /AfterCommit\(ctx context\.Context, effectId string, commit Commit\) error/);
    assert.match(go, /Format\(value interface\{\}\) \(\[\]Message, error\)/);

    const typeScript = emitTypeScriptFile(file, new TypeScriptExprVisitor(registry));
    assert.match(typeScript, /authorize\(request: Request, signal\?: AbortSignal\): Promise<Decision>;/);
    assert.match(typeScript, /append\(event: Event\): Promise<void>;/);
    assert.match(typeScript, /appendWithCheckpoint\(events: Event\[\], checkpoint: Checkpoint\): Promise<void>;/);
    assert.match(typeScript, /afterCommit\(effectId: string, commit: Commit, signal\?: AbortSignal\): Promise<void>;/);
    assert.match(typeScript, /format\(value: unknown\): Message\[\];/);

    const rust = emitRustFile(file, new RustExprVisitor(registry), new Set(), new Map(), {
      cancellationTokenPath: "crate::engine::CancellationToken",
    });
    assert.match(rust, /async fn authorize\(&self, request: &Request, cancellation: &CancellationToken\) -> Result<Decision, Box<dyn std::error::Error \+ Send \+ Sync>>;/);
    assert.match(rust, /async fn append\(&self, event: &Event\) -> Result<\(\), Box<dyn std::error::Error \+ Send \+ Sync>>;/);
    assert.match(rust, /async fn append_with_checkpoint\(&self, events: &Vec<Event>, checkpoint: &Checkpoint\) -> Result<\(\), Box<dyn std::error::Error \+ Send \+ Sync>>;/);
    assert.match(rust, /async fn after_commit\(&self, effect_id: &String, commit: &Commit, cancellation: &CancellationToken\) -> Result<\(\), Box<dyn std::error::Error \+ Send \+ Sync>>;/);
    assert.match(rust, /fn format\(&self, value: &serde_json::Value\) -> Vec<Message>;/);
    assert.doesNotMatch(rust, /PortError/);

    const python = emitPythonFile(file, new PythonExprVisitor(registry), "pipeline", {
      cancellationTokenPath: "prompty.core.cancellation.CancellationToken",
    });
    assert.match(python, /def authorize\(self, request: Request, cancellation: CancellationToken \| None = None\) -> Decision:/);
    assert.match(python, /async def authorize_async\(self, request: Request, cancellation: CancellationToken \| None = None\) -> Decision:/);
    assert.match(python, /def append\(self, event: Event\) -> None:/);
    assert.match(python, /async def append_async\(self, event: Event\) -> None:/);
    assert.match(python, /def append_with_checkpoint\(self, events: list\[Event\], checkpoint: Checkpoint\) -> None:/);
    assert.match(python, /def after_commit\(self, effect_id: str, commit: Commit, cancellation: CancellationToken \| None = None\) -> None:/);
    assert.match(python, /async def after_commit_async\(self, effect_id: str, commit: Commit, cancellation: CancellationToken \| None = None\) -> None:/);
    assert.match(python, /def format\(self, value: Any\) -> list\[Message\]:/);
  });

  it("exports effect flags while keeping cancellation out of logical parameters and model properties", () => {
    const { port, types } = canonicalPort();
    const registry = TypeRegistry.fromTypeGraph(types);
    const lowered = lowerType(port, registry, new Set());
    const authorize = lowered.methods.find(method => method.name === "authorize");
    const appendWithCheckpoint = lowered.methods.find(method => method.name === "appendWithCheckpoint");
    const afterCommit = lowered.methods.find(method => method.name === "afterCommit");

    assert.deepEqual(authorize?.params, { request: "Request" });
    assert.equal(authorize?.runtimeCancellable, true);
    assert.equal(appendWithCheckpoint?.atomic, true);
    assert.equal(afterCommit?.nonFatal, true);
    assert.deepEqual(port.properties, []);
    assert.equal(Object.hasOwn(authorize?.params ?? {}, "cancellation"), false);
    assert.equal(Object.hasOwn(authorize?.params ?? {}, "signal"), false);
    assert.equal(Object.hasOwn(authorize?.params ?? {}, "ctx"), false);

    const snapshot = buildExportSurfaceSnapshot(
      "Typra.Fixtures.CanonicalEnginePort",
      "Typra.Fixtures",
      "CanonicalEnginePort",
      [{ type: "TypeScript" }],
      types,
    );
    const methods = snapshot.targets[0].protocols[0].methods;
    assert.deepEqual(
      methods.map(method => ({
        name: method.name,
        runtimeCancellable: method.runtimeCancellable,
        atomic: method.atomic,
        nonFatal: method.nonFatal,
      })),
      [
        { name: "afterCommit", runtimeCancellable: true, atomic: false, nonFatal: true },
        { name: "append", runtimeCancellable: false, atomic: false, nonFatal: false },
        { name: "appendWithCheckpoint", runtimeCancellable: false, atomic: true, nonFatal: false },
        { name: "authorize", runtimeCancellable: true, atomic: false, nonFatal: false },
        { name: "format", runtimeCancellable: false, atomic: false, nonFatal: false },
      ],
    );
  });

  it("keeps zero-parameter cancellable Python helpers callable", () => {
    const helper = model("StatusProvider");
    helper.methods = [{
      name: "status",
      returns: "string",
      description: "",
      params: {},
      optional: false,
      sync: true,
      runtimeCancellable: true,
      atomic: false,
      nonFatal: false,
    }];
    const registry = TypeRegistry.fromTypeGraph([helper]);
    const python = emitPythonFile(
      lowerFile(helper, registry),
      new PythonExprVisitor(registry),
      "pipeline",
      { cancellationTokenPath: "prompty.core.cancellation.CancellationToken" },
    );

    assert.match(python, /def status\(self, cancellation: CancellationToken \| None = None\) -> str:/);
    assert.doesNotMatch(python, /@property\s+def status/);
  });
});
