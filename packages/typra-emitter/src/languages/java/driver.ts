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
import { buildBaseTestContext, TestContextOptions } from "../../testing/test-context.js";
import { emitJavaFileContent } from "./emitter.js";
import { emitJavaContext, emitJavaJson, emitJavaMaps, emitJavaSaveContext } from "./scaffolding.js";
import { emitJavaTest, emitJavaTestRunner, javaTestClassName } from "./test-emitter.js";
import { JavaExprVisitor } from "./visitor.js";
import { collectProtocolNodes, emitJavaProtocolScaffolds, shouldEmitCompileOnlyProtocolScaffolds } from "../../protocol-scaffolds.js";

const javaTestOptions: TestContextOptions = {
  renderKey: (key: string) => key,
  renderBoolean: (value: boolean) => value ? "true" : "false",
  escapeString: (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r"),
  getDelimiter: () => '"',
  scalarValues: {
    boolean: "false",
    float: "3.14",
    float32: "3.14",
    float64: "3.14",
    number: "3.14",
    int32: "3",
    int64: "3",
    integer: "3",
    string: '"example"',
  },
  typeMapper: {
    string: "String",
    boolean: "Boolean",
    int32: "Integer",
    int64: "Long",
    float32: "Float",
    float64: "Double",
    number: "Double",
  },
  renderEnumValue: (enumName, rawValue, _fieldName, isOpenEnum) => isOpenEnum ? null : ({
    value: `${enumName}.fromValue(${JSON.stringify(rawValue)})`,
    delimiter: "",
  }),
};

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

  const testClassNames: string[] = [];
  for (const n of nodes) {
    const fileDecl = lowerFile(n, registry, polymorphicTypeNames);
    const fileContent = emitJavaFileContent([fileDecl.types[0]], packageName, visitor, polymorphicTypeNames, fileDecl.enums);
    await emitJavaFile(context, `${toPascalCase(n.typeName.name)}.java`, fileContent, emitTarget["output-dir"], emitTarget["output-dir"]);

    if (emitTarget["test-dir"] && !n.isProtocol) {
      const testClass = javaTestClassName(n.typeName.name);
      testClassNames.push(testClass);
      const testContext = buildBaseTestContext(n, packageName, javaTestOptions);
      await emitJavaFile(context, `${testClass}.java`, emitJavaTest(testContext), emitTarget["test-dir"], emitTarget["test-dir"]);
    }
  }

  if (emitTarget["test-dir"] && shouldEmitCompileOnlyProtocolScaffolds(emitTarget)) {
    const scaffold = emitJavaProtocolScaffolds(collectProtocolNodes(nodes), packageName);
    if (scaffold) {
      testClassNames.push(scaffold.className);
      await emitJavaFile(context, `${scaffold.className}.java`, scaffold.source, emitTarget["test-dir"], emitTarget["test-dir"]);
    }
  }

  if (emitTarget["test-dir"] && testClassNames.length > 0) {
    await emitJavaFile(context, "TypraGeneratedTests.java", emitJavaTestRunner(packageName, testClassNames), emitTarget["test-dir"], emitTarget["test-dir"]);
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
