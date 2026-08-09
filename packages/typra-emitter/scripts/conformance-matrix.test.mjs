import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const requiredTargets = [
  "typescript",
  "python",
  "csharp",
  "go",
  "java",
  "rust",
  "swift",
];

const matrixPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "conformance-matrix.json",
);

describe("conformance matrix target coverage", () => {
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));

  it("declares exactly the required runtime backends", () => {
    assert.deepEqual(matrix.targets, requiredTargets);
  });

  it("requires every rule to cover every backend cell", () => {
    for (const rule of matrix.rules) {
      assert.deepEqual(
        Object.keys(rule.backends ?? {}),
        requiredTargets,
        `${rule.id} must declare every backend cell`,
      );
    }
  });
});
