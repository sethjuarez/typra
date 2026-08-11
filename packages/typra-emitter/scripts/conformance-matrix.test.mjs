import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  compareConformanceMatrixTargets,
  REQUIRED_CONFORMANCE_MATRIX_TARGETS,
  validateConformanceMatrix,
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

  it("validates the current matrix schema and waiver policy", () => {
    const comparison = validateConformanceMatrix(matrix);

    assert.equal(comparison.ok, true, comparison.failures.join("\n"));
  });

  it("rejects waived backend cells on enforced rules", () => {
    const invalid = structuredClone(matrix);
    invalid.rules[0].backends.typescript = { status: "waived", issue: "#49" };
    const comparison = validateConformanceMatrix(invalid);

    assert.equal(comparison.ok, false);
    assert.match(
      comparison.failures.join("\n"),
      /fixture-root-sample-shape\.typescript.*not marked known-gap/i,
    );
  });

  it("requires known-gap rules and backend waivers to cite the same tracker", () => {
    const invalid = structuredClone(matrix);
    const rule = invalid.rules.find(
      (candidate) => candidate.id === "keyed-collection-ambiguous-names",
    );
    assert.ok(rule);
    rule.issue = "#120";
    const comparison = validateConformanceMatrix(invalid);

    assert.equal(comparison.ok, false);
    assert.match(
      comparison.failures.join("\n"),
      /keyed-collection-ambiguous-names\.typescript.*does not match #120/i,
    );
  });

  it("rejects implemented backend cells on known-gap rules", () => {
    const invalid = structuredClone(matrix);
    const rule = invalid.rules.find(
      (candidate) => candidate.id === "keyed-collection-ambiguous-names",
    );
    assert.ok(rule);
    rule.backends.swift = "implemented";
    const comparison = validateConformanceMatrix(invalid);

    assert.equal(comparison.ok, false);
    assert.match(
      comparison.failures.join("\n"),
      /keyed-collection-ambiguous-names\.swift.*cannot be implemented/i,
    );
  });
});
