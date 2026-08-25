import { EmitContext, resolvePath } from "@typespec/compiler";
import { EmitTarget, TypraEmitterOptions } from "../../lib.js";
import { enumerateTypes, TypeNode, BaseTestContext } from "../../ir/ast.js";
import { GeneratorOptions, filterNodes } from "../../emitter.js";
import { TypeRegistry } from "../../ir/expansion.js";
import { TypeScriptExprVisitor } from "./visitor.js";
import { emitTypeScriptFile as emitTypeScriptFileDecl } from "./emitter.js";
import {
  emitTypeScriptContext,
  emitTypeScriptIndex,
  emitTypeScriptGroupIndex,
  emitEslintConfig,
} from "./scaffolding.js";
import { emitTypeScriptTest } from "./test-emitter.js";
import { lowerFile, collectPolymorphicTypeNames } from "../../ir/lower.js";
import {
  buildBaseTestContext,
  typescriptTestOptions,
} from "../../testing/test-context.js";
import { toKebabCase } from "../../ir/utilities.js";
import { resolve, dirname } from "path";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { emitGeneratedFile } from "../../cleanup/generated-file.js";
import { formatTypeScriptSource } from "./typescript-format.js";
import {
  resolveCustomFormatters,
  runCustomFormatters,
} from "../formatter-runner.js";
import {
  applyNamespaceGroups,
  projectNamespace,
  restoreNamespaceGroups,
} from "../../ir/namespace.js";
import {
  buildVectorConformanceCodeModel,
} from "../../ir/code-model.js";
import type { TransportContract } from "../../ir/transport.js";
import {
  collectProtocolNodes,
  emitTypeScriptProtocolScaffolds,
  shouldEmitCompileOnlyProtocolScaffolds,
} from "../../protocol-scaffolds.js";
import { normalizeOutputRequests } from "../../output-contributors.js";
import {
  collectTransportModelTypes,
  emitTypeScriptFetchClient,
  emitTypeScriptFetchClientConformanceTest,
} from "./transport-client.js";

/**
 * Stale generated files are removed centrally by `pruneStaleGeneratedFiles`, which uses the
 * previous run's manifest to decide ownership rather than guessing from file names.
 */

/**
 * Generate TypeScript code from TypeSpec models.
 */
export const generateTypeScript = async (
  context: EmitContext<TypraEmitterOptions>,
  node: TypeNode,
  emitTarget: EmitTarget,
  options?: GeneratorOptions,
) => {
  const nativeSerialization = emitTarget["native-serialization"] ?? "none";
  if (
    nativeSerialization === "pydantic" ||
    nativeSerialization === "jackson" ||
    nativeSerialization === "serde" ||
    nativeSerialization === "codable"
  ) {
    throw new Error(
      `TypeScript native-serialization: "${nativeSerialization}" is not supported; use "none" or "zod".`,
    );
  }
  if (nativeSerialization === "standard-schema") {
    throw new Error(
      'TypeScript native-serialization: "standard-schema" is reserved; use "none" or "zod".',
    );
  }
  const emitZod = nativeSerialization === "zod";
  const allTypes = Array.from(enumerateTypes(node));
  // filterNodes appends namespace-discovered `additionalModels` (types not
  // reachable from the root object). Run it first so namespace projection also
  // covers those additional models, not just the root-reachable subgraph.
  const nodes = filterNodes(allTypes, options);
  const namespaceGroupSnapshots = applyNamespaceGroups(nodes, {
    target: "typescript",
    semanticRoot: options?.rootNamespace,
    emitTarget,
    namespaceOutput: options?.namespaceOutput,
  });

  // Build the expression IR infrastructure
  const registry = TypeRegistry.fromTypeGraph(allTypes);
  const visitor = new TypeScriptExprVisitor(registry);

  const namespaceProjection = projectNamespace({
    target: "typescript",
    sourceNamespace: node.typeName.namespace,
    semanticRoot: options?.rootNamespace,
    emitTarget,
  });
  const tsNamespace = namespaceProjection.targetNamespace!;
  const modelTypes = collectTransportModelTypes(nodes);

  // Emit context classes (LoadContext, SaveContext)
  const contextCode = emitTypeScriptContext();
  await emitTypeScriptFile(
    context,
    "context.ts",
    contextCode,
    emitTarget["output-dir"],
  );

  // Collect polymorphic type names once for the full type graph
  const polymorphicTypeNames = new Set<string>();
  for (const n of allTypes) {
    for (const name of collectPolymorphicTypeNames(n, registry)) {
      polymorphicTypeNames.add(name);
    }
  }

  // Group root nodes by their semantic group folder
  const groupMap = new Map<string, TypeNode[]>();
  for (const n of nodes) {
    if (!n.base) {
      const g = n.group || "";
      if (!groupMap.has(g)) groupMap.set(g, []);
      groupMap.get(g)!.push(n);
    }
  }

  // Emit each base type file (includes children in the same file)
  for (const n of nodes) {
    // Skip child types - they're rendered with their parent
    if (n.base) {
      continue;
    }

    const group = n.group || "";
    const fileDecl = lowerFile(n, registry, polymorphicTypeNames);
    const code = emitTypeScriptFileDecl(fileDecl, visitor, tsNamespace, group, {
      nativeSerialization,
    });
    const outDir = group
      ? `${emitTarget["output-dir"]}/${group}`
      : emitTarget["output-dir"];
    await emitTypeScriptFile(
      context,
      `${toKebabCase(n.typeName.name)}.ts`,
      code,
      outDir,
      emitTarget["output-dir"],
    );
  }

  // Emit group index.ts files
  for (const [group, groupNodes] of groupMap) {
    if (!group) continue;
    const groupIndexCode = emitTypeScriptGroupIndex(group, groupNodes, emitZod);
    await emitTypeScriptFile(
      context,
      "index.ts",
      groupIndexCode,
      `${emitTarget["output-dir"]}/${group}`,
      emitTarget["output-dir"],
    );
  }

  // Emit test files for all types (skip protocols — they have no data to test)
  if (emitTarget["test-dir"]) {
    const importPath = namespaceProjection.importPath!;
    for (const n of nodes) {
      if (n.isProtocol) continue;
      const group = n.group || "";
      const testDir = group
        ? `${emitTarget["test-dir"]}/${group}`
        : emitTarget["test-dir"];
      const groupDepth = group ? group.split("/").filter(Boolean).length : 0;
      const testImportPath =
        groupDepth > 0
          ? `${"../".repeat(groupDepth)}${importPath}`
          : importPath;
      const testContext = buildTestContext(n, registry);
      const testCode = emitTypeScriptTest({
        ...testContext,
        importPath: testImportPath,
        namespace: tsNamespace,
      });
      await emitTypeScriptFile(
        context,
        `${toKebabCase(n.typeName.name)}.test.ts`,
        testCode,
        testDir,
        emitTarget["test-dir"],
      );
    }

    if (shouldEmitCompileOnlyProtocolScaffolds(emitTarget)) {
      const scaffoldCode = emitTypeScriptProtocolScaffolds(
        collectProtocolNodes(nodes),
        importPath,
      );
      await emitTypeScriptFile(
        context,
        "protocol-scaffolds.test.ts",
        scaffoldCode,
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
    }

    if ((options?.callableVectors?.vectors.length ?? 0) > 0) {
      await emitTypeScriptFile(
        context,
        "vector-conformance.test.ts",
        emitTypeScriptVectorConformanceTest(
          options!.callableVectors!,
          emitTarget["vector-adapter-path"] ?? "./vector-adapters",
        ),
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
    }

    const transportContracts = options?.transportContracts ?? [];
    if (shouldEmitFetchConsumer(emitTarget) && hasTransportVectors(transportContracts)) {
      await emitTypeScriptFile(
        context,
        "transport-client.test.ts",
        emitTypeScriptFetchClientConformanceTest(
          transportContracts,
          modelTypes,
          clientImportPath(importPath),
          importPath,
        ),
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
    }
  }

  if (shouldEmitFetchConsumer(emitTarget)) {
    const transportContracts = options?.transportContracts ?? [];
    if (transportContracts.length > 0) {
      await emitTypeScriptFile(
        context,
        "transport-client.ts",
        emitTypeScriptFetchClient(transportContracts, modelTypes),
        emitTarget["output-dir"],
      );
    }
  }

  // Emit root index.ts file — re-exports from group sub-indexes
  const indexContext = buildIndexContext(nodes);
  const indexCode = emitTypeScriptIndex(
    indexContext.baseTypes,
    indexContext.types,
    emitZod,
  );
  await emitTypeScriptFile(
    context,
    "index.ts",
    indexCode,
    emitTarget["output-dir"],
  );

  // Emit eslint.config.js to project root (parent of output-dir)
  if (emitTarget["output-dir"]) {
    const projectRoot = resolve(process.cwd(), emitTarget["output-dir"], "..");
    const eslintConfigCode = emitEslintConfig();
    await emitTypeScriptFile(
      context,
      "eslint.config.js",
      eslintConfigCode,
      projectRoot,
    );
  }

  // Format emitted files if format option is enabled (default: true)
  if (emitTarget.format !== false) {
    const outputDir = emitTarget["output-dir"]
      ? resolve(process.cwd(), emitTarget["output-dir"])
      : context.emitterOutputDir;
    const testDir = emitTarget["test-dir"]
      ? resolve(process.cwd(), emitTarget["test-dir"])
      : undefined;

    const custom = resolveCustomFormatters(emitTarget.format);
    if (custom) {
      runCustomFormatters(custom, { dir: outputDir, testDir });
    } else {
      formatTypeScriptFiles(outputDir, testDir);
    }
  }
  restoreNamespaceGroups(namespaceGroupSnapshots);
};

function shouldEmitFetchConsumer(target: EmitTarget): boolean {
  return normalizeOutputRequests(target).some(
    (request) =>
      request.target === "typescript" &&
      request.kind === "consumer" &&
      request.provider === "fetch",
  );
}

function hasTransportVectors(contracts: TransportContract[]): boolean {
  return contracts.some((contract) =>
    contract.operations.some((operation) =>
      (operation.callable.vectors ?? []).some(
        (vector) => vector.stage === "transport",
      ),
    ),
  );
}

function clientImportPath(modelImportPath: string): string {
  return modelImportPath.endsWith("/index")
    ? `${modelImportPath.slice(0, -"/index".length)}/transport-client`
    : `${modelImportPath}/transport-client`;
}

function emitTypeScriptVectorConformanceTest(
  vectors: NonNullable<GeneratorOptions["callableVectors"]>,
  adapterImportPath: string,
): string {
  const model = buildVectorConformanceCodeModel(vectors);
  const hasRequires = model.vectors.some(
    (entry) => (entry.vector.requires?.length ?? 0) > 0,
  );
  return [
    "// Copyright (c) Microsoft. All rights reserved.",
    "// WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "//",
    "// Enforced @vector behavioral conformance. Each vector is replayed through a",
    "// runtime-authored adapter resolved from the module referenced by the target's",
    "// 'vector-adapter-path' option. A vector with no adapter and no explicit waiver",
    "// is a hard failure — this suite never skips silently.",
    "//",
    "// Adapter contract: invoke() may return either a plain value or a Promise. The",
    "// harness awaits the result before normalizing, so an async runtime pipeline",
    "// can be driven directly on the test framework's event loop. Each vector must",
    "// perform exactly one awaited invocation and spawn no background concurrency,",
    "// so conformance stays deterministic.",
    "//",
    "// Classification is ENFORCED: an operation marked `@sync` (entry.sync === true)",
    "// must resolve synchronously — if its adapter returns a Promise/thenable the",
    "// vector is a hard failure. An async-capable operation (the default) stays",
    "// permissive: a plain value or a Promise both pass (await of a non-thenable is",
    "// a no-op).",
    "// See docs: reference/vector-conformance.",
    "",
    "import * as fs from \"fs\";",
    "import * as path from \"path\";",
    `import * as vectorAdapterModule from ${JSON.stringify(adapterImportPath)};`,
    "",
    "type AdapterContext = {",
    "  contract: string;",
    "  operation: string;",
    "  vector: Record<string, unknown>;",
    "  provider?: string;",
    "  targetApi?: string;",
    "  doubles: Record<string, unknown>;",
    "  baseDir: string;",
    "  resolveInput: (value: unknown) => unknown;",
    "};",
    "type VectorAdapter = {",
    "  invoke: (input: unknown, context: AdapterContext) => unknown | Promise<unknown>;",
    "  normalize?: (value: unknown, context: AdapterContext) => unknown;",
    "};",
    "",
    "const adapterModule = vectorAdapterModule as unknown as {",
    "  vectorAdapters?: Record<string, VectorAdapter>;",
    "  default?: Record<string, VectorAdapter>;",
    "  vectorWaivers?: Record<string, string>;",
    ...(hasRequires
      ? ["  vectorCapabilities?: Record<string, (context: AdapterContext) => boolean>;"]
      : []),
    "  vectorDoubles?: Record<string, unknown>;",
    "};",
    "const adapters: Record<string, VectorAdapter> =",
    "  adapterModule.vectorAdapters ?? adapterModule.default ?? {};",
    "const waivers: Record<string, string> = adapterModule.vectorWaivers ?? {};",
    ...(hasRequires
      ? [
          "const capabilities: Record<string, (context: AdapterContext) => boolean> =",
          "  adapterModule.vectorCapabilities ?? {};",
        ]
      : []),
    "const doubles: Record<string, unknown> = adapterModule.vectorDoubles ?? {};",
    "const baseDir = __dirname;",
    "",
    "function canonical(value: unknown): unknown {",
    "  if (Array.isArray(value)) return value.map(canonical);",
    "  if (value !== null && typeof value === \"object\") {",
    "    const source = value as Record<string, unknown>;",
    "    const out: Record<string, unknown> = {};",
    "    for (const key of Object.keys(source).sort()) out[key] = canonical(source[key]);",
    "    return out;",
    "  }",
    "  return value;",
    "}",
    "function stable(value: unknown): string {",
    "  return JSON.stringify(canonical(value));",
    "}",
    "",
    "// A thenable is the JS-native awaitable. `@sync` classification enforcement",
    "// and the await-if-awaitable unwrap both key off this shape.",
    "function isAwaitable(value: unknown): boolean {",
    "  return (",
    "    value !== null &&",
    "    (typeof value === \"object\" || typeof value === \"function\") &&",
    "    typeof (value as { then?: unknown }).then === \"function\"",
    "  );",
    "}",
    "",
    "function resolveRefs(value: unknown, dir: string): unknown {",
    "  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, dir));",
    "  if (value !== null && typeof value === \"object\") {",
    "    const source = value as Record<string, unknown>;",
    "    const keys = Object.keys(source);",
    "    if (keys.length === 1) {",
    "      const key = keys[0];",
    "      const raw = source[key];",
    "      if (key === \"$env\" && typeof raw === \"string\") return process.env[raw] ?? \"\";",
    "      if (key === \"$file\" && typeof raw === \"string\")",
    "        return fs.readFileSync(path.resolve(dir, raw), \"utf8\");",
    "      if (key === \"$json\" && typeof raw === \"string\")",
    "        return JSON.parse(fs.readFileSync(path.resolve(dir, raw), \"utf8\"));",
    "    }",
    "    const out: Record<string, unknown> = {};",
    "    for (const key of keys) out[key] = resolveRefs(source[key], dir);",
    "    return out;",
    "  }",
    "  return value;",
    "}",
    "",
    "async function runVector(",
    "  contract: string,",
    "  operation: string,",
    "  vector: Record<string, unknown>,",
    "  entrySync: boolean,",
    "): Promise<void> {",
    "  const operationKey = `${contract}.${operation}`;",
    '  const vectorName = typeof vector.name === "string" ? vector.name : "unnamed";',
    "  const vectorId = `${operationKey}:${vectorName}`;",
    "  const adapter = adapters[operationKey] ?? adapters[operation];",
    "  if (!adapter) {",
    "    const waiver = waivers[operationKey] ?? waivers[operation];",
    "    if (waiver) {",
    "      console.log(`SKIP ${vectorId} (waived: ${waiver})`);",
    "      return;",
    "    }",
    "    throw new Error(",
    "      `No vector adapter registered for ${operationKey}. Register ` +",
    "        `vectorAdapters[\"${operationKey}\"] in the module referenced by ` +",
    "        \"'vector-adapter-path', or add an explicit waiver. \" +",
    "        \"@vector conformance never skips silently.\",",
    "    );",
    "  }",
    ...(hasRequires
      ? [
          "  // Requirement guard: a vector may declare abstract capability tokens in",
          "  // `requires`. Each is resolved against the runtime-supplied capability",
          "  // table BEFORE the adapter runs. An unregistered token is a hard failure",
          "  // (never skip silently); an unavailable one yields a clean skip so an",
          "  // absent credential never reaches invoke as an empty value.",
          "  const requires = Array.isArray(vector.requires)",
          "    ? (vector.requires as string[])",
          "    : [];",
          "  if (requires.length > 0) {",
          "    const capabilityContext: AdapterContext = {",
          "      contract,",
          "      operation,",
          "      vector,",
          '      provider: typeof vector.provider === "string" ? vector.provider : undefined,',
          '      targetApi: typeof vector.targetApi === "string" ? vector.targetApi : undefined,',
          "      doubles,",
          "      baseDir,",
          "      resolveInput: (value: unknown) => resolveRefs(value, baseDir),",
          "    };",
          "    for (const token of requires) {",
          "      if (!(token in capabilities)) {",
          "        throw new Error(",
          "          `No capability predicate registered for requirement token \"${token}\". ` +",
          "            `Register vectorCapabilities[\"${token}\"] in the module referenced by ` +",
          "            \"'vector-adapter-path'. @vector conformance never skips silently.\",",
          "        );",
          "      }",
          "    }",
          "    for (const token of requires) {",
          "      if (!capabilities[token](capabilityContext)) {",
          "        console.log(`SKIP ${vectorId} (requirement unavailable: ${token})`);",
          "        return;",
          "      }",
          "    }",
          "  }",
        ]
      : []),
    "  // Per-vector waiver, consulted even when an adapter IS registered. Keyed",
    "  // by the vector id (`Contract.operation:name`) or `operation:name` so it",
    "  // never collides with an operation-level waiver. xfail: a waived vector",
    "  // that fails is an expected failure (green); xpass: a waived vector that",
    "  // passes is surfaced as a hard failure so stale waivers get removed.",
    "  const vectorWaiver =",
    "    waivers[vectorId] ?? waivers[`${operation}:${vectorName}`];",
    '  const waived = typeof vectorWaiver === "string" && vectorWaiver.length > 0;',
    "  let failure: unknown;",
    "  let failed = false;",
    "  try {",
    "    const context: AdapterContext = {",
    "      contract,",
    "      operation,",
    "      vector,",
    '      provider: typeof vector.provider === "string" ? vector.provider : undefined,',
    '      targetApi: typeof vector.targetApi === "string" ? vector.targetApi : undefined,',
    "      doubles,",
    "      baseDir,",
    "      resolveInput: (value: unknown) => resolveRefs(value, baseDir),",
    "    };",
    "    const input = resolveRefs(vector.input, baseDir);",
    "    const normalize = adapter.normalize ?? ((value: unknown) => value);",
    "    // Exactly one invocation. Capture a synchronous throw so it routes",
    "    // into the same error handling as an async rejection (error-path",
    "    // parity), and enforce @sync classification on the raw result before",
    "    // awaiting, so a misclassified adapter fails distinctly.",
    "    let invocation: unknown;",
    "    let syncThrew = false;",
    "    let syncError: unknown;",
    "    try {",
    "      invocation = adapter.invoke(input, context);",
    "    } catch (error) {",
    "      syncThrew = true;",
    "      syncError = error;",
    "    }",
    "    if (!syncThrew && entrySync && isAwaitable(invocation)) {",
    "      throw new Error(",
    "        `${vectorId}: operation is @sync but its adapter returned an ` +",
    "          \"awaitable. A @sync operation must resolve synchronously — drop \" +",
    "          \"@sync to make it async-capable, or make the adapter synchronous.\",",
    "      );",
    "    }",
    '    if ("expectedError" in vector) {',
    "      let threw = false;",
    "      let observedError: unknown;",
    "      const captureError = (error: unknown) => {",
    "        threw = true;",
    "        const detail = (error as { typraVector?: unknown }).typraVector;",
    "        observedError =",
    "          detail !== undefined",
    "            ? detail",
    "            : error instanceof Error",
    "              ? { message: error.message }",
    "              : error;",
    "      };",
    "      if (syncThrew) {",
    "        captureError(syncError);",
    "      } else {",
    "        try {",
    "          await invocation;",
    "        } catch (error) {",
    "          captureError(error);",
    "        }",
    "      }",
    "      if (!threw) {",
    "        throw new Error(",
    "          `${vectorId}: expected the adapter to signal an error, but it returned a value.`,",
    "        );",
    "      }",
    "      expect(stable(normalize(observedError, context))).toEqual(",
    "        stable(vector.expectedError),",
    "      );",
    "    } else {",
    "      if (syncThrew) throw syncError;",
    "      const observed = normalize(await invocation, context);",
    "      const expectedStable = stable(vector.expected);",
    "      const observedStable = stable(observed);",
    "      if (observedStable !== expectedStable) {",
    "        throw new Error(",
    "          JSON.stringify(",
    '            { vectorId, target: "typescript", expected: vector.expected, observed },',
    "            null,",
    "            2,",
    "          ),",
    "        );",
    "      }",
    "      expect(observedStable).toEqual(expectedStable);",
    "    }",
    "  } catch (error) {",
    "    failed = true;",
    "    failure = error;",
    "  }",
    "  if (waived) {",
    "    if (failed) {",
    "      console.log(`XFAIL ${vectorId} (waived: ${vectorWaiver})`);",
    "      return;",
    "    }",
    "    throw new Error(",
    "      `XPASS ${vectorId}: waived vector unexpectedly passed; ` +",
    "        `remove the waiver (${vectorWaiver})`,",
    "    );",
    "  }",
    "  if (failed) throw failure;",
    "}",
    "",
    'describe("callable vector conformance", () => {',
    ...model.vectors.flatMap((entry) => {
      const vector = entry.vector;
      const vectorName =
        typeof vector.name === "string" ? vector.name : "unnamed";
      const vectorId = `${entry.contract}.${entry.operation}:${vectorName}`;
      const vectorLiteral = JSON.stringify(JSON.stringify(vector));
      return [
        `  it(${JSON.stringify(vectorId)}, async () => {`,
        `    const vector = JSON.parse(${vectorLiteral}) as Record<string, unknown>;`,
        `    await runVector(${JSON.stringify(entry.contract)}, ${JSON.stringify(
          entry.operation,
        )}, vector, ${entry.sync ? "true" : "false"});`,
        "  });",
      ];
    }),
    "});",
    "",
  ].join("\n");
}

/**
 * Format TypeScript files using prettier.
 */
function formatTypeScriptFiles(outputDir: string, testDir?: string): void {
  const projectRoot = findTypeScriptProjectRoot(outputDir);
  if (!projectRoot) {
    console.warn(`Warning: Could not find package.json. Skipping formatting.`);
    return;
  }

  const dirs = [outputDir, ...(testDir ? [testDir] : [])];
  const prettierBin = findNodeModuleFile(projectRoot, [
    "prettier",
    "bin",
    "prettier.cjs",
  ]);

  for (const dir of dirs) {
    const globPattern = `${dir}/**/*.ts`;
    if (prettierBin) {
      try {
        execFileSync(process.execPath, [prettierBin, "--write", globPattern], {
          cwd: projectRoot,
          stdio: "pipe",
          encoding: "utf-8",
        });
      } catch (error) {
        console.warn(`Warning: prettier formatting failed for ${dir}.`);
      }
    } else {
      console.warn(
        `Warning: prettier not found for ${dir}. Run npm install in the TypeScript workspace.`,
      );
    }

    // Run eslint fix
    try {
      execFileSync("npx", ["eslint", "--fix", globPattern], {
        cwd: projectRoot,
        stdio: "pipe",
        encoding: "utf-8",
      });
    } catch (error) {
      // ESLint errors are common, don't warn about them
    }
  }
}

function findNodeModuleFile(
  startDir: string,
  segments: string[],
): string | undefined {
  let currentDir = resolve(startDir);
  const root = resolve("/");

  while (currentDir !== root && currentDir !== dirname(currentDir)) {
    const candidate = resolve(currentDir, "node_modules", ...segments);
    if (existsSync(candidate)) {
      return candidate;
    }
    currentDir = dirname(currentDir);
  }

  return undefined;
}

/**
 * Find the TypeScript project root by looking for package.json.
 */
function findTypeScriptProjectRoot(startDir: string): string | undefined {
  let currentDir = resolve(startDir);
  const root = resolve("/");

  while (currentDir !== root && currentDir !== dirname(currentDir)) {
    const packageJsonPath = resolve(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    currentDir = dirname(currentDir);
  }

  return undefined;
}

/**
 * Build context for rendering the index.ts file.
 */
function buildIndexContext(nodes: TypeNode[]): {
  baseTypes: TypeNode[];
  types: TypeNode[];
} {
  return {
    baseTypes: nodes.filter((n) => !n.base),
    types: nodes,
  };
}

/**
 * Build context for rendering a test file.
 */
function buildTestContext(
  node: TypeNode,
  registry: TypeRegistry,
): BaseTestContext {
  return buildBaseTestContext(node, undefined, typescriptTestOptions, (name) =>
    registry.get(name),
  );
}

/**
 * Write generated TypeScript content to file.
 */
async function emitTypeScriptFile(
  context: EmitContext<TypraEmitterOptions>,
  filename: string,
  content: string,
  outputDir?: string,
  outputRoot?: string,
): Promise<void> {
  outputDir = outputDir || `${context.emitterOutputDir}/typescript`;
  const filePath = resolvePath(outputDir, filename);

  await emitGeneratedFile(context, filePath, formatTypeScriptSource(content), {
    outputRoot: outputRoot || outputDir,
  });
}
