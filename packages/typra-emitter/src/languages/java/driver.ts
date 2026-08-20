import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { emitFile, EmitContext, resolvePath } from "@typespec/compiler";
import { emitGeneratedFile } from "../../cleanup/generated-file.js";
import { warnFormatterUnavailable } from "../formatter-warning.js";
import {
  resolveCustomFormatters,
  runCustomFormatters,
} from "../formatter-runner.js";
import { GeneratorOptions, filterNodes } from "../../emitter.js";
import { enumerateTypes, TypeNode } from "../../ir/ast.js";
import { TypeRegistry } from "../../ir/expansion.js";
import { collectPolymorphicTypeNames, lowerFile } from "../../ir/lower.js";
import { EmitTarget, TypraEmitterOptions } from "../../lib.js";
import { projectNamespace } from "../../ir/namespace.js";
import {
  buildBaseTestContext,
  TestContextOptions,
} from "../../testing/test-context.js";
import {
  emitJavaEnum,
  emitJavaFileContent,
  emitJavaMethodHelper,
  emitJavaUnknownCarrier,
  ensureJavaEditableSeamMarker,
} from "./emitter.js";
import {
  emitJavaContext,
  emitJavaJson,
  emitJavaMaps,
  emitJavaSaveContext,
  emitJavaYaml,
} from "./scaffolding.js";
import {
  emitJavaTest,
  emitJavaTestRunner,
  javaTestClassName,
} from "./test-emitter.js";
import { JavaExprVisitor } from "./visitor.js";
import {
  collectProtocolNodes,
  emitJavaProtocolScaffolds,
  shouldEmitCompileOnlyProtocolScaffolds,
} from "../../protocol-scaffolds.js";
import { javaEnumTypeName, javaTypeName } from "./identifiers.js";
import { buildVectorConformanceCodeModel } from "../../ir/code-model.js";

export const javaTestOptions: TestContextOptions = {
  renderKey: (key: string) => key,
  renderBoolean: (value: boolean) => (value ? "true" : "false"),
  escapeString: (value: string) => value,
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
  renderEnumValue: (enumName, rawValue, _fieldName, isOpenEnum) =>
    isOpenEnum
      ? null
      : {
          value: `${javaEnumTypeName(enumName)}.fromValue(${JSON.stringify(rawValue)})`,
          delimiter: "",
        },
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
  const packageName = projectNamespace({
    target: "java",
    sourceNamespace: node.typeName.namespace,
    semanticRoot: options?.rootNamespace,
    emitTarget,
  }).packageName!;
  const polymorphicTypeNames = collectPolymorphicTypeNames(node, registry);
  const fileDecls = nodes.map((n) =>
    lowerFile(n, registry, polymorphicTypeNames),
  );
  const allTypeDecls = fileDecls.flatMap((fileDecl) => fileDecl.types);

  await emitJavaFile(
    context,
    "LoadContext.java",
    emitJavaContext(packageName),
    emitTarget["output-dir"],
    emitTarget["output-dir"],
  );
  await emitJavaFile(
    context,
    "SaveContext.java",
    emitJavaSaveContext(packageName),
    emitTarget["output-dir"],
    emitTarget["output-dir"],
  );
  await emitJavaFile(
    context,
    "TypraMaps.java",
    emitJavaMaps(packageName),
    emitTarget["output-dir"],
    emitTarget["output-dir"],
  );
  await emitJavaFile(
    context,
    "TypraJson.java",
    emitJavaJson(packageName),
    emitTarget["output-dir"],
    emitTarget["output-dir"],
  );
  await emitJavaFile(
    context,
    "TypraYaml.java",
    emitJavaYaml(packageName),
    emitTarget["output-dir"],
    emitTarget["output-dir"],
  );

  const enums = new Map<
    string,
    ReturnType<typeof lowerFile>["enums"][number]
  >();
  for (const fileDecl of fileDecls) {
    for (const enumDef of fileDecl.enums) {
      if (!enumDef.isOpen) enums.set(javaEnumTypeName(enumDef.name), enumDef);
    }
  }
  for (const [enumName, enumDef] of enums) {
    await emitJavaFile(
      context,
      `${enumName}.java`,
      emitJavaEnum(enumDef, packageName, javaNativeSerialization(emitTarget)),
      emitTarget["output-dir"],
      emitTarget["output-dir"],
    );
  }

  const testClassNames: string[] = [];
  const helperFiles = new Set<string>();
  for (let index = 0; index < nodes.length; index++) {
    const n = nodes[index];
    const fileContent = emitJavaFileContent(
      [fileDecls[index].types[0]],
      packageName,
      visitor,
      polymorphicTypeNames,
      [],
      allTypeDecls,
      javaNativeSerialization(emitTarget),
    );
    await emitJavaFile(
      context,
      `${javaTypeName(n.typeName.name)}.java`,
      fileContent,
      emitTarget["output-dir"],
      emitTarget["output-dir"],
    );
    const carrier = emitJavaUnknownCarrier(
      fileDecls[index].types[0],
      packageName,
      javaNativeSerialization(emitTarget),
    );
    if (carrier) {
      await emitJavaFile(
        context,
        carrier.filename,
        carrier.source,
        emitTarget["output-dir"],
        emitTarget["output-dir"],
      );
    }
    const helper = emitJavaMethodHelper(fileDecls[index].types[0], packageName);
    if (helper) {
      helperFiles.add(helper.filename);
      await emitJavaMethodHelperIfMissing(
        context,
        helper.filename,
        helper.source,
        emitTarget["output-dir"],
      );
    }

    if (emitTarget["test-dir"] && !n.isProtocol) {
      const testClass = javaTestClassName(n.typeName.name);
      testClassNames.push(testClass);
      const testContext = buildBaseTestContext(
        n,
        packageName,
        javaTestOptions,
        (name) => registry.get(name),
      );
      await emitJavaFile(
        context,
        `${testClass}.java`,
        emitJavaTest(testContext, javaNativeSerialization(emitTarget)),
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
    }
  }

  if (
    emitTarget["test-dir"] &&
    shouldEmitCompileOnlyProtocolScaffolds(emitTarget)
  ) {
    const scaffold = emitJavaProtocolScaffolds(
      collectProtocolNodes(nodes),
      packageName,
    );
    if (scaffold) {
      testClassNames.push(scaffold.className);
      await emitJavaFile(
        context,
        `${scaffold.className}.java`,
        scaffold.source,
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
    }
  }

  if (
    emitTarget["test-dir"] &&
    (options?.callableVectors?.vectors.length ?? 0) > 0 &&
    javaNativeSerialization(emitTarget) === "jackson"
  ) {
    testClassNames.push("VectorConformanceTests");
    await emitJavaFile(
      context,
      "VectorConformanceTests.java",
      emitJavaVectorConformanceTest(
        options!.callableVectors!,
        packageName,
        emitTarget["vector-adapter-path"] ?? `${packageName}.VectorAdapters`,
      ),
      emitTarget["test-dir"],
      emitTarget["test-dir"],
    );
  }

  if (emitTarget["test-dir"] && testClassNames.length > 0) {
    await emitJavaFile(
      context,
      "TypraGeneratedTests.java",
      emitJavaTestRunner(packageName, testClassNames),
      emitTarget["test-dir"],
      emitTarget["test-dir"],
    );
  }

  if (emitTarget.format !== false) {
    const outputDir = resolve(
      process.cwd(),
      emitTarget["output-dir"] ?? context.emitterOutputDir,
    );
    const custom = resolveCustomFormatters(emitTarget.format);
    if (custom) {
      const testDir = emitTarget["test-dir"]
        ? resolve(process.cwd(), emitTarget["test-dir"])
        : undefined;
      runCustomFormatters(custom, { dir: outputDir, testDir });
    } else {
      formatJavaFiles(outputDir, helperFiles);
    }
  }
};

function javaNativeSerialization(emitTarget: EmitTarget): "none" | "jackson" {
  return emitTarget["native-serialization"] === "jackson" ? "jackson" : "none";
}

async function emitJavaFile(
  context: EmitContext<TypraEmitterOptions>,
  filename: string,
  content: string,
  outputDir?: string,
  outputRoot?: string,
): Promise<void> {
  const filePath = resolvePath(
    outputDir || `${context.emitterOutputDir}/java`,
    filename,
  );
  await emitGeneratedFile(context, filePath, content, {
    outputRoot: outputRoot || outputDir,
  });
}

async function emitJavaMethodHelperIfMissing(
  context: EmitContext<TypraEmitterOptions>,
  filename: string,
  content: string,
  outputDir?: string,
): Promise<void> {
  const filePath = resolvePath(
    outputDir || `${context.emitterOutputDir}/java`,
    filename,
  );
  if (!existsSync(filePath)) {
    await emitFile(context.program, { path: filePath, content });
    return;
  }

  // Seam files created before the marker contract stay unmarked forever under create-once,
  // which leaves them outside the cleaner allow-list. Prepend the marker without touching
  // any hand-written body.
  const migrated = ensureJavaEditableSeamMarker(readFileSync(filePath, "utf8"));
  if (migrated === null) return;
  await emitFile(context.program, { path: filePath, content: migrated });
}

function formatJavaFiles(outputDir: string, excludedFiles: Set<string>): void {
  if (!existsSync(outputDir)) return;
  const javaFiles = readdirSync(outputDir)
    .filter((file) => file.endsWith(".java") && !excludedFiles.has(file))
    .map((file) => resolve(outputDir, file));
  if (javaFiles.length === 0) return;

  try {
    execFileSync("google-java-format", ["--replace", ...javaFiles], {
      stdio: "pipe",
      encoding: "utf-8",
    });
  } catch (error) {
    // google-java-format is optional; javac validation enforces correctness.
    // Warn loudly so the presence-dependent output drift is attributable rather
    // than silently swallowed.
    warnFormatterUnavailable("google-java-format", outputDir, error);
  }
}

/**
 * Escape arbitrary text into the body of a double-quoted Java string literal whose
 * runtime value is ASCII-only JSON. Every non-ASCII code point is emitted as a JSON
 * `\uXXXX` escape (written as `\\uXXXX` in Java source, and as a surrogate pair for
 * astral code points), so the compiled source carries no bidi controls or literal
 * multibyte characters; Jackson decodes the JSON escapes back to the exact runtime
 * string when the payload is parsed.
 */
function javaEscapeUnit(ch: string): string {
  const cp = ch.codePointAt(0)!;
  if (ch === '"') {
    return '\\"';
  } else if (ch === "\\") {
    return "\\\\";
  } else if (cp === 0x0a) {
    return "\\n";
  } else if (cp === 0x0d) {
    return "\\r";
  } else if (cp === 0x09) {
    return "\\t";
  } else if (cp >= 0x20 && cp <= 0x7e) {
    return ch;
  } else if (cp <= 0xffff) {
    return `\\\\u${cp.toString(16).padStart(4, "0")}`;
  }
  const v = cp - 0x10000;
  const high = 0xd800 + (v >> 10);
  const low = 0xdc00 + (v & 0x3ff);
  return (
    `\\\\u${high.toString(16).padStart(4, "0")}` +
    `\\\\u${low.toString(16).padStart(4, "0")}`
  );
}

/**
 * Split the escaped payload into Java string literals that each stay well under the
 * JVM's 65_535-byte constant-pool limit, breaking only between whole escape units so
 * no `\uXXXX`/surrogate sequence is ever severed. The chunks are concatenated at
 * runtime (see `buildPayload`) rather than with compile-time `+`, which javac would
 * fold back into a single oversized constant.
 */
function javaPayloadLiteralChunks(text: string, maxLen = 40000): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const ch of text) {
    cur += javaEscapeUnit(ch);
    if (cur.length >= maxLen) {
      chunks.push(cur);
      cur = "";
    }
  }
  if (cur.length > 0 || chunks.length === 0) {
    chunks.push(cur);
  }
  return chunks;
}

/**
 * Emit the Java closed-loop `@vector` behavioral conformance suite. Each vector is
 * replayed through a runtime-authored `VectorAdapters` class named by the target's
 * `vector-adapter-path` option (default `<package>.VectorAdapters`). A vector with
 * no adapter and no explicit waiver is a hard `AssertionError` — this suite never
 * skips silently; a non-empty waiver prints a visible `SKIP` marker and passes.
 * Only emitted for the Jackson serialization mode, which supplies the JSON runtime
 * the harness parses and canonicalizes with.
 */
function emitJavaVectorConformanceTest(
  vectors: NonNullable<GeneratorOptions["callableVectors"]>,
  packageName: string,
  adapterClass: string,
): string {
  const model = buildVectorConformanceCodeModel(vectors);
  const payload = JSON.stringify(model.vectors);
  const payloadChunks = javaPayloadLiteralChunks(payload);
  const buildPayloadBody = [
    "  private static String buildPayload() {",
    "    StringBuilder sb = new StringBuilder();",
    ...payloadChunks.map((chunk) => `    sb.append("${chunk}");`),
    "    return sb.toString();",
    "  }",
  ];

  return [
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    "// Enforced @vector behavioral conformance. Each vector is replayed through a",
    "// runtime-authored VectorAdapters class named by the target's",
    "// 'vector-adapter-path' option. A vector with no adapter and no explicit waiver",
    "// is a hard failure — this suite never skips silently.",
    "// See docs: reference/vector-conformance.",
    `package ${packageName};`,
    "",
    "import com.fasterxml.jackson.databind.JsonNode;",
    "import com.fasterxml.jackson.databind.ObjectMapper;",
    "import com.fasterxml.jackson.databind.node.ArrayNode;",
    "import com.fasterxml.jackson.databind.node.ObjectNode;",
    "import com.fasterxml.jackson.databind.node.TextNode;",
    "import java.nio.file.Files;",
    "import java.nio.file.Path;",
    "import java.util.ArrayList;",
    "import java.util.Collections;",
    "import java.util.Iterator;",
    "import java.util.List;",
    "import java.util.Map;",
    "",
    "public final class VectorConformanceTests {",
    "  private VectorConformanceTests() { }",
    "",
    "  private static final ObjectMapper MAPPER = new ObjectMapper();",
    `  private static final String PAYLOAD = buildPayload();`,
    "",
    ...buildPayloadBody,
    "",
    "  @FunctionalInterface",
    "  public interface Invoke {",
    "    JsonNode apply(JsonNode input, VectorContext ctx) throws Exception;",
    "  }",
    "",
    "  @FunctionalInterface",
    "  public interface Normalizer {",
    "    JsonNode apply(JsonNode value, VectorContext ctx);",
    "  }",
    "",
    "  public static final class VectorAdapter {",
    "    public final Invoke invoke;",
    "    public final Normalizer normalize;",
    "    public VectorAdapter(Invoke invoke) { this(invoke, null); }",
    "    public VectorAdapter(Invoke invoke, Normalizer normalize) {",
    "      this.invoke = invoke;",
    "      this.normalize = normalize;",
    "    }",
    "  }",
    "",
    "  public static final class VectorContext {",
    "    public final String contract;",
    "    public final String operation;",
    "    public final JsonNode vector;",
    "    public final String provider;",
    "    public final String targetApi;",
    "    public final JsonNode doubles;",
    "    public final Path baseDir;",
    "    public VectorContext(String contract, String operation, JsonNode vector,",
    "        String provider, String targetApi, JsonNode doubles, Path baseDir) {",
    "      this.contract = contract;",
    "      this.operation = operation;",
    "      this.vector = vector;",
    "      this.provider = provider;",
    "      this.targetApi = targetApi;",
    "      this.doubles = doubles;",
    "      this.baseDir = baseDir;",
    "    }",
    "  }",
    "",
    "  public static final class VectorException extends RuntimeException {",
    "    private static final long serialVersionUID = 1L;",
    "    public final transient JsonNode payload;",
    "    public VectorException(String message) { this(message, null); }",
    "    public VectorException(String message, JsonNode payload) {",
    "      super(message);",
    "      this.payload = payload;",
    "    }",
    "  }",
    "",
    "  private static Path baseDir() {",
    '    String dir = System.getProperty("typra.vector.base-dir",',
    '        System.getProperty("user.dir"));',
    "    return Path.of(dir);",
    "  }",
    "",
    "  private static JsonNode resolveRefs(JsonNode value, Path dir) throws Exception {",
    "    if (value == null) { return null; }",
    "    if (value.isArray()) {",
    "      ArrayNode out = MAPPER.createArrayNode();",
    "      for (JsonNode item : value) { out.add(resolveRefs(item, dir)); }",
    "      return out;",
    "    }",
    "    if (value.isObject()) {",
    "      if (value.size() == 1) {",
    "        Map.Entry<String, JsonNode> kv = value.fields().next();",
    "        JsonNode inner = kv.getValue();",
    "        if (inner.isTextual()) {",
    "          String raw = inner.asText();",
    "          switch (kv.getKey()) {",
    '            case "$env": {',
    "              String env = System.getenv(raw);",
    '              return TextNode.valueOf(env == null ? "" : env);',
    "            }",
    '            case "$file":',
    "              return TextNode.valueOf(Files.readString(dir.resolve(raw)));",
    '            case "$json":',
    "              return MAPPER.readTree(Files.readString(dir.resolve(raw)));",
    "            default:",
    "              break;",
    "          }",
    "        }",
    "      }",
    "      ObjectNode out = MAPPER.createObjectNode();",
    "      Iterator<Map.Entry<String, JsonNode>> it = value.fields();",
    "      while (it.hasNext()) {",
    "        Map.Entry<String, JsonNode> kv = it.next();",
    "        out.set(kv.getKey(), resolveRefs(kv.getValue(), dir));",
    "      }",
    "      return out;",
    "    }",
    "    return value;",
    "  }",
    "",
    "  private static String canonical(JsonNode node) {",
    '    if (node == null || node.isNull()) { return "null"; }',
    "    if (node.isObject()) {",
    "      List<String> keys = new ArrayList<>();",
    "      node.fieldNames().forEachRemaining(keys::add);",
    "      Collections.sort(keys);",
    '      StringBuilder sb = new StringBuilder("{");',
    "      boolean first = true;",
    "      for (String key : keys) {",
    "        if (!first) { sb.append(','); }",
    "        first = false;",
    "        sb.append(TextNode.valueOf(key).toString())",
    "            .append(':').append(canonical(node.get(key)));",
    "      }",
    "      return sb.append('}').toString();",
    "    }",
    "    if (node.isArray()) {",
    '      StringBuilder sb = new StringBuilder("[");',
    "      for (int i = 0; i < node.size(); i++) {",
    "        if (i > 0) { sb.append(','); }",
    "        sb.append(canonical(node.get(i)));",
    "      }",
    "      return sb.append(']').toString();",
    "    }",
    "    return node.toString();",
    "  }",
    "",
    "  private static JsonNode normalize(VectorAdapter adapter, JsonNode value, VectorContext ctx) {",
    "    return adapter.normalize == null ? value : adapter.normalize.apply(value, ctx);",
    "  }",
    "",
    "  private static void assertEqual(String vectorId, JsonNode expected, JsonNode observed) {",
    "    String left = canonical(expected);",
    "    String right = canonical(observed);",
    "    if (!left.equals(right)) {",
    '      throw new AssertionError(vectorId + ": expected " + left + " but got " + right);',
    "    }",
    "  }",
    "",
    "  private static void runVector(JsonNode entry) throws Exception {",
    '    String contract = entry.path("contract").asText("");',
    '    String operation = entry.path("operation").asText("");',
    '    String operationKey = contract + "." + operation;',
    '    JsonNode vector = entry.has("vector") ? entry.get("vector") : MAPPER.createObjectNode();',
    '    String vectorName = vector.path("name").asText("unnamed");',
    '    String vectorId = operationKey + ":" + vectorName;',
    "",
    `    Map<String, VectorAdapter> adapters = ${adapterClass}.adapters();`,
    "    VectorAdapter adapter = adapters.get(operationKey);",
    "    if (adapter == null) { adapter = adapters.get(operation); }",
    "    if (adapter == null) {",
    `      Map<String, String> waivers = ${adapterClass}.waivers();`,
    "      String reason = waivers.get(operationKey);",
    "      if (reason == null) { reason = waivers.get(operation); }",
    "      if (reason != null && !reason.isEmpty()) {",
    '        System.out.println("SKIP " + vectorId + " (waived: " + reason + ")");',
    "        return;",
    "      }",
    '      throw new AssertionError("No vector adapter registered for " + operationKey',
    "          + \". Register it in the class referenced by 'vector-adapter-path', or add \"",
    '          + "an explicit waiver. @vector conformance never skips silently.");',
    "    }",
    "",
    "    Path dir = baseDir();",
    "    VectorContext ctx = new VectorContext(contract, operation, vector.deepCopy(),",
    '        vector.hasNonNull("provider") ? vector.get("provider").asText() : null,',
    '        vector.hasNonNull("targetApi") ? vector.get("targetApi").asText() : null,',
    `        ${adapterClass}.doubles(), dir);`,
    '    JsonNode input = resolveRefs(vector.has("input") ? vector.get("input").deepCopy() : null, dir);',
    "",
    '    if (vector.has("expectedError")) {',
    '      JsonNode expected = vector.get("expectedError");',
    "      try {",
    "        adapter.invoke.apply(input, ctx);",
    "        throw new AssertionError(vectorId",
    '            + ": expected the adapter to signal an error, but it returned a value.");',
    "      } catch (VectorException err) {",
    "        JsonNode observed = err.payload;",
    "        if (observed == null) {",
    "          ObjectNode msg = MAPPER.createObjectNode();",
    '          msg.put("message", err.getMessage());',
    "          observed = msg;",
    "        }",
    "        assertEqual(vectorId, expected, normalize(adapter, observed, ctx));",
    "      }",
    "    } else {",
    "      JsonNode observed = adapter.invoke.apply(input, ctx);",
    '      assertEqual(vectorId, vector.get("expected"), normalize(adapter, observed, ctx));',
    "    }",
    "  }",
    "",
    "  public static void run() {",
    "    JsonNode vectors;",
    "    try {",
    "      vectors = MAPPER.readTree(PAYLOAD);",
    "    } catch (Exception error) {",
    '      throw new AssertionError("failed to parse embedded vectors: " + error.getMessage(), error);',
    "    }",
    "    int failed = 0;",
    "    for (JsonNode entry : vectors) {",
    '      String vectorId = "?";',
    "      try {",
    '        vectorId = entry.path("contract").asText("") + "." + entry.path("operation").asText("")',
    '            + ":" + entry.path("vector").path("name").asText("unnamed");',
    "        runVector(entry);",
    '        System.out.println("PASS " + vectorId);',
    "      } catch (Throwable error) {",
    "        failed++;",
    '        System.out.println("FAIL " + vectorId + ": " + error.getMessage());',
    "      }",
    "    }",
    "    if (failed > 0) {",
    '      throw new AssertionError(failed + " @vector conformance failure(s)");',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}
