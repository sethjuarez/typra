// Copyright (c) Microsoft. All rights reserved.

// Guard for issue #261: the Swift emit target's `harness-test-dir` option must
// place the @vector conformance harness (VectorConformanceTests.swift) into a
// package/dir decoupled from the model target's `test-dir`, so a split-package
// runtime (model types in one package, provider stages in a separate SDK
// package) can host the harness where every stage's adapter is reachable.
//
// Model per-type tests, discovery ConformanceTests, and protocol scaffolds must
// still land in `test-dir`; only the vector harness relocates. When the option
// is unset, the harness stays in `test-dir` (unchanged behavior).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function yamlString(value: string): string {
  return JSON.stringify(value);
}

const SPEC = [
  'import "@typra/emitter";',
  "",
  "namespace Repro;",
  "",
  "model Sample {",
  "  id: string;",
  "}",
  "",
  "const LoadVectors = #[",
  '  #{ name: "loads", input: #{ id: "x" }, expected: #{ id: "x" } }',
  "];",
  "",
  "interface Seam {",
  "  @vector(LoadVectors)",
  "  load(id: string): Sample;",
  "}",
  "",
].join("\n");

type Compiled = {
  root: string;
  modelTestDir: string;
  harnessDir: string;
};

function makeWorkspace(): {
  root: string;
  generated: string;
  swiftOut: string;
  modelTestDir: string;
  harnessDir: string;
} {
  const root = mkdtempSync(path.join(process.cwd(), "tmp-swift-harness-"));
  const generated = path.join(root, "generated");
  const swiftOut = path.join(generated, "prompty-model");
  const modelTestDir = path.join(swiftOut, "Tests", "PromptyModelTests");
  // A sibling SDK package's test target, outside the model output tree.
  const harnessDir = path.join(
    generated,
    "prompty-sdk",
    "Tests",
    "PromptySDKTests",
  );
  return { root, generated, swiftOut, modelTestDir, harnessDir };
}

function runCompile(
  ws: ReturnType<typeof makeWorkspace>,
  useHarnessDir: boolean,
): void {
  const source = path.join(ws.root, "main.tsp");
  const config = path.join(ws.root, "tspconfig.yaml");
  const compilerEntry = require.resolve("@typespec/compiler");
  const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
  const tspCli = path.join(compilerRoot, "cmd", "tsp.js");

  writeFileSync(source, SPEC);
  writeFileSync(
    config,
    [
      "emit:",
      '  - "@typra/emitter"',
      "options:",
      '  "@typra/emitter":',
      `    emitter-output-dir: ${yamlString(ws.generated)}`,
      '    root-object: "Repro.Sample"',
      '    root-namespace: "Repro"',
      "    emit-targets:",
      "      - type: Swift",
      `        output-dir: ${yamlString(ws.swiftOut)}`,
      `        test-dir: ${yamlString(ws.modelTestDir)}`,
      ...(useHarnessDir
        ? [`        harness-test-dir: ${yamlString(ws.harnessDir)}`]
        : []),
      "        format: false",
      "",
    ].join("\n"),
  );

  execFileSync(process.execPath, [tspCli, "compile", source, "--config", config], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function compile(useHarnessDir: boolean): Compiled {
  const ws = makeWorkspace();
  runCompile(ws, useHarnessDir);
  return { root: ws.root, modelTestDir: ws.modelTestDir, harnessDir: ws.harnessDir };
}

describe("Swift @vector harness relocation via harness-test-dir (#261)", () => {
  it("emits the harness into harness-test-dir, keeping model tests in test-dir", () => {
    const c = compile(true);
    try {
      const relocated = path.join(c.harnessDir, "VectorConformanceTests.swift");
      const inModel = path.join(
        c.modelTestDir,
        "VectorConformanceTests.swift",
      );

      assert.ok(
        existsSync(relocated),
        "harness must be emitted into harness-test-dir",
      );
      assert.ok(
        !existsSync(inModel),
        "harness must NOT be emitted into the model test-dir",
      );

      // The relocated harness looks up the runtime-authored adapter registry by
      // name; the SDK package authors it beside the harness.
      const harness = readFileSync(relocated, "utf8");
      assert.match(harness, /VectorAdapters/);

      // Discovery ConformanceTests + model per-type tests stay in the model
      // package so they can import the model module.
      assert.ok(
        existsSync(path.join(c.modelTestDir, "ConformanceTests.swift")),
        "discovery ConformanceTests must remain in the model test-dir",
      );
      assert.ok(
        existsSync(path.join(c.modelTestDir, "SampleTests.swift")),
        "model per-type tests must remain in the model test-dir",
      );
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it("keeps the harness in test-dir when harness-test-dir is unset", () => {
    const c = compile(false);
    try {
      assert.ok(
        existsSync(path.join(c.modelTestDir, "VectorConformanceTests.swift")),
        "harness must default to the model test-dir",
      );
      assert.ok(
        !existsSync(path.join(c.harnessDir, "VectorConformanceTests.swift")),
        "harness must not appear in the SDK dir when the option is unset",
      );
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });
});

describe("Swift harness relocation reconciles across runs (#261)", () => {
  it("prunes the old test-dir harness when a later run relocates it, and preserves unmarked SDK files", () => {
    const ws = makeWorkspace();
    const modelHarness = path.join(
      ws.modelTestDir,
      "VectorConformanceTests.swift",
    );
    const relocatedHarness = path.join(
      ws.harnessDir,
      "VectorConformanceTests.swift",
    );
    try {
      // Run 1: harness lands in the model test-dir (no harness-test-dir).
      runCompile(ws, false);
      assert.ok(existsSync(modelHarness), "run 1 must emit the model-dir harness");

      // A hand-written, unmarked SDK test already lives in the SDK test target.
      mkdirSync(ws.harnessDir, { recursive: true });
      const handWritten = path.join(ws.harnessDir, "ProviderVectorTests.swift");
      writeFileSync(handWritten, "// hand-written SDK test\n");

      // Run 2: relocate the harness into the SDK package.
      runCompile(ws, true);

      assert.ok(
        existsSync(relocatedHarness),
        "run 2 must emit the harness into the SDK dir",
      );
      assert.ok(
        !existsSync(modelHarness),
        "run 2 must prune the stale model-dir harness (no orphan)",
      );
      assert.ok(
        existsSync(handWritten),
        "the unmarked hand-written SDK test must be preserved",
      );
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });

  it("prunes the relocated harness when a later run removes the option", () => {
    const ws = makeWorkspace();
    const modelHarness = path.join(
      ws.modelTestDir,
      "VectorConformanceTests.swift",
    );
    const relocatedHarness = path.join(
      ws.harnessDir,
      "VectorConformanceTests.swift",
    );
    try {
      runCompile(ws, true);
      assert.ok(existsSync(relocatedHarness), "run 1 must emit the SDK-dir harness");

      runCompile(ws, false);
      assert.ok(
        existsSync(modelHarness),
        "run 2 must emit the harness back into the model test-dir",
      );
      assert.ok(
        !existsSync(relocatedHarness),
        "run 2 must prune the stale relocated harness (no orphan)",
      );
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });
});
