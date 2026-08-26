import { EmitContext, resolvePath } from "@typespec/compiler";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { EmitTarget, TypraEmitterOptions } from "../../lib.js";
import {
  resolveCustomFormatters,
  runCustomFormatters,
} from "../formatter-runner.js";
import {
  buildVectorConformanceCodeModel,
} from "../../ir/code-model.js";
import { normalizeOutputRequests } from "../../output-contributors.js";
import type {
  TransportBinding,
  TransportContract,
  TransportOperation,
  TransportResponse,
} from "../../ir/transport.js";
import {
  firstSuccessStatusCode,
  successOrFallbackBodyResponses,
} from "../../ir/transport.js";
import {
  enumerateTypes,
  PropertyNode,
  TypeNode,
  PythonClassContext,
  PythonFileContext,
  PythonInitContext,
  PythonLoadContextContext,
  BaseTestContext,
} from "../../ir/ast.js";
import {
  resolveFactoryExpr,
  resolveCoerceExpr,
  TypeRegistry,
  collectExprTypeRefs,
} from "../../ir/expansion.js";
import { ExprVisitor, renderObjectLiteral } from "../../ir/visitor.js";
import { PythonExprVisitor } from "./visitor.js";
import { GeneratorOptions, filterNodes } from "../../emitter.js";
import { toSnakeCase } from "../../ir/utilities.js";
import { scalarRuntimeKind } from "../../ir/scalar-kinds.js";
import {
  buildBaseTestContext,
  pythonTestOptions,
} from "../../testing/test-context.js";
import { lowerFile, collectPolymorphicTypeNames } from "../../ir/lower.js";
import { emitPythonFile as emitPythonFileDecl } from "./emitter.js";
import { formatPythonSource } from "./python-format.js";
import {
  emitPythonContext,
  emitPythonInit,
  emitPythonGroupInit,
} from "./scaffolding.js";
import { emitPythonTest, emitPythonTestContext } from "./test-emitter.js";
import { emitGeneratedFile } from "../../cleanup/generated-file.js";
import {
  applyNamespaceGroups,
  projectNamespace,
  restoreNamespaceGroups,
} from "../../ir/namespace.js";
import {
  collectProtocolNodes,
  emitPythonProtocolScaffolds,
  shouldEmitCompileOnlyProtocolScaffolds,
} from "../../protocol-scaffolds.js";

/**
 * Type mapping from TypeSpec scalar types to Python types.
 * This is passed as data to templates, not used for inline rendering.
 */
export const pythonTypeMapper: Record<string, string> = {
  string: "str",
  number: "float",
  array: "list",
  object: "dict",
  boolean: "bool",
  int64: "int",
  int32: "int",
  float64: "float",
  float32: "float",
  integer: "int",
  float: "float",
  numeric: "float",
  any: "Any",
  dictionary: "dict[str, Any]",
};

/**
 * Stale generated files are removed centrally by `pruneStaleGeneratedFiles`, which uses the
 * previous run's manifest to decide ownership rather than guessing from file names.
 */

/**
 * Main entry point for Python code generation.
 * Prepares data contexts and delegates rendering to inline emitter functions.
 */
export const generatePython = async (
  context: EmitContext<TypraEmitterOptions>,
  node: TypeNode,
  emitTarget: EmitTarget,
  options?: GeneratorOptions,
): Promise<void> => {
  const allTypes = Array.from(enumerateTypes(node));
  // filterNodes appends namespace-discovered `additionalModels` (types not
  // reachable from the root object). Run it first so namespace projection also
  // covers those additional models, not just the root-reachable subgraph.
  const nodes = filterNodes(allTypes, options);
  const namespaceGroupSnapshots = applyNamespaceGroups(nodes, {
    target: "python",
    semanticRoot: options?.rootNamespace,
    emitTarget,
    namespaceOutput: options?.namespaceOutput,
  });

  // Build the expression IR infrastructure
  const registry = TypeRegistry.fromTypeGraph(allTypes);
  const visitor = new PythonExprVisitor(registry);

  const namespaceProjection = projectNamespace({
    target: "python",
    sourceNamespace: node.typeName.namespace,
    semanticRoot: options?.rootNamespace,
    emitTarget,
  });
  const packageName = namespaceProjection.packageName!;
  const importPath = namespaceProjection.importPath!;
  const nativeSerialization = pythonNativeSerialization(emitTarget);
  const modelTypes = collectLoadSaveTypeNames(nodes);

  // Emit py.typed marker for PEP 561 compliance
  await emitPythonFile(
    context,
    "py.typed",
    "",
    emitTarget["output-dir"],
    emitTarget["output-dir"],
    { allowEmpty: true },
  );

  // Render LoadContext file
  const contextContext = buildLoadContextContext();
  const contextContent = emitPythonContext(contextContext.header);
  await emitPythonFile(
    context,
    "_context.py",
    contextContent,
    emitTarget["output-dir"],
  );

  // Render LoadContext tests
  if (emitTarget["test-dir"]) {
    const testContextContext = buildLoadContextContext(importPath);
    const testContextContent = emitPythonTestContext(
      testContextContext.header,
      importPath,
    );
    await emitPythonFile(
      context,
      "test_context.py",
      testContextContent,
      emitTarget["test-dir"],
    );
  }

  // Render init file — group-aware, imports from {group} subpackages
  const initContext = buildInitContext(nodes);
  const initContent = emitPythonInit(initContext.baseTypes, initContext.types);
  await emitPythonFile(
    context,
    "__init__.py",
    initContent,
    emitTarget["output-dir"],
  );

  // Collect polymorphic type names once for the full type graph
  const polymorphicTypeNames = new Set<string>();
  for (const n of allTypes) {
    for (const name of collectPolymorphicTypeNames(n, registry)) {
      polymorphicTypeNames.add(name);
    }
  }

  // Group nodes by their semantic group folder
  const groupMap = new Map<string, TypeNode[]>();
  for (const n of nodes) {
    if (!n.base) {
      const g = n.group || "";
      if (!groupMap.has(g)) groupMap.set(g, []);
      groupMap.get(g)!.push(n);
    }
  }

  for (const parentGroup of collectParentGroups(groupMap.keys())) {
    await emitPythonFile(
      context,
      "__init__.py",
      "",
      `${emitTarget["output-dir"]}/${parentGroup}`,
      emitTarget["output-dir"],
      { allowEmpty: true },
    );
  }

  // Render each base type and its children as a single file, into group subfolder
  for (const n of nodes) {
    // Skip child types - they're rendered with their parent
    if (!n.base) {
      const group = n.group || "";
      const fileDecl = lowerFile(n, registry, polymorphicTypeNames);
      const fileContent = emitPythonFileDecl(fileDecl, visitor, group, {
        cancellationTokenPath: emitTarget["cancellation-token-path"],
        nativeSerialization,
      });
      const outDir = group
        ? `${emitTarget["output-dir"]}/${group}`
        : emitTarget["output-dir"];
      await emitPythonFile(
        context,
        `_${n.typeName.name}.py`,
        fileContent,
        outDir,
        emitTarget["output-dir"],
      );
    }

    // Render test file for each type (skip protocols — they have no data to test)
    if (emitTarget["test-dir"] && !n.isProtocol) {
      const testDir = n.group
        ? `${emitTarget["test-dir"]}/${n.group}`
        : emitTarget["test-dir"];
      const testContext = buildTestContext(n, importPath, registry);
      const testContent = emitPythonTest(testContext, {
        nativeSerialization,
      });
      await emitPythonFile(
        context,
        `test_${toSnakeCase(n.typeName.name)}.py`,
        testContent,
        testDir,
        emitTarget["test-dir"],
      );
    }
  }

  if (
    emitTarget["test-dir"] &&
    shouldEmitCompileOnlyProtocolScaffolds(emitTarget)
  ) {
    const scaffoldContent = emitPythonProtocolScaffolds(
      collectProtocolNodes(nodes),
      importPath,
      emitTarget["cancellation-token-path"],
    );
    await emitPythonFile(
      context,
      "test_protocol_scaffolds.py",
      scaffoldContent,
      emitTarget["test-dir"],
      emitTarget["test-dir"],
    );
  }

  if (
    emitTarget["test-dir"] &&
    (options?.callableVectors?.vectors.length ?? 0) > 0
  ) {
    await emitPythonFile(
      context,
      "vector_runner.py",
      emitPythonVectorRunner(),
      emitTarget["test-dir"],
      emitTarget["test-dir"],
    );
    await emitPythonFile(
      context,
      "test_vector_conformance.py",
      emitPythonVectorConformanceTest(
        options!.callableVectors!,
        emitTarget["vector-adapter-path"] ?? "vector_adapters",
      ),
      emitTarget["test-dir"],
      emitTarget["test-dir"],
    );
  }

  if (shouldEmitFastApi(emitTarget)) {
    const transportContracts = options?.transportContracts ?? [];
    if (transportContracts.length > 0) {
      await emitPythonFile(
        context,
        "fastapi_routes.py",
        emitFastApiRoutes(transportContracts, modelTypes),
        emitTarget["output-dir"],
      );
      await emitPythonFile(
        context,
        "requirements-fastapi.txt",
        "fastapi\n",
        emitTarget["output-dir"],
      );
      if (emitTarget["test-dir"] && hasTransportVectors(transportContracts)) {
        await emitPythonFile(
          context,
          "test_fastapi_transport.py",
          emitFastApiVectorTests(transportContracts, importPath, modelTypes),
          emitTarget["test-dir"],
          emitTarget["test-dir"],
        );
      }
    }
  }

  if (shouldEmitStarlette(emitTarget)) {
    const transportContracts = options?.transportContracts ?? [];
    if (transportContracts.length > 0) {
      await emitPythonFile(
        context,
        "starlette_routes.py",
        emitStarletteRoutes(transportContracts, modelTypes),
        emitTarget["output-dir"],
      );
      await emitPythonFile(
        context,
        "requirements-starlette.txt",
        "starlette\n",
        emitTarget["output-dir"],
      );
      if (emitTarget["test-dir"] && hasTransportVectors(transportContracts)) {
        await emitPythonFile(
          context,
          "test_starlette_transport.py",
          emitStarletteVectorTests(transportContracts, importPath, modelTypes),
          emitTarget["test-dir"],
          emitTarget["test-dir"],
        );
      }
    }
  }

  if (shouldEmitHttpxConsumer(emitTarget)) {
    const transportContracts = options?.transportContracts ?? [];
    if (transportContracts.length > 0) {
      await emitPythonFile(
        context,
        "httpx_client.py",
        emitHttpxClient(transportContracts, modelTypes),
        emitTarget["output-dir"],
      );
      if (emitTarget["test-dir"] && hasTransportVectors(transportContracts)) {
        await emitPythonFile(
          context,
          "test_httpx_transport.py",
          emitHttpxVectorTests(transportContracts, importPath, modelTypes),
          emitTarget["test-dir"],
          emitTarget["test-dir"],
        );
      }
    }
  }

  // Emit group-level __init__.py for each group
  for (const [group, groupNodes] of groupMap) {
    if (!group) continue; // Root-level types (if any) are covered by the root __init__.py
    const groupInitContent = emitPythonGroupInit(group, groupNodes);
    await emitPythonFile(
      context,
      "__init__.py",
      groupInitContent,
      `${emitTarget["output-dir"]}/${group}`,
      emitTarget["output-dir"],
    );
  }

  // Format emitted files if format option is enabled (default: true)
  if (emitTarget.format !== false) {
    // Resolve output paths relative to current working directory (where tsp compile was run)
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
      formatPythonFiles(outputDir, testDir);
    }
  }
  restoreNamespaceGroups(namespaceGroupSnapshots);
};

function collectParentGroups(groups: Iterable<string>): string[] {
  const parents = new Set<string>();
  for (const group of groups) {
    const parts = group.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      parents.add(parts.slice(0, i).join("/"));
    }
  }
  return Array.from(parents).sort();
}

function pythonVectorSlug(index: number, entry: { contract: string; operation: string; vector: { name?: string } }): string {
  const name = entry.vector.name ?? "unnamed";
  const raw = `${entry.contract}_${entry.operation}_${name}`;
  const slug = raw
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `test_vector_${index}_${slug || "unnamed"}`;
}

// Seam-agnostic @vector conformance runner (Python). This module is a CONSTANT:
// it reads ZERO authored values and holds no per-vector data, so it regenerates
// byte-identical regardless of the runtime-authored seam. The thin harness
// injects every adapter/waiver/capability/double table via the `seam` mapping.
function emitPythonVectorRunner(): string {
  const lines = [
    "# Copyright (c) Microsoft. All rights reserved.",
    "# WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "#",
    "# Seam-agnostic @vector conformance runner. This module reads ZERO authored",
    "# values: the thin test harness injects every adapter/waiver/capability/double",
    "# table through the `seam` mapping passed to run_vector(). The runner is fully",
    "# value-independent, so it regenerates byte-identical no matter what the",
    "# runtime-authored seam contains.",
    "#",
    "# Adapter contract: invoke() may return either a plain value or an awaitable.",
    "# The runner awaits the result before normalizing, so an async runtime",
    "# pipeline runs directly on pytest-asyncio's event loop. Each vector must",
    "# perform exactly one awaited invocation and spawn no background concurrency,",
    "# so conformance stays deterministic.",
    "#",
    "# Classification is ENFORCED: an operation marked `@sync` (is_sync is True)",
    "# must resolve synchronously -- if its adapter returns an awaitable the vector",
    "# is a hard failure. An async-capable operation (the default) stays permissive:",
    "# a plain value or an awaitable both pass.",
    "# See docs: reference/vector-conformance.",
    "",
    "import inspect",
    "import json",
    "import os",
    "",
    "import pytest",
    "",
    "",
    "def _canonical(value):",
    "    return json.dumps(value, sort_keys=True)",
    "",
    "",
    "class _SyncViolation(AssertionError):",
    "    # A @sync operation whose adapter returned an awaitable. Distinct from an",
    "    # adapter domain error so the expectedError path never swallows it.",
    "    pass",
    "",
    "",
    "def _resolve_refs(value, base_dir):",
    "    if isinstance(value, list):",
    "        return [_resolve_refs(item, base_dir) for item in value]",
    "    if isinstance(value, dict):",
    "        if len(value) == 1:",
    "            ((key, raw),) = value.items()",
    '            if key == "$env" and isinstance(raw, str):',
    '                return os.environ.get(raw, "")',
    '            if key == "$file" and isinstance(raw, str):',
    '                with open(os.path.join(base_dir, raw), "r", encoding="utf-8") as handle:',
    "                    return handle.read()",
    '            if key == "$json" and isinstance(raw, str):',
    '                with open(os.path.join(base_dir, raw), "r", encoding="utf-8") as handle:',
    "                    return json.load(handle)",
    "        return {key: _resolve_refs(item, base_dir) for key, item in value.items()}",
    "    return value",
    "",
    "",
    "def _adapter_member(adapter, name):",
    "    if isinstance(adapter, dict):",
    "        return adapter.get(name)",
    "    return getattr(adapter, name, None)",
    "",
    "",
    "def _resolve_dispatch_key(root, dotted):",
    "    # Walks a deterministic field-access path (e.g. `agent.template.format.kind`)",
    "    # over a resolved vector input to read the @dispatch discriminator value that",
    "    # selects the concrete seam implementation. Returns None if any hop is missing",
    "    # so the caller can fail loudly on a misresolved path.",
    "    node = root",
    '    for key in dotted.split("."):',
    "        if isinstance(node, dict) and key in node:",
    "            node = node[key]",
    "        else:",
    "            return None",
    "    return node",
    "",
    "",
    "async def run_vector(contract, operation, vector, is_sync, seam, dispatch=None):",
    "    # Seam tables are injected by the harness; the runner authors none of them.",
    '    adapters = seam["adapters"]',
    '    waivers = seam["waivers"]',
    '    capabilities = seam.get("capabilities", {})',
    '    doubles = seam["doubles"]',
    '    base_dir = seam["base_dir"]',
    "",
    "    def resolve_input(value):",
    "        return _resolve_refs(value, base_dir)",
    "",
    "    operation_key = f\"{contract}.{operation}\"",
    "    vector_name = (",
    '        vector.get("name", "unnamed") if isinstance(vector, dict) else "unnamed"',
    "    )",
    '    vector_id = f"{operation_key}:{vector_name}"',
    "    # Behavioral polymorphic dispatch: when the seam is @dispatch-decorated the",
    "    # harness passes the discriminator access path. The concrete implementation is",
    "    # resolved once from the discriminator value read at that path and looked up in",
    "    # the seam's per-key registry (adapters keyed `Contract.operation#key` or",
    "    # `operation#key`). An impl absent for a valid discriminator reuses the",
    "    # capability-absent skip, exactly like a missing requirement.",
    "    if dispatch and dispatch.get(\"path\"):",
    "        dispatch_input = resolve_input(vector[\"input\"])",
    "        dispatch_key = _resolve_dispatch_key(dispatch_input, dispatch[\"path\"])",
    "        if not isinstance(dispatch_key, str):",
    "            raise AssertionError(",
    "                f\"{vector_id}: @dispatch path '{dispatch['path']}' did not \"",
    "                \"resolve to a string discriminator on the vector input.\"",
    "            )",
    "        adapter = adapters.get(f\"{operation_key}#{dispatch_key}\") or adapters.get(",
    "            f\"{operation}#{dispatch_key}\"",
    "        )",
    "        if adapter is None:",
    "            pytest.skip(f\"requirement unavailable: {dispatch_key}\")",
    "    else:",
    "        adapter = adapters.get(operation_key)",
    "        if adapter is None:",
    "            adapter = adapters.get(operation)",
    "        if adapter is None:",
    "            waiver = waivers.get(operation_key) or waivers.get(operation)",
    "            if waiver:",
    '                pytest.skip(f"waived: {waiver}")',
    "            raise AssertionError(",
    '                f"No vector adapter registered for {operation_key}. Register "',
    "                f'VECTOR_ADAPTERS[\"{operation_key}\"] in the module referenced by '",
    "                \"'vector-adapter-path', or add an explicit waiver. \"",
    '                "@vector conformance never skips silently."',
    "            )",
    '    invoke = _adapter_member(adapter, "invoke")',
    "    if invoke is None and callable(adapter):",
    "        invoke = adapter",
    "    if invoke is None:",
    "        raise AssertionError(",
    '            f"Adapter for {operation_key} exposes no callable \'invoke\'."',
    "        )",
    "    # Requirement guard: a vector may declare abstract capability tokens in",
    '    # "requires". Each is resolved against the injected capabilities table',
    "    # BEFORE the adapter runs. An unregistered token is a hard failure (never",
    "    # skip silently); an unavailable one yields a clean skip so an absent",
    "    # credential never reaches invoke as an empty value. Inert when a vector",
    "    # declares no requirements.",
    '    requires = vector.get("requires") if isinstance(vector, dict) else None',
    "    if requires:",
    "        capability_context = {",
    '            "contract": contract,',
    '            "operation": operation,',
    '            "vector": vector,',
    '            "provider": vector.get("provider"),',
    '            "targetApi": vector.get("targetApi"),',
    '            "doubles": doubles,',
    '            "baseDir": base_dir,',
    '            "resolveInput": resolve_input,',
    "        }",
    "        for token in requires:",
    "            if token not in capabilities:",
    "                raise AssertionError(",
    "                    f'No capability predicate registered for requirement token \"{token}\". '",
    "                    f'Register VECTOR_CAPABILITIES[\"{token}\"] in the module referenced by '",
    "                    \"'vector-adapter-path'. @vector conformance never skips silently.\"",
    "                )",
    "        for token in requires:",
    "            if not capabilities[token](capability_context):",
    '                pytest.skip(f"requirement unavailable: {token}")',
    "    # Per-vector waiver, consulted even when an adapter IS registered. Keyed by",
    '    # the vector id ("Contract.operation:name") or "operation:name" so it never',
    "    # collides with an operation-level waiver. xfail: a waived vector that fails",
    "    # is an expected failure (green); xpass: a waived vector that passes is a hard",
    "    # failure so stale waivers get removed.",
    "    per_vector_waiver = waivers.get(vector_id) or waivers.get(",
    "        f\"{operation}:{vector_name}\"",
    "    )",
    "",
    "    # Evaluate WITHOUT failing directly; raises on any failure, returns on a",
    "    # match, so the waiver decision below can turn a failure into an xfail.",
    "    async def _check():",
    '        normalize = _adapter_member(adapter, "normalize") or (',
    "            lambda value, context: value",
    "        )",
    "        context = {",
    '            "contract": contract,',
    '            "operation": operation,',
    '            "vector": vector,',
    '            "provider": vector.get("provider"),',
    '            "targetApi": vector.get("targetApi"),',
    '            "doubles": doubles,',
    '            "baseDir": base_dir,',
    '            "resolveInput": resolve_input,',
    "        }",
    '        resolved_input = resolve_input(vector["input"])',
    '        has_error = "expectedError" in vector',
    "        # Exactly one invocation, one optional await. A @sync operation must not",
    "        # yield an awaitable; an async-capable one is awaited if it does.",
    "        try:",
    "            result = invoke(resolved_input, context)",
    "            if inspect.isawaitable(result):",
    "                if is_sync:",
    '                    if hasattr(result, "close"):',
    "                        result.close()",
    "                    raise _SyncViolation(",
    "                        f\"{operation_key}: operation is @sync but its adapter \"",
    '                        "returned an awaitable. A @sync operation must resolve "',
    '                        "synchronously -- drop @sync to make it async-capable, or "',
    '                        "make the adapter synchronous."',
    "                    )",
    "                result = await result",
    "        except _SyncViolation:",
    "            raise",
    "        except Exception as error:  # noqa: BLE001",
    "            if not has_error:",
    "                raise",
    '            detail = getattr(error, "typra_vector", None)',
    "            observed = detail if detail is not None else {\"message\": str(error)}",
    "            assert _canonical(normalize(observed, context)) == _canonical(",
    '                vector["expectedError"]',
    "            )",
    "            return",
    "        if has_error:",
    "            raise AssertionError(",
    '                f"{operation_key}: expected the adapter to signal an error, "',
    '                "but it returned a value."',
    "            )",
    "        observed = normalize(result, context)",
    '        assert _canonical(observed) == _canonical(vector["expected"]), json.dumps(',
    "            {",
    '                "vectorId": vector_id,',
    '                "target": "python",',
    '                "expected": vector["expected"],',
    '                "observed": observed,',
    "            },",
    "            indent=2,",
    "            sort_keys=True,",
    "        )",
    "",
    "    try:",
    "        await _check()",
    "        _failure = None",
    "    except Exception as _error:  # noqa: BLE001",
    "        _failure = _error",
    "    if per_vector_waiver:",
    "        if _failure is not None:",
    '            print(f"XFAIL {vector_id} (waived: {per_vector_waiver})")',
    "            return",
    "        raise AssertionError(",
    '            f"XPASS {vector_id}: waived vector unexpectedly passed; "',
    '            f"remove the waiver ({per_vector_waiver})"',
    "        )",
    "    if _failure is not None:",
    "        raise _failure",
    "",
  ];
  return lines.join("\n");
}

function emitPythonVectorConformanceTest(
  vectors: NonNullable<GeneratorOptions["callableVectors"]>,
  adapterModule: string,
): string {
  const model = buildVectorConformanceCodeModel(vectors);
  const hasRequires = model.vectors.some(
    (entry) => (entry.vector.requires?.length ?? 0) > 0,
  );
  const lines = [
    "# Copyright (c) Microsoft. All rights reserved.",
    "# WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "#",
    "# Enforced @vector behavioral conformance. Each vector is replayed through the",
    "# seam-agnostic runner in vector_runner, which is injected with the",
    "# runtime-authored adapter tables resolved from the module referenced by the",
    "# target's 'vector-adapter-path' option. A vector with no adapter and no",
    "# explicit waiver is a hard failure -- this suite never skips silently.",
    "# See docs: reference/vector-conformance.",
    "",
    "import importlib",
    "import json",
    "import os",
    "",
    "import pytest",
    "",
    "from vector_runner import run_vector",
    "",
    "# Run every generated test on pytest-asyncio's event loop so awaitable adapters",
    "# are driven the way a real application invokes the runtime.",
    "pytestmark = pytest.mark.asyncio",
    "",
    `_ADAPTER_MODULE = importlib.import_module(${JSON.stringify(adapterModule)})`,
    'VECTOR_ADAPTERS = getattr(_ADAPTER_MODULE, "VECTOR_ADAPTERS", {})',
    'VECTOR_WAIVERS = getattr(_ADAPTER_MODULE, "VECTOR_WAIVERS", {})',
    ...(hasRequires
      ? ['VECTOR_CAPABILITIES = getattr(_ADAPTER_MODULE, "VECTOR_CAPABILITIES", {})']
      : []),
    'VECTOR_DOUBLES = getattr(_ADAPTER_MODULE, "VECTOR_DOUBLES", {})',
    "",
    "_BASE_DIR = os.path.dirname(os.path.abspath(__file__))",
    "",
    "# Runtime-authored seam injected into the value-independent runner.",
    "_SEAM = {",
    '    "adapters": VECTOR_ADAPTERS,',
    '    "waivers": VECTOR_WAIVERS,',
    ...(hasRequires ? ['    "capabilities": VECTOR_CAPABILITIES,'] : []),
    '    "doubles": VECTOR_DOUBLES,',
    '    "base_dir": _BASE_DIR,',
    "}",
  ];
  model.vectors.forEach((entry, index) => {
    const fn = pythonVectorSlug(index, entry);
    const vectorJson = JSON.stringify(entry.vector, null, 2)
      .split("\n")
      .map((line) => (line.length > 0 ? `    ${line}` : ""))
      .join("\n");
    const isSync = entry.sync ? "True" : "False";
    const dispatchArg = entry.dispatch
      ? `, dispatch={"path": ${JSON.stringify(entry.dispatch.path)}}`
      : "";
    lines.push(
      "",
      "",
      `async def ${fn}():`,
      "    vector_json = r'''",
      vectorJson,
      "    '''",
      "    vector = json.loads(vector_json, strict=False)",
      `    await run_vector(${JSON.stringify(entry.contract)}, ${JSON.stringify(entry.operation)}, vector, ${isSync}, _SEAM${dispatchArg})`,
    );
  });
  lines.push("");
  return lines.join("\n");
}

function collectLoadSaveTypeNames(nodes: TypeNode[]): Set<string> {
  return new Set(
    nodes.filter((node) => !node.isProtocol).map((node) => node.typeName.name),
  );
}

function shouldEmitFastApi(target: EmitTarget): boolean {
  return normalizeOutputRequests(target).some(
    (request) =>
      request.target === "python" &&
      request.kind === "server" &&
      request.provider === "fastapi",
  );
}

function shouldEmitStarlette(target: EmitTarget): boolean {
  return normalizeOutputRequests(target).some(
    (request) =>
      request.target === "python" &&
      request.kind === "server" &&
      request.provider === "starlette",
  );
}

function shouldEmitHttpxConsumer(target: EmitTarget): boolean {
  return normalizeOutputRequests(target).some(
    (request) =>
      request.target === "python" &&
      request.kind === "consumer" &&
      request.provider === "httpx",
  );
}

function hasTransportVectors(contracts: TransportContract[]): boolean {
  return contracts.some((contract) =>
    contract.operations.some((operation) =>
      (operation.callable.vectors ?? []).some((vector) => vector.stage === "transport"),
    ),
  );
}

function emitFastApiRoutes(
  contracts: TransportContract[],
  modelTypes: ReadonlySet<string>,
): string {
  const modelImports = collectFastApiModelImports(contracts, modelTypes);
  return [
    "# Copyright (c) Microsoft. All rights reserved.",
    "# WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "",
    "from __future__ import annotations",
    "",
    "import json",
    "from typing import Any, Protocol",
    "from fastapi import APIRouter, Body, Cookie, Header, Path, Query",
    ...(modelImports.length > 0 ? [`from . import ${modelImports.join(", ")}`] : []),
    "",
    `AUTH_REQUIREMENTS = json.loads(${JSON.stringify(JSON.stringify(fastApiAuthRequirements(contracts), null, 2))})`,
    "",
    ...contracts.flatMap((contract) => emitFastApiContract(contract, modelTypes)),
    "",
  ].join("\n");
}

function collectFastApiModelImports(
  contracts: TransportContract[],
  modelTypes: ReadonlySet<string>,
): string[] {
  const imports = new Set<string>();
  for (const contract of contracts) {
    for (const operation of contract.operations) {
      for (const binding of operation.bindings) {
        if (isPythonModelType(binding.type, modelTypes)) imports.add(binding.type);
      }
      for (const response of operation.responses) {
        if (response.body && isPythonModelType(response.body, modelTypes)) {
          imports.add(response.body);
        }
      }
    }
  }
  return Array.from(imports).sort();
}

function emitFastApiContract(
  contract: TransportContract,
  modelTypes: ReadonlySet<string>,
): string[] {
  const handlerName = `${contract.name}Handler`;
  const routerFactory = `create_${toSnakeCase(contract.name)}_router`;
  return [
    `class ${handlerName}(Protocol):`,
    ...contract.operations.flatMap((operation) => [
      `    async def ${operation.operation}(self, ${handlerSignature(operation)}):`,
      "        ...",
      "",
    ]),
    "",
    `def ${routerFactory}(handler: ${handlerName}) -> APIRouter:`,
    "    router = APIRouter()",
    ...contract.operations.flatMap((operation) =>
      emitFastApiOperation(operation, handlerName, modelTypes),
    ),
    "    return router",
    "",
  ];
}

function handlerSignature(operation: TransportOperation): string {
  return operation.bindings
    .map((binding) => `${toSnakeCase(binding.name)}: ${pythonType(binding.type, binding.optional)}`)
    .join(", ");
}

function emitFastApiOperation(
  operation: TransportOperation,
  _handlerName: string,
  modelTypes: ReadonlySet<string>,
): string[] {
  const routeArgs = [JSON.stringify(pythonFrameworkRoutePath(operation))];
  const statusCode = firstSuccessStatusCode(operation);
  if (statusCode) routeArgs.push(`status_code=${statusCode}`);
  const signature = operation.bindings
    .map(fastApiParameter)
    .filter(Boolean)
    .join(", ");
  const bodyBinding = operation.bindings.find((binding) => binding.kind === "body");
  const handlerArgs = operation.bindings
    .map((binding) => `${toSnakeCase(binding.name)}=${toSnakeCase(binding.name)}`)
    .join(", ");

  const lines = [
    "",
    `    @router.${operation.verb}(${routeArgs.join(", ")})`,
    `    async def ${operation.operation}(${signature}):`,
  ];
  if (bodyBinding && isPythonModelType(bodyBinding.type, modelTypes)) {
    const name = toSnakeCase(bodyBinding.name);
    lines.push(`        ${name} = ${bodyBinding.type}.load(${name})`);
  }
  lines.push(`        result = await handler.${operation.operation}(${handlerArgs})`);
  lines.push("        return result.save() if hasattr(result, \"save\") else result");
  return lines;
}

function pythonFrameworkRoutePath(operation: TransportOperation): string {
  let routePath = operation.path;
  for (const binding of operation.bindings.filter((candidate) => candidate.kind === "path")) {
    routePath = routePath.replace(
      new RegExp(`\\{${escapeRegExp(binding.wireName)}\\}`, "g"),
      `{${toSnakeCase(binding.name)}}`,
    );
  }
  return routePath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fastApiAuthRequirements(
  contracts: TransportContract[],
): Record<string, unknown> {
  const requirements: Record<string, unknown> = {};
  for (const contract of contracts) {
    for (const operation of contract.operations) {
      if (operation.auth) {
        requirements[`${contract.name}.${operation.operation}`] = operation.auth;
      }
    }
  }
  return requirements;
}

function fastApiParameter(binding: TransportBinding): string {
  const name = toSnakeCase(binding.name);
  const type = pythonType(binding.type, binding.optional);
  switch (binding.kind) {
    case "path":
      return `${name}: ${type} = Path(...)`;
    case "query":
      return `${name}: ${type} = Query(default=${binding.optional ? "None" : "..."}, alias=${JSON.stringify(binding.wireName)})`;
    case "header":
      return `${name}: ${type} = Header(default=${binding.optional ? "None" : "..."}, alias=${JSON.stringify(binding.wireName)})`;
    case "cookie":
      return `${name}: ${type} = Cookie(default=${binding.optional ? "None" : "..."}, alias=${JSON.stringify(binding.wireName)})`;
    case "body":
      return `${name}: Any = Body(...)`;
  }
}

function emitStarletteRoutes(
  contracts: TransportContract[],
  modelTypes: ReadonlySet<string>,
): string {
  const modelImports = collectFastApiModelImports(contracts, modelTypes);
  return [
    "# Copyright (c) Microsoft. All rights reserved.",
    "# WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "",
    "from __future__ import annotations",
    "",
    "import json",
    "from typing import Protocol",
    "from starlette.exceptions import HTTPException",
    "from starlette.requests import Request",
    "from starlette.responses import JSONResponse, Response",
    "from starlette.routing import Route",
    ...(modelImports.length > 0 ? [`from . import ${modelImports.join(", ")}`] : []),
    "",
    `AUTH_REQUIREMENTS = json.loads(${JSON.stringify(JSON.stringify(fastApiAuthRequirements(contracts), null, 2))})`,
    "",
    "def _coerce(value, type_name):",
    "    if value is None:",
    "        return None",
    "    if type_name == \"boolean\":",
    "        return str(value).lower() in {\"1\", \"true\", \"yes\", \"on\"}",
    "    if type_name in {\"int32\", \"int64\", \"integer\"}:",
    "        return int(value)",
    "    if type_name in {\"float32\", \"float64\", \"numeric\", \"number\"}:",
    "        return float(value)",
    "    return str(value)",
    "",
    "def _required(value, binding_name):",
    "    if value is None:",
    "        raise HTTPException(status_code=400, detail=f\"Missing required transport binding: {binding_name}\")",
    "    return value",
    "",
    ...contracts.flatMap((contract) => emitStarletteContract(contract, modelTypes)),
    "",
  ].join("\n");
}

function emitStarletteContract(
  contract: TransportContract,
  modelTypes: ReadonlySet<string>,
): string[] {
  const handlerName = `${contract.name}Handler`;
  const routeFactory = `create_${toSnakeCase(contract.name)}_routes`;
  return [
    `class ${handlerName}(Protocol):`,
    ...contract.operations.flatMap((operation) => [
      `    async def ${operation.operation}(self, ${handlerSignature(operation)}):`,
      "        ...",
      "",
    ]),
    "",
    `def ${routeFactory}(handler: ${handlerName}):`,
    ...contract.operations.flatMap((operation) =>
      emitStarletteOperation(operation, modelTypes),
    ),
    "    return [",
    ...contract.operations.map(
      (operation) =>
        `        Route(${JSON.stringify(pythonFrameworkRoutePath(operation))}, ${operation.operation}, methods=[${JSON.stringify(operation.verb.toUpperCase())}]),`,
    ),
    "    ]",
    "",
  ];
}

function emitStarletteOperation(
  operation: TransportOperation,
  modelTypes: ReadonlySet<string>,
): string[] {
  const bodyBinding = operation.bindings.find((binding) => binding.kind === "body");
  const handlerArgs = operation.bindings
    .map((binding) => `${toSnakeCase(binding.name)}=${toSnakeCase(binding.name)}`)
    .join(", ");
  const statusCode = firstSuccessStatusCode(operation) ?? 200;
  const lines = [
    `    async def ${operation.operation}(_request: Request):`,
  ];
  for (const binding of operation.bindings) {
    const name = toSnakeCase(binding.name);
    const typeName = JSON.stringify(binding.type);
    switch (binding.kind) {
      case "path":
        lines.push(
          `        ${name} = _coerce(_request.path_params.get(${JSON.stringify(name)}), ${typeName})`,
        );
        break;
      case "query":
        lines.push(...starletteBoundParameterLines(name, "_request.query_params", binding, typeName));
        break;
      case "header":
        lines.push(...starletteBoundParameterLines(name, "_request.headers", binding, typeName));
        break;
      case "cookie":
        lines.push(...starletteBoundParameterLines(name, "_request.cookies", binding, typeName));
        break;
      case "body":
        lines.push(`        ${name} = await _request.json()`);
        if (isPythonModelType(binding.type, modelTypes)) {
          lines.push(`        ${name} = ${binding.type}.load(${name})`);
        }
        break;
    }
  }
  if (!bodyBinding) {
    lines.push("        _ = _request");
  }
  lines.push(`        result = await handler.${operation.operation}(${handlerArgs})`);
  lines.push("        result = result.save() if hasattr(result, \"save\") else result");
  lines.push("        if result is None:");
  lines.push(`            return Response(status_code=${statusCode})`);
  lines.push(`        return JSONResponse(result, status_code=${statusCode})`);
  lines.push("");
  return lines;
}

function starletteBoundParameterLines(
  name: string,
  source: string,
  binding: TransportBinding,
  typeName: string,
): string[] {
  const rawName = `${name}_raw`;
  const lines = [`        ${rawName} = ${source}.get(${JSON.stringify(binding.wireName)})`];
  const value = binding.optional
    ? rawName
    : `_required(${rawName}, ${JSON.stringify(binding.wireName)})`;
  lines.push(`        ${name} = _coerce(${value}, ${typeName})`);
  return lines;
}

function emitHttpxClient(
  contracts: TransportContract[],
  modelTypes: ReadonlySet<string>,
): string {
  const imports = collectHttpxModelImports(contracts, modelTypes);
  return [
    "# Copyright (c) Microsoft. All rights reserved.",
    "# WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "",
    "from __future__ import annotations",
    "",
    "import json",
    "from typing import Any, Awaitable, Callable",
    "from urllib.parse import quote, urlencode",
    ...(imports.length > 0 ? [`from . import ${imports.join(", ")}`] : []),
    "",
    "TypraHttpxTransport = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]",
    "",
    "class TypraHttpxResponseError(Exception):",
    "    def __init__(self, response: dict[str, Any]):",
    "        super().__init__(f\"Unexpected response status {response.get('status')}\")",
    "        self.status = response.get(\"status\")",
    "        self.body = response.get(\"body\")",
    "",
    "def _join_url(base_url: str, path: str) -> str:",
    "    return f\"{base_url.rstrip('/')}/{path.lstrip('/')}\"",
    "",
    "def _serialize_value(value):",
    "    if value is None:",
    "        return None",
    "    if hasattr(value, \"isoformat\"):",
    "        return value.isoformat()",
    "    if isinstance(value, bool):",
    "        return \"true\" if value else \"false\"",
    "    return str(value)",
    "",
    "def _serialize_body(value):",
    "    return value.save() if hasattr(value, \"save\") else value",
    "",
    "def _matches_status(status: int, code: str) -> bool:",
    "    if code == \"*\":",
    "        return True",
    "    if code.isdigit():",
    "        return int(code) == status",
    "    if \"-\" in code:",
    "        start, end = code.split(\"-\", 1)",
    "        return int(start) <= status <= int(end)",
    "    return False",
    "",
    ...contracts.flatMap((contract) => emitHttpxContract(contract, modelTypes)),
    "",
  ].join("\n");
}

function collectHttpxModelImports(
  contracts: TransportContract[],
  modelTypes: ReadonlySet<string>,
): string[] {
  const imports = new Set<string>();
  for (const contract of contracts) {
    for (const operation of contract.operations) {
      for (const binding of operation.bindings) {
        if (modelTypes.has(binding.type)) imports.add(binding.type);
      }
      for (const response of successOrFallbackBodyResponses(operation)) {
        if (response.body && modelTypes.has(response.body)) imports.add(response.body);
      }
    }
  }
  return Array.from(imports).sort();
}

function emitHttpxContract(
  contract: TransportContract,
  modelTypes: ReadonlySet<string>,
): string[] {
  return [
    `class ${contract.name}Client:`,
    "    def __init__(self, base_url: str, transport: TypraHttpxTransport):",
    "        self._base_url = base_url",
    "        self._transport = transport",
    "",
    ...contract.operations.flatMap((operation) =>
      emitHttpxOperation(operation, modelTypes),
    ),
    "",
  ];
}

function emitHttpxOperation(
  operation: TransportOperation,
  modelTypes: ReadonlySet<string>,
): string[] {
  const signature = operation.bindings
    .map((binding) => `${toSnakeCase(binding.name)}: ${pythonType(binding.type, binding.optional)}`)
    .join(", ");
  const resultType = pythonResultType(operation, modelTypes);
  const lines = [
    `    async def ${operation.operation}(self, ${signature}) -> ${resultType}:`,
    `        path = ${JSON.stringify(routePathTemplate(operation))}`,
  ];
  for (const binding of operation.bindings.filter((entry) => entry.kind === "path")) {
    const name = toSnakeCase(binding.name);
    lines.push(
      `        path = path.replace(${JSON.stringify(`{${binding.wireName}}`)}, quote(_serialize_value(${name}) or \"\", safe=\"\"))`,
    );
  }
  lines.push("        query = {}");
  for (const binding of operation.bindings.filter((entry) => entry.kind === "query")) {
    const name = toSnakeCase(binding.name);
    lines.push(`        value = _serialize_value(${name})`);
    lines.push("        if value is not None:");
    lines.push(`            query[${JSON.stringify(binding.wireName)}] = value`);
  }
  lines.push("        if query:");
  lines.push("            path = f\"{path}?{urlencode(query)}\"");
  lines.push("        headers = {}");
  for (const binding of operation.bindings.filter((entry) => entry.kind === "header")) {
    const name = toSnakeCase(binding.name);
    lines.push(`        value = _serialize_value(${name})`);
    lines.push("        if value is not None:");
    lines.push(`            headers[${JSON.stringify(binding.wireName)}] = value`);
  }
  lines.push("        cookies = {}");
  for (const binding of operation.bindings.filter((entry) => entry.kind === "cookie")) {
    const name = toSnakeCase(binding.name);
    lines.push(`        value = _serialize_value(${name})`);
    lines.push("        if value is not None:");
    lines.push(`            cookies[${JSON.stringify(binding.wireName)}] = value`);
  }
  const body = operation.bindings.find((binding) => binding.kind === "body");
  if (body) {
    const name = toSnakeCase(body.name);
    lines.push('        headers.setdefault("Content-Type", "application/json")');
    lines.push(`        body = _serialize_body(${name})`);
  } else {
    lines.push("        body = None");
  }
  lines.push("        response = await self._transport({");
  lines.push(`            "method": ${JSON.stringify(operation.verb.toUpperCase())},`);
  lines.push("            \"url\": _join_url(self._base_url, path),");
  lines.push("            \"headers\": headers,");
  lines.push("            \"cookies\": cookies,");
  lines.push(`            "auth": ${pythonJsonExpression(operation.auth)},`);
  lines.push("            \"body\": body,");
  lines.push("        })");
  lines.push("        status = int(response.get(\"status\", 0))");
  lines.push("        if status < 200 or status >= 300:");
  lines.push("            raise TypraHttpxResponseError(response)");
  emitPythonResponseSelection(operation, modelTypes, lines, "        ");
  lines.push("        raise TypraHttpxResponseError(response)");
  lines.push("");
  return lines;
}

function routePathTemplate(operation: TransportOperation): string {
  return operation.uriTemplate.replace(/\{\?[^}]+\}/g, "");
}

function pythonJsonExpression(value: unknown): string {
  if (value === undefined) return "None";
  return `json.loads(${JSON.stringify(JSON.stringify(value))})`;
}

function emitPythonResponseSelection(
  operation: TransportOperation,
  modelTypes: ReadonlySet<string>,
  lines: string[],
  indent: string,
): void {
  const successResponses = operation.responses.filter((response) => response.kind === "success");
  const fallbackResponses =
    successResponses.length === 0
      ? operation.responses.filter((response) => response.kind === "unknown")
      : [];
  for (const response of [...successResponses, ...fallbackResponses]) {
    const statusCheck = response.statusCodes
      .map((code) => `_matches_status(status, ${JSON.stringify(code)})`)
      .join(" or ");
    lines.push(`${indent}if ${statusCheck}:`);
    if (!response.body || response.body === "void") {
      lines.push(`${indent}    return None`);
    } else if (isPythonModelType(response.body, modelTypes)) {
      lines.push(`${indent}    return ${response.body}.load(response.get("body"))`);
    } else {
      lines.push(`${indent}    return response.get("body")`);
    }
  }
}

function pythonResultType(
  operation: TransportOperation,
  modelTypes: ReadonlySet<string>,
): string {
  const responseTypes = [
    ...new Set(
      successOrFallbackBodyResponses(operation).map((response) =>
        pythonType(response.body!, false),
      ),
    ),
  ];
  const hasExplicitSuccess = operation.responses.some((response) => response.kind === "success");
  const hasVoidSuccess = operation.responses.some(
    (response) =>
      (response.kind === "success" || (!hasExplicitSuccess && response.kind === "unknown")) &&
      (!response.body || response.body === "void"),
  );
  if (hasVoidSuccess) responseTypes.push("None");
  return responseTypes.length > 0 ? responseTypes.join(" | ") : "None";
}

function emitFastApiVectorTests(
  contracts: TransportContract[],
  importPath: string,
  modelTypes: ReadonlySet<string>,
): string {
  const operations = contracts.flatMap((contract) => contract.operations);
  const vectorEntries = operations.flatMap((operation) =>
    (operation.callable.vectors ?? [])
      .filter((vector) => vector.stage === "transport")
      .map((vector) => ({
        contract: operation.contract,
        operation: operation.operation,
        verb: operation.verb,
        path: operation.path,
        bindings: operation.bindings.map((binding) => ({
          ...binding,
          pythonName: toSnakeCase(binding.name),
        })),
        responseType: operation.responses.find((response) => response.body)?.body,
        vector,
      })),
  );
  const responseTypes = [
    ...new Set(
      vectorEntries
        .map((entry) => entry.responseType)
        .filter((type): type is string => typeof type === "string" && isPythonModelType(type, modelTypes)),
    ),
  ].sort();
  const routerFactories = contracts.map((contract) => ({
    contract: contract.name,
    name: `create_${toSnakeCase(contract.name)}_router`,
  }));
  return [
    "# Copyright (c) Microsoft. All rights reserved.",
    "# WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "",
    "import json",
    "from fastapi import FastAPI",
    "from fastapi.testclient import TestClient",
    responseTypes.length > 0
      ? `from ${importPath} import ${responseTypes.join(", ")}`
      : "",
    `from ${importPath}.fastapi_routes import ${routerFactories.map((factory) => factory.name).join(", ")}`,
    "",
    `TRANSPORT_VECTORS = json.loads(${JSON.stringify(JSON.stringify(vectorEntries, null, 2))})`,
    `MODEL_TYPES = {${responseTypes.map((type) => `${JSON.stringify(type)}: ${type}`).join(", ")}}`,
    `ROUTER_FACTORIES = {${routerFactories.map((factory) => `${JSON.stringify(factory.contract)}: ${factory.name}`).join(", ")}}`,
    "",
    "",
    "class _VectorHandler:",
    "    def __init__(self, entry):",
    "        self.entry = entry",
    "        self.calls = {}",
    "",
    ...operations.flatMap((operation) => [
      `    async def ${operation.operation}(self, **_kwargs):`,
      `        self.calls[${JSON.stringify(operation.operation)}] = _kwargs`,
      "        expected = self.entry[\"vector\"].get(\"expected\")",
      "        response_type = self.entry.get(\"responseType\")",
      "        if response_type in MODEL_TYPES:",
      "            return MODEL_TYPES[response_type].load(expected)",
      "        return expected",
      "",
    ]),
    "",
    "def _path_for(entry):",
    "    path = entry[\"path\"]",
    "    inputs = entry[\"vector\"][\"input\"]",
    "    for binding in entry[\"bindings\"]:",
    "        if binding[\"kind\"] == \"path\":",
    "            key = binding[\"wireName\"]",
    "            value = inputs.get(key, inputs.get(binding[\"name\"]))",
    "            path = path.replace(\"{\" + key + \"}\", str(value))",
    "    return path",
    "",
    "",
    "def _request_kwargs(entry):",
    "    inputs = entry[\"vector\"][\"input\"]",
    "    params = {}",
    "    headers = {}",
    "    cookies = {}",
    "    json_body = None",
    "    for binding in entry[\"bindings\"]:",
    "        key = binding[\"wireName\"]",
    "        value = inputs.get(key, inputs.get(binding[\"name\"]))",
    "        if value is None:",
    "            continue",
    "        if binding[\"kind\"] == \"query\":",
    "            params[key] = value",
    "        elif binding[\"kind\"] == \"header\":",
    "            headers[key] = str(value)",
    "        elif binding[\"kind\"] == \"cookie\":",
    "            cookies[key] = str(value)",
    "        elif binding[\"kind\"] == \"body\":",
    "            json_body = value",
    "    kwargs = {}",
    "    if params:",
    "        kwargs[\"params\"] = params",
    "    if headers:",
    "        kwargs[\"headers\"] = headers",
    "    if cookies:",
    "        kwargs[\"cookies\"] = cookies",
    "    if json_body is not None:",
    "        kwargs[\"json\"] = json_body",
    "    return kwargs",
    "",
    "",
    "def _saved(value):",
    "    return value.save() if hasattr(value, \"save\") else value",
    "",
    "",
    "def _assert_handler_received(entry, handler):",
    "    received = handler.calls[entry[\"operation\"]]",
    "    inputs = entry[\"vector\"][\"input\"]",
    "    for binding in entry[\"bindings\"]:",
    "        key = binding[\"wireName\"]",
    "        expected = inputs.get(key, inputs.get(binding[\"name\"]))",
    "        if expected is None:",
    "            continue",
    "        assert _saved(received[binding[\"pythonName\"]]) == expected",
    "",
    "",
    "def test_fastapi_transport_vectors_execute_routes():",
    "    assert TRANSPORT_VECTORS",
    "    for entry in TRANSPORT_VECTORS:",
    "        app = FastAPI()",
    "        handler = _VectorHandler(entry)",
    "        app.include_router(ROUTER_FACTORIES[entry[\"contract\"]](handler))",
    "        client = TestClient(app)",
    "        response = getattr(client, entry[\"verb\"])(_path_for(entry), **_request_kwargs(entry))",
    "        assert response.status_code < 400, response.text",
    "        _assert_handler_received(entry, handler)",
    "        assert response.json() == entry[\"vector\"].get(\"expected\")",
    "",
  ].join("\n");
}

function emitStarletteVectorTests(
  contracts: TransportContract[],
  importPath: string,
  modelTypes: ReadonlySet<string>,
): string {
  return emitFastApiVectorTests(contracts, importPath, modelTypes)
    .replace("from fastapi import FastAPI", "from starlette.applications import Starlette")
    .replace("from fastapi.testclient import TestClient", "from starlette.testclient import TestClient")
    .replace(".fastapi_routes import", ".starlette_routes import")
    .replace(/create_(\w+)_router/g, "create_$1_routes")
    .replace("test_fastapi_transport_vectors_execute_routes", "test_starlette_transport_vectors_execute_routes")
    .replace("        app = FastAPI()\n", "")
    .replace(
      "        app.include_router(ROUTER_FACTORIES[entry[\"contract\"]](handler))",
      "        app = Starlette(routes=ROUTER_FACTORIES[entry[\"contract\"]](handler))",
    );
}

function emitHttpxVectorTests(
  contracts: TransportContract[],
  importPath: string,
  modelTypes: ReadonlySet<string>,
): string {
  const operations = contracts.flatMap((contract) => contract.operations);
  const vectorEntries = operations.flatMap((operation) =>
    (operation.callable.vectors ?? [])
      .filter((vector) => vector.stage === "transport")
      .map((vector) => ({
        contract: operation.contract,
        operation: operation.operation,
        bindings: operation.bindings.map((binding) => ({
          ...binding,
          pythonName: toSnakeCase(binding.name),
        })),
        auth: operation.auth,
        successStatus: firstSuccessStatusCode(operation) ?? 200,
        vector,
      })),
  );
  const clientNames = [...new Set(contracts.map((contract) => `${contract.name}Client`))].sort();
  const modelImports = [
    ...new Set(
      operations.flatMap((operation) =>
        operation.bindings
          .filter((binding) => binding.kind === "body" && modelTypes.has(binding.type))
          .map((binding) => binding.type),
      ),
    ),
  ].sort();
  return [
    "# Copyright (c) Microsoft. All rights reserved.",
    "# WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "",
    "import asyncio",
    "import json",
    modelImports.length > 0 ? `from ${importPath} import ${modelImports.join(", ")}` : "",
    `from ${importPath}.httpx_client import ${[...clientNames, "TypraHttpxResponseError"].join(", ")}`,
    "",
    `TRANSPORT_VECTORS = json.loads(${JSON.stringify(JSON.stringify(vectorEntries, null, 2))})`,
    "",
    "def _input_args(entry):",
    "    inputs = entry[\"vector\"][\"input\"]",
    "    args = {}",
    "    for binding in entry[\"bindings\"]:",
    "        value = inputs.get(binding[\"name\"], inputs.get(binding[\"wireName\"]))",
    "        if binding[\"kind\"] == \"body\" and binding[\"type\"] in globals():",
    "            value = globals()[binding[\"type\"]].load(value)",
    "        args[binding[\"pythonName\"]] = value",
    "    return args",
    "",
    "def _saved(value):",
    "    return value.save() if hasattr(value, \"save\") else value",
    "",
    "async def _capture_transport(captured, entry, request):",
    "    captured.append(request)",
    "    return {\"status\": entry.get(\"successStatus\", 200), \"body\": entry[\"vector\"].get(\"expected\")}",
    "",
    "async def _error_transport(_request):",
    "    return {\"status\": 401, \"body\": {\"error\": \"unauthorized\"}}",
    "",
    "async def _run_httpx_transport_vectors_execute_clients():",
    "    assert TRANSPORT_VECTORS",
    "    for entry in TRANSPORT_VECTORS:",
    "        captured = []",
    "        client = globals()[entry[\"contract\"] + \"Client\"](\"https://example.test\", lambda request, entry=entry, captured=captured: _capture_transport(captured, entry, request))",
    "        result = await getattr(client, entry[\"operation\"])(**_input_args(entry))",
    "        assert captured",
    "        assert captured[0][\"auth\"] == entry.get(\"auth\")",
    "        assert _saved(result) == entry[\"vector\"].get(\"expected\")",
    "",
    "def test_httpx_transport_vectors_execute_clients():",
    "    asyncio.run(_run_httpx_transport_vectors_execute_clients())",
    "",
    "async def _run_httpx_transport_errors_preserve_body():",
    "    entry = TRANSPORT_VECTORS[0]",
    "    client = globals()[entry[\"contract\"] + \"Client\"](\"https://example.test\", _error_transport)",
    "    try:",
    "        await getattr(client, entry[\"operation\"])(**_input_args(entry))",
    "    except TypraHttpxResponseError as error:",
    "        assert error.status == 401",
    "        assert error.body == {\"error\": \"unauthorized\"}",
    "    else:",
    "        raise AssertionError(\"expected TypraHttpxResponseError\")",
    "",
    "def test_httpx_transport_errors_preserve_body():",
    "    asyncio.run(_run_httpx_transport_errors_preserve_body())",
    "",
  ].join("\n");
}

function pythonType(type: string, optional = false): string {
  if (type.includes(" | ")) {
    const rendered = type.split(" | ").map((part) => pythonType(part.trim(), false)).join(" | ");
    return optional ? `${rendered} | None` : rendered;
  }
  const runtimeKind = scalarRuntimeKind(type);
  const resolved =
    runtimeKind === "string"
      ? "str"
      : runtimeKind === "boolean"
        ? "bool"
        : runtimeKind === "integral"
          ? "int"
          : runtimeKind === "fractional"
            ? "float"
            : type;
  return optional ? `${resolved} | None` : resolved;
}

function isPythonModelType(type: string, modelTypes: ReadonlySet<string>): boolean {
  return modelTypes.has(type);
}

function pythonNativeSerialization(
  emitTarget: EmitTarget,
): "none" | "pydantic" {
  return emitTarget["native-serialization"] === "pydantic"
    ? "pydantic"
    : "none";
}

/**
 * Format Python files using ruff linter and formatter.
 * Runs formatters via uv from the Python project root (where pyproject.toml is located).
 * CI enforces `ruff check` and `ruff format --check`, so both must pass.
 */
function formatPythonFiles(outputDir: string, testDir?: string): void {
  // Find the Python project root by looking for pyproject.toml
  const projectRoot = findPythonProjectRoot(outputDir);
  if (!projectRoot) {
    console.warn(
      `Warning: Could not find pyproject.toml. Skipping formatting.`,
    );
    return;
  }

  const dirs = [outputDir, ...(testDir ? [testDir] : [])];

  for (const dir of dirs) {
    // Run ruff check with auto-fix (linting)
    try {
      execFileSync("uv", ["run", "ruff", "check", "--fix", dir], {
        cwd: projectRoot,
        stdio: "pipe",
        encoding: "utf-8",
      });
    } catch (error) {
      console.warn(
        `Warning: ruff check failed for ${dir}. You may need to install ruff or run it manually.`,
      );
    }

    // Run ruff format (formatting — matches CI's `ruff format --check`)
    try {
      execFileSync("uv", ["run", "ruff", "format", dir], {
        cwd: projectRoot,
        stdio: "pipe",
        encoding: "utf-8",
      });
    } catch (error) {
      console.warn(
        `Warning: ruff format failed for ${dir}. You may need to install ruff or run it manually.`,
      );
    }
  }
}

/**
 * Find the Python project root by traversing up from the output directory
 * looking for pyproject.toml.
 */
function findPythonProjectRoot(startDir: string): string | undefined {
  let currentDir = resolve(startDir);
  const root = resolve("/");

  // On Windows, also check for drive root (e.g., "C:\")
  while (currentDir !== root && currentDir !== dirname(currentDir)) {
    const pyprojectPath = resolve(currentDir, "pyproject.toml");
    if (existsSync(pyprojectPath)) {
      return currentDir;
    }
    currentDir = dirname(currentDir);
  }

  return undefined;
}

/**
 * Build context for rendering a single Python class.
 * Resolves factories and coercions via the expression IR when registry/visitor provided.
 */
function buildClassContext(
  node: TypeNode,
  registry?: TypeRegistry,
  visitor?: ExprVisitor,
): PythonClassContext {
  // Pre-compute safe factory method names to avoid field/classmethod collisions.
  const fieldNames = new Set(node.properties.map((p) => toSnakeCase(p.name)));
  const factoryNameMap: Record<string, string> = {};
  for (const factory of node.factories) {
    const snakeName = toSnakeCase(factory.name);
    factoryNameMap[factory.name] = fieldNames.has(snakeName)
      ? `create_${snakeName}`
      : snakeName;
  }

  // Resolve factories via expression IR (when registry+visitor available)
  const factoryTypeRefs: string[] = [];
  const renderedFactories =
    registry && visitor
      ? (node.factories || []).map((f) => {
          const expr = resolveFactoryExpr(f.sets, f.params, node, registry);
          for (const ref of collectExprTypeRefs(expr)) {
            factoryTypeRefs.push(ref.name);
          }
          return {
            name: f.name,
            safeName: factoryNameMap[f.name],
            params: f.params,
            body: visitor.visitExpr(expr),
          };
        })
      : [];

  // Resolve coercions via expression IR
  const renderedCoercions =
    registry && visitor
      ? (node.coercions || []).map((c) => {
          const expr = resolveCoerceExpr(
            c.expansion,
            c.scalar,
            node,
            registry,
            "data",
          );
          return {
            scalar: pythonTypeMapper[c.scalar] || c.scalar,
            expression: renderObjectLiteral(expr, visitor, "py"),
          };
        })
      : [];

  // Keep factory-referenced types for file-level import resolution
  // Don't merge into class imports — the file template handles imports
  const baseImports = getUniqueImportTypes(node);

  return {
    node,
    typeMapper: pythonTypeMapper,
    coercions: prepareCoercions(node),
    polymorphicTypes: node.retrievePolymorphicTypes(),
    imports: baseImports,
    collectionTypes: getCollectionTypes(node),
    coercionProperty: getCoercionProperty(node),
    factoryNameMap,
    renderedFactories,
    renderedCoercions,
    factoryTypeRefs,
  };
}

/**
 * Build context for rendering a Python file with a base type and its children.
 */
function buildFileContext(
  node: TypeNode,
  registry: TypeRegistry,
  visitor: ExprVisitor,
): PythonFileContext {
  const classes: PythonClassContext[] = [
    buildClassContext(node, registry, visitor),
    ...node.childTypes.map((ct) => buildClassContext(ct, registry, visitor)),
  ];

  // Build grouped imports: module → set of type names to import from that module
  // This handles both base types (module == type) and child types (module == parent type)
  const childTypeNames = new Set([
    node.typeName.name,
    ...node.childTypes.map((ct) => ct.typeName.name),
  ]);
  const importMap = new Map<string, Set<string>>();

  const addImport = (typeName: string) => {
    if (childTypeNames.has(typeName)) return; // Skip types defined in this file
    // Find which module this type lives in
    const refNode = registry.get(typeName);
    const module = refNode?.base ? refNode.base.name : typeName;
    if (!importMap.has(module)) importMap.set(module, new Set());
    importMap.get(module)!.add(typeName);
  };

  // Property-based imports (base types referenced by properties)
  for (const name of getUniqueImportTypes(node)) {
    addImport(name);
  }

  // Factory-referenced imports (may include child types like TextPart)
  for (const cls of classes) {
    for (const ref of cls.factoryTypeRefs) {
      addImport(ref);
    }
  }

  const imports = Array.from(importMap.entries())
    .map(([module, names]) => ({ module, names: Array.from(names).sort() }))
    .sort((a, b) => a.module.localeCompare(b.module));

  return {
    containsAbstract:
      node.isAbstract || node.childTypes.some((c) => c.isAbstract),
    typings: ["Any", "Callable", "Optional"],
    imports,
    classes,
    typeMapper: pythonTypeMapper,
  };
}

/**
 * Build context for rendering the __init__.py file.
 */
function buildInitContext(nodes: TypeNode[]): PythonInitContext {
  return {
    baseTypes: nodes.filter((n) => !n.base),
    types: nodes,
  };
}

/**
 * Build context for rendering a test file using the standardized shared helper.
 */
function buildTestContext(
  node: TypeNode,
  packageName: string,
  registry: TypeRegistry,
): BaseTestContext & { classCtx: PythonClassContext } {
  const base = buildBaseTestContext(
    node,
    packageName,
    pythonTestOptions,
    (name) => registry.get(name),
  );
  const classCtx = buildClassContext(node);
  return { ...base, classCtx };
}

/**
 * Build context for rendering the LoadContext file.
 */
function buildLoadContextContext(
  packageName?: string,
): PythonLoadContextContext {
  return {
    header: "Typra LoadContext",
    package: packageName,
  };
}

/**
 * Prepare coercion representations for template rendering.
 * Converts coercions to Python-specific format with JSON stringification.
 */
function prepareCoercions(
  node: TypeNode,
): Array<{ scalar: string; alternate: string }> {
  if (!node.coercions || node.coercions.length === 0) {
    return [];
  }

  return node.coercions.map((alt) => ({
    scalar: pythonTypeMapper[alt.scalar],
    alternate: JSON.stringify(alt.expansion, null, "")
      .replaceAll("\n", "")
      .replaceAll('"{value}"', " data"),
  }));
}

/**
 * Get the coercion property name from coercions.
 * The coercion property is the one that receives "{value}" in the expansion.
 */
function getCoercionProperty(node: TypeNode): string | null {
  if (!node.coercions || node.coercions.length === 0) {
    return null;
  }

  // Look for a property that has "{value}" as its expansion value
  for (const alt of node.coercions) {
    for (const [key, value] of Object.entries(alt.expansion)) {
      if (value === "{value}") {
        return key;
      }
    }
  }
  return null;
}

/**
 * Get collection properties with their nested type info for load_* methods.
 */
function getCollectionTypes(
  node: TypeNode,
): Array<{ prop: PropertyNode; type: string[]; hasNameProperty: boolean }> {
  return node.properties
    .filter((p) => p.isCollection && !p.isScalar && !p.isDict)
    .map((p) => ({
      prop: p,
      type:
        p.type?.properties
          .filter((t) => t.name !== "name")
          .map((t) => t.name) || [],
      // Ordinary lists remain ordered arrays even when their element has a `name` field.
      // Only Record<T>|Named<T>[] explicitly opts into name-keyed map serialization.
      hasNameProperty: p.isNamedCollection,
    }));
}

/**
 * Get unique import types needed from other modules.
 * Excludes self-references and parent types.
 */
function getUniqueImportTypes(node: TypeNode): string[] {
  const imports = [
    node.properties
      .filter((p) => !p.isScalar && !p.isDict)
      .map((p) => p.typeName.name),
    ...node.childTypes.flatMap((c) =>
      c.properties
        .filter((p) => !p.isScalar && !p.isDict)
        .map((p) => p.typeName.name),
    ),
  ]
    .flat()
    .filter((n) => n !== node.typeName.name && node.base?.name !== n);

  // Remove duplicates and sort
  return Array.from(new Set(imports)).sort();
}

/**
 * Write generated Python content to file using TypeSpec's emitFile API.
 */
async function emitPythonFile(
  context: EmitContext<TypraEmitterOptions>,
  filename: string,
  content: string,
  outputDir?: string,
  outputRoot?: string,
  options: { allowEmpty?: boolean } = {},
): Promise<void> {
  outputDir = outputDir || `${context.emitterOutputDir}/python`;
  const filePath = resolvePath(outputDir, filename);

  await emitGeneratedFile(context, filePath, formatPythonSource(content), {
    outputRoot: outputRoot || outputDir,
    allowEmpty: options.allowEmpty,
  });
}
