// Copyright (c) Microsoft. All rights reserved.

// Executable proof that the Part III typed @dispatch resolver (issue #282) is a
// COMPILE-TIME contract in Swift, not a runtime dictionary. We generate the
// committed `fixtures/dispatch-seam` spec for Swift, then exercise the EMITTED
// provider protocol + resolve switch (`RendererProvider` / `RendererResolver`)
// two ways:
//
//   * positive -> a struct conforming to every provider slot routes each
//                 committed vector's discriminator through
//                 `RendererResolver.resolve`, selecting the typed Renderer impl
//                 that reproduces `expected` (swift build + run)          => GREEN
//   * negative -> a struct that OMITS one slot fails to COMPILE: conforming to
//                 `RendererProvider` obliges every requirement, so a missing slot
//                 is a "does not conform" error, never a silent skip      => swiftc RED
//
// A green positive and a red (compile-error) negative together prove the
// resolver's completeness is enforced by the type system — the Swift form of §5
// control 2. The positive run also exercises §5 control 1 (correct route
// reproduces `expected`) through idiomatic, statically-typed call sites.
//
// The emitted models import Yams for their YAML seam; the proof only touches the
// JSON path, so a local stub Yams target keeps the package self-contained and
// network-free (the twin of the TypeScript proof's `yaml` shim).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "dispatch-seam",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.DispatchSeam.Root";
const MODULE = "TypraFixtures";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function swiftAvailable(): boolean {
  try {
    execFileSync("swift", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// A minimal Yams stand-in: the emitted TypraRuntime imports Yams for its YAML
// seam, but this proof drives only JSON, so the YAML entry points are never
// called. Providing module-scoped `load`/`dump` (the surface TypraRuntime
// references as `Yams.load`/`Yams.dump`) keeps the package buildable offline.
const YAMS_STUB = [
  "import Foundation",
  "",
  "public func load(yaml: String) throws -> Any? { return nil }",
  "public func dump(object: Any) throws -> String { return String() }",
  "",
].join("\n");

// Consumer renderer: understands only its own dialect's substitution braces
// (mustache `{{name}}`, jinja2 `{{ name }}`), so a wrong slot would leave the
// template unsubstituted. Stores the pattern SOURCE (a String is Sendable) so the
// struct satisfies the seam's `Sendable` refinement.
const DIALECT_RENDERER = [
  "import Foundation",
  `import ${MODULE}`,
  "",
  "struct DialectRenderer: Renderer {",
  "  let patternSource: String",
  "  func render(agent: Agent, inputs: Inputs) async throws -> String {",
  "    let pattern = try NSRegularExpression(pattern: patternSource)",
  "    let content = agent.template.content",
  "    let ns = content as NSString",
  "    let matches = pattern.matches(",
  "      in: content, range: NSRange(location: 0, length: ns.length))",
  "    var result = String()",
  "    var last = 0",
  "    for m in matches {",
  "      let full = m.range",
  "      result += ns.substring(",
  "        with: NSRange(location: last, length: full.location - last))",
  "      let key = ns.substring(with: m.range(at: 1))",
  "      if let value = inputs.values[key] { result += \"\\(value)\" }",
  "      last = full.location + full.length",
  "    }",
  "    result += ns.substring(from: last)",
  "    return result",
  "  }",
  "}",
  "",
].join("\n");

// FULL provider: every @dispatch slot attached (liquid explicitly nil to model a
// valid-but-unimplemented variant).
const FULL_PROVIDER = [
  "import Foundation",
  `import ${MODULE}`,
  "",
  "struct FullProvider: RendererProvider {",
  '  var mustache: (any Renderer)? { DialectRenderer(patternSource: "\\\\{\\\\{(\\\\w+)\\\\}\\\\}") }',
  '  var jinja2: (any Renderer)? { DialectRenderer(patternSource: "\\\\{\\\\{ (\\\\w+) \\\\}\\\\}") }',
  "  var liquid: (any Renderer)? { nil }",
  "}",
  "",
].join("\n");

// PARTIAL provider: DROPS the `mustache` slot. `RendererProvider` still requires
// it, so this struct cannot conform — the compile-time control. Named the same as
// the full provider so `main.swift` references it unchanged.
const PARTIAL_PROVIDER = [
  "import Foundation",
  `import ${MODULE}`,
  "",
  "struct FullProvider: RendererProvider {",
  '  var jinja2: (any Renderer)? { DialectRenderer(patternSource: "\\\\{\\\\{ (\\\\w+) \\\\}\\\\}") }',
  "  var liquid: (any Renderer)? { nil }",
  "}",
  "",
].join("\n");

// Proof driver: walk each committed vector's discriminator down the dispatch path
// on the TYPED Agent graph. The discriminator is read from the format union's
// serialized `kind` — the same `kind` the shape's own discriminator switch keys
// on — then routed through the emitted resolver to the typed impl.
const MAIN = [
  "import Foundation",
  `import ${MODULE}`,
  "",
  'let vectorsPath = ProcessInfo.processInfo.environment["VECTORS"]!',
  "let data = try Data(contentsOf: URL(fileURLWithPath: vectorsPath))",
  "let vectors = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]",
  "let provider = FullProvider()",
  "var failures = 0",
  "for vec in vectors {",
  '  let name = vec["name"] as! String',
  '  let input = vec["input"] as! [String: Any]',
  '  let agent = try Agent.load(input["agent"]!)',
  '  let inputs = try Inputs.load(input["inputs"]!)',
  '  let kind = (try agent.template.format.save())["kind"] as! String',
  "  guard let renderer = try RendererResolver.resolve(kind: kind, registry: provider) else {",
  '    print("FAIL \\(name): no impl attached for \\(kind)")',
  "    failures += 1",
  "    continue",
  "  }",
  "  let got = try await renderer.render(agent: agent, inputs: inputs)",
  '  let expected = vec["expected"] as! String',
  "  if got == expected {",
  '    print("PASS \\(name)")',
  "  } else {",
  "    print(\"FAIL \\(name): got '\\(got)' expected '\\(expected)'\")",
  "    failures += 1",
  "  }",
  "}",
  "if failures > 0 {",
  '  print("SUITE FAILED")',
  "  exit(1)",
  "}",
  'print("SUITE OK")',
  "",
].join("\n");

function packageManifest(): string {
  return [
    "// swift-tools-version: 5.9",
    "import PackageDescription",
    "",
    "let package = Package(",
    '  name: "Proof",',
    "  platforms: [.macOS(.v12)],",
    "  targets: [",
    '    .target(name: "Yams", path: "Sources/Yams"),',
    `    .target(name: "${MODULE}", dependencies: ["Yams"], path: "Sources/${MODULE}"),`,
    `    .executableTarget(name: "Proof", dependencies: ["${MODULE}"], path: "Sources/Proof"),`,
    "  ]",
    ")",
    "",
  ].join("\n");
}

type RunResult = { status: number; output: string };

describe("typed @dispatch resolver is a compile-time contract (Swift)", () => {
  it("routes typed vectors green with a full provider; a missing slot fails to compile", (t) => {
    if (!swiftAvailable()) {
      t.skip("swift toolchain not available");
      return;
    }

    const output = mkdtempSync(
      path.join(tmpdir(), "typra-dispatch-typed-swift-"),
    );
    const emitRoot = path.join(output, "generated");
    const swiftOut = path.join(emitRoot, "swift");
    const swiftTestDir = path.join(emitRoot, "swift-tests");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");

    try {
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(emitRoot)}`,
          `    root-object: ${yamlString(ROOT_OBJECT)}`,
          "    deterministic-output: true",
          "    emit-targets:",
          "      - type: Swift",
          `        output-dir: ${yamlString(swiftOut)}`,
          `        test-dir: ${yamlString(swiftTestDir)}`,
          `        package-name: ${yamlString(MODULE)}`,
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", FIXTURE, "--config", config],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const resolverSrc = readFileSync(
        path.join(
          swiftOut,
          "Sources",
          MODULE,
          "renderer_resolver.swift",
        ),
        "utf8",
      );

      // -- rendered-code lock: the emitted resolver is the twin of the shape ----
      // discriminator switch — a provider protocol with one accessor per variant
      // plus a switch that throws on an unknown discriminator.
      assert.match(resolverSrc, /public protocol RendererProvider \{/);
      assert.match(resolverSrc, /var mustache: \(any Renderer\)\? \{ get \}/);
      assert.match(resolverSrc, /var jinja2: \(any Renderer\)\? \{ get \}/);
      assert.match(resolverSrc, /var liquid: \(any Renderer\)\? \{ get \}/);
      assert.match(
        resolverSrc,
        /public static func resolve\(kind: String, registry: any RendererProvider\) throws -> \(any Renderer\)\?/,
      );
      assert.match(resolverSrc, /case "mustache": return registry\.mustache/);
      // Closed dispatch: an unknown discriminator is a hard error, never nil.
      assert.match(
        resolverSrc,
        /throw TypraRuntimeError\.unknownDiscriminator\(/,
      );

      // -- assemble a self-contained, offline SwiftPM package ------------------
      const pkgDir = path.join(output, "pkg");
      const moduleDir = path.join(pkgDir, "Sources", MODULE);
      const yamsDir = path.join(pkgDir, "Sources", "Yams");
      const proofDir = path.join(pkgDir, "Sources", "Proof");
      mkdirSync(yamsDir, { recursive: true });
      mkdirSync(proofDir, { recursive: true });
      // Copy the emitted library sources verbatim (models + seam + resolver).
      cpSync(path.join(swiftOut, "Sources", MODULE), moduleDir, {
        recursive: true,
      });
      writeFileSync(path.join(pkgDir, "Package.swift"), packageManifest());
      writeFileSync(path.join(yamsDir, "Yams.swift"), YAMS_STUB);
      writeFileSync(
        path.join(proofDir, "DialectRenderer.swift"),
        DIALECT_RENDERER,
      );
      writeFileSync(path.join(proofDir, "main.swift"), MAIN);
      const providerPath = path.join(proofDir, "Provider.swift");

      const build = (): RunResult => {
        try {
          const out = execFileSync("swift", ["build", "--target", "Proof"], {
            cwd: pkgDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          return { status: 0, output: out };
        } catch (error) {
          const err = error as {
            status?: number;
            stdout?: string;
            stderr?: string;
          };
          return {
            status: err.status ?? 1,
            output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
          };
        }
      };

      // -- compile-time control (§5 control 2) --------------------------------
      // Dropping the `mustache` slot must fail to compile: conforming to
      // RendererProvider obliges every requirement.
      writeFileSync(providerPath, PARTIAL_PROVIDER);
      const partial = build();
      assert.notEqual(
        partial.status,
        0,
        "dropping the mustache slot must fail to compile",
      );
      assert.match(
        partial.output,
        /does not conform to protocol 'RendererProvider'|mustache/,
        `swiftc must reject the missing slot, got:\n${partial.output}`,
      );

      // -- positive control: full provider builds + routes green --------------
      writeFileSync(providerPath, FULL_PROVIDER);
      const built = build();
      assert.equal(
        built.status,
        0,
        `full provider must build:\n${built.output}`,
      );

      const snapshot = JSON.parse(
        readFileSync(
          path.join(emitRoot, ".typra-generated", "vectors.json"),
          "utf8",
        ),
      ) as { vectors: { vector: Record<string, unknown> }[] };
      const vectors = snapshot.vectors
        .map((entry) => entry.vector)
        .filter((vector) => typeof vector.expected === "string");
      assert.ok(vectors.length >= 2, "fixture must carry routed vectors");
      const vectorsFile = path.join(output, "vectors-data.json");
      writeFileSync(vectorsFile, JSON.stringify(vectors));

      let runOut: RunResult;
      try {
        const out = execFileSync("swift", ["run", "Proof"], {
          cwd: pkgDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, VECTORS: vectorsFile },
        });
        runOut = { status: 0, output: out };
      } catch (error) {
        const err = error as {
          status?: number;
          stdout?: string;
          stderr?: string;
        };
        runOut = {
          status: err.status ?? 1,
          output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
        };
      }

      // -- runtime positive control (§5 control 1) ----------------------------
      assert.equal(
        runOut.status,
        0,
        `typed routing must reproduce every vector's expected, got:\n${runOut.output}`,
      );
      assert.match(runOut.output, /SUITE OK/);
      for (const vector of vectors) {
        assert.match(
          runOut.output,
          new RegExp(`PASS ${vector.name as string}`),
        );
      }
      assert.doesNotMatch(runOut.output, /FAIL /);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
