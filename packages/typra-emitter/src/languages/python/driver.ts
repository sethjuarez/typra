import { EmitContext, resolvePath } from "@typespec/compiler";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { EmitTarget, TypraEmitterOptions } from "../../lib.js";
import {
  buildVectorConformanceCodeModel,
  VectorConformanceCodeModel,
} from "../../ir/code-model.js";
import { normalizeOutputRequests } from "../../output-contributors.js";
import type {
  TransportBinding,
  TransportContract,
  TransportOperation,
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
  const namespaceGroupSnapshots = applyNamespaceGroups(allTypes, {
    target: "python",
    semanticRoot: options?.rootNamespace,
    emitTarget,
    namespaceOutput: options?.namespaceOutput,
  });
  const nodes = filterNodes(allTypes, options);

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
      "test_vector_conformance.py",
      emitPythonVectorConformanceTest(
        options!.callableVectors!,
        importPath,
        nodes,
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
      if (emitTarget["test-dir"]) {
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

    formatPythonFiles(outputDir, testDir);
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

function emitPythonVectorConformanceTest(
  vectors: NonNullable<GeneratorOptions["callableVectors"]>,
  importPath: string,
  nodes: TypeNode[],
): string {
  const model = buildVectorConformanceCodeModel(vectors, {
    loadSaveTypes: collectLoadSaveTypeNames(nodes),
  });
  const payload = JSON.stringify(model.vectors, null, 2);
  return [
    "# Copyright (c) Microsoft. All rights reserved.",
    "# WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "",
    "import json",
    ...(model.modelImports.length > 0
      ? [`from ${importPath} import ${model.modelImports.join(", ")}`]
      : []),
    "",
    "VECTORS = json.loads(",
    `    ${JSON.stringify(payload)}`,
    ")",
    "",
    "",
    "def test_callable_vector_payloads_roundtrip():",
    "    for index, entry in enumerate(VECTORS):",
    "        vector_id = f\"{entry['contract']}.{entry['operation']}:{entry['vector'].get('name', 'unnamed')}\"",
    "        vector = entry['vector']",
    '        expected_transcript = {"vectorId": vector_id, "target": "python", "input": vector["input"]}',
    '        observed_transcript = {"vectorId": vector_id, "target": "python", "input": json.loads(json.dumps(vector["input"]))}',
    "        metadata = vector_metadata(vector)",
    "        if metadata:",
    '            expected_transcript["metadata"] = metadata',
    '            observed_transcript["metadata"] = json.loads(json.dumps(metadata))',
    "        if 'expected' in vector:",
    '            expected_transcript["result"] = vector["expected"]',
    '            observed_transcript["result"] = json.loads(json.dumps(vector["expected"]))',
    "        if 'expectedError' in vector:",
    '            expected_transcript["error"] = vector["expectedError"]',
    '            observed_transcript["error"] = json.loads(json.dumps(vector["expectedError"]))',
    '        assert observed_transcript == expected_transcript, json.dumps({"vectorId": vector_id, "target": "python", "expectedTranscript": expected_transcript, "observedTranscript": observed_transcript}, indent=2)',
    "        assert_vector_model_roundtrips(index, entry)",
    "",
    "",
    "def vector_metadata(vector):",
    "    metadata = {",
    '        "stage": vector.get("stage"),',
    '        "provider": vector.get("provider"),',
    '        "targetApi": vector.get("targetApi"),',
    '        "portability": vector.get("portability"),',
    '        "normalization": vector.get("normalization"),',
    "    }",
    "    return {key: value for key, value in metadata.items() if value is not None}",
    "",
    "",
    ...emitPythonVectorRoundTripHelpers(model),
    "",
  ].join("\n");
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
    "from typing import Protocol",
    "from fastapi import APIRouter, Body, Cookie, Header, Path, Query",
    ...(modelImports.length > 0 ? [`from . import ${modelImports.join(", ")}`] : []),
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
  const routeArgs = [`"${operation.path}"`];
  const statusCode = firstStatusCode(operation);
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
  if (operation.responses.some((response) => response.body && isPythonModelType(response.body, modelTypes))) {
    lines.push("        return result.save()");
  } else {
    lines.push("        return result");
  }
  return lines;
}

function fastApiParameter(binding: TransportBinding): string {
  const name = toSnakeCase(binding.name);
  const type = pythonType(binding.type, binding.optional);
  switch (binding.kind) {
    case "path":
      return `${name}: ${type} = Path(..., alias=${JSON.stringify(binding.wireName)})`;
    case "query":
      return `${name}: ${type} = Query(default=${binding.optional ? "None" : "..."}, alias=${JSON.stringify(binding.wireName)})`;
    case "header":
      return `${name}: ${type} = Header(default=${binding.optional ? "None" : "..."}, alias=${JSON.stringify(binding.wireName)})`;
    case "cookie":
      return `${name}: ${type} = Cookie(default=${binding.optional ? "None" : "..."}, alias=${JSON.stringify(binding.wireName)})`;
    case "body":
      return `${name}: dict = Body(...)`;
  }
}

function emitFastApiVectorTests(
  contracts: TransportContract[],
  importPath: string,
  modelTypes: ReadonlySet<string>,
): string {
  const operations = contracts.flatMap((contract) => contract.operations);
  const vectorEntries = operations.flatMap((operation) =>
    (operation.callable.vectors ?? []).map((vector) => ({
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

function firstStatusCode(operation: TransportOperation): number | undefined {
  for (const response of operation.responses) {
    const code = response.statusCodes[0];
    if (code && /^\d+$/.test(code)) return Number(code);
  }
  return undefined;
}

function pythonType(type: string, optional = false): string {
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

function emitPythonVectorRoundTripHelpers(
  model: VectorConformanceCodeModel,
): string[] {
  const lines = ["def assert_vector_model_roundtrips(index, entry):"];
  for (const testCase of model.cases) {
    lines.push(`    if index == ${testCase.index}:`);
    const bodyStart = lines.length;
    for (const { paramName, typeName } of testCase.paramRoundTrips) {
      lines.push(`        if ${JSON.stringify(paramName)} in entry["vector"]["input"]:`)
      lines.push(`            value = entry["vector"]["input"][${JSON.stringify(paramName)}]`);
      lines.push(`            assert ${typeName}.load(value).save() == value`);
    }
    if (testCase.expectedRoundTrip) {
      lines.push('        if "expected" in entry["vector"]:');
      lines.push('            value = entry["vector"]["expected"]');
      lines.push(`            assert ${testCase.expectedRoundTrip}.load(value).save() == value`);
    }
    if (lines.length === bodyStart) {
      lines.push("        pass");
    }
  }
  return lines;
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

  await emitGeneratedFile(context, filePath, content, {
    outputRoot: outputRoot || outputDir,
    allowEmpty: options.allowEmpty,
  });
}
