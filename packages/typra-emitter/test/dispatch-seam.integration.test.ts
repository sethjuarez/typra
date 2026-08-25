import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";

// End-to-end integration coverage for the dispatched seam.
//
// The example TypeSpec (fixtures/dispatch-seam/main.tsp) is COMMITTED — a full
// model + @sample + polymorphic @discriminator("kind") union + @dispatch seam +
// @vectors. The emitted code it produces is NOT committed: this test compiles the
// committed spec to a throwaway temp directory and asserts on the real generated
// output. That keeps the inspectable TypeSpec in the tree while proving the
// generated shape stays correct, without checking a large generated tree into git.
//
// Scope note (Part II-A): dispatch is resolved into the IR/surface only. The seam
// still renders as a plain, key-free scaffold — there is no per-language resolve/
// registry glue yet (that is Part II-B). These assertions lock exactly that: the
// polymorphic discriminator de/serialization is real, the seam is key-free, and
// the resolved dispatch path is recorded on every target's export surface.

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "dispatch-seam",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.DispatchSeam.Root";
const EXPECTED_DISPATCH_PATH = "agent.template.format.kind";
const TARGETS = ["typescript", "python", "go"] as const;

describe("dispatch-seam end-to-end emission", () => {
  let output: string;

  // Model files nest under a namespace-derived subtree that varies per target
  // (e.g. typescript/fixtures/dispatch-seam/, python/fixtures/dispatchseam/,
  // while Go flattens into its package dir). Locate by basename so the assertions
  // stay robust to that layout rather than pinning a per-target directory shape.
  const findFile = (targetDir: string, basename: string): string => {
    const root = path.join(output, targetDir);
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.name === basename) {
          return full;
        }
      }
    }
    throw new Error(`Emitted file '${basename}' not found under ${targetDir}/`);
  };

  const read = (targetDir: string, basename: string): string =>
    readFileSync(findFile(targetDir, basename), "utf8");

  before(async () => {
    output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-seam-"));
    const result = await generate({
      output,
      source: FIXTURE,
      rootObject: ROOT_OBJECT,
      targets: [...TARGETS],
      format: false,
      generateTests: false,
      deterministic: true,
    });
    assert.equal(result.success, true, result.errors?.join("\n"));
  });

  after(() => {
    rmSync(output, { recursive: true, force: true });
  });

  it("emits real polymorphic discriminator dispatch in TypeScript", () => {
    const source = read("typescript", "template-format.ts");
    // The base routes to the concrete subtype by the discriminator value.
    assert.match(source, /static\s+load\s*\(/);
    assert.match(source, /loadKind\s*\(/);
    assert.match(source, /case "mustache":\s*\n\s*return MustacheFormat\.load/);
    assert.match(source, /case "jinja2":\s*\n\s*return Jinja2Format\.load/);
    assert.match(source, /case "liquid":\s*\n\s*return LiquidFormat\.load/);
    // Subtypes extend the polymorphic base and carry their variant field.
    assert.match(source, /class MustacheFormat extends TemplateFormat/);
    assert.match(source, /partialsEnabled/);
  });

  it("emits real polymorphic discriminator dispatch in Python", () => {
    const source = read("python", "_TemplateFormat.py");
    assert.match(source, /def load_kind\(/);
    assert.match(source, /MustacheFormat\.load\(/);
    assert.match(source, /Jinja2Format\.load\(/);
    assert.match(source, /LiquidFormat\.load\(/);
    assert.match(source, /class MustacheFormat\(TemplateFormat\)/);
  });

  it("emits real polymorphic discriminator dispatch in Go", () => {
    const source = read("go", "template_format.go");
    assert.match(source, /func LoadTemplateFormat\(/);
    assert.match(source, /case "mustache":\s*\n\s*return LoadMustacheFormat/);
    assert.match(source, /case "jinja2":\s*\n\s*return LoadJinja2Format/);
    assert.match(source, /case "liquid":\s*\n\s*return LoadLiquidFormat/);
  });

  it("renders the @dispatch seam as a key-free scaffold (resolve/registry is Part II-B)", () => {
    const ts = read("typescript", "renderer.ts");
    // A plain seam interface over the two declared params — no discriminator key,
    // no resolver, no registry. Part II-A must not leak emission concerns.
    assert.match(ts, /interface Renderer/);
    assert.match(ts, /render\(agent: Agent, inputs: Inputs\)/);
    assert.doesNotMatch(ts, /Registry|register\w*Renderer|resolve\w*Renderer/i);

    const go = read("go", "renderer.go");
    assert.match(go, /type Renderer interface/);
    assert.match(go, /Render\(agent Agent, inputs Inputs\)/);
    assert.doesNotMatch(go, /Registry|Register\w*Renderer|Resolve\w*Renderer/);
  });

  it("records the resolved dispatch path on every target's export surface", () => {
    const surface = JSON.parse(
      readFileSync(
        path.join(output, ".typra-generated", "export-surfaces.json"),
        "utf8",
      ),
    ) as {
      root?: { object?: string };
      targets?: Array<{
        target: string;
        protocols?: Array<{
          name: string;
          dispatch?: {
            path?: string;
            discriminator?: { model?: string; field?: string };
          };
        }>;
      }>;
    };

    assert.equal(surface.root?.object, ROOT_OBJECT);

    for (const targetName of TARGETS) {
      const target = surface.targets?.find((item) => item.target === targetName);
      assert.ok(target, `export surface missing target ${targetName}`);
      const renderer = target.protocols?.find(
        (protocol) => protocol.name === "Renderer",
      );
      assert.ok(
        renderer,
        `export surface missing Renderer seam for ${targetName}`,
      );
      assert.equal(
        renderer.dispatch?.path,
        EXPECTED_DISPATCH_PATH,
        `unexpected dispatch path for ${targetName}`,
      );
      assert.equal(renderer.dispatch?.discriminator?.model, "TemplateFormat");
      assert.equal(renderer.dispatch?.discriminator?.field, "kind");
    }
  });
});
