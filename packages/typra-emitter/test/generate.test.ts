import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate, SUPPORTED_TARGET_LANGUAGES } from "../src/generate.js";
import { csharpGroupFolder } from "../src/languages/csharp/driver.js";
import { validateNativeSerializationTargets } from "../src/native-serialization.js";
import {
  findContributor,
  normalizeOutputRequests,
} from "../src/output-contributors.js";

const require = createRequire(import.meta.url);

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function assertGeneratedTypeScriptTestsTypeCheck(output: string): void {
  const globals = path.join(output, "generated", "typescript-tests", "globals.d.ts");
  const tsconfig = path.join(output, "generated", "tsconfig.tests.json");
  const tsc = require.resolve("typescript/bin/tsc");
  writeFileSync(
    globals,
    [
      "declare function describe(name: string, fn: () => void): void;",
      "declare function it(name: string, fn: () => void | Promise<void>): void;",
      "declare function expect(value: unknown): { toEqual(expected: unknown): void };",
      "",
    ].join("\n"),
  );
  // The @vector conformance harness imports its runtime adapter registry from
  // the module referenced by `vector-adapter-path` (default `./vector-adapters`),
  // which lives outside the regenerated tree. Provide a stub so the generated
  // suite type-checks standalone.
  writeFileSync(
    path.join(output, "generated", "typescript-tests", "vector-adapters.ts"),
    [
      "export const vectorAdapters = {};",
      "export const vectorWaivers = {};",
      "export const vectorDoubles = {};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: [
          "typescript/**/*.ts",
          "typescript-tests/vector-conformance.test.ts",
          "typescript-tests/transport-client.test.ts",
          "typescript-tests/globals.d.ts",
        ],
      },
      null,
      2,
    ),
  );
  execFileSync(process.execPath, [tsc, "--project", tsconfig], {
    cwd: path.join(output, "generated"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("generate", () => {
  it("rejects unsupported target languages before creating output", async () => {
    const output = path.join(tmpdir(), `typra-invalid-target-${Date.now()}`);
    const result = await generate({
      output,
      targets: ["invalid" as never],
    });

    assert.equal(result.success, false);
    assert.deepEqual(result.targets, ["invalid"]);
    assert.match(
      result.errors?.[0] ?? "",
      /Unsupported target language\(s\): invalid/,
    );
    assert.equal(existsSync(output), false);
  });

  it("advertises every generator target through the public target registry", () => {
    assert.deepEqual(SUPPORTED_TARGET_LANGUAGES, [
      "python",
      "csharp",
      "typescript",
      "go",
      "java",
      "rust",
      "swift",
      "markdown",
    ]);
  });

  it("rejects unsupported native serialization target pairs before creating output", async () => {
    const output = path.join(
      tmpdir(),
      `typra-invalid-native-serialization-${Date.now()}`,
    );
    const result = await generate({
      output,
      targets: {
        go: {
          outputDir: path.join(output, "go"),
          nativeSerialization: "zod",
        },
      } as never,
    });

    assert.equal(result.success, false);
    assert.match(
      result.errors?.[0] ?? "",
      /Target "go" does not support native-serialization "zod"/,
    );
    assert.equal(existsSync(output), false);
  });

  it("validates native serialization compatibility centrally for every target", () => {
    assert.deepEqual(
      normalizeOutputRequests({
        type: "Python",
        "native-serialization": "pydantic",
        outputs: [
          { kind: "models" },
          { kind: "native-serialization", provider: "pydantic" },
        ],
      }),
      [
        {
          target: "python",
          kind: "models",
          provider: "typra",
          source: "core",
        },
        {
          target: "python",
          kind: "native-serialization",
          provider: "pydantic",
          source: "native-serialization",
        },
      ],
    );
    assert.equal(
      findContributor({
        target: "TypeScript",
        kind: "consumer",
        provider: "fetch",
      })?.provider,
      "fetch",
    );
    assert.equal(
      findContributor({
        target: "Python",
        kind: "server",
        provider: "starlette",
      })?.provider,
      "starlette",
    );
    assert.equal(
      findContributor({
        target: "Python",
        kind: "consumer",
        provider: "httpx",
      })?.provider,
      "httpx",
    );
    assert.deepEqual(
      validateNativeSerializationTargets([
        { type: "TypeScript", "native-serialization": "zod" },
        { type: "typescript", "native-serialization": "standard-schema" },
        { type: "python", "native-serialization": "pydantic" },
        { type: "java", "native-serialization": "jackson" },
        { type: "rust", "native-serialization": "serde" },
        { type: "swift", "native-serialization": "codable" },
        { type: "java", "native-serialization": "none" },
      ]),
      [],
    );
    assert.deepEqual(
      validateNativeSerializationTargets([
        { type: "typescript", "native-serialization": "pydantic" },
        { type: "python", "native-serialization": "standard-schema" },
        { type: "java", "native-serialization": "zod" },
        { type: "swift", "native-serialization": "standard-schema" },
        { type: "typescript", outputs: [{ kind: "server", provider: "fastapi" }] },
        { type: "python", outputs: [{ kind: "consumer", provider: "fetch" }] },
      ]),
      [
        'Target "typescript" does not support native-serialization "pydantic". Supported values: "none", "zod", "standard-schema".',
        'Target "python" does not support native-serialization "standard-schema". Supported values: "none", "pydantic".',
        'Target "java" does not support native-serialization "zod". Supported values: "none", "jackson".',
        'Target "swift" does not support native-serialization "standard-schema". Supported values: "none", "codable".',
        'Target "typescript" does not support output contributor "server:fastapi".',
        'Target "python" does not support output contributor "consumer:fetch".',
      ],
    );
  });

  it("generates the bundled fixture with default source and root settings", async () => {
    const output = path.join(tmpdir(), `typra-default-generate-${Date.now()}`);
    try {
      const result = await generate({
        output,
        targets: ["swift"],
        format: false,
        generateTests: false,
      });

      assert.equal(result.success, true, result.errors?.join("\n"));
      assert.equal(
        existsSync(path.join(output, "swift", "Package.swift")),
        true,
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("rejects complex defaults before they can relax required-field guards", () => {
    const output = mkdtempSync(
      path.join(process.cwd(), "tmp-complex-default-"),
    );
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          "",
          "namespace Typra.DefaultProbe;",
          "",
          "model Root {",
          '  owner: Owner = #{ id: "owner-1" };',
          '  nullableOwner: Owner | null = #{ id: "owner-2" };',
          "  owners: Owner[] = #[];",
          "}",
          "",
          "model Owner {",
          "  id: string;",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.DefaultProbe.Root"',
          '    root-namespace: "Typra.DefaultProbe"',
          "    emit-targets:",
          "      - type: TypeScript",
          `        output-dir: ${yamlString(path.join(output, "generated", "typescript"))}`,
          `        test-dir: ${yamlString(path.join(output, "generated", "typescript-tests"))}`,
          "        format: false",
          "      - type: Python",
          `        output-dir: ${yamlString(path.join(output, "generated", "python"))}`,
          `        test-dir: ${yamlString(path.join(output, "generated", "python-tests"))}`,
          "        format: false",
          "",
        ].join("\n"),
      );

      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [tspCli, "compile", source, "--config", config],
            {
              cwd: process.cwd(),
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            },
          ),
        (error: unknown) => {
          const output =
            error &&
            typeof error === "object" &&
            "stdout" in error &&
            "stderr" in error
              ? `${String((error as { stdout?: unknown }).stdout ?? "")}${String((error as { stderr?: unknown }).stderr ?? "")}`
              : String(error);
          assert.match(output, /typra-emitter-unsupported-complex-default/);
          assert.match(output, /Property 'owner' has an unsupported default/);
          assert.match(
            output,
            /Property 'nullableOwner' has an unsupported default/,
          );
          assert.match(output, /Property 'owners' has an unsupported default/);
          return true;
        },
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("emits TypeSpec-native interface/op callables through protocol target renderers", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-native-callable-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          "",
          "namespace Typra.CallableProbe;",
          "",
          "model Root {",
          "  id: string;",
          "}",
          "",
          "model RenderRequest {",
          "  prompt: string;",
          "  flag?: boolean;",
          "}",
          "",
          "model RenderContext {",
          "  traceId?: string;",
          "}",
          "",
          "model RenderResult {",
          "  output: string;",
          "}",
          "",
          "const RenderVectors = #[",
          '  #{ name: "basic", input: #{ request: #{ prompt: "hi", flag: true } }, expected: #{ output: "hi" } }',
          "];",
          "",
          "@doc(\"Callable Renderer\")",
          "interface Renderer {",
          "  @doc(\"Render a prompt.\")",
          "  @vector(RenderVectors)",
          "  render(request: RenderRequest, context: RenderContext): RenderResult;",
          "  @vector(#{ input: #{ scores: #[1, 2] }, expected: #[1, 2] })",
          "  summarize(scores: int32[]): int32[];",
          "}",
          "",
          "interface Cache<T> {",
          "  get(): T;",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.CallableProbe.Root"',
          '    root-namespace: "Typra.CallableProbe"',
          "    emit-targets:",
          "      - type: TypeScript",
          `        output-dir: ${yamlString(path.join(output, "generated", "typescript"))}`,
          `        test-dir: ${yamlString(path.join(output, "generated", "typescript-tests"))}`,
          "        format: false",
          "      - type: Python",
          `        output-dir: ${yamlString(path.join(output, "generated", "python"))}`,
          `        test-dir: ${yamlString(path.join(output, "generated", "python-tests"))}`,
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(process.execPath, [tspCli, "compile", source, "--config", config], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const renderer = readFileSync(
        path.join(output, "generated", "typescript", "renderer.ts"),
        "utf8",
      );
      assert.match(renderer, /export interface Renderer/);
      assert.match(
        renderer,
        /render\(request: RenderRequest, context: RenderContext\): Promise<RenderResult>;/,
      );
      assert.match(
        renderer,
        /summarize\(scores: number\[\]\): Promise<number\[\]>;/,
      );
      const vectors = JSON.parse(
        readFileSync(
          path.join(output, "generated", ".typra-generated", "vectors.json"),
          "utf8",
        ),
      );
      assert.deepEqual(vectors.vectors, [
        {
          contract: "Renderer",
          operation: "render",
          params: { request: "RenderRequest", context: "RenderContext" },
          returns: "RenderResult",
          sync: false,
          vector: {
            name: "basic",
            stage: "callable",
            operation: "render",
            input: { request: { prompt: "hi", flag: true } },
            expected: { output: "hi" },
          },
        },
        {
          contract: "Renderer",
          operation: "summarize",
          params: { scores: "int32[]" },
          returns: "int32[]",
          sync: false,
          vector: {
            stage: "callable",
            operation: "summarize",
            input: { scores: [1, 2] },
            expected: [1, 2],
          },
        },
      ]);
      const tsVectorTest = readFileSync(
        path.join(
          output,
          "generated",
          "typescript-tests",
          "vector-conformance.test.ts",
        ),
        "utf8",
      );
      assert.match(tsVectorTest, /callable vector conformance/);
      assert.match(tsVectorTest, /"contract": "Renderer"/);
      assert.match(tsVectorTest, /"operation": "render"/);
      // Vector inputs are opaque evidence: no model-typed load/save round-trip
      // is generated even though `render` takes a `RenderRequest` param.
      assert.doesNotMatch(tsVectorTest, /assertVectorModelRoundTrips/);
      assert.doesNotMatch(tsVectorTest, /RenderRequest\.load/);
      const pyVectorTest = readFileSync(
        path.join(
          output,
          "generated",
          "python-tests",
          "test_vector_conformance.py",
        ),
        "utf8",
      );
      assert.match(pyVectorTest, /_ADAPTER_MODULE = importlib\.import_module/);
      assert.match(pyVectorTest, /VECTOR_ADAPTERS\.get\(operation_key\)/);
      assert.match(pyVectorTest, /def test_vector_0_/);
      assert.match(pyVectorTest, /@vector conformance never skips silently/);
      assert.doesNotMatch(pyVectorTest, /assert_vector_model_roundtrips/);
      assert.doesNotMatch(pyVectorTest, /RenderRequest\.load/);
      assert.equal(
        existsSync(path.join(output, "generated", "typescript", "cache.ts")),
        false,
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("nests namespace-discovered models that are not reachable from the root object", () => {
    // Regression: models discovered via the root namespace but NOT reachable
    // from `root-object` are appended as `additionalModels` by filterNodes.
    // Namespace projection must cover them too, so a nested TSP namespace like
    // `Contracts.Tracing` drives `contracts/tracing/...` output paths rather
    // than collapsing to the source folder / target root.
    const output = mkdtempSync(path.join(process.cwd(), "tmp-orphan-namespace-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          "",
          "namespace Typra.OrphanProbe {",
          "  model Root {",
          "    id: string;",
          "  }",
          "}",
          "",
          // Declared in a nested namespace and NEVER referenced by Root, so it
          // only reaches the emitters as a namespace-discovered additional model.
          "namespace Typra.OrphanProbe.Contracts.Tracing {",
          "  model TraceFile {",
          "    path: string;",
          "  }",
          "}",
          "",
          // Interfaces/operations always emit at the target root regardless of
          // the namespace they are declared in — only models nest.
          "namespace Typra.OrphanProbe.Operations.Pipeline {",
          "  interface ProbeRenderer {",
          "    render(file: Typra.OrphanProbe.Contracts.Tracing.TraceFile): string;",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.OrphanProbe.Root"',
          '    root-namespace: "Typra.OrphanProbe"',
          "    deterministic-output: true",
          "    emit-targets:",
          "      - type: Rust",
          `        output-dir: ${yamlString(path.join(output, "generated", "rust"))}`,
          '        import-path: "orphan::model"',
          "        format: false",
          '        protocol-scaffolds: "compile-only"',
          "      - type: TypeScript",
          `        output-dir: ${yamlString(path.join(output, "generated", "typescript"))}`,
          "        format: false",
          "      - type: Python",
          `        output-dir: ${yamlString(path.join(output, "generated", "python"))}`,
          '        package-name: "orphan"',
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", source, "--config", config],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const rustRoot = path.join(output, "generated", "rust");
      assert.equal(
        existsSync(path.join(rustRoot, "contracts", "tracing", "trace_file.rs")),
        true,
        "Rust: orphan model should nest under contracts/tracing/",
      );
      assert.equal(
        existsSync(path.join(rustRoot, "trace_file.rs")),
        false,
        "Rust: orphan model should not be emitted flat at the crate root",
      );

      const tsRoot = path.join(output, "generated", "typescript");
      assert.equal(
        existsSync(path.join(tsRoot, "contracts", "tracing", "trace-file.ts")),
        true,
        "TypeScript: orphan model should nest under contracts/tracing/",
      );
      assert.equal(
        existsSync(path.join(tsRoot, "trace-file.ts")),
        false,
        "TypeScript: orphan model should not be emitted flat at the module root",
      );

      const pyRoot = path.join(output, "generated", "python");
      assert.equal(
        existsSync(
          path.join(pyRoot, "contracts", "tracing", "_TraceFile.py"),
        ),
        true,
        "Python: orphan model should nest under contracts/tracing/",
      );
      assert.equal(
        existsSync(path.join(pyRoot, "_TraceFile.py")),
        false,
        "Python: orphan model should not be emitted flat at the package root",
      );

      // Interfaces/operations stay at the target root even when declared in a
      // nested namespace (`Operations.Pipeline`) — only models nest.
      assert.equal(
        existsSync(path.join(rustRoot, "probe_renderer.rs")),
        true,
        "Rust: op should emit at the crate root, not under operations/pipeline/",
      );
      assert.equal(
        existsSync(
          path.join(rustRoot, "operations", "pipeline", "probe_renderer.rs"),
        ),
        false,
        "Rust: op should not nest under operations/pipeline/",
      );
      assert.equal(
        existsSync(path.join(tsRoot, "probe-renderer.ts")),
        true,
        "TypeScript: op should emit at the module root, not under operations/pipeline/",
      );
      assert.equal(
        existsSync(
          path.join(tsRoot, "operations", "pipeline", "probe-renderer.ts"),
        ),
        false,
        "TypeScript: op should not nest under operations/pipeline/",
      );
      assert.equal(
        existsSync(path.join(pyRoot, "_ProbeRenderer.py")),
        true,
        "Python: op should emit at the package root, not under operations/pipeline/",
      );
      assert.equal(
        existsSync(
          path.join(pyRoot, "operations", "pipeline", "_ProbeRenderer.py"),
        ),
        false,
        "Python: op should not nest under operations/pipeline/",
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("PascalCases every segment of a C# group folder path", () => {
    // Unit-level guard for the helper behind the folder-casing fix: each
    // `/`-split segment must be PascalCased, blanks trimmed away, and
    // already-PascalCase namespace projections must pass through unchanged.
    assert.equal(csharpGroupFolder("connection"), "Connection");
    assert.equal(csharpGroupFolder("tools"), "Tools");
    assert.equal(csharpGroupFolder("mcp"), "Mcp");
    assert.equal(csharpGroupFolder("http2"), "Http2");
    assert.equal(csharpGroupFolder("model_options"), "ModelOptions");
    assert.equal(csharpGroupFolder("contracts/core"), "Contracts/Core");
    assert.equal(csharpGroupFolder("Contracts/Core"), "Contracts/Core");
    assert.equal(csharpGroupFolder("a/b/c"), "A/B/C");
    assert.equal(csharpGroupFolder("contracts//core"), "Contracts/Core");
    assert.equal(csharpGroupFolder(""), "");
  });

  it("emits PascalCase C# subfolders for lowercase TSP source groups", () => {
    // Regression: C# uses `node.group` verbatim as the emitted subfolder. For a
    // flat-namespace schema whose models live in lowercase source subfolders
    // (`schema/model/connection/`, `schema/model/tools/`), the folder-derived
    // group is the lowercase folder name, so C# emitted `connection/Connection.cs`
    // — non-idiomatic and inconsistent with namespace-projected groups (which are
    // PascalCase). C# folders must be PascalCase regardless of the group's source.
    const output = mkdtempSync(path.join(process.cwd(), "tmp-csharp-folder-case-"));
    const modelRoot = path.join(output, "schema", "model");
    const source = path.join(modelRoot, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      mkdirSync(path.join(modelRoot, "connection"), { recursive: true });
      mkdirSync(path.join(modelRoot, "tools"), { recursive: true });
      // Flat namespace on purpose: the sub-path must come from the source folder,
      // exercising the folder-derived group (not a namespace projection).
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          'import "./connection/connection.tsp";',
          'import "./tools/tool.tsp";',
          "",
          "namespace Typra.CsFolderCase;",
          "",
          "model Root {",
          "  conn: Connection;",
          "  tool: Tool;",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        path.join(modelRoot, "connection", "connection.tsp"),
        [
          "namespace Typra.CsFolderCase;",
          "",
          "model Connection {",
          "  id: string;",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        path.join(modelRoot, "tools", "tool.tsp"),
        [
          "namespace Typra.CsFolderCase;",
          "",
          "model Tool {",
          "  kind: string;",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.CsFolderCase.Root"',
          '    root-namespace: "Typra.CsFolderCase"',
          "    deterministic-output: true",
          "    emit-targets:",
          "      - type: CSharp",
          `        output-dir: ${yamlString(path.join(output, "generated", "csharp"))}`,
          '        namespace: "Typra.CsFolderCase"',
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", source, "--config", config],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const csRoot = path.join(output, "generated", "csharp");
      // Read on-disk directory names directly: existsSync is case-insensitive on
      // Windows/macOS and would ignore the very casing this test guards.
      const groupDirs = readdirSync(csRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      assert.ok(
        groupDirs.includes("Connection"),
        `C#: expected PascalCase Connection/ folder, got ${JSON.stringify(groupDirs)}`,
      );
      assert.ok(
        !groupDirs.includes("connection"),
        `C#: model should not emit under lowercase connection/ folder, got ${JSON.stringify(groupDirs)}`,
      );
      assert.ok(
        groupDirs.includes("Tools"),
        `C#: expected PascalCase Tools/ folder, got ${JSON.stringify(groupDirs)}`,
      );
      assert.ok(
        !groupDirs.includes("tools"),
        `C#: model should not emit under lowercase tools/ folder, got ${JSON.stringify(groupDirs)}`,
      );
      assert.equal(
        existsSync(path.join(csRoot, "Connection", "Connection.cs")),
        true,
        "C#: Connection model should emit inside its group folder",
      );
      assert.equal(
        existsSync(path.join(csRoot, "Tools", "Tool.cs")),
        true,
        "C#: Tool model should emit inside its group folder",
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("keeps legacy @protocol/@method and TypeSpec interface/op projections equivalent", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-callable-equiv-"));
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    const commonModels = [
      "model Root {",
      "  id: string;",
      "}",
      "",
      "model RenderRequest {",
      "  prompt: string;",
      "}",
      "",
      "model RenderContext {",
      "  traceId?: string;",
      "}",
      "",
      "model RenderResult {",
      "  output: string;",
      "}",
      "",
    ];

    const compileVariant = (
      variant: string,
      callableLines: string[],
    ): {
      generated: string;
      renderer: string;
      surface: Record<string, unknown>;
      hydration: Record<string, unknown>;
    } => {
      const variantRoot = path.join(output, variant);
      const source = path.join(variantRoot, "main.tsp");
      const config = path.join(variantRoot, "tspconfig.yaml");
      const generated = path.join(variantRoot, "generated");
      mkdirSync(variantRoot, { recursive: true });
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          "",
          "namespace Typra.CallableEquivalence;",
          "",
          ...commonModels,
          ...callableLines,
          "",
        ].join("\n"),
      );
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(generated)}`,
          '    root-object: "Typra.CallableEquivalence.Root"',
          '    root-namespace: "Typra.CallableEquivalence"',
          "    emit-targets:",
          "      - type: TypeScript",
          `        output-dir: ${yamlString(path.join(generated, "typescript"))}`,
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(process.execPath, [tspCli, "compile", source, "--config", config], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

      return {
        generated,
        renderer: readFileSync(
          path.join(generated, "typescript", "renderer.ts"),
          "utf8",
        ),
        surface: JSON.parse(
          readFileSync(
            path.join(generated, ".typra-generated", "export-surfaces.json"),
            "utf8",
          ),
        ),
        hydration: JSON.parse(
          readFileSync(
            path.join(generated, ".typra-generated", "hydration-seams.json"),
            "utf8",
          ),
        ),
      };
    };

    const normalizeSurface = (
      snapshot: Record<string, unknown>,
    ): Record<string, unknown> => ({
      ...snapshot,
      targets: (snapshot.targets as Array<Record<string, unknown>>).map(
        (target) => ({
          ...target,
          outputRoot: "<generated>/typescript",
        }),
      ),
    });

    try {
      const legacy = compileVariant("legacy", [
        '@doc("Callable Renderer")',
        "model Renderer {}",
        "@@protocol(Renderer);",
        '@@method(Renderer, "render", "RenderResult", "Render a prompt.", #{ request: "RenderRequest", context: "RenderContext" }, false, false);',
      ]);
      const native = compileVariant("native", [
        '@doc("Callable Renderer")',
        "interface Renderer {",
        '  @doc("Render a prompt.")',
        "  render(request: RenderRequest, context: RenderContext): RenderResult;",
        "}",
      ]);

      assert.equal(native.renderer, legacy.renderer);
      assert.deepEqual(
        normalizeSurface(native.surface),
        normalizeSurface(legacy.surface),
      );
      assert.deepEqual(native.hydration, legacy.hydration);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("emits a Prompty-style callable/vector projection without HTTP transport", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-prompty-slice-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          "",
          "namespace Typra.PromptySlice;",
          "",
          "model Root {",
          "  name: string;",
          "}",
          "",
          "model RenderRequest {",
          "  template: string;",
          "  variables?: Record<unknown>;",
          "}",
          "",
          "model RenderResult {",
          "  instructions: string;",
          "}",
          "",
          "model ParseRequest {",
          "  content: string;",
          "}",
          "",
          "model ParseResult {",
          "  messages: string[];",
          "}",
          "",
          "model ProcessRequest {",
          "  text: string;",
          "}",
          "",
          "model ProcessResult {",
          "  value: string;",
          "}",
          "",
          "const RenderVectors = #[",
          '  #{ name: "frontmatter-body", stage: "render", provider: "prompty", targetApi: "local", portability: "portable", normalization: #{ trailingNewline: "trim" }, input: #{ request: #{ template: "Hello {{name}}", variables: #{ name: "Typra" } } }, expected: #{ instructions: "Hello Typra" } }',
          "];",
          "",
          "interface Renderer {",
          "  @vector(RenderVectors)",
          "  render(request: RenderRequest): RenderResult;",
          "}",
          "",
          "interface Parser {",
          '  @vector(#{ name: "markdown-body", stage: "parse", input: #{ request: #{ content: "---\\nname: demo\\n---\\nHello" } }, expected: #{ messages: #["Hello"] } })',
          "  parse(request: ParseRequest): ParseResult;",
          "}",
          "",
          "interface Processor {",
          '  @vector(#{ name: "extract-text", stage: "process", input: #{ request: #{ text: "hello" } }, expected: #{ value: "hello" } })',
          "  process(request: ProcessRequest): ProcessResult;",
          "}",
          "",
          "interface Harness {",
          '  @vector(#{ name: "replay-mismatch", stage: "replay", input: #{ request: #{ text: "" } }, expectedError: #{ code: "replay-drift" } })',
          "  verify(request: ProcessRequest): ProcessResult;",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.PromptySlice.Root"',
          '    root-namespace: "Typra.PromptySlice"',
          "    hydration-zones:",
          '      - "runtime/prompty"',
          "    emit-targets:",
          "      - type: TypeScript",
          `        output-dir: ${yamlString(path.join(output, "generated", "typescript"))}`,
          `        test-dir: ${yamlString(path.join(output, "generated", "typescript-tests"))}`,
          '        import-path: "../typescript/index"',
          '        native-serialization: "zod"',
          "        outputs:",
          "          - kind: models",
          "          - kind: native-serialization",
          "            provider: zod",
          '        protocol-scaffolds: "compile-only"',
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(process.execPath, [tspCli, "compile", source, "--config", config], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const renderer = readFileSync(
        path.join(output, "generated", "typescript", "renderer.ts"),
        "utf8",
      );
      assert.match(renderer, /export interface Renderer/);
      assert.match(renderer, /render\(request: RenderRequest\): Promise<RenderResult>;/);
      assert.equal(
        existsSync(path.join(output, "generated", "typescript", "http.ts")),
        false,
      );

      const vectorTest = readFileSync(
        path.join(
          output,
          "generated",
          "typescript-tests",
          "vector-conformance.test.ts",
        ),
        "utf8",
      );
      assert.match(vectorTest, /"contract": "Renderer"/);
      assert.match(vectorTest, /"stage": "render"/);
      assert.match(vectorTest, /"provider": "prompty"/);
      assert.match(vectorTest, /"targetApi": "local"/);
      assert.match(vectorTest, /"normalization": \{\s+"trailingNewline": "trim"/);
      assert.match(vectorTest, /"contract": "Harness"/);
      assert.match(vectorTest, /"expectedError": \{\s+"code": "replay-drift"/);
      assert.doesNotMatch(vectorTest, /RenderRequest\.load\(value\)\.save\(\)/);

      const scaffold = readFileSync(
        path.join(
          output,
          "generated",
          "typescript-tests",
          "protocol-scaffolds.test.ts",
        ),
        "utf8",
      );
      assert.match(scaffold, /class CompileOnlyRenderer implements Renderer/);
      assert.match(scaffold, /class CompileOnlyHarness implements Harness/);
      assertGeneratedTypeScriptTestsTypeCheck(output);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("emits a Python FastAPI transport projection from TypeSpec HTTP decorators", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-fastapi-slice-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          'import "@typespec/http";',
          "using TypeSpec.Http;",
          "",
          "namespace Typra.FastApiSlice;",
          "",
          "model Root {",
          "  name: string;",
          "}",
          "",
          "model Pet {",
          "  name: string;",
          "}",
          "",
          "model UpdatePetRequest {",
          "  name: string;",
          "}",
          "",
          "model ErrorBody {",
          "  message: string;",
          "}",
          "",
          "model DecoratedData {",
          "  @header traceId: string;",
          "  value: string;",
          "}",
          "",
          "model PetNotFound {",
          "  @statusCode statusCode: 404;",
          "  @body body: ErrorBody;",
          "}",
          "",
          "model CreatedPet {",
          "  @statusCode statusCode: 201;",
          "  @body body: Pet;",
          "}",
          "",
          "model GenericStatusEnvelope {",
          "  @statusCode statusCode: int32;",
          "  @body body: ErrorBody;",
          "}",
          "",
          "const ReadVectors = #[",
          '  #{ name: "read-pet", stage: "transport", input: #{ petId: "p1", includeDetails: true, sessionId: "s1" }, expected: #{ name: "Rover" } }',
          "];",
          "const UpdateVectors = #[",
          '  #{ name: "update-pet", stage: "transport", input: #{ petId: "p1", contentVersion: "v1", request: #{ name: "Fido" } }, expected: #{ name: "Fido" } }',
          "];",
          "const CreateVectors = #[",
          '  #{ name: "create-pet", stage: "transport", input: #{ request: #{ name: "Spot" } }, expected: #{ name: "Spot" } }',
          "];",
          "const NameVectors = #[",
          '  #{ name: "pet-name", stage: "transport", input: #{ petId: "p1" }, expected: "Rover" }',
          "];",
          "const EchoVectors = #[",
          '  #{ name: "echo-name", stage: "transport", input: #{ value: "Rover" }, expected: "Rover" }',
          "];",
          "",
          "@route(\"/pets\")",
          "@useAuth(BearerAuth)",
          "interface Pets {",
          "  @get",
          "  @route(\"/{petId}\")",
          "  @vector(ReadVectors)",
          "  read(@path petId: string, @query includeDetails?: boolean, @cookie sessionId: string): Pet | PetNotFound;",
          "",
          "  @post",
          "  @route(\"/{petId}\")",
          "  @vector(UpdateVectors)",
          "  update(@path petId: string, @header contentVersion: string, @body request: UpdatePetRequest): Pet;",
          "",
          "  @post",
          "  @route(\"/\")",
          "  @vector(CreateVectors)",
          "  create(@body request: UpdatePetRequest): CreatedPet;",
          "",
          "  @get",
          "  @route(\"/names/{pet-id}\")",
          "  @vector(NameVectors)",
          "  getName(@path(\"pet-id\") petId: string): string | PetNotFound;",
          "",
          "  @post",
          "  @route(\"/echo\")",
          "  @vector(EchoVectors)",
          "  echo(@body value: string): string;",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.FastApiSlice.Root"',
          '    root-namespace: "Typra.FastApiSlice"',
          "    emit-targets:",
          "      - type: Python",
          `        output-dir: ${yamlString(path.join(output, "generated", "python"))}`,
          `        test-dir: ${yamlString(path.join(output, "generated", "python-tests"))}`,
          '        import-path: "typra.fastapislice"',
          "        outputs:",
          "          - kind: server",
          "            provider: fastapi",
          "          - kind: server",
          "            provider: starlette",
          "          - kind: consumer",
          "            provider: httpx",
          "        format: false",
          "      - type: TypeScript",
          `        output-dir: ${yamlString(path.join(output, "generated", "typescript"))}`,
          `        test-dir: ${yamlString(path.join(output, "generated", "typescript-tests"))}`,
          '        import-path: "../typescript/index"',
          "        outputs:",
          "          - kind: consumer",
          "            provider: fetch",
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(process.execPath, [tspCli, "compile", source, "--config", config], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const routes = readFileSync(
        path.join(output, "generated", "python", "fastapi_routes.py"),
        "utf8",
      );
      assert.match(routes, /from typing import Any, Protocol/);
      assert.match(routes, /from fastapi import APIRouter, Body, Cookie, Header, Path, Query/);
      assert.match(routes, /AUTH_REQUIREMENTS = json\.loads/);
      assert.match(routes, /\\"Pets\.read\\": \{/);
      assert.match(routes, /\\"scheme\\": \\"Bearer\\"/);
      assert.doesNotMatch(routes, /Authorization/);
      assert.match(routes, /class PetsHandler\(Protocol\):/);
      assert.match(routes, /async def read\(self, session_id: str, pet_id: str, include_details: bool \| None\):/);
      assert.match(routes, /@router\.get\("\/pets\/\{pet_id\}", status_code=200\)/);
      assert.match(routes, /@router\.get\("\/pets\/names\/\{pet_id\}", status_code=200\)/);
      assert.match(routes, /@router\.post\("\/pets\/", status_code=201\)/);
      assert.match(routes, /pet_id: str = Path\(\.\.\.\)/);
      assert.doesNotMatch(routes, /Path\(\.\.\., alias="pet-id"\)/);
      assert.match(routes, /include_details: bool \| None = Query\(default=None, alias="includeDetails"\)/);
      assert.match(routes, /session_id: str = Cookie\(default=\.\.\., alias="session_id"\)/);
      assert.match(routes, /content_version: str = Header\(default=\.\.\., alias="content-version"\)/);
      assert.match(routes, /request = UpdatePetRequest\.load\(request\)/);
      assert.match(routes, /value: Any = Body\(\.\.\.\)/);
      assert.match(routes, /return result\.save\(\) if hasattr\(result, "save"\) else result/);
      assert.match(routes, /async def getName\(pet_id: str = Path\(\.\.\.\)\):\n        result = await handler\.getName\(pet_id=pet_id\)\n        return result\.save\(\) if hasattr\(result, "save"\) else result/);

      assert.equal(
        readFileSync(
          path.join(output, "generated", "python", "requirements-fastapi.txt"),
          "utf8",
        ),
        "# <auto-generated by typra-emitter>\nfastapi\n",
      );
      assert.equal(
        readFileSync(
          path.join(output, "generated", "python", "requirements-starlette.txt"),
          "utf8",
        ),
        "# <auto-generated by typra-emitter>\nstarlette\n",
      );
      const pythonProtocol = readFileSync(
        path.join(output, "generated", "python", "_Pets.py"),
        "utf8",
      );
      assert.match(pythonProtocol, /def get_name\(self, pet_id: str\) -> str \| PetNotFound:/);

      const starletteRoutes = readFileSync(
        path.join(output, "generated", "python", "starlette_routes.py"),
        "utf8",
      );
      assert.match(starletteRoutes, /from starlette\.exceptions import HTTPException/);
      assert.match(starletteRoutes, /def _required\(value, binding_name\):/);
      assert.match(starletteRoutes, /from starlette\.routing import Route/);
      assert.match(starletteRoutes, /AUTH_REQUIREMENTS = json\.loads/);
      assert.doesNotMatch(starletteRoutes, /Authorization/);
      assert.match(starletteRoutes, /Route\("\/pets\/\{pet_id\}", read, methods=\["GET"\]\)/);
      assert.match(starletteRoutes, /Route\("\/pets\/names\/\{pet_id\}", getName, methods=\["GET"\]\)/);
      assert.match(starletteRoutes, /pet_id = _coerce\(_request\.path_params\.get\("pet_id"\), "string"\)/);
      assert.match(starletteRoutes, /session_id = _coerce\(_required\(session_id_raw, "session_id"\), "string"\)/);
      assert.match(starletteRoutes, /content_version = _coerce\(_required\(content_version_raw, "content-version"\), "string"\)/);
      assert.match(starletteRoutes, /include_details = _coerce\(include_details_raw, "boolean"\)/);
      assert.match(starletteRoutes, /result = result\.save\(\) if hasattr\(result, "save"\) else result/);

      const httpxClient = readFileSync(
        path.join(output, "generated", "python", "httpx_client.py"),
        "utf8",
      );
      assert.match(httpxClient, /class PetsClient:/);
      assert.match(httpxClient, /TypraHttpxResponseError/);
      assert.match(httpxClient, /"cookies": cookies/);
      assert.match(httpxClient, /"auth": json\.loads/);
      assert.doesNotMatch(httpxClient, /Authorization/);
      assert.match(httpxClient, /return Pet\.load\(response\.get\("body"\)\)/);

      const transportTest = readFileSync(
        path.join(output, "generated", "python-tests", "test_fastapi_transport.py"),
        "utf8",
      );
      assert.match(transportTest, /TRANSPORT_VECTORS = json\.loads/);
      assert.match(transportTest, /from fastapi.testclient import TestClient/);
      assert.match(transportTest, /def test_fastapi_transport_vectors_execute_routes/);
      assert.match(transportTest, /_assert_handler_received\(entry, handler\)/);
      assert.match(transportTest, /\\"stage\\": \\"transport\\"/);
      assert.match(transportTest, /\\"verb\\": \\"get\\"/);
      assert.match(transportTest, /\\"verb\\": \\"post\\"/);
      assert.match(transportTest, /\\"path\\": \\"\/pets\/\{petId\}\\"/);
      const starletteTest = readFileSync(
        path.join(output, "generated", "python-tests", "test_starlette_transport.py"),
        "utf8",
      );
      assert.match(starletteTest, /test_starlette_transport_vectors_execute_routes/);
      assert.match(starletteTest, /Starlette\(routes=ROUTER_FACTORIES/);
      const httpxTest = readFileSync(
        path.join(output, "generated", "python-tests", "test_httpx_transport.py"),
        "utf8",
      );
      assert.match(httpxTest, /test_httpx_transport_vectors_execute_clients/);
      assert.match(httpxTest, /test_httpx_transport_errors_preserve_body/);
      assert.match(httpxTest, /import asyncio/);
      assert.match(httpxTest, /asyncio\.run\(_run_httpx_transport_vectors_execute_clients\(\)\)/);
      assert.match(httpxTest, /\\"successStatus\\": 201/);
      const pythonVectorConformance = readFileSync(
        path.join(output, "generated", "python-tests", "test_vector_conformance.py"),
        "utf8",
      );
      // Transport vectors no longer round-trip the body-envelope return type
      // (`Pet`) through generated load/save; only the opaque transcript compare
      // remains.
      assert.doesNotMatch(pythonVectorConformance, /\.load\(value\)\.save\(\) == value/);
      assert.doesNotMatch(pythonVectorConformance, /assert_vector_model_roundtrips/);
      // The vector conformance harness now replays each vector through a
      // runtime adapter registry rather than comparing a payload to itself.
      assert.doesNotMatch(pythonVectorConformance, /assert observed_transcript == expected_transcript/);
      assert.match(pythonVectorConformance, /_ADAPTER_MODULE = importlib\.import_module/);
      assert.match(pythonVectorConformance, /_run_vector\(VECTORS\[/);

      const tsClient = readFileSync(
        path.join(output, "generated", "typescript", "transport-client.ts"),
        "utf8",
      );
      const decoratedData = readFileSync(
        path.join(output, "generated", "typescript", "decorated-data.ts"),
        "utf8",
      );
      assert.match(decoratedData, /traceId: string/);
      assert.match(decoratedData, /value: string/);
      const genericStatusEnvelope = readFileSync(
        path.join(output, "generated", "typescript", "generic-status-envelope.ts"),
        "utf8",
      );
      assert.doesNotMatch(genericStatusEnvelope, /statusCode/);
      assert.match(genericStatusEnvelope, /body!: ErrorBody/);
      assert.match(tsClient, /export class PetsClient/);
      assert.match(tsClient, /export type TypraFetchTransport/);
      assert.match(tsClient, /cookies\?: Record<string, string>/);
      assert.match(tsClient, /auth\?: TypraAuthRequirement/);
      assert.match(tsClient, /export interface TypraAuthRequirement/);
      assert.match(tsClient, /auth: \{\n\s+\"options\": \[/);
      assert.match(tsClient, /"scheme": "Bearer"/);
      assert.doesNotMatch(tsClient, /Authorization/);
      assert.match(tsClient, /export class TypraFetchResponseError extends Error/);
      assert.match(tsClient, /async read\(input: \{ sessionId: string; petId: string; includeDetails\?: boolean \}\): Promise<Pet>/);
      assert.match(tsClient, /let path = "\/pets\/\{petId\}";/);
      assert.match(tsClient, /path = path\.replace\(pathParameterPattern\("petId"\), encodeURIComponent/);
      assert.match(tsClient, /query\.set\("includeDetails", value\)/);
      assert.match(tsClient, /cookies\["session_id"\] = value/);
      assert.match(tsClient, /headers\["content-version"\] = value/);
      assert.match(tsClient, /headers\["Content-Type"\] \?\?= "application\/json"/);
      assert.match(tsClient, /const body = serializeBody\(input\.request\)/);
      assert.match(tsClient, /if \(!isSuccessStatus\(response\.status\)\)/);
      assert.match(tsClient, /if \(matchesStatusCode\(response\.status, "200"\)\)/);
      assert.match(tsClient, /if \(matchesStatusCode\(response\.status, "201"\)\)/);
      assert.match(tsClient, /return Pet\.load\(response\.body as Record<string, unknown>\)/);
      assert.doesNotMatch(tsClient, /ErrorBody\.load/);
      const tsConsumerTest = readFileSync(
        path.join(output, "generated", "typescript-tests", "transport-client.test.ts"),
        "utf8",
      );
      assert.match(tsConsumerTest, /transport fetch consumer conformance/);
      assert.match(tsConsumerTest, /const client = new PetsClient/);
      assert.match(tsConsumerTest, /captured = request/);
      assert.match(tsConsumerTest, /url": "https:\/\/example\.test\/pets\/p1\?includeDetails=true"/);
      assert.match(tsConsumerTest, /"cookies": \{\n\s+"session_id": "s1"/);
      assert.match(tsConsumerTest, /"auth": \{\n\s+"options": \[/);
      assert.match(tsConsumerTest, /"body": undefined/);
      assert.match(tsConsumerTest, /"body": \{\n\s+"name": "Fido"/);
      assert.match(tsConsumerTest, /status: 201/);
      assert.match(tsConsumerTest, /non-success-response/);
      assert.match(tsConsumerTest, /TypraFetchResponseError/);
      assert.match(tsConsumerTest, /expect\(observed\)\.toEqual/);
      assertGeneratedTypeScriptTestsTypeCheck(output);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("skips Python transport conformance tests when HTTP operations have no transport vectors", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-http-no-vectors-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          'import "@typespec/http";',
          "using TypeSpec.Http;",
          "",
          "namespace Typra.NoVectorTransport;",
          "model Root { name: string; }",
          "model Pet { name: string; }",
          "@route(\"/pets\")",
          "interface Pets {",
          "  @get",
          "  @route(\"/{petId}\")",
          "  read(@path petId: string): Pet;",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.NoVectorTransport.Root"',
          '    root-namespace: "Typra.NoVectorTransport"',
          "    emit-targets:",
          "      - type: Python",
          `        output-dir: ${yamlString(path.join(output, "generated", "python"))}`,
          `        test-dir: ${yamlString(path.join(output, "generated", "python-tests"))}`,
          '        import-path: "typra.novectortransport"',
          "        outputs:",
          "          - kind: server",
          "            provider: fastapi",
          "          - kind: server",
          "            provider: starlette",
          "          - kind: consumer",
          "            provider: httpx",
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(process.execPath, [tspCli, "compile", source, "--config", config], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

      assert.equal(existsSync(path.join(output, "generated", "python", "fastapi_routes.py")), true);
      assert.equal(existsSync(path.join(output, "generated", "python", "starlette_routes.py")), true);
      assert.equal(existsSync(path.join(output, "generated", "python", "httpx_client.py")), true);
      assert.equal(
        existsSync(path.join(output, "generated", "python-tests", "test_fastapi_transport.py")),
        false,
      );
      assert.equal(
        existsSync(path.join(output, "generated", "python-tests", "test_starlette_transport.py")),
        false,
      );
      assert.equal(
        existsSync(path.join(output, "generated", "python-tests", "test_httpx_transport.py")),
        false,
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("preserves nested namespaces under a dotted root namespace", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-namespace-projection-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          "",
          "namespace Typra.NamespaceProbe;",
          "",
          "model Root {",
          "  child: Runtime.Child;",
          "  tool: Runtime.Tools.Tool;",
          "}",
          "",
          "model Owner {",
          "  name: string;",
          "}",
          "",
          "namespace Runtime {",
          "  model Child {",
          "    value: string;",
          "  }",
          "",
          "  namespace Tools {",
          "    model Tool {",
          "      owner: Owner;",
          "    }",
          "  }",
          "",
          "  interface Renderer {",
          "    render(child: Child): Child;",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.NamespaceProbe.Root"',
          '    root-namespace: "Typra.NamespaceProbe"',
          "    emit-targets:",
          "      - type: TypeScript",
          `        output-dir: ${yamlString(path.join(output, "generated", "typescript"))}`,
          "        format: false",
          "      - type: Python",
          `        output-dir: ${yamlString(path.join(output, "generated", "python"))}`,
          "        format: false",
          "      - type: Rust",
          `        output-dir: ${yamlString(path.join(output, "generated", "rust"))}`,
          "        format: false",
          "      - type: TypeScript",
          `        output-dir: ${yamlString(path.join(output, "generated", "typescript-flat"))}`,
          "        namespace-output: flat",
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(process.execPath, [tspCli, "compile", source, "--config", config], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const ast = JSON.parse(
        readFileSync(path.join(output, "generated", "json-ast", "model.json"), "utf8"),
      );
      assert.equal(ast.properties[0].typeName.namespace, "Typra.NamespaceProbe.Runtime");
      assert.equal(ast.properties[0].typeName.name, "Child");
      assert.equal(ast.properties[0].type.properties[0].name, "value");
      assert.equal(ast.properties[1].typeName.namespace, "Typra.NamespaceProbe.Runtime.Tools");
      assert.equal(ast.properties[1].typeName.name, "Tool");

      const tsRoot = readFileSync(
        path.join(output, "generated", "typescript", "root.ts"),
        "utf8",
      );
      assert.match(tsRoot, /from "\.\/runtime\/tools\/tool"/);
      assert.ok(
        existsSync(path.join(output, "generated", "typescript", "runtime", "child.ts")),
      );
      assert.ok(
        existsSync(
          path.join(output, "generated", "typescript", "runtime", "tools", "tool.ts"),
        ),
      );
      const tsNestedTool = readFileSync(
        path.join(output, "generated", "typescript", "runtime", "tools", "tool.ts"),
        "utf8",
      );
      assert.match(tsNestedTool, /from "\.\.\/\.\.\/owner"/);
      assert.ok(
        existsSync(path.join(output, "generated", "typescript-flat", "tool.ts")),
      );
      assert.ok(
        !existsSync(
          path.join(output, "generated", "typescript-flat", "runtime", "tools", "tool.ts"),
        ),
      );

      const pythonRootInit = readFileSync(
        path.join(output, "generated", "python", "__init__.py"),
        "utf8",
      );
      assert.match(pythonRootInit, /from \.runtime\.tools import \(/);
      assert.ok(
        existsSync(path.join(output, "generated", "python", "runtime", "__init__.py")),
      );
      assert.ok(
        existsSync(path.join(output, "generated", "python", "runtime", "_Child.py")),
      );
      assert.ok(
        existsSync(
          path.join(output, "generated", "python", "runtime", "tools", "_Tool.py"),
        ),
      );
      const pythonNestedTool = readFileSync(
        path.join(output, "generated", "python", "runtime", "tools", "_Tool.py"),
        "utf8",
      );
      assert.match(pythonNestedTool, /from \.\.\._Owner import Owner/);

      const rustRootMod = readFileSync(
        path.join(output, "generated", "rust", "mod.rs"),
        "utf8",
      );
      assert.match(rustRootMod, /pub mod runtime;/);
      const rustRuntimeMod = readFileSync(
        path.join(output, "generated", "rust", "runtime", "mod.rs"),
        "utf8",
      );
      assert.match(rustRuntimeMod, /pub mod child;/);
      assert.match(rustRuntimeMod, /pub mod tools;/);
      assert.ok(
        existsSync(path.join(output, "generated", "rust", "runtime", "tools", "mod.rs")),
      );
      const rustNestedTool = readFileSync(
        path.join(output, "generated", "rust", "runtime", "tools", "tool.rs"),
        "utf8",
      );
      assert.match(rustNestedTool, /use super::super::super::owner::Owner;/);

      const exportSurfaces = JSON.parse(
        readFileSync(
          path.join(output, "generated", ".typra-generated", "export-surfaces.json"),
          "utf8",
        ),
      );
      assert.equal(exportSurfaces.root.namespace, "Typra.NamespaceProbe");
      assert.equal(
        exportSurfaces.targets.find((target: { target: string }) => target.target === "typescript")
          .namespace,
        "Typra.NamespaceProbe",
      );
      assert.equal(
        exportSurfaces.targets.find((target: { target: string }) => target.target === "python")
          .packageName,
        "typra.namespaceprobe",
      );
      const tsTarget = exportSurfaces.targets.find(
        (target: { target: string }) => target.target === "typescript",
      );
      assert.equal(
        tsTarget.exports.filter((entry: { name: string }) => entry.name === "Child").length,
        1,
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("rejects native serialization values on unsupported targets", () => {
    const output = mkdtempSync(
      path.join(process.cwd(), "tmp-native-serialization-target-"),
    );
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          "",
          "namespace Typra.NativeProbe;",
          "",
          "model Root {",
          "  name: string;",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.NativeProbe.Root"',
          "    emit-targets:",
          "      - type: Python",
          `        output-dir: ${yamlString(path.join(output, "generated", "python"))}`,
          '        native-serialization: "jackson"',
          "        format: false",
          "",
        ].join("\n"),
      );

      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [tspCli, "compile", source, "--config", config],
            {
              cwd: process.cwd(),
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            },
          ),
        (error: unknown) => {
          const output =
            error &&
            typeof error === "object" &&
            "stdout" in error &&
            "stderr" in error
              ? `${String((error as { stdout?: unknown }).stdout ?? "")}${String((error as { stderr?: unknown }).stderr ?? "")}`
              : String(error);
          assert.match(output, /typra-emitter-native-serialization-target/);
          assert.match(
            output,
            /Target "Python" does not support native-serialization "jackson"/,
          );
          assert.match(output, /Supported values: "none", "pydantic"/);
          return true;
        },
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("allows Rust serde for open discriminated bases with a fallback carrier", () => {
    const output = mkdtempSync(
      path.join(process.cwd(), "tmp-rust-serde-open-"),
    );
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          "",
          "namespace Typra.RustSerdeProbe;",
          "",
          '@discriminator("kind")',
          "model Root {",
          "  kind: string;",
          "}",
          "",
          "model Known extends Root {",
          '  kind: "known";',
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.RustSerdeProbe.Root"',
          '    root-namespace: "Typra.RustSerdeProbe"',
          "    emit-targets:",
          "      - type: Rust",
          `        output-dir: ${yamlString(path.join(output, "generated", "rust"))}`,
          '        native-serialization: "serde"',
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", source, "--config", config],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const generated = readFileSync(
        path.join(output, "generated", "rust", "root.rs"),
        "utf8",
      );
      assert.match(generated, /RootKind::Custom \{/);
      assert.match(
        generated,
        /raw: serde_json::Map<String, serde_json::Value>/,
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("allows Rust serde for discriminators with unclaimed base values by emitting a fallback carrier", () => {
    const output = mkdtempSync(
      path.join(process.cwd(), "tmp-rust-serde-unclaimed-"),
    );
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          "",
          "namespace Typra.RustSerdeUnclaimedProbe;",
          "",
          "union RootKind {",
          '  known: "known";',
          '  base: "base";',
          "}",
          "",
          '@discriminator("kind")',
          "model Root {",
          "  kind: RootKind;",
          "}",
          "",
          "model Known extends Root {",
          '  kind: "known";',
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.RustSerdeUnclaimedProbe.Root"',
          '    root-namespace: "Typra.RustSerdeUnclaimedProbe"',
          "    emit-targets:",
          "      - type: Rust",
          `        output-dir: ${yamlString(path.join(output, "generated", "rust"))}`,
          '        native-serialization: "serde"',
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", source, "--config", config],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const generated = readFileSync(
        path.join(output, "generated", "rust", "root.rs"),
        "utf8",
      );
      assert.match(generated, /RootKind::Custom \{/);
      assert.match(
        generated,
        /raw: serde_json::Map<String, serde_json::Value>/,
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
