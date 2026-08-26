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
import { isClosedPolymorphicDispatch } from "../../ir/declarations.js";
import {
  collectDispatchedContracts,
  DispatchedContract,
} from "../../ir/vector.js";
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

  // Part III: emit one behavioral @dispatch resolver (provider Record + resolve
  // switch, the twin of the shape discriminator switch) per dispatched seam
  // interface, into the LIBRARY beside the seam file, placed in its group folder
  // (issue #282). The provider is a real consumer extension point, so a forgotten
  // slot fails to compile. NOTE: emission currently rides the presence of @vector
  // cases; decoupling it is a tracked #282 follow-up.
  if ((options?.callableVectors?.vectors.length ?? 0) > 0) {
    for (const dispatched of collectDispatchedContracts(
      options!.callableVectors!.vectors,
    )) {
      const resolverDir = dispatched.group
        ? `${emitTarget["output-dir"]}/${dispatched.group}`
        : emitTarget["output-dir"];
      await emitTypeScriptFile(
        context,
        `${toKebabCase(dispatched.contract)}-resolver.ts`,
        emitTypeScriptDispatchResolver(dispatched),
        resolverDir,
        emitTarget["output-dir"],
      );
    }
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
      // The interpreter lives in a standalone, seam-agnostic runner module; the
      // conformance suite below is a thin harness that injects the
      // runtime-authored seam tables. The runner is vector-independent, so its
      // text never varies with the schema.
      await emitTypeScriptFile(
        context,
        "vector-runner.ts",
        emitTypeScriptVectorRunner(),
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
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

// The seam-agnostic @vector conformance runner. This text is a CONSTANT: it
// carries no per-schema data, imports no authored adapter values, and reads
// every seam table (adapters/waivers/capabilities/doubles) plus the base
// directory from the `seam` parameter the harness injects. Emitting it verbatim
// keeps requires-free harnesses byte-identical and idempotent regardless of the
// schema, and lets the interpreter be unit-tested in isolation with injected
// fakes.
function emitTypeScriptVectorRunner(): string {
  return [
    "// Copyright (c) Microsoft. All rights reserved.",
    "// WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "//",
    "// Seam-agnostic @vector conformance runner. This module is the relocated",
    "// interpreter that the thin vector-conformance harness drives: reference",
    "// resolution ($env/$file/$json), canonical/stable JSON, adapter lookup with",
    "// bare-operation fallback, the requirement/capability guard, per-vector waiver",
    "// xfail/xpass, await-if-awaitable with @sync enforcement, and the",
    "// canonical-equality assertion.",
    "//",
    "// It reads ZERO authored values: every adapter/waiver/capability/double table",
    "// and the base directory are injected by the harness through the `seam`",
    "// parameter, so this interpreter's behavior is fully determined by its inputs",
    "// and is independently unit-testable with injected fakes. Because it holds no",
    "// per-schema data, its text is constant across every generated target.",
    "//",
    "// Adapter contract: invoke() may return either a plain value or a Promise. The",
    "// runner awaits the result before normalizing, so an async runtime pipeline",
    "// can be driven directly on the test framework's event loop. Each vector must",
    "// perform exactly one awaited invocation and spawn no background concurrency,",
    "// so conformance stays deterministic.",
    "//",
    "// Classification is ENFORCED: an operation marked `@sync` (entrySync === true)",
    "// must resolve synchronously — if its adapter returns a Promise/thenable the",
    "// vector is a hard failure. An async-capable operation (the default) stays",
    "// permissive: a plain value or a Promise both pass (await of a non-thenable is",
    "// a no-op).",
    "//",
    "// Behavioral polymorphic dispatch (@dispatch): the optional `dispatch` argument",
    "// carries the discriminator access path. When present the runner reads the key",
    "// at that path on the vector input and selects the implementation from the",
    "// seam's per-key registry (adapters keyed `Contract.operation#key`). An impl",
    "// absent for a valid key reuses the capability-absent skip. Undispatched seams",
    "// pass no `dispatch` and keep the single-adapter lookup unchanged.",
    "// See docs: reference/vector-conformance.",
    "",
    "import * as fs from \"fs\";",
    "import * as path from \"path\";",
    "",
    "export type AdapterContext = {",
    "  contract: string;",
    "  operation: string;",
    "  vector: Record<string, unknown>;",
    "  provider?: string;",
    "  targetApi?: string;",
    "  doubles: Record<string, unknown>;",
    "  baseDir: string;",
    "  resolveInput: (value: unknown) => unknown;",
    "};",
    "export type VectorAdapter = {",
    "  invoke: (input: unknown, context: AdapterContext) => unknown | Promise<unknown>;",
    "  normalize?: (value: unknown, context: AdapterContext) => unknown;",
    "};",
    "// Runtime-authored seam tables injected by the harness. `capabilities` is",
    "// optional: a requires-free harness omits it and the requirement guard below",
    "// stays inert.",
    "export type VectorSeam = {",
    "  adapters: Record<string, VectorAdapter>;",
    "  waivers: Record<string, string>;",
    "  capabilities?: Record<string, (context: AdapterContext) => boolean>;",
    "  doubles: Record<string, unknown>;",
    "  baseDir: string;",
    "};",
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
    "// Walks a deterministic field-access path (e.g. `agent.template.format.kind`)",
    "// over a resolved vector input to read the @dispatch discriminator value that",
    "// selects the concrete seam implementation. Returns undefined if any hop is",
    "// missing so the caller can fail loudly on a misresolved path.",
    "function resolveDispatchKey(root: unknown, dotted: string): unknown {",
    "  return dotted.split(\".\").reduce<unknown>((node, key) => {",
    "    if (node !== null && typeof node === \"object\" && key in (node as Record<string, unknown>)) {",
    "      return (node as Record<string, unknown>)[key];",
    "    }",
    "    return undefined;",
    "  }, root);",
    "}",
    "",
    "export async function runVector(",
    "  contract: string,",
    "  operation: string,",
    "  vector: Record<string, unknown>,",
    "  entrySync: boolean,",
    "  seam: VectorSeam,",
    "  dispatch?: { path: string },",
    "): Promise<void> {",
    "  const { adapters, waivers, doubles, baseDir } = seam;",
    "  const capabilities = seam.capabilities ?? {};",
    "  const operationKey = `${contract}.${operation}`;",
    '  const vectorName = typeof vector.name === "string" ? vector.name : "unnamed";',
    "  const vectorId = `${operationKey}:${vectorName}`;",
    "  // Behavioral polymorphic dispatch: when the seam is @dispatch-decorated the",
    "  // harness passes the discriminator access path. The concrete implementation",
    "  // is resolved once from the discriminator value read at that path and looked",
    "  // up in the seam's per-key registry (adapters keyed `Contract.operation#key`",
    "  // or `operation#key`). An impl absent for a valid discriminator reuses the",
    "  // capability-absent skip, exactly like a missing requirement.",
    "  let adapter: VectorAdapter | undefined;",
    "  if (dispatch && dispatch.path.length > 0) {",
    "    const dispatchInput = resolveRefs(vector.input, baseDir);",
    "    const dispatchKey = resolveDispatchKey(dispatchInput, dispatch.path);",
    "    if (typeof dispatchKey !== \"string\") {",
    "      throw new Error(",
    "        `${vectorId}: @dispatch path '${dispatch.path}' did not resolve to a ` +",
    "          \"string discriminator on the vector input.\",",
    "      );",
    "    }",
    "    adapter =",
    "      adapters[`${operationKey}#${dispatchKey}`] ??",
    "      adapters[`${operation}#${dispatchKey}`];",
    "    if (!adapter) {",
    "      console.log(`SKIP ${vectorId} (requirement unavailable: ${dispatchKey})`);",
    "      return;",
    "    }",
    "  } else {",
    "    adapter = adapters[operationKey] ?? adapters[operation];",
    "    if (!adapter) {",
    "      const waiver = waivers[operationKey] ?? waivers[operation];",
    "      if (waiver) {",
    "        console.log(`SKIP ${vectorId} (waived: ${waiver})`);",
    "        return;",
    "      }",
    "      throw new Error(",
    "        `No vector adapter registered for ${operationKey}. Register ` +",
    "          `vectorAdapters[\"${operationKey}\"] in the module referenced by ` +",
    "          \"'vector-adapter-path', or add an explicit waiver. \" +",
    "          \"@vector conformance never skips silently.\",",
    "      );",
    "    }",
    "  }",
    "  // Requirement guard: a vector may declare abstract capability tokens in",
    "  // `requires`. Each is resolved against the seam-supplied capability table",
    "  // BEFORE the adapter runs. An unregistered token is a hard failure (never",
    "  // skip silently); an unavailable one yields a clean skip so an absent",
    "  // credential never reaches invoke as an empty value. A requires-free harness",
    "  // injects no capability table and this guard stays inert.",
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
  ].join("\n");
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
    "// Enforced @vector behavioral conformance. Each vector is replayed through the",
    "// seam-agnostic runner in ./vector-runner, which is injected with the",
    "// runtime-authored adapter tables resolved from the module referenced by the",
    "// target's 'vector-adapter-path' option. A vector with no adapter and no",
    "// explicit waiver is a hard failure — this suite never skips silently.",
    "// See docs: reference/vector-conformance.",
    "",
    `import * as vectorAdapterModule from ${JSON.stringify(adapterImportPath)};`,
    "import {",
    "  runVector,",
    ...(hasRequires ? ["  type AdapterContext,"] : []),
    "  type VectorAdapter,",
    "  type VectorSeam,",
    "} from \"./vector-runner\";",
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
    "const seam: VectorSeam = {",
    "  adapters,",
    "  waivers,",
    ...(hasRequires ? ["  capabilities,"] : []),
    "  doubles,",
    "  baseDir: __dirname,",
    "};",
    "",
    'describe("callable vector conformance", () => {',
    ...model.vectors.flatMap((entry) => {
      const vector = entry.vector;
      const vectorName =
        typeof vector.name === "string" ? vector.name : "unnamed";
      const vectorId = `${entry.contract}.${entry.operation}:${vectorName}`;
      const vectorLiteral = JSON.stringify(JSON.stringify(vector));
      const dispatchArg = entry.dispatch
        ? `, { path: ${JSON.stringify(entry.dispatch.path)} }`
        : "";
      return [
        `  it(${JSON.stringify(vectorId)}, async () => {`,
        `    const vector = JSON.parse(${vectorLiteral}) as Record<string, unknown>;`,
        `    await runVector(${JSON.stringify(entry.contract)}, ${JSON.stringify(
          entry.operation,
        )}, vector, ${entry.sync ? "true" : "false"}, seam${dispatchArg});`,
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
 * Emit the Part III behavioral @dispatch resolver for one seam interface — the
 * TypeScript twin of the shape discriminator switch (the `loadKind` switch the
 * discriminated union emits). Where `loadKind` maps a discriminator value to a
 * constructed SHAPE, this maps it to a selected BEHAVIOR (the seam impl) read
 * from a `Record` provider whose keys ARE the `dispatch.variants`.
 *
 * A `Record<Kind, Seam | null>` forces the consumer to DECLARE every variant
 * slot: omitting one is a compile error (`Property '<kind>' is missing`) — the
 * TypeScript form of issue #282 §5 control 2. A `null` slot signals a
 * valid-but-unimplemented variant to the caller (e.g. the conformance harness
 * skips it), never a silent registration miss. This is compile-time *slot*
 * completeness, not implementation completeness.
 *
 * The unknown-value arm mirrors the shape switch precedence: a closed or
 * abstract-without-default dispatch throws (no base impl to fall back to), while
 * a default/open dispatch yields `null` (explicit skip).
 */
function emitTypeScriptDispatchResolver(entry: DispatchedContract): string {
  const seam = entry.contract;
  const provider = `${seam}Provider`;
  const kindType = `${seam}Kind`;
  const field = entry.decl.discriminatorField;
  const variants = entry.decl.variants;
  const seamModule = `./${toKebabCase(seam)}`;
  // Closed (no fallback, no default): an unknown discriminator is a hard error,
  // exactly as the shape switch throws. An open or default dispatch yields null
  // (harness explicit-skip); an abstract-open base routes unknowns to a carrier
  // in the shape loader, never throwing, so a bare `isClosedPolymorphicDispatch`
  // is the faithful twin of that throw arm.
  const rejectsUnknown = isClosedPolymorphicDispatch(entry.decl);
  const kindUnion = variants
    .map((variant) => JSON.stringify(variant.value))
    .join(" | ");

  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Copyright (c) Microsoft. All rights reserved.",
    "// WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "//",
    `// Part III behavioral @dispatch resolver for ${seam} — the twin of the shape`,
    "// discriminator switch, emitted into the library beside the seam interface.",
    `// ${provider} is a Record keyed by every @dispatch variant, so a consumer that`,
    "// omits a slot fails to compile; a null slot signals a valid-but-unimplemented",
    "// variant to the caller (e.g. the conformance harness skips it).",
    "// See docs: reference/vector-conformance.",
    "",
    `import type { ${seam} } from "${seamModule}";`,
    "",
    `/** Every @dispatch discriminator value for the ${seam} seam. */`,
    `export type ${kindType} = ${kindUnion};`,
    "",
    "/**",
    ` * Consumer-attached provider of ${seam} impls, one slot per @dispatch variant.`,
    ` * A Record over ${kindType} forces every slot to be DECLARED (a missing key is a`,
    " * compile error); a null value signals a valid-but-unimplemented variant.",
    " */",
    `export type ${provider} = Record<${kindType}, ${seam} | null>;`,
    "",
    "/**",
    ` * Map a '${field}' discriminator value to the selected ${seam} impl — the`,
    " * behavioral twin of the shape discriminator switch.",
    " */",
    `export function resolve${seam}(`,
    `  ${field}: string,`,
    `  provider: ${provider},`,
    `): ${seam} | null {`,
    `  switch (${field}) {`,
  ];
  for (const variant of variants) {
    lines.push(`    case ${JSON.stringify(variant.value)}:`);
    lines.push(`      return provider[${JSON.stringify(variant.value)}];`);
  }
  if (rejectsUnknown) {
    lines.push("    default:");
    lines.push("      throw new Error(");
    lines.push(
      `        \`Unknown ${seam} discriminator field '${field}' value: \${${field}}\`,`,
    );
    lines.push("      );");
  } else {
    lines.push("    default:");
    lines.push("      return null;");
  }
  lines.push("  }");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
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
