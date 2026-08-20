// Copyright (c) Microsoft. All rights reserved.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CallableVectorSnapshot } from "../src/ir/vector.js";
import {
  evaluateVectorAdapterCoverage,
  formatVectorAdapterCoverageFailure,
} from "../src/ir/vector-coverage.js";

function snapshot(): CallableVectorSnapshot {
  return {
    emitter: "typra-emitter",
    version: 1,
    vectors: [
      {
        contract: "Echo",
        operation: "echo",
        params: { payload: "string" },
        returns: "string",
        vector: { operation: "echo", stage: "callable", input: {}, expected: "" },
      },
      {
        contract: "Echo",
        operation: "echo",
        params: { payload: "string" },
        returns: "string",
        vector: {
          operation: "echo",
          stage: "callable",
          name: "second",
          input: {},
          expected: "",
        },
      },
      {
        contract: "Sum",
        operation: "sum",
        params: { values: "int32[]" },
        returns: "int32",
        vector: { operation: "sum", stage: "callable", input: {}, expected: 0 },
      },
    ],
  };
}

describe("vector adapter coverage gate", () => {
  it("collapses vectors to the distinct operations that must be covered", () => {
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      adapterKeys: ["Echo.echo", "Sum.sum"],
    });
    assert.deepEqual(result.operations, ["Echo.echo", "Sum.sum"]);
    assert.ok(result.ok);
    assert.deepEqual(result.missing, []);
  });

  it("accepts a bare operation name as covering a contract-qualified vector", () => {
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      adapterKeys: ["echo", "sum"],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.covered, ["Echo.echo", "Sum.sum"]);
  });

  it("fails when an operation has neither an adapter nor a waiver", () => {
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      adapterKeys: ["Echo.echo"],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["Sum.sum"]);
    assert.match(
      formatVectorAdapterCoverageFailure(result),
      /Sum\.sum/,
    );
  });

  it("treats an enumerated waiver as acceptable coverage", () => {
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      adapterKeys: ["Echo.echo"],
      waiverKeys: ["Sum.sum"],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.waived, ["Sum.sum"]);
    assert.deepEqual(result.missing, []);
  });

  it("rejects a wildcard waiver even when it would cover the gap", () => {
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      adapterKeys: ["Echo.echo"],
      waiverKeys: ["*"],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.wildcardWaivers, ["*"]);
    // The wildcard does not silently cover the missing operation.
    assert.deepEqual(result.missing, ["Sum.sum"]);
    assert.match(
      formatVectorAdapterCoverageFailure(result),
      /Wildcard waivers are not allowed/,
    );
  });
});
