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

  it("type-covers an array-of-model seam when the element type is serializable", () => {
    // The array-of-model slice landed across all 7 runtimes: the typed
    // conformance entrypoint now emits a per-element decode/compare for
    // `Model[]` params and returns whose element model is in the `@serializable`
    // closure. So an op whose param/return is an array-of-serializable-model is
    // typed-covered — the flip that lets prompty delete its `RenderSegment[]` /
    // `Message[]` doubles. (This assertion flipped red-first when the drivers
    // gained array support, exactly as the scalar->model flip did.)
    const snap: CallableVectorSnapshot = {
      emitter: "typra-emitter",
      version: 1,
      serializedTypes: ["Note"],
      vectors: [
        {
          contract: "Bundle",
          namespace: "Typra.Sample",
          group: "",
          operation: "pack",
          params: { notes: "Note[]" },
          returns: "Note[]",
          sync: false,
          vector: { operation: "pack", stage: "callable", input: {}, expected: [] },
        },
      ],
    };
    const covered = evaluateVectorAdapterCoverage({ snapshot: snap, adapterKeys: [] });
    assert.ok(covered.ok);
    assert.deepEqual(covered.typed, ["Bundle.pack"]);
    assert.deepEqual(covered.covered, []);
    assert.deepEqual(covered.missing, []);
    assertPartition(covered);
  });

  it("does NOT type-cover an optional-model seam even when the element type is serializable", () => {
    // Guard for the NEXT deferred boundary. The typed conformance entrypoint
    // emits a decode/compare for a bare model (`Model`) and an array-of-model
    // (`Model[]`), but NOT for an optional model (`Model?`) — the drivers have no
    // null-carrier decode yet. So an op whose param OR return is `Model?` must
    // stay OFF the typed rail (adapter/waiver/missing), even when the model is in
    // the serializable closure. Flipping this to typed before the optional-model
    // driver slice ships would let a consumer delete a double the runtime cannot
    // yet decode. When that slice lands with real driver support, this assertion
    // flips red-first and becomes a typed-covered case.
    const snap: CallableVectorSnapshot = {
      emitter: "typra-emitter",
      version: 1,
      serializedTypes: ["Note"],
      vectors: [
        {
          contract: "Bundle",
          namespace: "Typra.Sample",
          group: "",
          operation: "peek",
          params: { note: "Note?" },
          returns: "Note?",
          sync: false,
          vector: { operation: "peek", stage: "callable", input: {}, expected: null },
        },
      ],
    };
    const missing = evaluateVectorAdapterCoverage({ snapshot: snap, adapterKeys: [] });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.typed, []);
    assert.deepEqual(missing.missing, ["Bundle.peek"]);

    // It CAN still be covered the honest way — a hand adapter or an explicit
    // waiver — since it is a genuine, not-yet-emittable seam.
    const adapted = evaluateVectorAdapterCoverage({
      snapshot: snap,
      adapterKeys: ["Bundle.peek"],
    });
    assert.ok(adapted.ok);
    assert.deepEqual(adapted.covered, ["Bundle.peek"]);
    assert.deepEqual(adapted.typed, []);
    assertPartition(adapted);
  });

  it("does NOT let a partially-typed seam read as fully typed-covered", () => {
    // Seam-level guardrail (parent's ask): a seam whose ops are a MIX of
    // typed-eligible and not-yet-eligible must never present as a whole
    // typed-covered seam, or a consumer could delete the double while one op
    // still rides its adapter. Coverage is classified per-OP, so the eligible
    // op lands in `typed` and the ineligible one in `missing` — and because
    // `ok` requires zero `missing`, the seam cannot pass verify until EVERY op
    // is covered. This is strictly stronger than a seam-level flag: render AND
    // renderSegments must both be eligible before prompty may retire Renderer.
    const snap: CallableVectorSnapshot = {
      emitter: "typra-emitter",
      version: 1,
      serializedTypes: ["Note"],
      vectors: [
        {
          contract: "Bundle",
          namespace: "Typra.Sample",
          group: "",
          operation: "pack",
          params: { notes: "Note[]" },
          returns: "Note[]",
          sync: false,
          vector: { operation: "pack", stage: "callable", input: {}, expected: [] },
        },
        {
          contract: "Bundle",
          namespace: "Typra.Sample",
          group: "",
          operation: "peek",
          params: { note: "Note?" },
          returns: "Note?",
          sync: false,
          vector: { operation: "peek", stage: "callable", input: {}, expected: null },
        },
      ],
    };

    // With no adapter for the ineligible op, the seam is INCOMPLETE: the
    // array-of-model op is typed, the optional-model op is missing, ok=false.
    const partial = evaluateVectorAdapterCoverage({ snapshot: snap, adapterKeys: [] });
    assert.equal(partial.ok, false);
    assert.deepEqual(partial.typed, ["Bundle.pack"]);
    assert.deepEqual(partial.missing, ["Bundle.peek"]);
    assertPartition(partial);

    // The ONLY way the whole seam passes is covering EVERY op: the eligible op
    // via the typed rail, the not-yet-eligible one via a hand adapter (or an
    // explicit waiver). Then — and only then — is the seam retirable.
    const complete = evaluateVectorAdapterCoverage({
      snapshot: snap,
      adapterKeys: ["Bundle.peek"],
    });
    assert.ok(complete.ok);
    assert.deepEqual(complete.typed, ["Bundle.pack"]);
    assert.deepEqual(complete.covered, ["Bundle.peek"]);
    assert.deepEqual(complete.missing, []);
    assertPartition(complete);
  });

  it("type-covers a carrier-param seam (optional or not) when the return is typed", () => {
    // The Record<unknown>-carrier slice landed across all 7 runtimes: an untyped
    // carrier param (Record<unknown>, optional or not) decodes via the target's
    // native untyped-JSON codec and threads straight through to the seam call.
    // This is the exact shape of prompty's three vector seams — Renderer.render /
    // renderSegments (`inputs: Record<unknown>`, non-optional) and Parser.parse
    // (`context?: Record<unknown>`, optional) — all with a typed return. Both ops
    // sit on ONE seam, so the every-op guard must see BOTH eligible for the seam
    // to be retirable. (This assertion flipped red-first when the drivers gained
    // carrier support, exactly as the scalar->model->array flips did.)
    const snap: CallableVectorSnapshot = {
      emitter: "typra-emitter",
      version: 1,
      serializedTypes: ["Note"],
      vectors: [
        {
          contract: "Assembler",
          namespace: "Typra.Sample",
          group: "",
          operation: "assemble",
          params: { note: "Note", options: "Record<unknown>" },
          returns: "Note[]",
          sync: false,
          vector: { operation: "assemble", stage: "callable", input: {}, expected: [] },
        },
        {
          contract: "Assembler",
          namespace: "Typra.Sample",
          group: "",
          operation: "reassemble",
          params: { note: "Note", options: "Record<unknown>?" },
          returns: "Note[]",
          sync: false,
          vector: { operation: "reassemble", stage: "callable", input: {}, expected: [] },
        },
      ],
    };
    const covered = evaluateVectorAdapterCoverage({ snapshot: snap, adapterKeys: [] });
    assert.ok(covered.ok);
    assert.deepEqual(covered.typed, ["Assembler.assemble", "Assembler.reassemble"]);
    assert.deepEqual(covered.covered, []);
    assert.deepEqual(covered.missing, []);
    assertPartition(covered);
  });

  it("does NOT type-cover an op whose RETURN is an untyped carrier (param-only invariant)", () => {
    // The carrier admission is deliberately PARAM-ONLY: an untyped carrier must
    // never loosen RETURN checking. An op that RETURNS a Record<unknown> has no
    // schema to decode/compare its result against, so it stays OFF the typed rail
    // (adapter/waiver/missing) even though its params are all typed. Flipping a
    // carrier-return op to typed would let a consumer delete a double whose result
    // the runtime cannot structurally verify.
    const snap: CallableVectorSnapshot = {
      emitter: "typra-emitter",
      version: 1,
      serializedTypes: ["Note"],
      vectors: [
        {
          contract: "Emit",
          namespace: "Typra.Sample",
          group: "",
          operation: "raw",
          params: { payload: "string" },
          returns: "Record<unknown>",
          sync: false,
          vector: { operation: "raw", stage: "callable", input: {}, expected: {} },
        },
      ],
    };
    const missing = evaluateVectorAdapterCoverage({ snapshot: snap, adapterKeys: [] });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.typed, []);
    assert.deepEqual(missing.missing, ["Emit.raw"]);

    // It CAN still be covered the honest way — a hand adapter or a waiver.
    const adapted = evaluateVectorAdapterCoverage({
      snapshot: snap,
      adapterKeys: ["Emit.raw"],
    });
    assert.ok(adapted.ok);
    assert.deepEqual(adapted.covered, ["Emit.raw"]);
    assert.deepEqual(adapted.typed, []);
    assertPartition(adapted);
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
