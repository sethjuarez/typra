import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";

// Regression: an OPEN-union polymorphic shape loader with a DECLARED `*` wildcard
// variant must route an ABSENT/BLANK discriminator to that catch-all instead of
// hard-rejecting it.
//
// The prompty seams coerce a bare string into `{ id: "..." }` with NO
// `provider`, then hydrate it via `Model.load(...)`. The generated loader emits a
// `Custom*` default `else`/`default` arm (it KNOWS a declared catch-all exists)
// yet still hard-raised when the discriminator was absent/blank — preempting the
// default and making the shorthand never hydrate. The fix: when a DECLARED `*`
// variant exists, an absent/blank discriminator normalizes to "" and flows to
// that same catch-all, exactly as the @dispatch rail resolves it.
//
// The tolerance is scoped to a declared `*` variant ONLY. A CLOSED union, an
// abstract open union with only an unknown carrier, AND a non-abstract open union
// that falls back to its own base by SELF-REFERENCE all still reject an
// absent/blank discriminator up front — a blank discriminator names no variant
// (this preserves the shipped `FixtureConnection` conformance contract). Unknown
// NON-blank discriminators still route to the declared default / self-reference
// base / carrier.
//
// This suite compiles the `dispatch-union-coerce` fixture — whose `Model`
// (open + declared `*` CustomModel) is tolerant, whose `Embedding`
// (open + self-reference, NO `*`) still rejects blank, and whose
// `TemplateFormat`/`ParserConfig` are closed — for every target, then asserts the
// emitted loader shapes. The Python loaders are additionally executed end-to-end
// in the repo's Python conformance run; this suite locks the emitted source shape
// across all seven backends.

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "features",
  "dispatch-union-coerce",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.Features.DispatchUnionCoerce.Root";

type Target =
  | "rust"
  | "python"
  | "typescript"
  | "csharp"
  | "java"
  | "go"
  | "swift";

// For each target: the emitted file basename that carries the OPEN `Model`
// loader, a needle proving the loader routes an unrecognized/absent discriminator
// to its fallback variant, the emitted file basename for the CLOSED
// `TemplateFormat` loader, and a needle proving that loader still rejects.
const CASES: Array<{
  target: Target;
  openModelFile: string;
  openFallbackNeedle: string;
  closedFile: string;
  closedRejectNeedle: string;
}> = [
  {
    target: "python",
    openModelFile: "_Model.py",
    openFallbackNeedle: "return CustomModel.load",
    closedFile: "_TemplateFormat.py",
    closedRejectNeedle: "expected non-blank string",
  },
  {
    target: "rust",
    openModelFile: "model.rs",
    // The tolerant read — `unwrap_or("")` — is what lets an absent/blank
    // discriminator fall to the `_` fallback arm rather than error.
    openFallbackNeedle: '.unwrap_or("")',
    closedFile: "template_format.rs",
    // validate_discriminator() is emitted only for closed unions; it is the
    // closed rejection path.
    closedRejectNeedle: "fn validate_discriminator",
  },
  {
    target: "typescript",
    openModelFile: "model.ts",
    openFallbackNeedle: "return CustomModel.load",
    closedFile: "template-format.ts",
    closedRejectNeedle: "expected non-blank string",
  },
  {
    target: "csharp",
    openModelFile: "Model.cs",
    openFallbackNeedle: "_ => CustomModel.Load",
    closedFile: "TemplateFormat.cs",
    closedRejectNeedle: "expected non-blank string",
  },
  {
    target: "java",
    openModelFile: "Model.java",
    openFallbackNeedle: "return CustomModel.load",
    closedFile: "TemplateFormat.java",
    closedRejectNeedle: "expected non-blank string",
  },
  {
    target: "go",
    openModelFile: "model.go",
    openFallbackNeedle: "return LoadCustomModel",
    closedFile: "template_format.go",
    closedRejectNeedle: "expected non-blank string",
  },
  {
    target: "swift",
    openModelFile: "model.swift",
    openFallbackNeedle: ".customModel(try CustomModel.load",
    closedFile: "template_format.swift",
    closedRejectNeedle: 'expected: "non-blank string"',
  },
];

function findByBasename(root: string, basename: string): string {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
      } else if (entry === basename) {
        return full;
      }
    }
  }
  throw new Error(`could not find ${basename} under ${root}`);
}

describe("open-union shape loader: absent/blank discriminator routes to the fallback variant", () => {
  let output: string;
  let result: Awaited<ReturnType<typeof generate>>;

  before(async () => {
    output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-loader-fallback-"));
    result = await generate({
      output,
      source: FIXTURE,
      rootObject: ROOT_OBJECT,
      targets: CASES.map((entry) => entry.target),
      format: false,
      generateTests: false,
      deterministic: true,
    });
  });

  after(() => {
    // Best-effort cleanup; leaving the temp dir on failure aids debugging.
  });

  it("emits across every target", () => {
    assert.equal(
      result.success,
      true,
      `emit must succeed, got: ${result.errors?.join("\n")}`,
    );
  });

  for (const entry of CASES) {
    it(`${entry.target}: open Model loader routes absent/blank to the fallback (no reject); closed TemplateFormat still rejects`, () => {
      const root = path.join(output, entry.target);

      const modelSrc = readFileSync(
        findByBasename(root, entry.openModelFile),
        "utf8",
      );
      // An open union never rejects a blank/absent discriminator: the
      // "non-blank string" guard must be absent from its loader entirely.
      assert.doesNotMatch(
        modelSrc,
        /non-blank/i,
        `${entry.target} open Model loader must not reject a blank discriminator\n--- emitted ---\n${modelSrc}`,
      );
      assert.ok(
        modelSrc.includes(entry.openFallbackNeedle),
        `${entry.target} open Model loader must route to the fallback via ${JSON.stringify(
          entry.openFallbackNeedle,
        )}\n--- emitted ---\n${modelSrc}`,
      );

      const closedSrc = readFileSync(
        findByBasename(root, entry.closedFile),
        "utf8",
      );
      assert.ok(
        closedSrc.includes(entry.closedRejectNeedle),
        `${entry.target} closed TemplateFormat loader must still reject via ${JSON.stringify(
          entry.closedRejectNeedle,
        )}\n--- emitted ---\n${closedSrc}`,
      );
    });
  }

  it("python: open Embedding loader (self-reference, no `*`) rejects a blank discriminator but routes unknown non-blank to the base", () => {
    const root = path.join(output, "python");
    const embeddingSrc = readFileSync(
      findByBasename(root, "_Embedding.py"),
      "utf8",
    );
    // Embedding is an open union with NO declared `*` subtype: its only fallback
    // is the base model itself by self-reference. Per the shipped self-reference
    // conformance contract, a blank/absent discriminator names no variant and is
    // rejected up front — tolerance is reserved for a DECLARED `*` catch-all.
    assert.match(
      embeddingSrc,
      /non-blank/i,
      `python open Embedding (self-reference) loader must reject a blank discriminator\n--- emitted ---\n${embeddingSrc}`,
    );
    // Unknown NON-blank discriminators still fall through to the self-referencing
    // base instance rather than raising an unknown-value error.
    assert.ok(
      embeddingSrc.includes("# create new instance (stop recursion)"),
      "python open Embedding loader must route unknown non-blank to the self-referencing base instance",
    );
  });
});
