// Copyright (c) Microsoft. All rights reserved.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";
import type { PolymorphicDispatchDecl } from "../src/ir/declarations.js";
import { dispatchBehavior } from "../src/ir/vector.js";
import ts from "typescript";

const require = createRequire(import.meta.url);

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "features",
  "dispatch-target-regression",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.Features.DispatchTargetRegression.Root";
const COLLISION_FIXTURE = path.resolve(
  process.cwd(),
  "test",
  "fixtures",
  "dispatch-wildcard-collision",
  "main.tsp",
);
const COLLISION_ROOT =
  "Typra.Fixtures.Features.DispatchWildcardCollision.Root";

function findFile(root: string, basename: string): string {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current)) {
      const candidate = path.join(current, entry);
      if (statSync(candidate).isDirectory()) pending.push(candidate);
      else if (entry === basename) return candidate;
    }
  }
  throw new Error(`Missing generated file ${basename} under ${root}`);
}

describe("open @dispatch wildcard contract", () => {
  it("normalizes open and closed behavior once in the shared IR", () => {
    const open: PolymorphicDispatchDecl = {
      discriminatorField: "kind",
      variants: [
        {
          value: "known",
          typeName: { namespace: "Test", name: "Known" },
        },
      ],
      defaultVariant: {
        typeName: { namespace: "Test", name: "CustomCarrier" },
        isSelfReference: false,
      },
      isAbstract: true,
      isClosed: false,
    };
    assert.deepEqual(dispatchBehavior(open), {
      openness: "open",
      wildcard: {
        name: "wildcard",
        variant: open.defaultVariant,
      },
    });

    const closed: PolymorphicDispatchDecl = {
      ...open,
      defaultVariant: null,
      isClosed: true,
    };
    assert.deepEqual(dispatchBehavior(closed), {
      openness: "closed",
      wildcard: null,
    });

    const legacyOpen: PolymorphicDispatchDecl = {
      ...open,
      defaultVariant: null,
      isClosed: false,
    };
    assert.deepEqual(dispatchBehavior(legacyOpen), {
      openness: "open",
      wildcard: null,
    });
  });

  it("emits one required, explicitly named wildcard provider slot in every runtime", async () => {
    const output = mkdtempSync(path.join(tmpdir(), "typra-open-dispatch-"));
    try {
      const result = await generate({
        output,
        source: FIXTURE,
        rootObject: ROOT_OBJECT,
        targets: [
          "typescript",
          "python",
          "go",
          "csharp",
          "java",
          "rust",
          "swift",
        ],
        format: false,
        generateTests: true,
        deterministic: true,
      });
      assert.equal(result.success, true, result.errors?.join("\n"));

      const cases: Array<{
        target: string;
        file: string;
        required: RegExp;
        route: RegExp;
        forbidden: RegExp[];
      }> = [
        {
          target: "typescript",
          file: "renderer-resolver.ts",
          required: /& \{ wildcard: Renderer \}/,
          route: /default:\s+return registry\.wildcard;/,
          forbidden: [/\bwildcard\?:/, /\bcustom\??:/],
        },
        {
          target: "python",
          file: "_renderer_resolver.py",
          required: /^\s+wildcard: Renderer$/m,
          route: /return registry\.wildcard/,
          forbidden: [/wildcard: Renderer \| None/, /impls\.get\("wildcard"\)/],
        },
        {
          target: "go",
          file: "renderer_resolver.go",
          required: /^\s+Wildcard Renderer$/m,
          route: /return registry\.Wildcard, nil/,
          forbidden: [/Custom Renderer/, /Wildcard Renderer\s*\/\//],
        },
        {
          target: "csharp",
          file: "RendererResolver.cs",
          required: /IRenderer Wildcard \{ get; \}/,
          route: /_ => registry\.Wildcard/,
          forbidden: [/IRenderer\? Wildcard/, /IRenderer\? Custom/],
        },
        {
          target: "java",
          file: "RendererProvider.java",
          required: /Renderer wildcard\(\);/,
          route: /Renderer wildcard\(\);/,
          forbidden: [/Renderer custom\(\)/],
        },
        {
          target: "rust",
          file: "renderer_resolver.rs",
          required: /fn wildcard\(&self\) -> &dyn Renderer;/,
          route: /_ => Some\(registry\.wildcard\(\)\)/,
          forbidden: [/fn custom\(/, /fn wildcard\([^)]*\) -> Option/],
        },
        {
          target: "swift",
          file: "renderer_resolver.swift",
          required: /var wildcard: any Renderer \{ get \}/,
          route: /default: return registry\.wildcard/,
          forbidden: [/var wildcard: \(any Renderer\)\?/, /var custom:/],
        },
      ];

      for (const check of cases) {
        const source = readFileSync(
          findFile(path.join(output, check.target), check.file),
          "utf8",
        );
        assert.match(source, check.required, `${check.target}: required slot`);
        assert.match(source, check.route, `${check.target}: wildcard route`);
        for (const forbidden of check.forbidden) {
          assert.doesNotMatch(
            source,
            forbidden,
            `${check.target}: forbidden optional/custom fallback`,
          );
        }
      }

      const closedControls = [
        ["typescript", "closed-router-resolver.ts", /throw new Error\(/],
        ["python", "_closed_router_resolver.py", /raise ValueError\(/],
        [
          "go",
          "closed_router_resolver.go",
          /fmt\.Errorf\("unknown ClosedRouter/,
        ],
        ["csharp", "ClosedRouterResolver.cs", /throw new ArgumentException/],
        [
          "java",
          "ClosedRouterResolver.java",
          /throw new IllegalArgumentException/,
        ],
        [
          "rust",
          "closed_router_resolver.rs",
          /other => panic!\("Unknown ClosedRouter/,
        ],
        [
          "swift",
          "closed_router_resolver.swift",
          /throw TypraRuntimeError\.unknownDiscriminator/,
        ],
      ] as const;
      for (const [target, file, rejectsUnknown] of closedControls) {
        const source = readFileSync(
          findFile(path.join(output, target), file),
          "utf8",
        );
        assert.match(
          source,
          rejectsUnknown,
          `${target}: closed control must reject discriminator "contoso"`,
        );
        assert.doesNotMatch(source, /wildcard/i, `${target}: closed control`);
      }

      const closedRuntimeControls = [
        [
          "typescript",
          "closed-router.conformance.test.ts",
          /const provider = closedRouterProvider;[\s\S]*resolveClosedRouter\("typra-unknown-discriminator", provider\)/,
        ],
        [
          "python",
          "test_closed_router_conformance.py",
          /resolve_closed_router\("typra-unknown-discriminator", closed_router_provider\)/,
        ],
        [
          "go",
          "closed_router_conformance_test.go",
          /provider := vectoradapters\.ClosedRouterProvider\(\)[\s\S]*ResolveClosedRouter\("typra-unknown-discriminator", provider\)/,
        ],
        [
          "csharp",
          "ClosedRouterConformanceTests.cs",
          /var provider = Provider\(\);[\s\S]*ClosedRouterResolver\.Resolve\("typra-unknown-discriminator", provider\)/,
        ],
        [
          "java",
          "ClosedRouterConformanceTests.java",
          /ClosedRouterProvider provider = [^;]+\.closedRouter\(\);[\s\S]*ClosedRouterResolver\.resolve\("typra-unknown-discriminator", provider\)/,
        ],
        [
          "rust",
          "closed_router_conformance_test.rs",
          /closed_router_resolver::resolve\("typra-unknown-discriminator", &provider\)/,
        ],
        [
          "swift",
          "ClosedRouterConformanceTests.swift",
          /ClosedRouterResolver\.resolve\(kind: "typra-unknown-discriminator", registry: provider\)/,
        ],
      ] as const;
      for (const [target, file, directResolverAssertion] of closedRuntimeControls) {
        const source = readFileSync(
          findFile(path.join(output, target), file),
          "utf8",
        );
        assert.match(
          source,
          directResolverAssertion,
          `${target}: generated conformance must execute the closed resolver with an arbitrary unknown string`,
        );
      }

      const javaResolver = readFileSync(
        findFile(path.join(output, "java"), "RendererResolver.java"),
        "utf8",
      );
      assert.match(
        javaResolver,
        /Objects\.requireNonNull\(registry\.wildcard\(\)/,
        "Java must reject a null wildcard returned by its required accessor",
      );
      const csharpResolver = readFileSync(
        findFile(path.join(output, "csharp"), "RendererResolver.cs"),
        "utf8",
      );
      assert.match(
        csharpResolver,
        /registry\.Wildcard \?\? throw new InvalidOperationException/,
        "C# must reject a null wildcard despite nullable-reference warning suppression",
      );
      const goResolver = readFileSync(
        findFile(path.join(output, "go"), "renderer_resolver.go"),
        "utf8",
      );
      assert.match(
        goResolver,
        /if registry\.Wildcard == nil \{[\s\S]*return nil, fmt\.Errorf\("Renderer provider requires a non-nil wildcard/,
        "Go must reject a nil wildcard on a directly constructed zero-value provider",
      );

      const tsResolver = findFile(
        path.join(output, "typescript"),
        "renderer-resolver.ts",
      );
      const missingProvider = path.join(
        path.dirname(tsResolver),
        "missing-wildcard-provider.ts",
      );
      writeFileSync(
        missingProvider,
        [
          'import type { RendererProvider } from "./renderer-resolver";',
          "export const missing: RendererProvider = {",
          "  jinja2: null,",
          "  mustache: null,",
          "};",
          "",
        ].join("\n"),
      );
      const program = ts.createProgram([missingProvider], {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Node10,
      });
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .filter(
          (diagnostic) =>
            path.basename(diagnostic.file?.fileName ?? "") ===
            "missing-wildcard-provider.ts",
        )
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      assert.ok(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.includes("wildcard") && diagnostic.includes("missing"),
        ),
        `missing wildcard provider must fail TypeScript compilation:\n${diagnostics.join("\n")}`,
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("rejects a normalized known variant collision with the reserved wildcard slot before output", async () => {
    const output = mkdtempSync(
      path.join(tmpdir(), "typra-dispatch-wildcard-collision-"),
    );
    try {
      const config = path.join(output, "tspconfig.yaml");
      const targetOutput = path.join(output, "python");
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${JSON.stringify(output)}`,
          `    root-object: ${JSON.stringify(COLLISION_ROOT)}`,
          '    root-namespace: "Typra.Fixtures.Features.DispatchWildcardCollision"',
          "    emit-targets:",
          "      - type: python",
          `        output-dir: ${JSON.stringify(targetOutput)}`,
          "        format: false",
          "",
        ].join("\n"),
      );
      const compilerEntry = require.resolve("@typespec/compiler");
      const compilerRoot = path.resolve(path.dirname(compilerEntry), "..", "..");
      const result = spawnSync(
        process.execPath,
        [
          path.join(compilerRoot, "cmd", "tsp.js"),
          "compile",
          COLLISION_FIXTURE,
          "--config",
          config,
        ],
        { cwd: output, encoding: "utf8" },
      );
      unlinkSync(config);
      assert.notEqual(result.status, 0);
      assert.match(
        `${result.stdout}${result.stderr}`,
        /typra-emitter-dispatch-wildcard-slot-collision/,
      );
      assert.equal(
        existsSync(targetOutput),
        false,
        "a reserved wildcard slot collision must stop before target output",
      );
      assert.deepEqual(
        readdirSync(output),
        [],
        "the failed compile must leave no generated artifacts",
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
