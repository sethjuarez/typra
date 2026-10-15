import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { generate } from "../src/generate.js";

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "features",
  "dispatch-delegate",
  "main.tsp",
);
const ROOT = "Typra.Fixtures.Features.DispatchDelegate.Root";
const require = createRequire(import.meta.url);
const INVALID_FIXTURE = path.resolve(
  process.cwd(),
  "test",
  "fixtures",
  "delegate-invalid",
  "main.tsp",
);
const PYTHON_ADAPTER = path.resolve(
  process.cwd(),
  "fixtures",
  "features",
  "dispatch-delegate",
  "vector-adapters",
  "python",
  "vector_adapters.py",
);
const TYPED_SEAM_FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "features",
  "typed-seam-conformance",
  "main.tsp",
);

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

describe("@delegate provider doubles", () => {
  it("keeps Swift plain-seam conformance independent of dispatched contracts", async () => {
    const output = mkdtempSync(path.join(tmpdir(), "typra-swift-plain-seam-"));
    try {
      const result = await generate({
        output,
        source: TYPED_SEAM_FIXTURE,
        rootObject: "Typra.Fixtures.Features.TypedSeamConformance.Root",
        targets: ["swift"],
        format: false,
        generateTests: true,
        deterministic: true,
      });
      assert.equal(result.success, true, result.errors?.join("\n"));
      const source = readFileSync(
        findFile(path.join(output, "swift"), "vector_conformance.swift"),
        "utf8",
      );
      assert.match(source, /runTransformerConformance/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("emits deterministic attach-only providers in all seven runtimes", async () => {
    const output = mkdtempSync(path.join(tmpdir(), "typra-delegate-"));
    try {
      const result = await generate({
        output,
        source: FIXTURE,
        rootObject: ROOT,
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

      const checks = [
        [
          "typescript",
          "renderer.conformance.test.ts",
          /new delegateAdapters\.Jinja2Renderer\(\)/,
        ],
        ["python", "test_renderer_conformance.py", /delegate_adapters\.Jinja2Renderer\(\)/],
        ["go", "renderer_conformance_test.go", /vectoradapters\.Jinja2Renderer\{\}/],
        ["csharp", "RendererConformanceTests.cs", /new global::[\w.]+\.Jinja2Renderer\(\)/],
        ["java", "RendererConformanceTests.java", /new typra\.fixtures\.features\.dispatchdelegate\.Jinja2Renderer\(\)/],
        ["rust", "renderer_conformance_test.rs", /Jinja2Renderer::default\(\)/],
        ["swift", "RendererConformanceTests.swift", /Jinja2Renderer\(\)/],
      ] as const;

      for (const [target, file, expected] of checks) {
        const source = readFileSync(
          findFile(path.join(output, target), file),
          "utf8",
        );
        assert.match(source, expected, target);
        assert.match(source, /MustacheRenderer/, target);
        assert.match(source, /CustomRenderer/, target);
      }

      const typeScript = readFileSync(
        findFile(
          path.join(output, "typescript"),
          "renderer.conformance.test.ts",
        ),
        "utf8",
      );
      assert.match(
        typeScript,
        /jinja2: new delegateAdapters\.Jinja2Renderer\(\)/,
      );
      assert.match(typeScript, /TypraGeneratedRendererProvider/);
      assert.doesNotMatch(typeScript, /format_kind: new Jinja2Renderer/);
      const metaTypeScript = readFileSync(
        findFile(
          path.join(output, "typescript"),
          "meta-renderer.conformance.test.ts",
        ),
        "utf8",
      );
      assert.match(
        metaTypeScript,
        /type: new delegateAdapters\.TypeRenderer\(\)/,
      );
      assert.match(
        metaTypeScript,
        /kind: new delegateAdapters\.KindRenderer\(\)/,
      );
      const metaRust = readFileSync(
        findFile(
          path.join(output, "rust"),
          "meta_renderer_conformance_test.rs",
        ),
        "utf8",
      );
      assert.match(metaRust, /r#type: vector_adapters::TypeRenderer/);
      assert.match(metaRust, /fn r#type\(&self\)/);
      const metaSwift = readFileSync(
        findFile(
          path.join(output, "swift"),
          "MetaRendererConformanceTests.swift",
        ),
        "utf8",
      );
      assert.match(
        metaSwift,
        /func testDelegateProviderResolves\(\) throws \{/,
        "closed zero-vector Swift delegate probe must propagate resolver errors",
      );

      const noVectorFiles = [
        ["typescript", "renderer-without-vectors.conformance.test.ts"],
        ["python", "test_renderer_without_vectors_conformance.py"],
        ["go", "renderer_without_vectors_conformance_test.go"],
        ["csharp", "RendererWithoutVectorsConformanceTests.cs"],
        ["java", "RendererWithoutVectorsConformanceTests.java"],
        ["rust", "renderer_without_vectors_conformance_test.rs"],
        ["swift", "RendererWithoutVectorsConformanceTests.swift"],
      ] as const;
      for (const [target, file] of noVectorFiles) {
        const source = readFileSync(
          findFile(path.join(output, target), file),
          "utf8",
        );
        assert.match(source, /NoVectorJinja2Renderer/, `${target} no-vector provider`);
        assert.doesNotMatch(
          source,
          /(?:delegateAdapters\.|delegate_adapters\.|vectoradapters\.|global::[\w.]+\.|vector_adapters::)Jinja2Renderer(?:\(\)|::default\(\)|\{\})/,
          `${target} must not reuse the same-union vector implementation symbol`,
        );
        assert.match(
          source,
          /TypraGeneratedRendererWithoutVectorsProvider/,
          `${target} no-vector provider type`,
        );
        if (target === "typescript") {
          assert.match(source, /instantiates and resolves the generated delegate provider/);
        } else if (target === "python") {
          assert.match(source, /def test_renderer_without_vectors_delegate_provider_resolves/);
          assert.doesNotMatch(source, /^import (?:asyncio|inspect|json)$/m);
        } else if (target === "go") {
          assert.match(source, /func TestRendererWithoutVectorsDelegateProviderResolves/);
          assert.doesNotMatch(source, /"encoding\/json"/);
        } else if (target === "csharp") {
          assert.match(source, /public void DelegateProviderResolves\(\)/);
          assert.match(source, /RendererWithoutVectorsResolver\.Resolve\("jinja2", Provider\(\)\)/);
        } else if (target === "java") {
          assert.match(source, /private static void delegateProviderResolves\(\)/);
          assert.match(source, /RendererWithoutVectorsResolver\.resolve\("jinja2", new DelegateProvider\(\)\)/);
          assert.match(source, /RendererWithoutVectorsConformanceTests::delegateProviderResolves/);
        } else if (target === "rust") {
          assert.match(source, /fn renderer_without_vectors_delegate_provider_resolves\(\)/);
          assert.match(source, /renderer_without_vectors_resolver::resolve\("jinja2", &provider\)/);
        } else if (target === "swift") {
          assert.match(source, /func testDelegateProviderResolves\(\)/);
          assert.match(source, /RendererWithoutVectorsResolver\.resolve\(kind: "jinja2", registry: self\.provider\(\)\)/);
        }
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("runs Python delegate conformance with default and dotted import paths", async (t) => {
    if (spawnSync("uv", ["--version"], { stdio: "ignore" }).status !== 0) {
      t.skip("uv toolchain not available");
      return;
    }
    for (const configuredImportPath of [undefined, "acme.generated"]) {
      const output = mkdtempSync(path.join(process.cwd(), "tmp-delegate-python-"));
      try {
        const result = await generate({
          output,
          source: FIXTURE,
          rootObject: ROOT,
          targets: ["python"],
          format: false,
          generateTests: true,
          deterministic: true,
          ...(configuredImportPath ? { importPath: configuredImportPath } : {}),
        });
        assert.equal(result.success, true, result.errors?.join("\n"));

        const pythonOut = path.join(output, "python");
        const resolverImportRoot = configuredImportPath ?? "typra";
        const packageDir = path.join(
          output,
          "module",
          ...resolverImportRoot.split("."),
        );
        mkdirSync(packageDir, { recursive: true });
        cpSync(pythonOut, packageDir, { recursive: true });
        cpSync(PYTHON_ADAPTER, path.join(output, "module", "vector_adapters.py"));

        const conformance = findFile(
          packageDir,
          "test_renderer_without_vectors_conformance.py",
        );
        const source = readFileSync(conformance, "utf8");
        assert.match(
          source,
          new RegExp(
            `from ${resolverImportRoot.replace(/\./g, "\\.")}\\._renderer_without_vectors_resolver import`,
          ),
        );
        assert.match(source, /def test_renderer_without_vectors_delegate_provider_resolves/);

        const consumerOwned = findFile(
          packageDir,
          "test_consumer_owned_renderer_conformance.py",
        );
        const consumerOwnedSource = readFileSync(consumerOwned, "utf8");
        const expectedConsumerImport = configuredImportPath
          ? "acme.generated._consumer_owned_renderer_resolver"
          : "typra._consumer_owned_renderer_resolver";
        assert.match(
          consumerOwnedSource,
          new RegExp(
            `from ${expectedConsumerImport.replace(/\./g, "\\.")} import (?:\\(\\s*)?resolve_consumer_owned_renderer`,
          ),
        );

        const run = spawnSync(
          "uv",
          [
            "run",
            "--python",
            "3.12",
            "--with",
            "pydantic",
            "--with",
            "pytest",
            "--with",
            "PyYAML",
            "python",
            "-m",
            "pytest",
            conformance,
            "-q",
            "-p",
            "no:cacheprovider",
          ],
          {
            cwd: path.join(output, "module"),
            encoding: "utf8",
            env: {
              ...process.env,
              PYTHONPATH: path.join(output, "module"),
            },
          },
        );
        const runtimeOutput = `${run.stdout ?? ""}${run.stderr ?? ""}`;
        assert.equal(run.status, 0, runtimeOutput);
        assert.match(runtimeOutput, /1 passed/);
      } finally {
        rmSync(output, { recursive: true, force: true });
      }
    }
  });

  it("reports exact mapping, safety, collision, and wildcard diagnostics", () => {
    const output = mkdtempSync(path.join(tmpdir(), "typra-delegate-invalid-"));
    try {
      const config = path.join(output, "tspconfig.yaml");
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    root-object: "Typra.Test.DelegateInvalid.Root"`,
          "    emit-targets:",
          "      - type: typescript",
          `        output-dir: ${JSON.stringify(path.join(output, "typescript"))}`,
          "        format: false",
          "",
        ].join("\n"),
      );
      const compilerEntry = require.resolve("@typespec/compiler");
      const compilerRoot = path.resolve(
        path.dirname(compilerEntry),
        "..",
        "..",
      );
      const result = spawnSync(
        process.execPath,
        [
          path.join(compilerRoot, "cmd", "tsp.js"),
          "compile",
          INVALID_FIXTURE,
          "--config",
          config,
        ],
        { cwd: output, encoding: "utf8" },
      );
      const diagnostics = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(result.status, 0, diagnostics);
      for (const code of [
        "typra-emitter-delegate-requires-dispatch",
        "typra-emitter-delegate-missing-slot",
        "typra-emitter-delegate-unknown-slot",
        "typra-emitter-delegate-unsafe-symbol",
        "typra-emitter-delegate-symbol-collision",
        "typra-emitter-delegate-wildcard-misuse",
        "typra-emitter-delegate-slot-collision",
      ]) {
        assert.match(diagnostics, new RegExp(code), code);
      }
      assert.match(
        diagnostics,
        /MissingWildcard[\s\S]*missing required dispatch slot "wildcard"/,
      );
      assert.match(
        diagnostics,
        /ReservedWildcardSlot[\s\S]*reserved wildcard slot/,
        "literal wildcard plus explicit '*' must report the normalized reserved-slot collision (#301)",
      );
      assert.match(
        diagnostics,
        /ParentSymbolCollision[\s\S]*"Request", which collides with a generated or schema symbol/,
      );
      assert.equal(
        diagnostics.match(/typra-emitter-delegate-requires-dispatch/g)?.length,
        1,
        "delegate-requires-dispatch should be reported once per interface",
      );
      assert.match(diagnostics, /reserved consumer symbol "class"/);
      assert.match(diagnostics, /"ClosedA", which collides with a generated or schema symbol/);
      assert.match(diagnostics, /"fooBar" and "foo_bar"[\s\S]*normalize to "foo_bar"/);
      assert.match(diagnostics, /"URLValue" and "url_value"[\s\S]*normalize to "url_value"/);
      assert.match(diagnostics, /"v1Kind" and "v1_kind"[\s\S]*normalize to "V1Kind" for go/);
      assert.match(diagnostics, /"class" and "class_"[\s\S]*normalize to "class_"/);
      assert.match(diagnostics, /"DelegateProvider", which collides with a generated or schema symbol/);
      assert.match(diagnostics, /"TypraGeneratedGeneratedNamesProvider", which collides with a generated or schema symbol/);
      assert.match(diagnostics, /"GeneratedNamesResolver", which collides with a generated or schema symbol/);
      for (const iface of [
        "SlotIdentifierCollision",
        "AcronymSlotIdentifierCollision",
        "DigitSlotIdentifierCollision",
        "KeywordSlotIdentifierCollision",
      ]) {
        const messages = [
          ...diagnostics.matchAll(
            new RegExp(
              `@delegate on ${iface} has dispatch slots [^\\r\\n]+`,
              "g",
            ),
          ),
        ].map((match) => match[0]);
        assert.ok(messages.length > 0, `${iface} should report a slot collision`);
        assert.equal(
          new Set(messages).size,
          messages.length,
          `${iface} should not duplicate a target collision diagnostic`,
        );
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
