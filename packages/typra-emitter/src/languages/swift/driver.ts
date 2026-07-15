import { EmitContext, resolvePath } from "@typespec/compiler";
import { execFileSync } from "child_process";
import { relative, resolve } from "path";
import { EmitTarget, TypraEmitterOptions } from "../../lib.js";
import { BaseTestContext, enumerateTypes, TypeNode } from "../../ir/ast.js";
import { GeneratorOptions, filterNodes } from "../../emitter.js";
import { TypeRegistry } from "../../ir/expansion.js";
import { lowerFile, collectPolymorphicTypeNames } from "../../ir/lower.js";
import { buildBaseTestContext, swiftTestOptions } from "../../testing/test-context.js";
import { collectProtocolNodes, shouldEmitCompileOnlyProtocolScaffolds } from "../../protocol-scaffolds.js";
import { emitGeneratedFile } from "../../cleanup/generated-file.js";
import { emitSwiftFile } from "./emitter.js";
import { SwiftExprVisitor } from "./visitor.js";
import { emitSwiftConformanceTest, emitSwiftTests } from "./test-emitter.js";
import { emitSwiftPackage, emitSwiftProtocolScaffolds, emitSwiftRuntime, swiftModuleName } from "./scaffolding.js";
import { swiftFileName } from "./identifiers.js";

export const swiftTypeMapper: Record<string, string> = {
  "string": "String",
  "number": "Double",
  "array": "[Any]",
  "object": "[String: Any]",
  "boolean": "Bool",
  "int64": "Int64",
  "int32": "Int32",
  "float64": "Double",
  "float32": "Float",
  "integer": "Int",
  "float": "Double",
  "numeric": "Double",
  "any": "Any",
  "dictionary": "[String: Any]",
  "unknown": "Any",
};

export const generateSwift = async (
  context: EmitContext<TypraEmitterOptions>,
  node: TypeNode,
  emitTarget: EmitTarget,
  options?: GeneratorOptions
): Promise<void> => {
  const allTypes = Array.from(enumerateTypes(node));
  const nodes = filterNodes(allTypes, options);
  const registry = TypeRegistry.fromTypeGraph(allTypes);
  const visitor = new SwiftExprVisitor(registry);
  const moduleName = swiftModuleName(emitTarget["package-name"] || node.typeName.namespace);

  const polymorphicTypeNames = new Set<string>();
  for (const n of nodes) {
    for (const name of collectPolymorphicTypeNames(n, registry)) {
      polymorphicTypeNames.add(name);
    }
  }

  const outputDir = emitTarget["output-dir"] || `${context.emitterOutputDir}/swift`;
  const sourceRoot = `${outputDir}/Sources/${moduleName}`;
  const testRoot = emitTarget["test-dir"];
  const packageTestPath = testRoot ? toSwiftPackagePath(relative(outputDir, testRoot)) : undefined;

  await emitSwiftGeneratedFile(context, "Package.swift", emitSwiftPackage(moduleName, packageTestPath), outputDir, outputDir, { marker: false });
  await emitSwiftGeneratedFile(context, "TypraRuntime.swift", emitSwiftRuntime(moduleName), sourceRoot, outputDir);

  for (const n of nodes) {
    if (!n.base) {
      const group = n.group || "";
      const fileDecl = lowerFile(n, registry, polymorphicTypeNames);
      const content = emitSwiftFile(fileDecl, visitor, polymorphicTypeNames);
      const outDir = group ? `${sourceRoot}/${group}` : sourceRoot;
      await emitSwiftGeneratedFile(context, swiftFileName(n.typeName.name), content, outDir, outputDir);
    }

    if (testRoot && !n.base && !n.isProtocol) {
      const testContext = { ...buildTestContext(n), moduleName };
      const group = n.group || "";
      const outDir = group ? `${testRoot}/${group}` : testRoot;
      await emitSwiftGeneratedFile(context, `${n.typeName.name}Tests.swift`, emitSwiftTests(testContext), outDir, outputDir);
    }
  }

  if (testRoot) {
    await emitSwiftGeneratedFile(context, "ConformanceTests.swift", emitSwiftConformanceTest(moduleName), testRoot, outputDir);
  }

  if (testRoot && shouldEmitCompileOnlyProtocolScaffolds(emitTarget)) {
    const scaffoldContent = emitSwiftProtocolScaffolds(collectProtocolNodes(nodes), moduleName);
    if (scaffoldContent) {
      await emitSwiftGeneratedFile(context, "ProtocolScaffoldsTests.swift", scaffoldContent, testRoot, outputDir);
    }
  }

  if (emitTarget.format !== false) {
    const resolvedOutput = resolve(process.cwd(), outputDir);
    formatSwiftFiles(resolvedOutput);
  }
};

function buildTestContext(node: TypeNode): BaseTestContext {
  return buildBaseTestContext(node, undefined, swiftTestOptions);
}

function formatSwiftFiles(outputDir: string): void {
  try {
    execFileSync("swift-format", ["format", "--in-place", "--recursive", outputDir], {
      stdio: "pipe",
      encoding: "utf-8",
    });
  } catch {
    // swift-format is optional; deterministic emitter formatting is the fallback.
  }
}

function toSwiftPackagePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

async function emitSwiftGeneratedFile(
  context: EmitContext<TypraEmitterOptions>,
  filename: string,
  content: string,
  outputDir: string,
  outputRoot: string,
  options: { marker?: boolean } = {},
): Promise<void> {
  const filePath = resolvePath(outputDir, filename);
  await emitGeneratedFile(context, filePath, content, { outputRoot, marker: options.marker });
}
