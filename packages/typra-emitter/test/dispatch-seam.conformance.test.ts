import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";

// Behavioral conformance for the dispatched seam.
//
// The sibling `dispatch-seam.integration.test.ts` proves the emitted *shape* —
// the models de/serialize polymorphically and the seam is key-free. This file
// proves the emitted *behavior*: that the discriminator access path Part II-A
// resolved (`agent.template.format.kind`) actually routes each vector's input to
// the correct implementation and reproduces the vector's `expected` output.
//
// It deliberately uses ONLY Part II-A artifacts — the recorded dispatch path and
// discriminator from export-surfaces.json, plus the committed @vector cases from
// vectors.json — and performs the dispatch itself. This mirrors, in-process, what
// the per-language conformance harness will later *emit* (Part II-B), so we can
// find out whether the resolved path is correct now, without emission templates.

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "dispatch-seam",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.DispatchSeam.Root";

// One renderer per TemplateFormat.kind. Each understands ONLY its own dialect's
// delimiter style, so routing to the wrong renderer leaves the template
// unsubstituted (output !== expected). That makes the dispatch decision
// behaviorally load-bearing rather than cosmetic: if the emitter resolved the
// wrong discriminator path, these vectors go red.
type Renderer = (content: string, values: Record<string, unknown>) => string;
const RENDERERS: Record<string, Renderer> = {
  mustache: (content, values) =>
    content.replace(/\{\{(\w+)\}\}/g, (_m, key) =>
      String(values[key] ?? `{{${key}}}`),
    ),
  jinja2: (content, values) =>
    content.replace(/\{\{ (\w+) \}\}/g, (_m, key) =>
      String(values[key] ?? `{{ ${key} }}`),
    ),
  liquid: (content, values) =>
    content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) =>
      String(values[key] ?? `{{ ${key} }}`),
    ),
};

const resolvePath = (root: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>((node, key) => {
    if (
      node &&
      typeof node === "object" &&
      key in (node as Record<string, unknown>)
    ) {
      return (node as Record<string, unknown>)[key];
    }
    return undefined;
  }, root);

interface Dispatch {
  discriminator: { model: string; field: string };
  path: string;
}
interface Surface {
  targets: {
    target: string;
    protocols?: { name: string; dispatch?: Dispatch }[];
  }[];
}
interface VectorEntry {
  vector: {
    name: string;
    input: {
      agent: { template: { content: string } };
      inputs: { values: Record<string, unknown> };
    };
    expected: string;
  };
}

describe("dispatch-seam behavioral conformance (dispatch-by-path)", () => {
  let output: string;
  let dispatch: Dispatch;
  let vectors: VectorEntry[];

  const readJson = <T>(...segments: string[]): T =>
    JSON.parse(readFileSync(path.join(output, ...segments), "utf8")) as T;

  before(async () => {
    output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-conf-"));
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

    vectors = readJson<{ vectors: VectorEntry[] }>(
      ".typra-generated",
      "vectors.json",
    ).vectors;
    assert.equal(vectors.length, 2);
  });

  after(() => {
    rmSync(output, { recursive: true, force: true });
  });

  it("routes every committed vector to the right renderer via the resolved path and reproduces `expected`", () => {
    for (const entry of vectors) {
      const { input, expected, name } = entry.vector;

      // The ONLY emitter-derived decision under test: walk the resolved dispatch
      // path over the vector input to pick the implementation.
      const kind = resolvePath(input, dispatch.path);
      assert.equal(
        typeof kind,
        "string",
        `${name}: dispatch path ${dispatch.path} did not resolve to a discriminator value`,
      );

      const renderer = RENDERERS[kind as string];
      assert.ok(
        renderer,
        `${name}: resolved discriminator '${String(kind)}' has no registered renderer`,
      );

      const actual = renderer(
        input.agent.template.content,
        input.inputs.values,
      );
      assert.equal(
        actual,
        expected,
        `${name}: dispatched renderer produced '${actual}', expected '${expected}'`,
      );
    }
  });

  it("resolves the discriminator field as the terminal segment of the path", () => {
    assert.equal(dispatch.discriminator.model, "TemplateFormat");
    assert.equal(dispatch.discriminator.field, "kind");
    assert.equal(
      dispatch.path.split(".").at(-1),
      dispatch.discriminator.field,
      "the resolved path must terminate at the discriminator field",
    );
  });

  it("proves the resolved path is load-bearing: a different path misroutes", () => {
    // Negative control. `agent.name` is a real, reachable field — but it is NOT
    // the discriminator. If the emitter had guessed it, dispatch would resolve
    // 'greeter' and fail to route. This asserts the emitter did NOT pick it and
    // that such a path genuinely fails to select a renderer.
    assert.notEqual(dispatch.path, "agent.name");
    for (const entry of vectors) {
      const wrong = resolvePath(entry.vector.input, "agent.name");
      assert.equal(wrong, "greeter");
      assert.equal(
        RENDERERS[wrong as string],
        undefined,
        "a non-discriminator path must not select a renderer",
      );
    }
  });
});
