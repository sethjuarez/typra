import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";

// Coerce-aware dispatch path resolution.
//
// The prompty seams reference their discriminator model through a
// `Model | string` union with a `@coerce` (the "object OR shorthand string"
// wire spelling). `collectDispatchPaths` traverses INTO the coerce-canonical
// model arm, so the discriminator stays reachable and emit succeeds. Before the
// fix this fixture failed to emit with `typra-emitter-dispatch-unreachable`.
//
// This is a real compile (not a mock) so it also proves the discriminator model
// still lowers its PolymorphicDispatchDecl (the typed rail) through the union,
// AND that PIN-ONLY discriminated subtypes populate the variant roster.

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "features",
  "dispatch-union-coerce",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.Features.DispatchUnionCoerce.Root";

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

const sortedValues = (decl: PolymorphicDispatchDecl): string[] =>
  decl.variants.map((variant) => variant.value).sort();

describe("coerce-aware @dispatch: discriminator through a `T | string` union param", () => {
  let output: string;
  let result: Awaited<ReturnType<typeof generate>>;
  let dispatch: Dispatch;

  before(async () => {
    output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-union-coerce-"));
    result = await generate({
      output,
      source: FIXTURE,
      rootObject: ROOT_OBJECT,
      targets: ["go"],
      format: false,
      generateTests: false,
      deterministic: true,
    });
    assert.equal(
      result.success,
      true,
      `emit must succeed through the coerced union param, got: ${result.errors?.join(
        "\n",
      )}`,
    );

    const surface = JSON.parse(
      readFileSync(
        path.join(output, ".typra-generated", "export-surfaces.json"),
        "utf8",
      ),
    ) as Surface;
    const renderer = surface.targets
      .flatMap((target) => target.protocols ?? [])
      .find((protocol) => protocol.name === "Renderer");
    assert.ok(renderer?.dispatch, "Renderer must carry dispatch metadata");
    dispatch = renderer.dispatch;
  });

  after(() => {
    rmSync(output, { recursive: true, force: true });
  });

  it("resolves the discriminator access path through the coerce-canonical arm", () => {
    assert.deepEqual(dispatch.discriminator, {
      model: "TemplateFormat",
      field: "kind",
    });
    assert.equal(dispatch.path, "agent.template.format.kind");
  });

  it("still lowers the typed PolymorphicDispatchDecl through the union (pin-only subtypes)", () => {
    const decl = dispatch.decl;
    assert.ok(
      decl,
      "dispatch must carry the lowered PolymorphicDispatchDecl even behind a coerced union",
    );
    assert.equal(decl.discriminatorField, "kind");
    // Pin-only subtypes (no extra fields) still populate the variant roster.
    assert.deepEqual(sortedValues(decl), ["jinja2", "mustache"]);
    assert.deepEqual(
      decl.variants.map((variant) => variant.typeName.name).sort(),
      ["Jinja2Format", "MustacheFormat"],
    );
    assert.equal(decl.isClosed, true);
    assert.equal(decl.defaultVariant, null);
  });
});
