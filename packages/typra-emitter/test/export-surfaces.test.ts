import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Model } from "@typespec/compiler";

import { inferRootNamespace } from "../src/emitter.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { TypeNode } from "../src/ir/ast.js";
import { buildExportSurfaceSnapshot } from "../src/contract-surface.js";
import { lowerFile } from "../src/ir/lower.js";
import { goPackageNameFromNamespace } from "../src/languages/go/driver.js";
import { emitPythonFile } from "../src/languages/python/emitter.js";
import { emitPythonInit } from "../src/languages/python/scaffolding.js";
import { PythonExprVisitor } from "../src/languages/python/visitor.js";
import { emitRustGroupMod, emitRustLib } from "../src/languages/rust/driver.js";
import { emitTypeScriptIndex } from "../src/languages/typescript/scaffolding.js";
import {
  buildToolchainMetadata,
  formatUnsupportedTypeSpecVersionMessage,
  getToolchainMetadata,
  getUnsupportedTypeSpecPackages,
  reportToolchainCompatibility,
  shouldBlockUnsupportedTypeSpecToolchain,
} from "../src/compatibility.js";

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
  for (const child of childTypes) {
    child.base = node.typeName;
    child.group = group;
  }
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

  it("emits Python protocol method stubs without no-effect statements", () => {
    const registry = TypeRegistry.fromTypeGraph(baseTypes);
    const file = lowerFile(eventSink, registry);
    const source = emitPythonFile(file, new PythonExprVisitor(registry), "pipeline");

    assert.match(source, /from typing import Any, Protocol, runtime_checkable/);
    assert.match(
      source,
      /def emit\(self, event: Any\) -> None:\n        """Emit an event\."""\n        raise NotImplementedError/,
    );
    assert.doesNotMatch(source, /\n        \.\.\./);
    assert.doesNotMatch(source, /def emit\(self, event: Any\) -> None: \.\.\./);
  });

  it("prunes unused Python typing imports after rendering protocol-only files", () => {
    const checkpointStoreWithSave = makeType("CheckpointStore", "pipeline", [], true, [
      {
        name: "save",
        returns: "void",
        description: "Save a checkpoint.",
        params: { checkpoint: "Checkpoint" },
        optional: false,
        sync: false,
      },
    ]);
    const registry = TypeRegistry.fromTypeGraph([checkpoint, checkpointStoreWithSave]);
    const file = lowerFile(checkpointStoreWithSave, registry);
    const source = emitPythonFile(file, new PythonExprVisitor(registry), "pipeline");

    assert.match(source, /from typing import Protocol, runtime_checkable/);
    assert.doesNotMatch(source, /from typing import .*Any/);
    assert.match(source, /from \.\.events\._Checkpoint import Checkpoint/);
    assert.match(source, /def save\(self, checkpoint: Checkpoint\) -> None:/);
    assert.match(source, /async def save_async\(self, checkpoint: Checkpoint\) -> None:/);
  });

  it("builds deterministic target export surface snapshots", () => {
    const toolchain = buildToolchainMetadata([
      { name: "@typra/emitter", version: "0.2.5", supportedRange: "0.2.5" },
      { name: "@typespec/json-schema", version: "1.10.0", supportedRange: "1.10.0" },
      { name: "@typespec/compiler", version: "1.10.0", supportedRange: "1.10.0" },
    ]);
    const snapshot = buildExportSurfaceSnapshot(
      "Prompty.Prompty",
      "Prompty",
      "Prompty",
      [
        { type: "TypeScript", "output-dir": "generated/typescript" },
        { type: "Python", "output-dir": "generated/python" },
        { type: "Rust", "output-dir": "generated/rust" },
        { type: "Go", "output-dir": "generated/go", "package-name": "promptyruntime" },
      ],
      allTypes,
      toolchain,
    );

    const targets = new Map(snapshot.targets.map((target) => [target.target, target]));

    assert.deepEqual(snapshot.toolchain.packages.map((entry) => entry.name), [
      "@typespec/compiler",
      "@typespec/json-schema",
      "@typra/emitter",
    ]);
    assert.deepEqual(snapshot.toolchain.packages.map((entry) => entry.version), ["1.10.0", "1.10.0", "0.2.5"]);
    assert.deepEqual(targets.get("go")?.packageName, "promptyruntime");
    assert.deepEqual(targets.get("typescript")?.rootExports, [
      "AudioPart",
      "Checkpoint",
      "CheckpointStore",
      "ContentPart",
      "EventSink",
      "HostToolRequest",
      "TextPart",
    ]);
    assert.deepEqual(targets.get("python")?.groups.find((group) => group.name === "pipeline")?.exports, [
      "CheckpointStore",
      "EventSink",
    ]);
    assert.deepEqual(targets.get("typescript")?.groups.find((group) => group.name === "pipeline")?.modules, [
      "checkpoint-store",
      "event-sink",
    ]);
    assert.deepEqual(targets.get("python")?.groups.find((group) => group.name === "pipeline")?.modules, [
      "_CheckpointStore",
      "_EventSink",
    ]);
    assert.deepEqual(targets.get("rust")?.modules, ["context", "conversation", "events", "pipeline"]);
    assert.deepEqual(targets.get("typescript")?.protocols, [
      {
        name: "CheckpointStore",
        group: "pipeline",
        symbol: "CheckpointStore",
        source: "./pipeline/checkpoint-store",
        methods: [],
      },
      {
        name: "EventSink",
        group: "pipeline",
        symbol: "EventSink",
        source: "./pipeline/event-sink",
        methods: [
          {
            name: "emit",
            returns: "void",
            params: { event: "unknown" },
            optional: false,
            sync: true,
          },
        ],
      },
    ]);
  });
});

describe("TypeSpec compatibility guard", () => {
  it("accepts the validated TypeSpec toolchain versions", () => {
    const toolchain = buildToolchainMetadata([
      { name: "@typespec/compiler", version: "1.10.0", supportedRange: "1.10.0" },
      { name: "@typespec/json-schema", version: "1.10.0", supportedRange: "1.10.0" },
      { name: "@typra/emitter", version: "0.2.5", supportedRange: "0.2.5" },
    ]);

    assert.deepEqual(getUnsupportedTypeSpecPackages(toolchain), []);
  });

  it("resolves the installed validated TypeSpec toolchain versions", () => {
    const toolchain = getToolchainMetadata();

    assert.deepEqual(toolchain.packages.map((entry) => entry.name), [
      "@typespec/compiler",
      "@typespec/json-schema",
      "@typra/emitter",
    ]);
    assert.equal(toolchain.packages.find((entry) => entry.name === "@typespec/compiler")?.version, "1.10.0");
    assert.equal(toolchain.packages.find((entry) => entry.name === "@typespec/json-schema")?.version, "1.10.0");
    assert.equal(getUnsupportedTypeSpecPackages(toolchain).length, 0);
  });

  it("formats a clear diagnostic for unvalidated TypeSpec toolchain versions", () => {
    const toolchain = buildToolchainMetadata([
      { name: "@typespec/compiler", version: "1.13.0", supportedRange: "1.10.0" },
      { name: "@typespec/json-schema", version: "1.13.0", supportedRange: "1.10.0" },
      { name: "@typra/emitter", version: "0.2.5", supportedRange: "0.2.5" },
    ]);
    const unsupported = getUnsupportedTypeSpecPackages(toolchain);

    assert.deepEqual(unsupported.map((entry) => entry.name), ["@typespec/compiler", "@typespec/json-schema"]);
    assert.match(
      formatUnsupportedTypeSpecVersionMessage(unsupported, false),
      /validated with @typespec\/compiler@1\.10\.0, @typespec\/json-schema@1\.10\.0; found @typespec\/compiler@1\.13\.0, @typespec\/json-schema@1\.13\.0/,
    );
  });

  it("reports unvalidated TypeSpec versions as errors by default", () => {
    const diagnostics: Array<{ severity: string; message: string }> = [];
    const context = {
      options: {},
      program: {
        reportDiagnostic: (diagnostic: { severity: string; message: string }) => diagnostics.push(diagnostic),
      },
    };

    reportToolchainCompatibility(
      context,
      buildToolchainMetadata([
        { name: "@typespec/compiler", version: "1.13.0", supportedRange: "1.10.0" },
        { name: "@typespec/json-schema", version: "1.10.0", supportedRange: "1.10.0" },
      ]),
    );

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].severity, "error");
    assert.match(diagnostics[0].message, /Pin the TypeSpec toolchain to the supported versions/);
    assert.equal(shouldBlockUnsupportedTypeSpecToolchain(context.options, buildToolchainMetadata([
      { name: "@typespec/compiler", version: "1.13.0", supportedRange: "1.10.0" },
    ])), true);
  });

  it("can downgrade unvalidated TypeSpec versions to warnings by explicit option", () => {
    const diagnostics: Array<{ severity: string; message: string }> = [];
    const context = {
      options: { "allow-unsupported-typespec-version": true },
      program: {
        reportDiagnostic: (diagnostic: { severity: string; message: string }) => diagnostics.push(diagnostic),
      },
    };

    reportToolchainCompatibility(
      context,
      buildToolchainMetadata([{ name: "@typespec/compiler", version: "1.13.0", supportedRange: "1.10.0" }]),
    );

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].severity, "warning");
    assert.match(diagnostics[0].message, /allow-unsupported-typespec-version is enabled/);
    assert.equal(shouldBlockUnsupportedTypeSpecToolchain(context.options, buildToolchainMetadata([
      { name: "@typespec/compiler", version: "1.13.0", supportedRange: "1.10.0" },
    ])), false);
  });
});
