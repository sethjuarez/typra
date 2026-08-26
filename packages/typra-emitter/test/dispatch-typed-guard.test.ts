import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertTypedDispatchSupported,
  isTypedDispatchEntry,
  type CallableVectorSnapshotEntry,
} from "../src/ir/vector.js";

// Part III — Phase 1 (issue #282 §8), typed-rail eligibility.
//
// Two safety nets guard the typed conformance rail:
//  1. `isTypedDispatchEntry` — only a `@dispatch` that resolved to a lowered
//     `PolymorphicDispatchDecl` rides the typed rail. A dispatch WITHOUT a decl
//     (non-polymorphic discriminator model) must fall back to the stringly
//     runner so it is never dropped from BOTH rails.
//  2. `assertTypedDispatchSupported` — a dispatched vector that leans on
//     stringly-runner-only semantics fails LOUD at emit time instead of being
//     silently weakened into a passing-but-hollow typed [Fact].

function entry(
  overrides: Partial<CallableVectorSnapshotEntry> = {},
  vectorOverrides: Partial<CallableVectorSnapshotEntry["vector"]> = {},
): CallableVectorSnapshotEntry {
  return {
    contract: "Renderer",
    namespace: "Typra.Fixtures.DispatchSeam",
    group: "",
    operation: "render",
    params: { agent: "Agent", inputs: "Inputs" },
    returns: "string",
    sync: false,
    dispatch: {
      discriminator: { model: "TemplateFormat", field: "kind" },
      path: "agent.template.format.kind",
      decl: {
        discriminatorField: "kind",
        variants: [
          { value: "mustache", typeName: { namespace: "N", name: "M" } },
        ],
        defaultVariant: null,
        isAbstract: false,
        isClosed: true,
      },
    } as CallableVectorSnapshotEntry["dispatch"],
    vector: {
      name: "mustache-basic",
      stage: "callable",
      operation: "render",
      input: { agent: {}, inputs: {} },
      expected: "Hello world",
      ...vectorOverrides,
    },
    ...overrides,
  };
}

describe("typed @dispatch rail eligibility (issue #282 §8)", () => {
  it("routes a decl-less @dispatch to the stringly runner, not the typed rail", () => {
    const typed = entry();
    assert.equal(isTypedDispatchEntry(typed), true);

    // A @dispatch whose discriminator model is not polymorphic carries a path
    // but no `decl`. It must NOT ride the typed rail — otherwise the C# driver's
    // `undispatched` filter would exclude it while `collectDispatchedContracts`
    // also skips it, dropping the vector from BOTH rails.
    const declLess = entry();
    (declLess.dispatch as { decl?: unknown }).decl = undefined;
    assert.equal(isTypedDispatchEntry(declLess), false);

    // A truly undispatched seam is likewise runner-bound.
    const plain = entry();
    plain.dispatch = undefined;
    assert.equal(isTypedDispatchEntry(plain), false);
  });

  it("accepts a plain inline-input + expected dispatched vector", () => {
    assert.doesNotThrow(() => assertTypedDispatchSupported(entry()));
  });

  it("rejects vector semantics the typed rail cannot faithfully reproduce", () => {
    const cases: Array<[string, Partial<CallableVectorSnapshotEntry["vector"]>]> = [
      ["expectedError", { expectedError: { code: "boom" } }],
      ["requires", { requires: ["provider:openai"] }],
      ["normalization", { normalization: { trim: true } }],
      ["delegated portability", { portability: "delegated" }],
      ["explicit provider", { provider: "openai" }],
      ["$file input ref", { input: { agent: { $file: "a.txt" } } }],
      ["$env input ref", { input: { inputs: { $env: "HOME" } } }],
      ["$json input ref", { input: { agent: { $json: "a.json" } } }],
    ];
    for (const [label, vectorOverrides] of cases) {
      assert.throws(
        () => assertTypedDispatchSupported(entry({}, vectorOverrides)),
        /not supported/,
        `expected ${label} to be rejected`,
      );
    }
  });

  it("rejects a discriminator path whose head is not a parameter", () => {
    const bad = entry({ params: { onlyOther: "Thing" } });
    assert.throws(
      () => assertTypedDispatchSupported(bad),
      /path head "agent" is not a parameter/,
    );
  });
});
