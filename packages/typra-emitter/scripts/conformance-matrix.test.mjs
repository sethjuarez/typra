import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  compareConformanceMatrixTargets,
  REQUIRED_CONFORMANCE_MATRIX_TARGETS,
} from "./conformance-matrix-policy.mjs";

const matrixPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "conformance-matrix.json",
);

describe("conformance matrix target coverage", () => {
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));

  it("declares exactly the required runtime backends", () => {
    assert.equal(
      compareConformanceMatrixTargets(matrix.targets).ok,
      true,
      "fixture matrix targets must match the required runtime backend set",
    );
  });

  it("accepts the required runtime backends regardless of order", () => {
    assert.equal(
      compareConformanceMatrixTargets(
        [...REQUIRED_CONFORMANCE_MATRIX_TARGETS].reverse(),
      ).ok,
      true,
    );
  });

  it("rejects an omitted required runtime backend", () => {
    const withoutSwift = REQUIRED_CONFORMANCE_MATRIX_TARGETS.filter(
      (target) => target !== "swift",
    );
    const comparison = compareConformanceMatrixTargets(withoutSwift);

    assert.equal(comparison.ok, false);
    assert.match(comparison.failures.join("\n"), /missing.*swift/i);
  });

  it("requires every rule to cover every backend cell", () => {
    for (const rule of matrix.rules) {
      assert.equal(
        compareConformanceMatrixTargets(Object.keys(rule.backends ?? {})).ok,
        true,
        `${rule.id} must declare every backend cell`,
      );
    }
  });
});
