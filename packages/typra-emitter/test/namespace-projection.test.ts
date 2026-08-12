import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  goPackageNameFromNamespace,
  javaPackageName,
  projectNamespace,
  relativeNamespaceSegments,
  swiftModuleName,
} from "../src/ir/namespace.js";

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
