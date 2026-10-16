// Issue #361: unsupported numeric literal unions must fail with a useful property-level
// diagnostic instead of an internal-looking "Unable to resolve undefined" message.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  generate,
  packageRoot,
  removeDir,
  scratchDir,
} from "./native-probe.js";

const FIXTURE = path.join(
  packageRoot,
  "fixtures",
  "features",
  "numeric-literal-union",
  "main.tsp",
);
const ROOT = "Typra.Fixtures.Features.NumericLiteralUnion.Root";
const INLINE_PREFIX = [
  'import "@typra/emitter";',
  "",
  "namespace Typra.Fixtures.Features.NumericLiteralUnion;",
  "",
  "@serializable",
  "model Root {",
];

function assertGenerationDiagnostic(
  source: string,
  pattern: RegExp,
): void {
  const root = scratchDir("numeric-literal-union");
  try {
    assert.throws(
      () => generate(root, source, ROOT, ["typescript"]),
      pattern,
    );
  } finally {
    removeDir(root);
  }
}

describe("numeric literal union diagnostics (#361)", () => {
  it("names the unsupported property", () => {
    assertGenerationDiagnostic(
      FIXTURE,
      /typra-emitter-unsupported-numeric-literal-union[\s\S]*Numeric literal unions are not supported for property 'level'/,
    );
  });

  it("uses the numeric-literal diagnostic when the union also includes null", () => {
    assertGenerationDiagnostic(
      [...INLINE_PREFIX, "  level?: 1 | 2 | null;", "}", ""].join("\n"),
      /typra-emitter-unsupported-numeric-literal-union[\s\S]*property 'level'/,
    );
  });

  it("keeps mixed numeric/string unions on the generic unsupported path", () => {
    assertGenerationDiagnostic(
      [...INLINE_PREFIX, '  level?: 1 | "draft";', "}", ""].join("\n"),
      /typra-emitter-unsupported-union-types/,
    );
  });

  it("continues to accept string literal unions", () => {
    const root = scratchDir("numeric-literal-union");
    try {
      generate(
        root,
        [...INLINE_PREFIX, '  level?: "low" | "high";', "}", ""].join("\n"),
        ROOT,
        ["typescript"],
      );
    } finally {
      removeDir(root);
    }
  });
});
