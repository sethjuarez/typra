// Copyright (c) Microsoft. All rights reserved.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CallableVectorSnapshot } from "../src/ir/vector.js";
import {
  evaluateVectorAdapterCoverage,
  formatVectorAdapterCoverageFailure,
} from "../src/ir/vector-coverage.js";

// A snapshot with a deliberate mix of coverage sources:
//   - Echo.echo (string -> string)       : scalar seam -> the emitted typed
//     conformance entrypoint covers it, so NO hand adapter is required.
//   - Sum.sum   (int32[] -> int32)       : scalar seam (array-of-scalar) -> also
//     typed-covered.
//   - Revise.revise ({ note: Note } -> Note) : model in/out whose boundary model
//     `Note` IS in the `@serializable` closure (`serializedTypes`), so the typed
//     entrypoint decodes/compares it through the emitted loader -> typed-covered.
//   - Vault.seal ({ secret: Secret } -> Secret) : model in/out whose boundary
//     model `Secret` is NOT serializable, so the typed rail has no decode
//     primitive; it can only be covered by a hand adapter or an explicit waiver.
function snapshot(): CallableVectorSnapshot {
  return {
    emitter: "typra-emitter",
    version: 1,
    serializedTypes: ["Note"],
    vectors: [
      {
        contract: "Echo",
        namespace: "Typra.Sample",
        group: "",
        operation: "echo",
        params: { payload: "string" },
        returns: "string",
        sync: false,
        vector: { operation: "echo", stage: "callable", input: {}, expected: "" },
      },
      {
        contract: "Echo",
        namespace: "Typra.Sample",
        group: "",
        operation: "echo",
        params: { payload: "string" },
        returns: "string",
        sync: false,
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
        namespace: "Typra.Sample",
        group: "",
        operation: "sum",
        params: { values: "int32[]" },
        returns: "int32",
        sync: false,
        vector: { operation: "sum", stage: "callable", input: {}, expected: 0 },
      },
      {
        contract: "Revise",
        namespace: "Typra.Sample",
        group: "",
        operation: "revise",
        params: { note: "Note" },
        returns: "Note",
        sync: false,
        vector: { operation: "revise", stage: "callable", input: {}, expected: {} },
      },
      {
        contract: "Vault",
        namespace: "Typra.Sample",
        group: "",
        operation: "seal",
        params: { secret: "Secret" },
        returns: "Secret",
        sync: false,
        vector: { operation: "seal", stage: "callable", input: {}, expected: {} },
      },
    ],
  };
}

// Ops covered by the emitted typed entrypoint (scalar + serializable-model),
// sorted. `Vault.seal` is deliberately excluded: `Secret` is not serializable.
const TYPED_OPS = ["Echo.echo", "Revise.revise", "Sum.sum"];
const SCALAR_OPS = ["Echo.echo", "Sum.sum"];
const MODEL_TYPED_OP = "Revise.revise";
// A model op the scalar OR serializable-model typed rail cannot express: it must
// be covered by a hand adapter or an explicit waiver.
const MODEL_OP = "Vault.seal";

describe("vector adapter coverage gate", () => {
  it("collapses vectors to the distinct operations that must be covered", () => {
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      adapterKeys: ["Vault.seal"],
    });
    assert.deepEqual(result.operations, [
      "Echo.echo",
      "Revise.revise",
      "Sum.sum",
      "Vault.seal",
    ]);
  });

  it("auto-covers scalar and serializable-model seams via the typed entrypoint, no adapter needed", () => {
    // The whole point of issue #511 Cat 1 (+ the model parity slice): a seam
    // exercised by the emitted typed conformance entrypoint — scalar, or a
    // model-in/model-out seam whose boundary models are serializable — is
    // covered without a hand adapter, so the consumer can delete its double and
    // still pass verify.
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      // Only the non-serializable model op is hand-covered; the rest carry NO
      // adapter and ride the typed rail.
      adapterKeys: ["Vault.seal"],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.typed, TYPED_OPS);
    assert.deepEqual(result.covered, [MODEL_OP]);
    assert.deepEqual(result.missing, []);
    assert.ok(result.typed.includes(MODEL_TYPED_OP));
  });

  it("does NOT type-cover a model seam whose boundary type is outside the serializable closure", () => {
    // Honest reuse invariant: `Secret` is not in `serializedTypes`, so the typed
    // entrypoint has no loader to decode/compare it and the seam stays off the
    // typed rail — it needs a hand adapter or an explicit waiver.
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      adapterKeys: [],
    });
    assert.equal(result.ok, false);
    assert.ok(!result.typed.includes(MODEL_OP));
    assert.deepEqual(result.missing, [MODEL_OP]);
  });

  it("keeps a hand adapter authoritative over the typed rail (no double-count)", () => {
    // A typed-eligible op that ALSO has a hand adapter stays in `covered`, not
    // `typed`: adapters registered today keep their classification (no-drop), and
    // each op lands in exactly one bucket (no double-count).
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      adapterKeys: ["Echo.echo", "Vault.seal"],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.covered, ["Echo.echo", MODEL_OP]);
    assert.deepEqual(result.typed, ["Revise.revise", "Sum.sum"]);
    assertPartition(result);
  });

  it("accepts a bare operation name as covering a contract-qualified vector", () => {
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      adapterKeys: ["seal"],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.covered, [MODEL_OP]);
    assertPartition(result);
  });

  it("fails when a NON-typed operation has neither an adapter nor a waiver", () => {
    // The non-serializable model op cannot ride the typed rail, so without an
    // adapter or waiver it is a genuine gap.
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      adapterKeys: [],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, [MODEL_OP]);
    // The typed ops are still covered via the typed rail even while the model op
    // is missing.
    assert.deepEqual(result.typed, TYPED_OPS);
    assert.match(formatVectorAdapterCoverageFailure(result), /Vault\.seal/);
  });

  it("treats an enumerated waiver as acceptable coverage for a non-typed op", () => {
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      adapterKeys: [],
      waiverKeys: ["Vault.seal"],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.waived, [MODEL_OP]);
    assert.deepEqual(result.typed, TYPED_OPS);
    assert.deepEqual(result.missing, []);
    assertPartition(result);
  });

  it("prefers the typed rail over a redundant waiver for a typed op", () => {
    // A waiver on a typed-eligible op is redundant now that the typed rail covers
    // it; the honest classification is `typed`, and the waiver simply drops out.
    // The op stays OK either way (no-drop) — it is merely reclassified.
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      adapterKeys: ["Vault.seal"],
      waiverKeys: ["Echo.echo", "Revise.revise"],
    });
    assert.ok(result.ok);
    assert.ok(result.typed.includes("Echo.echo"));
    assert.ok(result.typed.includes(MODEL_TYPED_OP));
    assert.deepEqual(result.waived, []);
    assertPartition(result);
  });

  it("rejects a wildcard waiver even when it would cover the gap", () => {
    const result = evaluateVectorAdapterCoverage({
      snapshot: snapshot(),
      adapterKeys: [],
      waiverKeys: ["*"],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.wildcardWaivers, ["*"]);
    // The wildcard does not silently cover the missing model op.
    assert.deepEqual(result.missing, [MODEL_OP]);
    assert.match(
      formatVectorAdapterCoverageFailure(result),
      /Wildcard waivers are not allowed/,
    );
  });

  it("strictly expands coverage: no op OK under the old rules becomes missing", () => {
    // No-drop invariant. The pre-typed rule marked an op OK iff it had an adapter
    // or an enumerated waiver. Adding the typed rail must never move such an op
    // out of the OK set — it only ever rescues would-be-missing ops.
    const snap = snapshot();
    const adapterKeys = ["Vault.seal"];
    const waiverKeys: string[] = [];

    // The set an old adapter/waiver-only gate would consider covered.
    const legacyOk = new Set<string>();
    for (const entry of snap.vectors) {
      const key = `${entry.contract}.${entry.operation}`;
      const bare = key.slice(key.indexOf(".") + 1);
      if (
        adapterKeys.includes(key) ||
        adapterKeys.includes(bare) ||
        waiverKeys.includes(key) ||
        waiverKeys.includes(bare)
      ) {
        legacyOk.add(key);
      }
    }

    const result = evaluateVectorAdapterCoverage({
      snapshot: snap,
      adapterKeys,
      waiverKeys,
    });
    const newOk = new Set([...result.covered, ...result.typed, ...result.waived]);
    // Every op OK under the old rules is still OK.
    for (const op of legacyOk) {
      assert.ok(newOk.has(op), `${op} must remain covered`);
    }
    // And coverage strictly expanded (the scalar + serializable-model ops are
    // newly OK).
    assert.ok(newOk.size > legacyOk.size);
    assertPartition(result);
  });

  it("degrades to scalar-only coverage when serializedTypes is absent (old snapshot)", () => {
    // A snapshot emitted before the field existed lacks `serializedTypes`. The
    // model seams then have no known loader, so only the scalar ops ride the
    // typed rail — a safe, strictly-narrower classification.
    const snap = snapshot();
    delete (snap as { serializedTypes?: string[] }).serializedTypes;
    const result = evaluateVectorAdapterCoverage({
      snapshot: snap,
      adapterKeys: ["Vault.seal", "Revise.revise"],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.typed, SCALAR_OPS);
    assert.deepEqual(result.covered, ["Revise.revise", MODEL_OP]);
    assertPartition(result);
  });
});

// Every operation lands in exactly one bucket (no double-count, no drop).
function assertPartition(result: {
  operations: string[];
  covered: string[];
  typed: string[];
  waived: string[];
  missing: string[];
}): void {
  const buckets = [
    ...result.covered,
    ...result.typed,
    ...result.waived,
    ...result.missing,
  ];
  // No op appears twice across buckets.
  assert.equal(new Set(buckets).size, buckets.length, "buckets must be disjoint");
  // The union is exactly the operation set.
  assert.deepEqual([...buckets].sort(), [...result.operations].sort());
}
