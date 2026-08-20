import { EmitContext, resolvePath } from "@typespec/compiler";
import { execFileSync } from "child_process";
import { resolve } from "path";
import { EmitTarget, TypraEmitterOptions } from "../../lib.js";
import { BaseTestContext, enumerateTypes, TypeNode } from "../../ir/ast.js";
import { GeneratorOptions, filterNodes } from "../../emitter.js";
import {
  resolveCustomFormatters,
  runCustomFormatters,
} from "../formatter-runner.js";

import {
  buildBaseTestContext,
  goTestOptions,
} from "../../testing/test-context.js";
import { toSnakeCase } from "../../ir/utilities.js";
import { TypeRegistry } from "../../ir/expansion.js";
import { GoExprVisitor } from "./visitor.js";
import {
  lowerFile,
  lowerType,
  collectPolymorphicTypeNames,
} from "../../ir/lower.js";
import { emitGoFileContent } from "./emitter.js";
import { emitGoContext } from "./scaffolding.js";
import { emitGoTest } from "./test-emitter.js";
import { buildGoFieldNames } from "./identifiers.js";
import { emitGeneratedFile } from "../../cleanup/generated-file.js";
import { projectNamespace } from "../../ir/namespace.js";
import { buildVectorConformanceCodeModel } from "../../ir/code-model.js";
import {
  collectProtocolNodes,
  emitGoProtocolScaffolds,
  shouldEmitCompileOnlyProtocolScaffolds,
} from "../../protocol-scaffolds.js";

/**
 * Type mapping from TypeSpec scalar types to Go types.
 */
export const goTypeMapper: Record<string, string> = {
  string: "string",
  number: "float64",
  array: "[]",
  object: "map[string]interface{}",
  boolean: "bool",
  int64: "int64",
  int32: "int32",
  float64: "float64",
  float32: "float32",
  integer: "int",
  float: "float64",
  numeric: "float64",
  any: "interface{}",
  dictionary: "map[string]interface{}",
};

/**
 * Main entry point for Go code generation.
 */
export const generateGo = async (
  context: EmitContext<TypraEmitterOptions>,
  node: TypeNode,
  emitTarget: EmitTarget,
  options?: GeneratorOptions,
): Promise<void> => {
  const allTypes = Array.from(enumerateTypes(node));
  const nodes = filterNodes(allTypes, options);

  // Build the expression IR infrastructure
  const registry = TypeRegistry.fromTypeGraph(allTypes);
  const visitor = new GoExprVisitor(registry);

  const namespaceProjection = projectNamespace({
    target: "go",
    sourceNamespace: node.typeName.namespace,
    semanticRoot: options?.rootNamespace,
    emitTarget,
  });
  const packageName = namespaceProjection.packageName!;

  // Collect all polymorphic type names across all nodes
  const polymorphicTypeNames = new Set<string>();
  const scalarCoercibleTypeNames = new Set<string>();
  for (const n of nodes) {
    const polyTypes = n.retrievePolymorphicTypes();
    if (polyTypes) {
      polymorphicTypeNames.add(n.typeName.name);
    }
    if (n.coercions.length > 0) {
      scalarCoercibleTypeNames.add(n.typeName.name);
    }
  }
  const declarationUniverse = nodes.map((n) =>
    lowerType(n, registry, polymorphicTypeNames),
  );

  // Emit context file (LoadContext/SaveContext utilities)
  const contextContent = emitGoContext({
    header: "Typra Context",
    packageName,
  });
  await emitGoFile(
    context,
    "context.go",
    contextContent,
    emitTarget["output-dir"],
  );

  // Emit each base type and its children as a single file (Go stays flat — no subfolders)
  for (const n of nodes) {
    // Skip child types - they're rendered with their parent
    if (!n.base) {
      const fileDecl = lowerFile(n, registry, polymorphicTypeNames);
      // Go stays flat: pass group as a header comment only, no subfolder emission
      const fileContent = emitGoFileContent(
        fileDecl.types,
        packageName,
        visitor,
        polymorphicTypeNames,
        fileDecl.enums,
        n.group || "",
        scalarCoercibleTypeNames,
        declarationUniverse,
      );
      const fileName = toSnakeCase(n.typeName.name) + ".go";
      await emitGoFile(
        context,
        fileName,
        fileContent,
        emitTarget["output-dir"],
        emitTarget["output-dir"],
      );
    }

    // Emit test file for each type (skip protocols — they have no data to test)
    if (emitTarget["test-dir"] && !n.isProtocol) {
      const importPath = emitTarget["import-path"] || packageName;
      const fieldNames = buildGoFieldNames(
        collectInheritedPropertyNames(n, registry),
      );
      const testContext = {
        ...buildTestContext(n, packageName, registry),
        importPath,
        fieldNames,
      };
      const testContent = emitGoTest(testContext);
      const testFileName = toSnakeCase(n.typeName.name) + "_test.go";
      await emitGoFile(
        context,
        testFileName,
        testContent,
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
    }
  }

  if (
    emitTarget["test-dir"] &&
    shouldEmitCompileOnlyProtocolScaffolds(emitTarget)
  ) {
    const importPath = emitTarget["import-path"] || packageName;
    const scaffoldContent = emitGoProtocolScaffolds(
      collectProtocolNodes(nodes),
      packageName,
      importPath,
    );
    await emitGoFile(
      context,
      "protocol_scaffolds_test.go",
      scaffoldContent,
      emitTarget["test-dir"],
      emitTarget["test-dir"],
    );
  }

  if (
    emitTarget["test-dir"] &&
    (options?.callableVectors?.vectors.length ?? 0) > 0
  ) {
    await emitGoFile(
      context,
      "vector_conformance_test.go",
      emitGoVectorConformanceTest(
        options!.callableVectors!,
        packageName,
        emitTarget["vector-adapter-path"] ?? "vectoradapters",
      ),
      emitTarget["test-dir"],
      emitTarget["test-dir"],
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
      formatGoFiles(outputDir, testDir);
    }
  }
};

/**
 * Format Go files using gofmt and goimports.
 */
function formatGoFiles(outputDir: string, testDir?: string): void {
  const dirs = [outputDir, ...(testDir ? [testDir] : [])];

  for (const dir of dirs) {
    // Run gofmt — use execFileSync to avoid shell injection
    try {
      execFileSync("gofmt", ["-w", dir], {
        stdio: "pipe",
        encoding: "utf-8",
      });
    } catch (error) {
      console.warn(
        `Warning: gofmt formatting failed for ${dir}. You may need to install Go.`,
      );
    }

    // Run goimports if available
    try {
      execFileSync("goimports", ["-w", dir], {
        stdio: "pipe",
        encoding: "utf-8",
      });
    } catch (error) {
      // goimports is optional, don't warn if not available
    }
  }
}

/**
 * Build context for rendering a test file.
 */
function buildTestContext(
  node: TypeNode,
  packageName: string,
  registry: TypeRegistry,
): BaseTestContext {
  return buildBaseTestContext(node, packageName, goTestOptions, (name) =>
    registry.get(name),
  );
}

function collectInheritedPropertyNames(
  node: TypeNode,
  registry: TypeRegistry,
): string[] {
  const chain: TypeNode[] = [];
  const visited = new Set<string>();
  let current: TypeNode | undefined = node;
  while (current && !visited.has(current.typeName.name)) {
    visited.add(current.typeName.name);
    chain.unshift(current);
    current = current.base ? registry.get(current.base.name) : undefined;
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const type of chain) {
    for (const prop of type.properties) {
      if (!seen.has(prop.name)) {
        names.push(prop.name);
        seen.add(prop.name);
      }
    }
  }
  return names;
}

/**
 * Write generated Go content to file.
 */
async function emitGoFile(
  context: EmitContext<TypraEmitterOptions>,
  filename: string,
  content: string,
  outputDir?: string,
  outputRoot?: string,
): Promise<void> {
  outputDir = outputDir || `${context.emitterOutputDir}/go`;
  const filePath = resolvePath(outputDir, filename);

  await emitGeneratedFile(context, filePath, content, {
    outputRoot: outputRoot || outputDir,
  });
}

/**
 * Build a Go test-function identifier for a vector. Must be a unique,
 * exported `TestXxx(t *testing.T)` name so `go test` discovers it.
 */
function goVectorSlug(
  index: number,
  entry: { contract: string; operation: string; vector: { name?: string } },
): string {
  const name = entry.vector.name ?? "unnamed";
  const raw = `${entry.contract} ${entry.operation} ${name}`;
  const pascal = raw
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  return `TestVector${index}${pascal || "Unnamed"}`;
}

/**
 * Emit the Go closed-loop `@vector` behavioral conformance suite. Each vector is
 * replayed through a runtime-authored adapter resolved from the package named by
 * the target's `vector-adapter-path` option. A vector with no adapter and no
 * explicit waiver is a hard failure — this suite never skips silently.
 */
function emitGoVectorConformanceTest(
  vectors: NonNullable<GeneratorOptions["callableVectors"]>,
  packageName: string,
  adapterImportPath: string,
): string {
  const model = buildVectorConformanceCodeModel(vectors);
  const payload = JSON.stringify(model.vectors, null, 2);
  // JSON string escapes are a subset of Go interpreted-string-literal escapes,
  // so JSON.stringify yields a valid Go double-quoted literal — except a raw
  // U+FEFF (BOM), which Go rejects mid-source, so escape it explicitly.
  const payloadLiteral = JSON.stringify(payload).replace(/\uFEFF/g, "\\ufeff");

  const lines: string[] = [
    "// Copyright (c) Microsoft. All rights reserved.",
    "// WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "//",
    "// Enforced @vector behavioral conformance. Each vector is replayed through a",
    "// runtime-authored adapter resolved from the package referenced by the",
    "// target's 'vector-adapter-path' option. A vector with no adapter and no",
    "// explicit waiver is a hard failure — this suite never skips silently.",
    "// See docs: reference/vector-conformance.",
    "",
    `package ${packageName}_test`,
    "",
    "import (",
    '\t"encoding/json"',
    '\t"os"',
    '\t"path/filepath"',
    '\t"runtime"',
    '\t"testing"',
    "",
    `\tvectoradapters ${JSON.stringify(adapterImportPath)}`,
    ")",
    "",
    `var vectorConformancePayload = []byte(${payloadLiteral})`,
    "",
    "// vcCanonical round-trips a value through generic JSON so map keys sort",
    "// regardless of whether the adapter returned a struct or a map.",
    "func vcCanonical(t *testing.T, value any) string {",
    "\tt.Helper()",
    "\traw, err := json.Marshal(value)",
    "\tif err != nil {",
    '\t\tt.Fatalf("failed to marshal value: %v", err)',
    "\t}",
    "\tvar normalized any",
    "\tif err := json.Unmarshal(raw, &normalized); err != nil {",
    '\t\tt.Fatalf("failed to normalize value: %v", err)',
    "\t}",
    "\tout, err := json.Marshal(normalized)",
    "\tif err != nil {",
    '\t\tt.Fatalf("failed to re-marshal value: %v", err)',
    "\t}",
    "\treturn string(out)",
    "}",
    "",
    "func vcBaseDir() string {",
    "\t_, file, _, ok := runtime.Caller(0)",
    "\tif !ok {",
    '\t\treturn "."',
    "\t}",
    "\treturn filepath.Dir(file)",
    "}",
    "",
    "func vcResolveRefs(t *testing.T, value any, dir string) any {",
    "\tswitch typed := value.(type) {",
    "\tcase []any:",
    "\t\tout := make([]any, len(typed))",
    "\t\tfor i, item := range typed {",
    "\t\t\tout[i] = vcResolveRefs(t, item, dir)",
    "\t\t}",
    "\t\treturn out",
    "\tcase map[string]any:",
    "\t\tif len(typed) == 1 {",
    "\t\t\tfor key, raw := range typed {",
    "\t\t\t\tstr, isStr := raw.(string)",
    '\t\t\t\tif isStr && key == "$env" {',
    "\t\t\t\t\treturn os.Getenv(str)",
    "\t\t\t\t}",
    '\t\t\t\tif isStr && key == "$file" {',
    "\t\t\t\t\tdata, err := os.ReadFile(filepath.Join(dir, str))",
    "\t\t\t\t\tif err != nil {",
    '\t\t\t\t\t\tt.Fatalf("failed to read $file %q: %v", str, err)',
    "\t\t\t\t\t}",
    "\t\t\t\t\treturn string(data)",
    "\t\t\t\t}",
    '\t\t\t\tif isStr && key == "$json" {',
    "\t\t\t\t\tdata, err := os.ReadFile(filepath.Join(dir, str))",
    "\t\t\t\t\tif err != nil {",
    '\t\t\t\t\t\tt.Fatalf("failed to read $json %q: %v", str, err)',
    "\t\t\t\t\t}",
    "\t\t\t\t\tvar parsed any",
    "\t\t\t\t\tif err := json.Unmarshal(data, &parsed); err != nil {",
    '\t\t\t\t\t\tt.Fatalf("failed to parse $json %q: %v", str, err)',
    "\t\t\t\t\t}",
    "\t\t\t\t\treturn parsed",
    "\t\t\t\t}",
    "\t\t\t}",
    "\t\t}",
    "\t\tout := make(map[string]any, len(typed))",
    "\t\tfor key, item := range typed {",
    "\t\t\tout[key] = vcResolveRefs(t, item, dir)",
    "\t\t}",
    "\t\treturn out",
    "\tdefault:",
    "\t\treturn value",
    "\t}",
    "}",
    "",
    "func vcRunVector(t *testing.T, index int) {",
    "\tvar vectors []map[string]any",
    "\tif err := json.Unmarshal(vectorConformancePayload, &vectors); err != nil {",
    '\t\tt.Fatalf("failed to decode embedded vectors: %v", err)',
    "\t}",
    "\tentry := vectors[index]",
    '\tcontract, _ := entry["contract"].(string)',
    '\toperation, _ := entry["operation"].(string)',
    '\toperationKey := contract + "." + operation',
    '\tvector, _ := entry["vector"].(map[string]any)',
    '\tvectorName := "unnamed"',
    '\tif name, ok := vector["name"].(string); ok {',
    "\t\tvectorName = name",
    "\t}",
    '\tvectorID := operationKey + ":" + vectorName',
    "",
    "\tadapter, ok := vectoradapters.VectorAdapters[operationKey]",
    "\tif !ok {",
    "\t\tadapter, ok = vectoradapters.VectorAdapters[operation]",
    "\t}",
    "\tif !ok {",
    "\t\twaiver, hasWaiver := vectoradapters.VectorWaivers[operationKey]",
    "\t\tif !hasWaiver {",
    "\t\t\twaiver, hasWaiver = vectoradapters.VectorWaivers[operation]",
    "\t\t}",
    '\t\tif hasWaiver && waiver != "" {',
    '\t\t\tt.Skipf("SKIP %s (waived: %s)", vectorID, waiver)',
    "\t\t\treturn",
    "\t\t}",
    '\t\tt.Fatalf("No vector adapter registered for %s. Register "+',
    '\t\t\t"VectorAdapters[%q] in the package referenced by \'vector-adapter-path\', "+',
    '\t\t\t"or add an explicit waiver. @vector conformance never skips silently.",',
    "\t\t\toperationKey, operationKey)",
    "\t\treturn",
    "\t}",
    "",
    "\tbaseDir := vcBaseDir()",
    '\tprovider, _ := vector["provider"].(string)',
    '\ttargetAPI, _ := vector["targetApi"].(string)',
    "\tctx := vectoradapters.Context{",
    "\t\tContract:  contract,",
    "\t\tOperation: operation,",
    "\t\tVector:    vector,",
    "\t\tProvider:  provider,",
    "\t\tTargetAPI: targetAPI,",
    "\t\tDoubles:   vectoradapters.VectorDoubles,",
    "\t\tBaseDir:   baseDir,",
    "\t}",
    '\tinput := vcResolveRefs(t, vector["input"], baseDir)',
    "\tnormalize := adapter.Normalize",
    "\tif normalize == nil {",
    "\t\tnormalize = func(value any, _ vectoradapters.Context) any { return value }",
    "\t}",
    "",
    '\tif _, isError := vector["expectedError"]; isError {',
    "\t\t_, err := adapter.Invoke(input, ctx)",
    "\t\tif err == nil {",
    '\t\t\tt.Fatalf("%s: expected the adapter to signal an error, but it returned a value.", vectorID)',
    "\t\t\treturn",
    "\t\t}",
    "\t\tvar observed any",
    "\t\tif carrier, ok := err.(interface{ TypraVector() any }); ok {",
    "\t\t\tobserved = carrier.TypraVector()",
    "\t\t} else {",
    '\t\t\tobserved = map[string]any{"message": err.Error()}',
    "\t\t}",
    "\t\tgot := vcCanonical(t, normalize(observed, ctx))",
    '\t\twant := vcCanonical(t, vector["expectedError"])',
    "\t\tif got != want {",
    '\t\t\tt.Fatalf("%s error mismatch\\n want %s\\n got  %s", vectorID, want, got)',
    "\t\t}",
    "\t\treturn",
    "\t}",
    "",
    "\tobserved, err := adapter.Invoke(input, ctx)",
    "\tif err != nil {",
    '\t\tt.Fatalf("%s: adapter returned an unexpected error: %v", vectorID, err)',
    "\t\treturn",
    "\t}",
    "\tgot := vcCanonical(t, normalize(observed, ctx))",
    '\twant := vcCanonical(t, vector["expected"])',
    "\tif got != want {",
    '\t\tt.Fatalf("%s mismatch\\n want %s\\n got  %s", vectorID, want, got)',
    "\t}",
    "}",
    "",
  ];

  model.vectors.forEach((entry, index) => {
    lines.push(
      `func ${goVectorSlug(index, entry)}(t *testing.T) { vcRunVector(t, ${index}) }`,
    );
  });
  lines.push("");
  return lines.join("\n");
}
