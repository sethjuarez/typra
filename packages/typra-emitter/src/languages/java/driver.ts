import { execFileSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { EmitContext, resolvePath } from "@typespec/compiler";
import { emitGeneratedFile } from "../../cleanup/generated-file.js";
import { GeneratorOptions, filterNodes } from "../../emitter.js";
import { enumerateTypes, TypeNode } from "../../ir/ast.js";
import { TypeRegistry } from "../../ir/expansion.js";
import { collectPolymorphicTypeNames, lowerFile } from "../../ir/lower.js";
import { toPascalCase } from "../../ir/visitor.js";
import { EmitTarget, TypraEmitterOptions } from "../../lib.js";
import { emitJavaFileContent } from "./emitter.js";
import { emitJavaContext, emitJavaJson, emitJavaMaps, emitJavaSaveContext } from "./scaffolding.js";
import { JavaExprVisitor } from "./visitor.js";

export const generateJava = async (
  context: EmitContext<TypraEmitterOptions>,
  node: TypeNode,
  emitTarget: EmitTarget,
  options?: GeneratorOptions,
): Promise<void> => {
  const allTypes = Array.from(enumerateTypes(node));
  const nodes = filterNodes(allTypes, options);
  const registry = TypeRegistry.fromTypeGraph(allTypes);
  const visitor = new JavaExprVisitor(registry);
  const packageName = javaPackageName(emitTarget.namespace ?? emitTarget["package-name"] ?? node.typeName.namespace);
  const polymorphicTypeNames = collectPolymorphicTypeNames(node, registry);

  await emitJavaFile(context, "LoadContext.java", emitJavaContext(packageName), emitTarget["output-dir"], emitTarget["output-dir"]);
  await emitJavaFile(context, "SaveContext.java", emitJavaSaveContext(packageName), emitTarget["output-dir"], emitTarget["output-dir"]);
  await emitJavaFile(context, "TypraMaps.java", emitJavaMaps(packageName), emitTarget["output-dir"], emitTarget["output-dir"]);
  await emitJavaFile(context, "TypraJson.java", emitJavaJson(packageName), emitTarget["output-dir"], emitTarget["output-dir"]);

  for (const n of nodes) {
    const fileDecl = lowerFile(n, registry, polymorphicTypeNames);
    const fileContent = emitJavaFileContent([fileDecl.types[0]], packageName, visitor, polymorphicTypeNames, fileDecl.enums);
    await emitJavaFile(context, `${toPascalCase(n.typeName.name)}.java`, fileContent, emitTarget["output-dir"], emitTarget["output-dir"]);
  }

  if (emitTarget.format !== false) {
    formatJavaFiles(resolve(process.cwd(), emitTarget["output-dir"] ?? context.emitterOutputDir));
  }
};

export function javaPackageName(namespace: string): string {
  return namespace.toLowerCase().replace(/[^a-z0-9.]+/g, ".").replace(/^\.+|\.+$/g, "") || "typra";
}

async function emitJavaFile(
  context: EmitContext<TypraEmitterOptions>,
  filename: string,
  content: string,
  outputDir?: string,
  outputRoot?: string,
): Promise<void> {
  const filePath = resolvePath(outputDir || `${context.emitterOutputDir}/java`, filename);
  await emitGeneratedFile(context, filePath, content, { outputRoot: outputRoot || outputDir });
}

function formatJavaFiles(outputDir: string): void {
  if (!existsSync(outputDir)) return;
  const javaFiles = readdirSync(outputDir)
    .filter(file => file.endsWith(".java"))
    .map(file => resolve(outputDir, file));
  if (javaFiles.length === 0) return;

  try {
    execFileSync("google-java-format", ["--replace", ...javaFiles], {
      stdio: "pipe",
      encoding: "utf-8",
    });
  } catch {
    // google-java-format is optional; javac validation enforces correctness.
  }
}
