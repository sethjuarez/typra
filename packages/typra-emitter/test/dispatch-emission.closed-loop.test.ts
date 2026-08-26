// Copyright (c) Microsoft. All rights reserved.

// Rendered-code lock proving @dispatch routing is EMITTED (not hand-written glue)
// for every runtime target, plus the Part III §8 retirement of the stringly
// monolith once a seam is fully dispatched.
//
// Executable end-to-end proofs live in siblings: the TYPED resolver rail is run
// per language in `dispatch-conformance.typed-typescript.test.ts` /
// `dispatch-conformance.typed-python.test.ts` (emitted per-interface conformance,
// positive + missing-attachment negative) and `dispatch-resolver.typed-*.test.ts`
// (resolver contract). This file asserts the RENDERED target code: every runtime
// target (C#, Python, TypeScript, Java, Swift, Go, Rust) now emits a typed
// per-interface conformance suite that routes through the emitted resolver against
// a consumer-attached provider — and no longer emits the
// VectorRunner/VectorConformanceTests monolith at all.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "dispatch-seam",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.DispatchSeam.Root";

describe("@dispatch routing is emitted (rendered-code lock)", () => {
  // Every runtime target now emits a typed per-interface conformance suite that
  // routes through the emitted resolver against a consumer-attached provider and
  // no longer emits the stringly monolith — each is also RUN end-to-end in its
  // typed sibling test.
  it("emits @dispatch routing glue for every runtime target", async () => {
    const output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-render-"));
    try {
      const result = await generate({
        output,
        source: FIXTURE,
        rootObject: ROOT_OBJECT,
        targets: [
          "typescript",
          "python",
          "go",
          "java",
          "csharp",
          "rust",
          "swift",
        ],
        format: false,
        generateTests: true,
        deterministic: true,
      });
      assert.equal(result.success, true, result.errors?.join("\n"));

      const read = (...parts: string[]): string =>
        readFileSync(path.join(output, ...parts), "utf8");

      // Part III §8: languages migrated to the TYPED resolver rail no longer emit
      // the stringly VectorRunner/VectorConformanceTests monolith for an
      // all-dispatched fixture. Instead they emit a per-interface, typed
      // conformance suite that ROUTES THROUGH the emitted resolver against a
      // consumer-attached provider — the same discriminator the shape reads,
      // now enforced by the compiler rather than a JSON dictionary.
      type TypedLock = {
        conformance: string;
        mustInclude: RegExp[];
        retired: string[];
      };
      const typedLocks: TypedLock[] = [
        {
          conformance: path.join(
            "csharp",
            "tests",
            "RendererConformanceTests.cs",
          ),
          mustInclude: [
            // consumes the emitted resolver, not a stringly composite key
            /RendererResolver\.Resolve\(kind, Provider\(\)\)/,
            // reads the SAME typed discriminator the shape Load switch reads
            /var kind = agent\.Template\.Format\.Kind;/,
            // invokes the typed seam method on the resolved impl
            /await impl!\.RenderAsync\(agent, inputs\)/,
            // provider VALUE is consumer-authored outside the conformance tree
            /VectorProviders\.Renderer\(\)/,
          ],
          retired: [
            path.join("csharp", "tests", "VectorConformanceTests.cs"),
            path.join("csharp", "tests", "VectorRunner.cs"),
          ],
        },
        {
          conformance: path.join(
            "python",
            "tests",
            "test_renderer_conformance.py",
          ),
          mustInclude: [
            // consumes the emitted resolver, not a stringly composite key
            /impl = resolve_renderer\(kind, renderer_provider\)/,
            // imports the emitted resolver twin of the shape load switch
            /\._renderer_resolver import resolve_renderer/,
            // reads the SAME typed discriminator the shape load switch reads
            /kind = agent\.template\.format\.kind/,
            // invokes the typed seam method on the resolved impl
            /result = impl\.render\(agent, inputs\)/,
          ],
          retired: [
            path.join("python", "tests", "test_vector_conformance.py"),
            path.join("python", "tests", "vector_runner.py"),
          ],
        },
        {
          conformance: path.join(
            "typescript",
            "tests",
            "renderer.conformance.test.ts",
          ),
          mustInclude: [
            // consumes the emitted resolver, not a stringly composite key
            /const impl = resolveRenderer\(kind, rendererProvider\)/,
            // imports the emitted resolver twin of the shape load switch
            // (import path is namespace-derived here, so match the module suffix)
            /from "[^"]*renderer-resolver"/,
            // reads the SAME typed discriminator the shape load switch reads
            /const kind = agent\.template\.format\.kind;/,
            // invokes the typed seam method on the resolved impl
            /await impl!\.render\(agent, inputs\)/,
          ],
          retired: [
            path.join("typescript", "tests", "vector-conformance.test.ts"),
            path.join("typescript", "tests", "vector-runner.ts"),
          ],
        },
        {
          conformance: path.join(
            "java",
            "tests",
            "RendererConformanceTests.java",
          ),
          mustInclude: [
            // consumes the emitted resolver, not a stringly composite key
            /Renderer impl = RendererResolver\.resolve\(kind, VectorProviders\.renderer\(\)\)/,
            // reads the SAME typed discriminator the shape load switch reads
            /String kind = agent\.template\.format\.kind;/,
            // invokes the typed seam method on the resolved impl
            /Object actual = impl\.render\(agent, inputs\)/,
            // provider VALUE is consumer-authored outside the conformance tree
            /VectorProviders\.renderer\(\)/,
          ],
          retired: [
            path.join("java", "tests", "VectorConformanceTests.java"),
            path.join("java", "tests", "VectorRunner.java"),
          ],
        },
        {
          conformance: path.join(
            "swift",
            "tests",
            "RendererConformanceTests.swift",
          ),
          mustInclude: [
            // consumes the emitted resolver, not a stringly composite key
            /guard let impl = try RendererResolver\.resolve\(kind: kind, provider: provider\(\)\)/,
            // reads the SAME discriminator off the typed union's serialized form
            // (a Swift union is an enum with no stored discriminator property)
            /let kind = try \(agent\.template\.format\.save\(\)\)\["kind"\] as! String/,
            // invokes the typed seam method on the resolved impl
            /let actual = try await impl\.render\(agent: agent, inputs: inputs\)/,
            // provider VALUE is consumer-authored outside the conformance tree
            /VectorProviders\.renderer\(\)/,
          ],
          retired: [
            path.join("swift", "tests", "VectorConformanceTests.swift"),
            path.join("swift", "tests", "VectorRunner.swift"),
          ],
        },
        {
          conformance: path.join(
            "go",
            "tests",
            "renderer_conformance_test.go",
          ),
          mustInclude: [
            // consumes the emitted resolver against the consumer provider, not a
            // stringly composite key
            /impl, err := fixtures\.ResolveRenderer\(kind, vectoradapters\.RendererProvider\(\)\)/,
            // reads the SAME discriminator off the typed union's serialized form
            // (a Go union field is interface{} with no exported discriminator)
            /kind := agent\.Template\.Format\.\(interface \{/,
            // invokes the typed seam method on the resolved impl
            /actual, err := impl\.Render\(agent, inputs\)/,
            // provider VALUE is consumer-authored outside the conformance tree
            /vectoradapters\.RendererProvider\(\)/,
          ],
          retired: [
            path.join("go", "tests", "vector_conformance_test.go"),
            path.join("go", "vectorrunner", "vector_runner.go"),
          ],
        },
        {
          conformance: path.join(
            "rust",
            "tests",
            "renderer_conformance_test.rs",
          ),
          mustInclude: [
            // consumes the emitted resolver against the consumer provider, not a
            // stringly composite key
            /let seam_impl = renderer_resolver::resolve\(kind, &provider\)/,
            // imports the emitted resolver twin of the shape discriminator match
            // (import root is import-path-derived, so match the module suffix)
            /use \S+::model::renderer_resolver::\{self, RendererProvider\};/,
            // reads the SAME discriminator off the typed union's serialized form
            // (a Rust union field is serde_json::Value with no discriminator field)
            /let kind = agent\.template\.format\s*\n\s*\.get\("kind"\)/,
            // invokes the typed seam method on the resolved impl
            /let actual = seam_impl\.render\(&agent, &inputs\)\.await/,
            // provider VALUE is consumer-authored outside the conformance tree
            /vector_adapters::renderer_provider\(\)/,
          ],
          retired: [
            path.join("rust", "tests", "vector_conformance_test.rs"),
            path.join("rust", "tests", "vector_runner", "mod.rs"),
          ],
        },
      ];

      for (const lock of typedLocks) {
        const conformance = read(lock.conformance);
        for (const pattern of lock.mustInclude) {
          assert.match(
            conformance,
            pattern,
            `${lock.conformance} must route through the typed resolver rail (${pattern})`,
          );
        }
        for (const retired of lock.retired) {
          assert.ok(
            !existsSync(path.join(output, retired)),
            `${retired} must NOT be emitted once the seam is fully dispatched (typed rail retires the stringly monolith)`,
          );
        }
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
