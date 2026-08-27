import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";

// Regression: TYPED per-interface @vector conformance where the @dispatch
// discriminator is reached through a COERCED `T | string` union AND a seam op
// carries a BARE `unknown` param — prompty's real, previously-unexercised
// combination (harden-first for the >1.2.0 release).
//
//   * `dispatch-union-coerce` proved coerce-aware path resolution but its seams
//     have NO @vector ops, so the conformance DRIVER never ran over a coerce
//     union.
//   * `dispatch-vector-params` proved non-model @vector param mapping but its
//     discriminator is a DIRECT `format: FormatConfig` reference, never a coerce
//     union, and it has no bare `unknown` param.
//
// This suite compiles the `dispatch-vector-coerce` fixture — a dispatched
// `Renderer` (discriminator behind `FormatConfig | string`) and `Processor`
// (discriminator behind `Model | string`, op param `response: unknown`) — for
// every target and asserts two things:
//
//   Q2 — the bare `unknown` op param decodes to each language's dynamic-JSON
//        type (rust `serde_json::Value`, python passthrough, ts `unknown`, c#
//        `object`, java `Object`, go `interface{}`, swift `Any`) and is NEVER
//        imported as a typed model (no `use ...::unknown`, no raw spelling).
//
//   Q3 — the conformance discriminator read is emitted per each language's
//        field representation for a COERCE-UNION field and is well-formed
//        source (rust/swift read off the value/dict, python/ts/c#/java read the
//        typed attribute, go type-asserts). None leak raw TypeSpec type syntax.
//
// Together these lock that a coerce-union discriminator behind a @vector seam,
// including a bare `unknown` param, emits COMPILABLE conformance in all seven
// runtimes. The earlier prompty regen failure on this shape was caused solely by
// the raw-type import bug (issue #282 §8 twin), already fixed; this fixture is
// the guard that keeps the combined path green.

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "features",
  "dispatch-vector-coerce",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.Features.DispatchVectorCoerce.Root";

type Target =
  "rust" | "python" | "typescript" | "csharp" | "java" | "go" | "swift";

// Per target: the Processor conformance file, the expected decode of the bare
// `unknown` `response` param (Q2), and the expected coerce-union `provider`
// discriminator read (Q3). Both needles must be present; the raw-type sweep
// below proves no TypeSpec spelling leaks into any emitted test.
const CASES: Array<{
  target: Target;
  file: string;
  unknownDecode: string;
  providerRead: string;
}> = [
  {
    target: "rust",
    file: "processor_conformance_test.rs",
    unknownDecode: "let response: serde_json::Value = serde_json::from_str(",
    providerRead: '.get("provider")',
  },
  {
    target: "python",
    file: "test_processor_conformance.py",
    unknownDecode: 'response = payload["response"]',
    providerRead: "provider = agent.model.provider",
  },
  {
    target: "typescript",
    file: "processor.conformance.test.ts",
    unknownDecode: 'const response = payload["response"] as unknown;',
    providerRead: "const provider = agent.model.provider;",
  },
  {
    target: "csharp",
    file: "ProcessorConformanceTests.cs",
    unknownDecode: "JsonSerializer.Deserialize<object>(",
    providerRead: "agent.Model.Provider",
  },
  {
    target: "java",
    file: "ProcessorConformanceTests.java",
    unknownDecode: 'Object response = (Object) input.get("response");',
    providerRead: "String provider = agent.model.provider;",
  },
  {
    target: "go",
    file: "processor_conformance_test.go",
    unknownDecode: "var response interface{}",
    providerRead: "agent.Model.(interface {",
  },
  {
    target: "swift",
    file: "ProcessorConformanceTests.swift",
    unknownDecode: 'let response = input["response"] as! Any',
    providerRead: '["provider"] as! String',
  },
];

// Rust's Processor conformance must import ONLY the model types — the bare
// `unknown` param must never leak into the `use` list as a phantom alias.
const RUST_IMPORT = "use crate::model::{Agent, Processor};";

describe("typed @vector conformance over a coerce-union discriminator with a bare `unknown` param (Q2/Q3)", () => {
  let output: string;
  let result: Awaited<ReturnType<typeof generate>>;

  before(async () => {
    output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-vector-coerce-"));
    result = await generate({
      output,
      source: FIXTURE,
      rootObject: ROOT_OBJECT,
      targets: CASES.map((entry) => entry.target),
      format: false,
      generateTests: true,
      deterministic: true,
    });
  });

  it("emits across every target (coerce-union discriminator + `unknown` @vector param)", () => {
    assert.equal(
      result.success,
      true,
      `emit must succeed for a coerce-union dispatched @vector seam with an \`unknown\` param, got: ${result.errors?.join(
        "\n",
      )}`,
    );
  });

  for (const entry of CASES) {
    it(`${entry.target}: decodes the \`unknown\` param and reads the coerce-union discriminator without leaking raw types`, () => {
      const testsDir = path.join(output, entry.target, "tests");
      const conformance = path.join(testsDir, entry.file);
      const src = readFileSync(conformance, "utf8");

      // Q2: bare `unknown` param maps to the language dynamic-JSON type.
      assert.ok(
        src.includes(entry.unknownDecode),
        `${entry.target} processor conformance must decode the \`unknown\` param as ${JSON.stringify(
          entry.unknownDecode,
        )}\n--- emitted ---\n${src}`,
      );

      // Q3: coerce-union discriminator read is emitted per this language's field
      // representation.
      assert.ok(
        src.includes(entry.providerRead),
        `${entry.target} processor conformance must read the coerce-union discriminator via ${JSON.stringify(
          entry.providerRead,
        )}\n--- emitted ---\n${src}`,
      );

      // Neither the raw generic nor a bare `unknown` type token may survive.
      assert.doesNotMatch(
        src,
        /Record<unknown>/,
        `${entry.target} processor conformance must not contain raw \`Record<unknown>\``,
      );

      if (entry.target === "rust") {
        assert.ok(
          src.includes(RUST_IMPORT),
          `rust processor conformance must import models only (no phantom \`unknown\` alias): ${RUST_IMPORT}\n--- emitted ---\n${src}`,
        );
        assert.doesNotMatch(
          src,
          /use crate::model::\{[^}]*\bunknown\b[^}]*\}/,
          "rust processor conformance must never import a bare `unknown` type",
        );
      }
    });
  }

  it("no emitted test file in any target leaks a raw TypeSpec generic or `unknown` import", () => {
    for (const entry of CASES) {
      const testsDir = path.join(output, entry.target, "tests");
      for (const file of readdirSync(testsDir)) {
        if (file === "fixtures" || file === "Fixtures") continue;
        const full = path.join(testsDir, file);
        let src: string;
        try {
          src = readFileSync(full, "utf8");
        } catch {
          continue; // directories (e.g. an emitted package) — skip
        }
        assert.doesNotMatch(
          src,
          /Record<unknown>/,
          `${entry.target}/${file} leaks raw \`Record<unknown>\``,
        );
        // A `use`/`import` statement naming a bare `unknown` type is the exact
        // shape that aborted `cargo fmt` / failed the Python import.
        assert.doesNotMatch(
          src,
          /(?:use [^;\n]*|import [^;\n]*)\bunknown\b/,
          `${entry.target}/${file} imports a phantom \`unknown\` type`,
        );
      }
    }
  });
});
