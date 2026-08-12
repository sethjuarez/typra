import { EmitContext, resolvePath } from "@typespec/compiler";
import { execFileSync } from "child_process";
import { relative, resolve } from "path";
import { EmitTarget, TypraEmitterOptions } from "../../lib.js";
import { BaseTestContext, enumerateTypes, TypeNode } from "../../ir/ast.js";
import { GeneratorOptions, filterNodes } from "../../emitter.js";
import { TypeRegistry } from "../../ir/expansion.js";
import { lowerFile, collectPolymorphicTypeNames } from "../../ir/lower.js";
import {
  buildBaseTestContext,
  swiftTestOptions,
} from "../../testing/test-context.js";
import {
  collectProtocolNodes,
  shouldEmitCompileOnlyProtocolScaffolds,
} from "../../protocol-scaffolds.js";
import { emitGeneratedFile } from "../../cleanup/generated-file.js";
import {
  applyNamespaceGroups,
  projectNamespace,
  restoreNamespaceGroups,
} from "../../ir/namespace.js";
import { emitSwiftFile } from "./emitter.js";
import { SwiftExprVisitor } from "./visitor.js";
import { emitSwiftConformanceTest, emitSwiftTests } from "./test-emitter.js";
import {
  emitSwiftPackage,
  emitSwiftProtocolScaffolds,
  emitSwiftRuntime,
} from "./scaffolding.js";
import { swiftFileName } from "./identifiers.js";
import { SWIFT_TYPE_MAP } from "./types.js";

export const swiftTypeMapper: Record<string, string> = SWIFT_TYPE_MAP;

type SwiftNativeSerialization = "none" | "codable";

export const generateSwift = async (
  context: EmitContext<TypraEmitterOptions>,
  node: TypeNode,
  emitTarget: EmitTarget,
  options?: GeneratorOptions,
): Promise<void> => {
  const allTypes = Array.from(enumerateTypes(node));
  const namespaceGroupSnapshots = applyNamespaceGroups(allTypes, {
    target: "swift",
    semanticRoot: options?.rootNamespace,
    emitTarget,
    namespaceOutput: options?.namespaceOutput,
  });
  const nodes = filterNodes(allTypes, options);
  const registry = TypeRegistry.fromTypeGraph(allTypes);
  const visitor = new SwiftExprVisitor(registry);
  const moduleName = projectNamespace({
    target: "swift",
    sourceNamespace: node.typeName.namespace,
    semanticRoot: options?.rootNamespace,
    emitTarget,
  }).moduleName!;
  const nativeSerialization = swiftNativeSerialization(emitTarget);

  const polymorphicTypeNames = new Set<string>();
  for (const n of nodes) {
    for (const name of collectPolymorphicTypeNames(n, registry)) {
      polymorphicTypeNames.add(name);
    }
  }

  const outputDir =
    emitTarget["output-dir"] || `${context.emitterOutputDir}/swift`;
  const sourceRoot = `${outputDir}/Sources/${moduleName}`;
  const testRoot = emitTarget["test-dir"];
  const packageTestPath = testRoot
    ? toSwiftPackagePath(relative(outputDir, testRoot))
    : undefined;
  const rootNodes = nodes.filter((n) => !n.base);
  const fileDecls = new Map(
    rootNodes.map((n) => [
      `${n.typeName.namespace}.${n.typeName.name}`,
      lowerFile(n, registry, polymorphicTypeNames),
    ]),
  );
  const declarationUniverse = Array.from(fileDecls.values()).flatMap(
    (file) => file.types,
  );
  await emitSwiftGeneratedFile(
    context,
    "Package.swift",
    emitSwiftPackage(moduleName, packageTestPath),
    outputDir,
    outputDir,
    { marker: false },
  );
  await emitSwiftGeneratedFile(
    context,
    "TypraRuntime.swift",
    emitSwiftRuntime(moduleName, nativeSerialization),
    sourceRoot,
    outputDir,
  );

  for (const n of nodes) {
    if (!n.base) {
      const group = n.group || "";
      const fileDecl = fileDecls.get(
        `${n.typeName.namespace}.${n.typeName.name}`,
      )!;
      const content = emitSwiftFile(
        fileDecl,
        visitor,
        polymorphicTypeNames,
        declarationUniverse,
        nativeSerialization,
      );
      const outDir = group ? `${sourceRoot}/${group}` : sourceRoot;
      await emitSwiftGeneratedFile(
        context,
        swiftFileName(n.typeName.name),
        content,
        outDir,
        outputDir,
      );
    }

    if (testRoot && !n.base && !n.isProtocol) {
      const testContext = { ...buildTestContext(n, registry), moduleName };
      const group = n.group || "";
      const outDir = group ? `${testRoot}/${group}` : testRoot;
      await emitSwiftGeneratedFile(
        context,
        `${n.typeName.name}Tests.swift`,
        emitSwiftTests({
          ...testContext,
          nativeSerialization,
        }),
        outDir,
        outputDir,
      );
    }
  }

  if (testRoot) {
    await emitSwiftGeneratedFile(
      context,
      "ConformanceTests.swift",
      emitSwiftConformanceTest(moduleName),
      testRoot,
      outputDir,
    );
  }

  if (testRoot && shouldEmitCompileOnlyProtocolScaffolds(emitTarget)) {
    const scaffoldContent = emitSwiftProtocolScaffolds(
      collectProtocolNodes(nodes),
      moduleName,
    );
    if (scaffoldContent) {
      await emitSwiftGeneratedFile(
        context,
        "ProtocolScaffoldsTests.swift",
        scaffoldContent,
        testRoot,
        outputDir,
      );
    }
  }

  if (emitTarget.format !== false) {
    const resolvedOutput = resolve(process.cwd(), outputDir);
    formatSwiftFiles(resolvedOutput);
  }
  restoreNamespaceGroups(namespaceGroupSnapshots);
};

function swiftNativeSerialization(
  emitTarget: EmitTarget,
): SwiftNativeSerialization {
  return emitTarget["native-serialization"] === "codable" ? "codable" : "none";
}

function buildTestContext(
  node: TypeNode,
  registry: TypeRegistry,
): BaseTestContext {
  return buildBaseTestContext(node, undefined, swiftTestOptions, (name) =>
    registry.get(name),
  );
}

function formatSwiftFiles(outputDir: string): void {
  try {
    execFileSync(
      "swift-format",
      ["format", "--in-place", "--recursive", outputDir],
      {
        stdio: "pipe",
        encoding: "utf-8",
      },
    );
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
  await emitGeneratedFile(context, filePath, content, {
    outputRoot,
    marker: options.marker,
  });
}
