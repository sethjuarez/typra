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
//
// Three seam shapes are asserted side by side:
//   - Renderer : CLOSED union; discriminator field IS the coerce target.
//   - Executor : OPEN union (`string` member) + a `*` wildcard catch-all, AND
//                the discriminator field DIFFERS from the coerce target — Model
//                coerces to #{id}, but dispatch resolves `provider`. The bare
//                string shorthand yields {id} with NO provider; emit must still
//                succeed and `agent.model.provider` must resolve. The `*` subtype
//                lowers to the decl's fallback `defaultVariant`.
//   - Parser   : CLOSED union; a second field-IS-coerce-target seam.

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
const sortedTypeNames = (decl: PolymorphicDispatchDecl): string[] =>
  decl.variants.map((variant) => variant.typeName.name).sort();

describe("coerce-aware @dispatch: discriminators through `T | string` union params", () => {
  let output: string;
  let result: Awaited<ReturnType<typeof generate>>;
  const dispatches = new Map<string, Dispatch>();

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
      `emit must succeed through the coerced union params, got: ${result.errors?.join(
        "\n",
      )}`,
    );

    const surface = JSON.parse(
      readFileSync(
        path.join(output, ".typra-generated", "export-surfaces.json"),
        "utf8",
      ),
    ) as Surface;
    for (const protocol of surface.targets.flatMap(
      (target) => target.protocols ?? [],
    )) {
      if (protocol.dispatch && !dispatches.has(protocol.name)) {
        dispatches.set(protocol.name, protocol.dispatch);
      }
    }
  });

  after(() => {
    rmSync(output, { recursive: true, force: true });
  });

  it("resolves the render discriminator where the coerce target IS the discriminator field", () => {
    const dispatch = dispatches.get("Renderer");
    assert.ok(dispatch, "Renderer must carry dispatch metadata");
    assert.deepEqual(dispatch.discriminator, {
      model: "TemplateFormat",
      field: "kind",
    });
    assert.equal(dispatch.path, "agent.template.format.kind");

    const decl = dispatch.decl;
    assert.ok(decl, "Renderer dispatch must lower a PolymorphicDispatchDecl");
    assert.equal(decl.discriminatorField, "kind");
    // Pin-only subtypes (no extra fields) still populate the variant roster.
    assert.deepEqual(sortedValues(decl), ["jinja2", "mustache"]);
    assert.deepEqual(sortedTypeNames(decl), ["Jinja2Format", "MustacheFormat"]);
    assert.equal(decl.isClosed, true);
    assert.equal(decl.defaultVariant, null);
  });

  it("resolves the execute discriminator through an OPEN union + `*` wildcard where the coerce target DIFFERS from the discriminator field (Model coerces #{id}, dispatches provider)", () => {
    const dispatch = dispatches.get("Executor");
    assert.ok(dispatch, "Executor must carry dispatch metadata");
    // The load-bearing case: `@coerce(Model, string, #{ id })` targets `id`, but
    // the dispatch discriminator is `provider`. The bare-string shorthand yields
    // {id} with no provider; emit must still succeed and the path must resolve
    // through the coerce-canonical model arm to the discriminator field.
    assert.deepEqual(dispatch.discriminator, {
      model: "Model",
      field: "provider",
    });
    assert.equal(dispatch.path, "agent.model.provider");

    const decl = dispatch.decl;
    assert.ok(decl, "Executor dispatch must lower a PolymorphicDispatchDecl");
    assert.equal(decl.discriminatorField, "provider");
    // Open union (`string` member) => not closed. The known literal providers
    // stay enumerated variants; the `*` wildcard subtype is NOT a variant.
    assert.equal(decl.isClosed, false);
    assert.deepEqual(sortedValues(decl), ["azure", "openai"]);
    assert.deepEqual(sortedTypeNames(decl), ["AzureModel", "OpenAIModel"]);
    // The `provider: "*"` catch-all lowers to the fallback `defaultVariant` —
    // the downstream-registry delegation hook — not into the variant roster.
    assert.ok(
      decl.defaultVariant,
      "the `*` wildcard subtype must lower to the fallback defaultVariant",
    );
    assert.equal(
      (decl.defaultVariant as { typeName: { name: string } }).typeName.name,
      "CustomModel",
    );
  });

  it("resolves the parse discriminator through a second coerced union seam", () => {
    const dispatch = dispatches.get("Parser");
    assert.ok(dispatch, "Parser must carry dispatch metadata");
    assert.deepEqual(dispatch.discriminator, {
      model: "ParserConfig",
      field: "kind",
    });
    assert.equal(dispatch.path, "agent.parser.kind");

    const decl = dispatch.decl;
    assert.ok(decl, "Parser dispatch must lower a PolymorphicDispatchDecl");
    assert.equal(decl.discriminatorField, "kind");
    assert.deepEqual(sortedValues(decl), ["chat", "completion"]);
    assert.deepEqual(sortedTypeNames(decl), ["ChatParser", "CompletionParser"]);
    assert.equal(decl.isClosed, true);
    assert.equal(decl.defaultVariant, null);
  });
});
