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
import {
  applyNamespaceGroups,
  projectNamespace,
  restoreNamespaceGroups,
} from "../../ir/namespace.js";
import {
  buildVectorConformanceCodeModel,
  VectorConformanceCodeModel,
} from "../../ir/code-model.js";
import {
  collectProtocolNodes,
  emitTypeScriptProtocolScaffolds,
  shouldEmitCompileOnlyProtocolScaffolds,
} from "../../protocol-scaffolds.js";

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
  const namespaceGroupSnapshots = applyNamespaceGroups(allTypes, {
    target: "typescript",
    semanticRoot: options?.rootNamespace,
    emitTarget,
    namespaceOutput: options?.namespaceOutput,
  });
  const nodes = filterNodes(allTypes, options);

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
          importPath,
          nodes,
        ),
        emitTarget["test-dir"],
        emitTarget["test-dir"],
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

    formatTypeScriptFiles(outputDir, testDir);
  }
  restoreNamespaceGroups(namespaceGroupSnapshots);
};

function emitTypeScriptVectorConformanceTest(
  vectors: NonNullable<GeneratorOptions["callableVectors"]>,
  importPath: string,
  nodes: TypeNode[],
): string {
  const model = buildVectorConformanceCodeModel(vectors, {
    loadSaveTypes: collectLoadSaveTypeNames(nodes),
  });
  const payload = JSON.stringify(model.vectors, null, 2);
  return [
    "// Copyright (c) Microsoft. All rights reserved.",
    "// WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "",
    ...(model.modelImports.length > 0
      ? [`import { ${model.modelImports.join(", ")} } from "${importPath}";`, ""]
      : []),
    `const vectors = ${payload} as const;`,
    "",
    'describe("callable vector conformance", () => {',
    "  for (const [index, entry] of vectors.entries()) {",
    '    const vectorName = ("name" in entry.vector ? entry.vector.name : undefined) ?? "unnamed";',
    "    const vectorId = `${entry.contract}.${entry.operation}:${vectorName}`;",
    "    it(vectorId, () => {",
    '      const expectedTranscript: Record<string, unknown> = { vectorId, target: "typescript", input: entry.vector.input };',
    '      const observedTranscript: Record<string, unknown> = { vectorId, target: "typescript", input: JSON.parse(JSON.stringify(entry.vector.input)) };',
    "      const metadata = vectorMetadata(entry.vector);",
    "      if (metadata) {",
    "        expectedTranscript.metadata = metadata;",
    "        observedTranscript.metadata = JSON.parse(JSON.stringify(metadata));",
    "      }",
    '      if ("expected" in entry.vector) {',
    "        expectedTranscript.result = entry.vector.expected;",
    "        observedTranscript.result = JSON.parse(JSON.stringify(entry.vector.expected));",
    "      }",
    '      if ("expectedError" in entry.vector) {',
    "        expectedTranscript.error = entry.vector.expectedError;",
    "        observedTranscript.error = JSON.parse(JSON.stringify(entry.vector.expectedError));",
    "      }",
    "      try {",
    "        expect(observedTranscript).toEqual(expectedTranscript);",
    "      } catch (error) {",
    "        throw new Error(`${JSON.stringify({ vectorId, target: \"typescript\", expectedTranscript, observedTranscript }, null, 2)}\\n${String(error)}`);",
    "      }",
    "      assertVectorModelRoundTrips(index, entry);",
    "    });",
    "  }",
    "});",
    "",
    "function vectorMetadata(vector: (typeof vectors)[number][\"vector\"]): Record<string, unknown> | undefined {",
    "  const metadata = Object.fromEntries([",
    '    ["stage", "stage" in vector ? vector.stage : undefined],',
    '    ["provider", "provider" in vector ? vector.provider : undefined],',
    '    ["targetApi", "targetApi" in vector ? vector.targetApi : undefined],',
    '    ["portability", "portability" in vector ? vector.portability : undefined],',
    '    ["normalization", "normalization" in vector ? vector.normalization : undefined],',
    "  ].filter(([, value]) => value !== undefined));",
    "  return Object.keys(metadata).length > 0 ? metadata : undefined;",
    "}",
    "",
    "function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {",
    "  if (typeof value !== \"object\" || value === null || Array.isArray(value)) {",
    "    throw new Error(`${label} must be an object for generated model load/save roundtrip.`);",
    "  }",
    "}",
    "",
    ...emitTypeScriptVectorRoundTripHelpers(model),
    "",
  ].join("\n");
}

function collectLoadSaveTypeNames(nodes: TypeNode[]): Set<string> {
  return new Set(
    nodes.filter((node) => !node.isProtocol).map((node) => node.typeName.name),
  );
}

function emitTypeScriptVectorRoundTripHelpers(
  model: VectorConformanceCodeModel,
): string[] {
  const lines = [
    "function assertVectorModelRoundTrips(index: number, entry: (typeof vectors)[number]): void {",
  ];
  for (const testCase of model.cases) {
    lines.push(`  if (index === ${testCase.index}) {`);
    for (const { paramName, typeName } of testCase.paramRoundTrips) {
      lines.push(`    if (${JSON.stringify(paramName)} in entry.vector.input) {`);
      lines.push(`      const value = entry.vector.input[${JSON.stringify(paramName)} as keyof typeof entry.vector.input] as unknown;`);
      lines.push(`      assertRecord(value, ${JSON.stringify(paramName)});`);
      lines.push(`      expect(${typeName}.load(value).save()).toEqual(value);`);
      lines.push("    }");
    }
    if (testCase.expectedRoundTrip) {
      lines.push("    if (\"expected\" in entry.vector) {");
      lines.push("      const value = entry.vector.expected as unknown;");
      lines.push(`      assertRecord(value, "expected");`);
      lines.push(`      expect(${testCase.expectedRoundTrip}.load(value).save()).toEqual(value);`);
      lines.push("    }");
    }
    lines.push("  }");
  }
  lines.push("}");
  return lines;
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

  await emitGeneratedFile(context, filePath, content, {
    outputRoot: outputRoot || outputDir,
  });
}
