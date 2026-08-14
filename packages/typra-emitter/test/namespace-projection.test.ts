import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Model } from "@typespec/compiler";
import {
  applyNamespaceGroups,
  goPackageNameFromNamespace,
  javaPackageName,
  projectNamespace,
  relativeNamespaceSegments,
  swiftModuleName,
} from "../src/ir/namespace.js";
import { TypeNode } from "../src/ir/ast.js";

describe("namespace projection", () => {
  it("computes relative namespace segments from the semantic root", () => {
    assert.deepEqual(
      relativeNamespaceSegments("Typra.Prompty.Runtime.Tools", "Typra.Prompty"),
      ["Runtime", "Tools"],
    );
    assert.deepEqual(
      relativeNamespaceSegments("External.Contracts", "Typra.Prompty"),
      ["External", "Contracts"],
    );
  });

  it("preserves existing target default package and module names", () => {
    assert.equal(javaPackageName("Typra.Prompty.Runtime"), "typra.prompty.runtime");
    assert.equal(goPackageNameFromNamespace("Typra.Prompty.Runtime"), "typrapromptyruntime");
    assert.equal(swiftModuleName("Typra.Prompty.Runtime"), "TypraPromptyRuntime");

    assert.deepEqual(
      projectNamespace({
        target: "python",
        sourceNamespace: "Typra.Prompty.Runtime",
        semanticRoot: "Typra.Prompty",
      }),
      {
        target: "python",
        sourceNamespace: "Typra.Prompty.Runtime",
        semanticRoot: "Typra.Prompty",
        relativeNamespace: ["Runtime"],
        isOutsideSemanticRoot: false,
        packageName: "typra.prompty.runtime",
        moduleName: "runtime",
        importPath: "typra.prompty.runtime",
        filesystemPath: ["runtime"],
        filesystemPathKind: "root-relative",
      },
    );
  });

  it("keeps semantic namespace separate from target package overrides", () => {
    assert.deepEqual(
      projectNamespace({
        target: "java",
        sourceNamespace: "Typra.Prompty.Runtime",
        semanticRoot: "Typra.Prompty",
        emitTarget: { "package-name": "com.example.prompty" },
      }),
      {
        target: "java",
        sourceNamespace: "Typra.Prompty.Runtime",
        semanticRoot: "Typra.Prompty",
        relativeNamespace: ["Runtime"],
        isOutsideSemanticRoot: false,
        packageName: "com.example.prompty",
        filesystemPath: ["com", "example", "prompty"],
        filesystemPathKind: "package",
      },
    );
  });

  it("lets Java package-name override namespace for package projection", () => {
    assert.equal(
      projectNamespace({
        target: "java",
        sourceNamespace: "Typra.Prompty.Runtime",
        emitTarget: {
          namespace: "ignored.namespace",
          "package-name": "com.example.prompty",
        },
      }).packageName,
      "com.example.prompty",
    );
  });

  it("projects runtime-specific namespace shapes deterministically", () => {
    assert.equal(
      projectNamespace({
        target: "typescript",
        sourceNamespace: "Typra.Prompty.Core",
        semanticRoot: "Typra.Prompty",
      }).targetNamespace,
      "Typra.Prompty",
    );
    assert.equal(
      projectNamespace({
        target: "csharp",
        sourceNamespace: "Typra.Prompty.Runtime",
        emitTarget: { namespace: "Company.Prompty" },
      }).targetNamespace,
      "Company.Prompty",
    );
    assert.equal(
      projectNamespace({
        target: "go",
        sourceNamespace: "Typra.Prompty.Runtime",
        emitTarget: { "package-name": "promptycontracts" },
      }).packageName,
      "promptycontracts",
    );
    assert.equal(
      projectNamespace({
        target: "swift",
        sourceNamespace: "1.Prompty Runtime",
      }).moduleName,
      "Typra1PromptyRuntime",
    );
    assert.equal(
      projectNamespace({
        target: "typescript",
        sourceNamespace: "Typra.Prompty",
      }).importPath,
      "../src/index",
    );
    assert.equal(
      projectNamespace({
        target: "rust",
        sourceNamespace: "Typra.Prompty",
      }).importPath,
      "crate",
    );
  });

  // Regression contract for how a *nested* TypeSpec namespace projects across
  // every target when the consumer configures a flat target namespace/package.
  //
  // Probe shape: `model App.Contracts.Core.Thing` with `root-namespace: "App"`.
  // The invariant this locks: the emitted *declaration identifier* (C# `namespace`,
  // Go/Java package name) is the single flat configured value and never gains the
  // `Contracts.Core` segments. Only targets that support module/folder nesting
  // reflect the nested namespace in `filesystemPath` (folders) and, for Rust,
  // `moduleName`. This is intentional — see the `## Namespace projection` table in
  // docs/reference/configuration and the systemic C# `IDE0130` suppression that
  // deliberately silences the folder-vs-namespace analyzer.
  const NESTED = "App.Contracts.Core";
  const ROOT = "App";

  it("keeps the C# namespace flat while nesting only the folder path", () => {
    const projection = projectNamespace({
      target: "csharp",
      sourceNamespace: NESTED,
      semanticRoot: ROOT,
      emitTarget: { namespace: "Prompty.Core" },
    });
    // Declaration identifier stays flat...
    assert.equal(projection.targetNamespace, "Prompty.Core");
    // ...while the file lands in a namespace-derived nested folder.
    assert.deepEqual(projection.filesystemPath, ["Contracts", "Core"]);
    assert.equal(projection.filesystemPathKind, "root-relative");
  });

  it("keeps Go a single flat package with no nested directories", () => {
    const projection = projectNamespace({
      target: "go",
      sourceNamespace: NESTED,
      semanticRoot: ROOT,
      emitTarget: { "package-name": "prompty", "import-path": "prompty/model" },
    });
    assert.equal(projection.packageName, "prompty");
    assert.equal(projection.importPath, "prompty/model");
    assert.deepEqual(projection.filesystemPath, []);
    assert.equal(projection.filesystemPathKind, "flat");
  });

  it("keeps the Java package flat, mapping only the package to a directory path", () => {
    const projection = projectNamespace({
      target: "java",
      sourceNamespace: NESTED,
      semanticRoot: ROOT,
      emitTarget: { "package-name": "com.prompty.core" },
    });
    // Package name does not absorb the nested `Contracts.Core` segments...
    assert.equal(projection.packageName, "com.prompty.core");
    // ...and the directory path mirrors the flat package, not the namespace.
    assert.deepEqual(projection.filesystemPath, ["com", "prompty", "core"]);
    assert.equal(projection.filesystemPathKind, "package");
  });

  it("nests Rust modules and folders for the nested namespace", () => {
    const projection = projectNamespace({
      target: "rust",
      sourceNamespace: NESTED,
      semanticRoot: ROOT,
      emitTarget: { "import-path": "prompty::model" },
    });
    assert.equal(projection.moduleName, "contracts::core");
    assert.equal(projection.importPath, "prompty::model");
    assert.deepEqual(projection.filesystemPath, ["contracts", "core"]);
    assert.equal(projection.filesystemPathKind, "root-relative");
  });

  it("nests Python subpackage folders while the import path stays the configured root", () => {
    const projection = projectNamespace({
      target: "python",
      sourceNamespace: NESTED,
      semanticRoot: ROOT,
      emitTarget: { "import-path": "prompty" },
    });
    assert.equal(projection.importPath, "prompty");
    assert.equal(projection.moduleName, "contracts.core");
    assert.deepEqual(projection.filesystemPath, ["contracts", "core"]);
    assert.equal(projection.filesystemPathKind, "root-relative");
  });

  it("nests Swift source folders but keeps a single flat module", () => {
    const projection = projectNamespace({
      target: "swift",
      sourceNamespace: NESTED,
      semanticRoot: ROOT,
      emitTarget: { "package-name": "PromptyCore" },
    });
    // Swift has no per-directory namespaces: the module is flat...
    assert.equal(projection.moduleName, "PromptyCore");
    // ...even though the source file is nested for organization.
    assert.deepEqual(projection.filesystemPath, ["Contracts", "Core"]);
    assert.equal(projection.filesystemPathKind, "root-relative");
  });

  it("nests TypeScript ESM folders for the nested namespace", () => {
    const projection = projectNamespace({
      target: "typescript",
      sourceNamespace: NESTED,
      semanticRoot: ROOT,
      emitTarget: { "import-path": "../index" },
    });
    assert.equal(projection.moduleName, "contracts/core");
    assert.deepEqual(projection.filesystemPath, ["contracts", "core"]);
    assert.equal(projection.filesystemPathKind, "root-relative");
  });

  it("signals namespaces outside the semantic root", () => {
    const projection = projectNamespace({
      target: "python",
      sourceNamespace: "External.Contracts",
      semanticRoot: "Typra.Prompty",
    });
    assert.equal(projection.isOutsideSemanticRoot, true);
    assert.deepEqual(projection.relativeNamespace, ["External", "Contracts"]);
  });
});

// Regression: how the module sub-path (`node.group`) is derived when a *nested*
// TypeSpec namespace and a source-folder-derived group (from `schema/model/<sub>/`)
// are BOTH present. A structural namespace projection is authoritative — it fully
// determines the sub-path and the folder-derived group is discarded, so the two
// never concatenate into doubled/junk segments. Before this contract, namespace
// `App.Contracts.Tracing` + source folder `tracing` emitted `contracts/tracing/tracing`,
// and a `contracts` folder emitted `contracts/tracing/contracts`.
describe("applyNamespaceGroups: namespace projection is authoritative over folder groups", () => {
  const ROOT = "App";

  function makeNode(namespace: string, folderGroup: string): TypeNode {
    const node = new TypeNode({} as Model, `Test ${namespace}`);
    node.typeName = { namespace, name: "Thing" };
    node.group = folderGroup;
    return node;
  }

  function groupAfter(namespace: string, folderGroup: string): string {
    const node = makeNode(namespace, folderGroup);
    applyNamespaceGroups([node], { target: "rust", semanticRoot: ROOT });
    return node.group;
  }

  it("drops a folder group that duplicates a trailing namespace segment (no doubling)", () => {
    // Probe B: source at `model/tracing/`, namespace `App.Contracts.Tracing`.
    assert.equal(groupAfter("App.Contracts.Tracing", "tracing"), "contracts/tracing");
  });

  it("drops a folder group that duplicates a leading namespace segment (no doubling)", () => {
    // Probe D: source at `model/contracts/tracing/` (collapses to folder `contracts`),
    // namespace `App.Contracts.Tracing`.
    assert.equal(groupAfter("App.Contracts.Tracing", "contracts"), "contracts/tracing");
  });

  it("drops a non-overlapping folder group in favor of the namespace path", () => {
    // The namespace is the single source of truth: source folder layout is irrelevant.
    assert.equal(groupAfter("App.Contracts.Tracing", "unrelated"), "contracts/tracing");
  });

  it("uses the namespace path when there is no folder group", () => {
    // Probe E / MINE: file flat under `model/`, namespace `App.Contracts.Core`.
    assert.equal(groupAfter("App.Contracts.Core", ""), "contracts/core");
  });

  it("preserves a folder group when the namespace is flat at the semantic root", () => {
    // Flat-namespace schemas (e.g. Typra's own `schema/model/<group>/` layout) keep
    // folder-based grouping: an empty namespace projection must not touch node.group.
    assert.equal(groupAfter("App", "events"), "events");
  });
});
