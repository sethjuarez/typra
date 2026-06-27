import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Model } from "@typespec/compiler";

import { inferRootNamespace } from "../src/emitter.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { TypeNode } from "../src/ir/ast.js";
import { lowerFile } from "../src/ir/lower.js";
import { goPackageNameFromNamespace } from "../src/languages/go/driver.js";
import { emitPythonInit } from "../src/languages/python/scaffolding.js";
import { emitRustGroupMod, emitRustLib } from "../src/languages/rust/driver.js";
import { emitTypeScriptIndex } from "../src/languages/typescript/scaffolding.js";

function makeType(
  name: string,
  group = "",
  childTypes: TypeNode[] = [],
  isProtocol = false,
  methods: TypeNode["methods"] = [],
): TypeNode {
  const node = new TypeNode({} as Model, `Test ${name}`);
  node.typeName = { namespace: "Prompty", name };
  node.group = group;
  node.childTypes = childTypes;
  node.isProtocol = isProtocol;
  node.methods = methods;
  return node;
}

describe("root naming", () => {
  it("infers the default root namespace from root-object", () => {
    assert.equal(inferRootNamespace("Prompty.Prompty"), "Prompty");
    assert.equal(inferRootNamespace("Typra.Fixtures.FixtureRoot"), "Typra.Fixtures");
  });

  it("derives Go package names from the emitted namespace and allows simple overrides", () => {
    assert.equal(goPackageNameFromNamespace("Prompty"), "prompty");
    assert.equal(goPackageNameFromNamespace("Typra.Fixtures"), "typrafixtures");
  });
});

describe("export surface scaffolding", () => {
  const textPart = makeType("TextPart", "conversation");
  const audioPart = makeType("AudioPart", "conversation");
  const contentPart = makeType("ContentPart", "conversation", [textPart, audioPart]);
  const checkpoint = makeType("Checkpoint", "events");
  const hostToolRequest = makeType("HostToolRequest", "events");
  const eventSink = makeType("EventSink", "pipeline", [], true, [
    {
      name: "emit",
      returns: "void",
      description: "Emit an event.",
      params: { event: "unknown" },
      optional: false,
      sync: true,
    },
  ]);
  const checkpointStore = makeType("CheckpointStore", "pipeline", [], true);
  const baseTypes = [contentPart, checkpoint, hostToolRequest, eventSink, checkpointStore];
  const allTypes = [...baseTypes, textPart, audioPart];

  it("keeps TypeScript root barrels broad across groups and protocols", () => {
    const index = emitTypeScriptIndex(baseTypes, allTypes);

    assert.match(index, /export \{ Checkpoint \} from "\.\/events\/checkpoint";/);
    assert.match(index, /export \{ HostToolRequest \} from "\.\/events\/host-tool-request";/);
    assert.match(index, /export type \{ EventSink \} from "\.\/pipeline\/event-sink";/);
    assert.match(index, /export type \{ CheckpointStore \} from "\.\/pipeline\/checkpoint-store";/);
    assert.match(index, /export \{ ContentPart, TextPart, AudioPart \} from "\.\/conversation\/content-part";/);
  });

  it("keeps Python package __init__ broad across groups and child types", () => {
    const init = emitPythonInit(baseTypes, allTypes);

    assert.match(init, /from \.events import \(\n    Checkpoint,\n    HostToolRequest,/);
    assert.match(init, /from \.conversation import \(\n    ContentPart,\n    TextPart,\n    AudioPart,/);
    assert.match(init, /"AudioPart",/);
    assert.match(init, /"CheckpointStore",/);
  });

  it("keeps Rust root and group modules re-exported", () => {
    const rootMod = emitRustLib(["context", "prompty"], ["events", "pipeline"]);
    const eventsMod = emitRustGroupMod(["checkpoint", "host_tool_request"]);

    assert.match(rootMod, /pub mod events;\npub use events::\*;/);
    assert.match(rootMod, /pub mod pipeline;\npub use pipeline::\*;/);
    assert.match(eventsMod, /pub mod checkpoint;\npub use checkpoint::\*;/);
    assert.match(eventsMod, /pub mod host_tool_request;\npub use host_tool_request::\*;/);
  });

  it("does not treat protocol void returns as importable model types", () => {
    const registry = TypeRegistry.fromTypeGraph(baseTypes);
    const file = lowerFile(eventSink, registry);

    assert.deepEqual(file.imports, []);
  });
});
