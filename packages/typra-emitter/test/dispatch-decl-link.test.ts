import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";

// Part III — Phase 0 IR seam.
//
// The behavioral `@dispatch` seam now carries the SAME lowered
// `PolymorphicDispatchDecl` that drives the discriminator model's shape `Load`
// switch, resolved from `discriminator.model`. This is the one IR edge that lets
// every emitter render the behavioral resolver as the twin of the shape switch
// (same `variants` / `isClosed` / `defaultVariant`) instead of interpreting a
// stringly-typed runtime path. This file proves the link exists and that the
// vector snapshot now also threads `namespace`/`group` so the conformance
// emitters can reuse the model-test per-group folder helper (issue §8.4).

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "dispatch-seam",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.DispatchSeam.Root";

interface PolymorphicVariant {
  value: string;
  typeName: { namespace: string; name: string };
}
interface PolymorphicDispatchDecl {
  discriminatorField: string;
  variants: PolymorphicVariant[];
  defaultVariant: unknown | null;
  isAbstract: boolean;
  isClosed: boolean;
}
interface Dispatch {
  discriminator: { model: string; field: string };
  path: string;
  decl?: PolymorphicDispatchDecl;
}
interface Surface {
  targets: {
    target: string;
    protocols?: { name: string; dispatch?: Dispatch }[];
  }[];
}
interface VectorSnapshotEntry {
  contract: string;
  namespace: string;
  group: string;
  dispatch?: Dispatch;
}

const sortedValues = (decl: PolymorphicDispatchDecl): string[] =>
  decl.variants.map((variant) => variant.value).sort();

describe("Part III IR seam: @dispatch reuses the PolymorphicDispatchDecl rail", () => {
  let output: string;
  let dispatch: Dispatch;
  let vectors: VectorSnapshotEntry[];

  const readJson = <T>(...segments: string[]): T =>
    JSON.parse(readFileSync(path.join(output, ...segments), "utf8")) as T;

  before(async () => {
    output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-decl-"));
    const result = await generate({
      output,
      source: FIXTURE,
      rootObject: ROOT_OBJECT,
      targets: ["go"],
      format: false,
      generateTests: false,
      deterministic: true,
    });
    assert.equal(result.success, true, result.errors?.join("\n"));

    const surface = readJson<Surface>(
      ".typra-generated",
      "export-surfaces.json",
    );
    const renderer = surface.targets
      .flatMap((target) => target.protocols ?? [])
      .find((protocol) => protocol.name === "Renderer");
    assert.ok(renderer?.dispatch, "Renderer must carry dispatch metadata");
    dispatch = renderer.dispatch;

    vectors = readJson<{ vectors: VectorSnapshotEntry[] }>(
      ".typra-generated",
      "vectors.json",
    ).vectors;
  });

  after(() => {
    rmSync(output, { recursive: true, force: true });
  });

  it("links the seam @dispatch to the discriminator model's lowered polymorphicDispatch", () => {
    const decl = dispatch.decl;
    assert.ok(
      decl,
      "dispatch must carry the lowered PolymorphicDispatchDecl (the Part III IR edge)",
    );
    // Same discriminator field and same variant roster the shape Load switch uses.
    assert.equal(decl.discriminatorField, "kind");
    assert.deepEqual(sortedValues(decl), ["jinja2", "liquid", "mustache"]);
    assert.deepEqual(
      decl.variants
        .map((variant) => variant.typeName.name)
        .sort(),
      ["Jinja2Format", "LiquidFormat", "MustacheFormat"],
    );
    // The discriminator union is closed with no wildcard fallback, so the emitted
    // resolver must reject unknown values exactly like the shape Load switch.
    assert.equal(decl.isClosed, true);
    assert.equal(decl.defaultVariant, null);
    assert.equal(decl.isAbstract, false);
  });

  it("threads namespace/group onto every vector snapshot entry (model-test folder parity)", () => {
    assert.ok(vectors.length > 0, "expected the dispatched vectors to be present");
    for (const entry of vectors) {
      assert.match(
        entry.namespace,
        /DispatchSeam$/,
        "each snapshot entry must carry the seam's namespace for per-group folder placement",
      );
      assert.equal(entry.group, "");
      const decl = entry.dispatch?.decl;
      assert.ok(
        decl,
        "each dispatched snapshot entry must also carry the lowered decl",
      );
      assert.deepEqual(sortedValues(decl), ["jinja2", "liquid", "mustache"]);
    }
  });
});
