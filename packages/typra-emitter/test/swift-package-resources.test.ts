// Copyright (c) Microsoft. All rights reserved.

// Integration guard for issue #260: the Swift emit target's `test-resources`
// option must flow through the driver into the regenerated Package.swift so a
// downstream project's bundled test resources survive `tsp compile`. The unit
// tests in swift-emitter.test.ts lock emitSwiftPackage directly; this test
// locks the option-to-driver wiring end to end (a regression that dropped the
// forwarding would leave those unit tests green but this one red).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
].join("\n");

function compile(testResources?: string[]): string {
  const root = mkdtempSync(path.join(process.cwd(), "tmp-swift-resources-"));
  const source = path.join(root, "main.tsp");
  const config = path.join(root, "tspconfig.yaml");
  const generated = path.join(root, "generated");
  const swiftOut = path.join(generated, "swift");
  const swiftTestDir = path.join(swiftOut, "Tests", "ReproTests");
  const compilerEntry = require.resolve("@typespec/compiler");
  const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
  const tspCli = path.join(compilerRoot, "cmd", "tsp.js");

  try {
    writeFileSync(source, SPEC);
    writeFileSync(
      config,
      [
        "emit:",
        '  - "@typra/emitter"',
        "options:",
        '  "@typra/emitter":',
        `    emitter-output-dir: ${yamlString(generated)}`,
        '    root-object: "Repro.Sample"',
        '    root-namespace: "Repro"',
        "    emit-targets:",
        "      - type: Swift",
        `        output-dir: ${yamlString(swiftOut)}`,
        `        test-dir: ${yamlString(swiftTestDir)}`,
        ...(testResources
          ? [
              "        test-resources:",
              ...testResources.map((r) => `          - ${yamlString(r)}`),
            ]
          : []),
        "        format: false",
        "",
      ].join("\n"),
    );

    execFileSync(
      process.execPath,
      [tspCli, "compile", source, "--config", config],
      { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    return readFileSync(path.join(swiftOut, "Package.swift"), "utf8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Swift Package.swift test resources flow through the driver (#260)", () => {
  it("emits resources: on the test target when test-resources is configured", () => {
    const pkg = compile(["Resources"]);
    assert.match(pkg, /\.testTarget\(/);
    assert.match(pkg, /resources: \[\.process\("Resources"\)\]/);
  });

  it("omits resources: when test-resources is not configured", () => {
    const pkg = compile();
    assert.match(pkg, /\.testTarget\(/);
    assert.doesNotMatch(pkg, /resources:/);
  });
});
