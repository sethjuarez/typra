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
    (options?.callableVectors?.vectors.length ?? 0) > 0
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
 * Serialization-agnostic: the harness drives the built-in JSON value model
 * (`TypraJson`/`TypraMaps` — `Map`/`List`/`String`/`Number`/`Boolean`/`null`), so it
 * is emitted for every serialization backend rather than gated on Jackson. Adapters
 * receive and return that same `Object` tree.
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
    "//",
    "// Serialization-agnostic: the harness drives the built-in JSON value model",
    "// (TypraJson/TypraMaps — Map/List/String/Number/Boolean/null), so it is emitted",
    "// for every serialization backend rather than gated on Jackson. Adapters receive",
    "// and return that same Object tree.",
    "//",
    "// Adapter contract: `invoke` may return a JSON value (Object) or a",
    "// Future/CompletableFuture of one; the harness awaits (joins) an awaitable before",
    "// comparing. Each vector performs exactly one awaited invocation and must not",
    "// spawn its own concurrency, so conformance stays deterministic.",
    "//",
    "// Classification is ENFORCED: an operation marked `@sync` (entry \"sync\" is true)",
    "// must resolve synchronously — if its adapter returns a Future the vector is a",
    "// hard failure. An async-capable operation (the default) stays permissive: a",
    "// plain value or a Future both pass.",
    "// See docs: reference/vector-conformance.",
    `package ${packageName};`,
    "",
    "import java.nio.file.Files;",
    "import java.nio.file.Path;",
    "import java.util.ArrayList;",
    "import java.util.Collections;",
    "import java.util.LinkedHashMap;",
    "import java.util.List;",
    "import java.util.Map;",
    "",
    "public final class VectorConformanceTests {",
    "  private VectorConformanceTests() { }",
    "",
    `  private static final String PAYLOAD = buildPayload();`,
    "",
    ...buildPayloadBody,
    "",
    "  @FunctionalInterface",
    "  public interface Invoke {",
    "    Object apply(Object input, VectorContext ctx) throws Exception;",
    "  }",
    "",
    "  @FunctionalInterface",
    "  public interface Normalizer {",
    "    Object apply(Object value, VectorContext ctx);",
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
    "    public final Object vector;",
    "    public final String provider;",
    "    public final String targetApi;",
    "    public final Object doubles;",
    "    public final Path baseDir;",
    "    public VectorContext(String contract, String operation, Object vector,",
    "        String provider, String targetApi, Object doubles, Path baseDir) {",
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
    "    public final transient Object payload;",
    "    public VectorException(String message) { this(message, null); }",
    "    public VectorException(String message, Object payload) {",
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
    "  // Field access over the built-in JSON object model (a JSON object decodes to a",
    "  // Map). A non-object or absent key yields null, matching the tolerant lookups",
    "  // the Jackson node API used to provide.",
    "  private static Object field(Object value, String key) {",
    "    return value instanceof Map<?, ?> map ? map.get(key) : null;",
    "  }",
    "",
    "  private static String text(Object value, String fallback) {",
    "    return value instanceof String s ? s : fallback;",
    "  }",
    "",
    "  private static boolean bool(Object value, boolean fallback) {",
    "    return value instanceof Boolean b ? b : fallback;",
    "  }",
    "",
    "  // Defensive deep copy so an adapter cannot mutate the shared decoded payload.",
    "  private static Object deepCopy(Object value) {",
    "    if (value instanceof Map<?, ?> map) {",
    "      Map<String, Object> out = new LinkedHashMap<>();",
    "      for (Map.Entry<?, ?> kv : map.entrySet()) {",
    "        out.put(String.valueOf(kv.getKey()), deepCopy(kv.getValue()));",
    "      }",
    "      return out;",
    "    }",
    "    if (value instanceof List<?> list) {",
    "      List<Object> out = new ArrayList<>();",
    "      for (Object item : list) { out.add(deepCopy(item)); }",
    "      return out;",
    "    }",
    "    return value;",
    "  }",
    "",
    "  private static Object resolveRefs(Object value, Path dir) throws Exception {",
    "    if (value instanceof List<?> list) {",
    "      List<Object> out = new ArrayList<>();",
    "      for (Object item : list) { out.add(resolveRefs(item, dir)); }",
    "      return out;",
    "    }",
    "    if (value instanceof Map<?, ?> map) {",
    "      if (map.size() == 1) {",
    "        Map.Entry<?, ?> kv = map.entrySet().iterator().next();",
    "        if (kv.getValue() instanceof String raw) {",
    "          switch (String.valueOf(kv.getKey())) {",
    '            case "$env": {',
    "              String env = System.getenv(raw);",
    '              return env == null ? "" : env;',
    "            }",
    '            case "$file":',
    "              return Files.readString(dir.resolve(raw));",
    '            case "$json":',
    "              return TypraJson.parse(Files.readString(dir.resolve(raw)));",
    "            default:",
    "              break;",
    "          }",
    "        }",
    "      }",
    "      Map<String, Object> out = new LinkedHashMap<>();",
    "      for (Map.Entry<?, ?> kv : map.entrySet()) {",
    "        out.put(String.valueOf(kv.getKey()), resolveRefs(kv.getValue(), dir));",
    "      }",
    "      return out;",
    "    }",
    "    return value;",
    "  }",
    "",
    "  // Stable stringification with object keys sorted, so equality ignores key order.",
    "  private static String canonical(Object node) {",
    "    if (node instanceof Map<?, ?> map) {",
    "      List<String> keys = new ArrayList<>();",
    "      for (Object key : map.keySet()) { keys.add(String.valueOf(key)); }",
    "      Collections.sort(keys);",
    '      StringBuilder sb = new StringBuilder("{");',
    "      boolean first = true;",
    "      for (String key : keys) {",
    "        if (!first) { sb.append(','); }",
    "        first = false;",
    "        sb.append(TypraJson.stringify(key))",
    "            .append(':').append(canonical(map.get(key)));",
    "      }",
    "      return sb.append('}').toString();",
    "    }",
    "    if (node instanceof List<?> list) {",
    '      StringBuilder sb = new StringBuilder("[");',
    "      for (int i = 0; i < list.size(); i++) {",
    "        if (i > 0) { sb.append(','); }",
    "        sb.append(canonical(list.get(i)));",
    "      }",
    "      return sb.append(']').toString();",
    "    }",
    "    return TypraJson.stringify(node);",
    "  }",
    "",
    "  private static Object normalize(VectorAdapter adapter, Object value, VectorContext ctx) {",
    "    return adapter.normalize == null ? value : adapter.normalize.apply(value, ctx);",
    "  }",
    "",
    "  // Await-if-awaitable: an adapter may return a JSON value directly or a",
    "  // Future/CompletableFuture of one. A plain value is returned unchanged; a",
    "  // future is joined and its completion exception unwrapped so an async adapter",
    "  // that fails signals its VectorException on the same path as a sync one.",
    "  private static Object awaitIfAwaitable(Object result) throws Exception {",
    "    Object value = result;",
    "    if (value instanceof java.util.concurrent.Future) {",
    "      try {",
    "        value = ((java.util.concurrent.Future<?>) value).get();",
    "      } catch (java.util.concurrent.ExecutionException ex) {",
    "        Throwable cause = ex.getCause();",
    "        if (cause instanceof RuntimeException) { throw (RuntimeException) cause; }",
    "        if (cause instanceof Exception) { throw (Exception) cause; }",
    "        if (cause instanceof Error) { throw (Error) cause; }",
    "        throw ex;",
    "      }",
    "    }",
    "    return value;",
    "  }",
    "",
    "  // A Future is the JVM-native awaitable. @sync enforcement keys off this shape:",
    "  // a synchronously-callable operation must never hand one back.",
    "  private static boolean isAwaitable(Object result) {",
    "    return result instanceof java.util.concurrent.Future;",
    "  }",
    "",
    "  // Exactly one invocation, with @sync classification enforced before awaiting.",
    "  private static Object invokeAdapter(VectorAdapter adapter, Object input,",
    "      VectorContext ctx, boolean sync, String vectorId) throws Exception {",
    "    Object raw = adapter.invoke.apply(input, ctx);",
    "    if (sync && isAwaitable(raw)) {",
    "      throw new AssertionError(vectorId",
    '          + ": operation is @sync but its adapter returned an awaitable. A @sync"',
    '          + " operation must resolve synchronously — drop @sync to make it"',
    '          + " async-capable, or make the adapter synchronous.");',
    "    }",
    "    return awaitIfAwaitable(raw);",
    "  }",
    "",
    "  private static void assertEqual(String vectorId, Object expected, Object observed) {",
    "    String left = canonical(expected);",
    "    String right = canonical(observed);",
    "    if (!left.equals(right)) {",
    '      throw new AssertionError(vectorId + ": expected " + left + " but got " + right);',
    "    }",
    "  }",
    "",
    "  private static void runVector(Object entry) throws Exception {",
    '    String contract = text(field(entry, "contract"), "");',
    '    String operation = text(field(entry, "operation"), "");',
    '    String operationKey = contract + "." + operation;',
    '    Object vector = field(entry, "vector");',
    "    if (vector == null) { vector = new LinkedHashMap<String, Object>(); }",
    '    String vectorName = text(field(vector, "name"), "unnamed");',
    '    String vectorId = operationKey + ":" + vectorName;',
    '    boolean sync = bool(field(entry, "sync"), false);',
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
    '    Object provider = field(vector, "provider");',
    '    Object targetApi = field(vector, "targetApi");',
    "    VectorContext ctx = new VectorContext(contract, operation, deepCopy(vector),",
    "        provider instanceof String p ? p : null,",
    "        targetApi instanceof String t ? t : null,",
    `        ${adapterClass}.doubles(), dir);`,
    '    Object input = resolveRefs(deepCopy(field(vector, "input")), dir);',
    "",
    '    if (vector instanceof Map<?, ?> vectorMap && vectorMap.containsKey("expectedError")) {',
    '      Object expected = vectorMap.get("expectedError");',
    "      try {",
    "        invokeAdapter(adapter, input, ctx, sync, vectorId);",
    "        throw new AssertionError(vectorId",
    '            + ": expected the adapter to signal an error, but it returned a value.");',
    "      } catch (VectorException err) {",
    "        Object observed = err.payload;",
    "        if (observed == null) {",
    "          Map<String, Object> msg = new LinkedHashMap<>();",
    '          msg.put("message", err.getMessage());',
    "          observed = msg;",
    "        }",
    "        assertEqual(vectorId, expected, normalize(adapter, observed, ctx));",
    "      }",
    "    } else {",
    "      Object observed = invokeAdapter(adapter, input, ctx, sync, vectorId);",
    '      assertEqual(vectorId, field(vector, "expected"), normalize(adapter, observed, ctx));',
    "    }",
    "  }",
    "",
    "  public static void run() {",
    "    Object parsed;",
    "    try {",
    "      parsed = TypraJson.parse(PAYLOAD);",
    "    } catch (Exception error) {",
    '      throw new AssertionError("failed to parse embedded vectors: " + error.getMessage(), error);',
    "    }",
    "    if (!(parsed instanceof List<?> vectors)) {",
    '      throw new AssertionError("embedded @vector payload must be a JSON array");',
    "    }",
    "    int failed = 0;",
    "    for (Object entry : vectors) {",
    '      String vectorId = "?";',
    "      try {",
    '        vectorId = text(field(entry, "contract"), "") + "." + text(field(entry, "operation"), "")',
    '            + ":" + text(field(field(entry, "vector"), "name"), "unnamed");',
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
