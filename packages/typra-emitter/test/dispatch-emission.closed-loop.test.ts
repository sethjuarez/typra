// Copyright (c) Microsoft. All rights reserved.

// Rendered-code lock proving @dispatch routing is EMITTED (not hand-written glue)
// for every runtime target, plus the Part III §8 retirement of the stringly
// monolith once a seam is fully dispatched.
//
// Executable end-to-end proofs live in siblings: the TYPED resolver rail is run
// per language in `dispatch-conformance.typed-typescript.test.ts` /
// `dispatch-conformance.typed-python.test.ts` (emitted per-interface conformance,
// positive + missing-attachment negative) and `dispatch-resolver.typed-*.test.ts`
// (resolver contract). This file asserts the RENDERED target code: the still
// stringly-routed targets (Go/Java/Rust/Swift) keep the vector-runner path-walker
// + composite-key lookup, while the migrated targets (C#, Python, TypeScript)
// emit a typed per-interface conformance suite that routes through the emitted
// resolver against a consumer-attached provider — and no longer emit the
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
  // Rendered-code lock for every runtime target. The still stringly-routed
  // targets (Go/Java/Rust/Swift) must define the discriminator path-walker and
  // look up a per-discriminator composite key in their vector-runner, and their
  // harness must pass the resolved @dispatch access path. The migrated targets
  // (C#, Python, TypeScript) instead emit a typed per-interface conformance suite
  // that routes through the emitted resolver and no longer emit the stringly
  // monolith — each is also RUN end-to-end in its typed sibling test.
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

      const PATH = "agent.template.format.kind";
      type LangLock = {
        runner: string;
        harness: string;
        helper: RegExp;
        composite: RegExp;
        harnessArg: string;
      };
      const locks: LangLock[] = [
        {
          runner: path.join("go", "vectorrunner", "vector_runner.go"),
          harness: path.join("go", "tests", "vector_conformance_test.go"),
          helper: /func resolveDispatchKey\(/,
          composite: /operationKey\+"#"\+dispatchKey|operationKey \+ "#" \+ dispatchKey/,
          harnessArg: `, "${PATH}")`,
        },
        {
          runner: path.join("java", "tests", "VectorRunner.java"),
          harness: path.join("java", "tests", "VectorConformanceTests.java"),
          helper: /private static String resolveDispatchKey\(/,
          composite: /operationKey \+ "#" \+ dispatchKey/,
          harnessArg: `, "${PATH}")`,
        },
        {
          runner: path.join("rust", "tests", "vector_runner", "mod.rs"),
          harness: path.join("rust", "tests", "vector_conformance_test.rs"),
          helper: /fn vc_resolve_dispatch_key\(/,
          composite: /\{\}#\{\}", operation_key, dispatch_key/,
          harnessArg: `Some("${PATH}")`,
        },
        {
          runner: path.join("swift", "tests", "VectorRunner.swift"),
          harness: path.join("swift", "tests", "VectorConformanceTests.swift"),
          helper: /func resolveDispatchKey\(/,
          composite: /\\\(operationKey\)#\\\(dispatchKey\)/,
          harnessArg: `dispatchPath: "${PATH}"`,
        },
      ];

      for (const lock of locks) {
        const runner = read(lock.runner);
        const harness = read(lock.harness);
        assert.match(
          runner,
          lock.helper,
          `${lock.runner} must define the @dispatch discriminator path walker`,
        );
        assert.match(
          runner,
          lock.composite,
          `${lock.runner} must look up a per-discriminator composite key`,
        );
        assert.ok(
          harness.includes(lock.harnessArg),
          `${lock.harness} must pass the resolved @dispatch access path (${lock.harnessArg})`,
        );
      }

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
