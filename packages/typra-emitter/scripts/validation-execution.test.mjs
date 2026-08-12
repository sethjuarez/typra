import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareExpectedExecution,
  TOOLCHAIN_UNAVAILABLE,
} from "./validation-execution.mjs";

describe("fixture validation execution plan", () => {
  it("accepts an exact declared/executed match", () => {
    const result = compareExpectedExecution({
      label: "fixture validation",
      expected: ["typescript", "python"],
      implemented: ["python", "typescript"],
      executed: ["typescript", "python"],
    });

    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.warnings, []);
  });

  it("fails when a declared target is not executed", () => {
    const result = compareExpectedExecution({
      label: "executable conformance",
      expected: ["typescript", "python", "swift"],
      implemented: ["typescript", "python", "swift"],
      executed: ["typescript", "python"],
    });

    assert.match(
      result.failures.join("\n"),
      /did not execute declared targets\/stages/,
    );
    assert.match(result.failures.join("\n"), /swift/);
  });

  it("allows only explicitly declared toolchain skips", () => {
    const result = compareExpectedExecution({
      label: "executable conformance",
      expected: ["typescript", "swift"],
      implemented: ["typescript", "swift"],
      executed: ["typescript"],
      skipped: [{ id: "swift", reason: TOOLCHAIN_UNAVAILABLE }],
      allowedSkips: { swift: TOOLCHAIN_UNAVAILABLE },
    });

    assert.deepEqual(result.failures, []);
    assert.match(result.warnings.join("\n"), /swift/);
  });

  it("fails when a skip is not declared as an allowed toolchain skip", () => {
    const result = compareExpectedExecution({
      label: "executable conformance",
      expected: ["typescript", "python"],
      implemented: ["typescript", "python"],
      executed: ["typescript"],
      skipped: [{ id: "python", reason: TOOLCHAIN_UNAVAILABLE }],
    });

    assert.match(
      result.failures.join("\n"),
      /skipped targets\/stages without an allowed toolchain-unavailable declaration/,
    );
    assert.match(result.failures.join("\n"), /python/);
  });

  it("fails when implementations drift from the declared expected set", () => {
    const result = compareExpectedExecution({
      label: "fixture validation",
      expected: ["typescript", "python"],
      implemented: ["typescript", "python", "go"],
      executed: ["typescript", "python", "go"],
    });

    assert.match(
      result.failures.join("\n"),
      /implementations that are not declared/,
    );
    assert.match(
      result.failures.join("\n"),
      /executed targets\/stages that are not declared/,
    );
    assert.match(result.failures.join("\n"), /go/);
  });
});
