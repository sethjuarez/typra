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
import { isClosedPolymorphicDispatch } from "../../ir/declarations.js";
import {
  collectDispatchedContracts,
  DispatchedContract,
  CallableVectorSnapshotEntry,
  isTypedDispatchEntry,
  assertTypedDispatchSupported,
  classifyCallableParam,
} from "../../ir/vector.js";
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
  javaScalarType,
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
import { javaEnumTypeName, javaMethodName, javaPropertyName, javaTypeName } from "./identifiers.js";
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
    const adapterClass =
      emitTarget["vector-adapter-path"] ?? `${packageName}.VectorAdapters`;
    const allVectors = options!.callableVectors!.vectors;
    // A `@dispatch` seam routes through the typed resolver rail (issue #282 §8):
    // its vectors get a per-interface, typed `${Interface}ConformanceTests` class
    // in the seam's package. Undispatched seams — INCLUDING a @dispatch whose
    // discriminator model is not polymorphic (no `decl`, so no typed rail) — keep
    // the stringly JSON interpreter (VectorRunner) + monolithic
    // VectorConformanceTests, so no vector is dropped from both rails.
    const undispatched = allVectors.filter(
      (entry) => !isTypedDispatchEntry(entry),
    );

    if (undispatched.length > 0) {
      // The interpreter is emitted into a sibling VectorRunner class (which owns
      // the port types) so the harness stays thin. VectorRunner is a support
      // class, not a test class, so it is NOT registered in testClassNames.
      await emitJavaFile(
        context,
        "VectorRunner.java",
        emitJavaVectorRunner(packageName),
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
      testClassNames.push("VectorConformanceTests");
      await emitJavaFile(
        context,
        "VectorConformanceTests.java",
        emitJavaVectorConformanceTest(
          { ...options!.callableVectors!, vectors: undispatched },
          packageName,
          adapterClass,
        ),
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
    }

    for (const dispatched of collectDispatchedContracts(allVectors)) {
      const ifaceVectors = allVectors.filter(
        (entry) =>
          isTypedDispatchEntry(entry) &&
          entry.namespace === dispatched.namespace &&
          entry.group === dispatched.group &&
          entry.contract === dispatched.contract,
      );
      // §8.5: never emit an empty conformance file — but the resolver below is
      // still emitted for a zero-vector dispatched seam so control 2 keeps biting.
      if (ifaceVectors.length === 0) continue;
      testClassNames.push(`${dispatched.contract}ConformanceTests`);
      await emitJavaFile(
        context,
        `${dispatched.contract}ConformanceTests.java`,
        emitJavaInterfaceConformanceTest(
          dispatched,
          ifaceVectors,
          packageName,
          adapterClass,
        ),
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
    }
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

  // Part III: emit one behavioral @dispatch resolver (provider interface +
  // resolve switch, the twin of the shape discriminator load switch) per
  // dispatched seam interface, into the LIBRARY beside the seam interface
  // (issue #282). The provider is a real interface a consumer implements, so a
  // forgotten slot fails to compile — the same rail as the shape discriminator
  // switch, itself a library artifact. NOTE: emission currently rides the
  // presence of @vector cases; decoupling it to emit for every dispatched
  // contract regardless of test coverage is a tracked follow-up (issue #282).
  if ((options?.callableVectors?.vectors.length ?? 0) > 0) {
    for (const dispatched of collectDispatchedContracts(
      options!.callableVectors!.vectors,
    )) {
      await emitJavaFile(
        context,
        `${dispatched.contract}Provider.java`,
        emitJavaDispatchProvider(dispatched, packageName),
        emitTarget["output-dir"],
        emitTarget["output-dir"],
      );
      await emitJavaFile(
        context,
        `${dispatched.contract}Resolver.java`,
        emitJavaDispatchResolver(dispatched, packageName),
        emitTarget["output-dir"],
        emitTarget["output-dir"],
      );
    }
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
 * Split an escaped vector literal into Java string literals that each stay well under
 * the JVM's 65_535-byte constant-pool limit, breaking only between whole escape units
 * so no `\uXXXX`/surrogate sequence is ever severed. The chunks are concatenated at
 * runtime with a `StringBuilder` (see each per-vector method) rather than with
 * compile-time `+`, which javac would fold back into a single oversized constant.
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
 * Emit the seam-agnostic Java `@vector` conformance interpreter (VectorRunner).
 * As an emitted-type target (unlike Go/C#/Rust, which import an authored seam's
 * port types) this class OWNS the port types (Invoke/Normalizer/Capability/
 * VectorAdapter/VectorContext/VectorException); the runtime-authored adapter class
 * named by 'vector-adapter-path' imports them from here. The interpreter reads
 * ZERO authored values: the adapter/waiver/capability/doubles tables and the
 * harness base directory all arrive through the injected `VectorSeam`, so it is
 * value-independent. A vector with no adapter and no explicit waiver is a hard
 * `AssertionError` — this suite never skips silently; a non-empty waiver prints a
 * visible `SKIP` marker and passes. Serialization-agnostic: it drives the built-in
 * JSON value model (`TypraJson`/`TypraMaps` — `Map`/`List`/`String`/`Number`/
 * `Boolean`/`null`), so it is emitted for every serialization backend.
 */
function emitJavaVectorRunner(packageName: string): string {
  return [
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    "// Seam-agnostic @vector behavioral conformance interpreter. This class reads",
    "// ZERO runtime-authored values; the harness injects the adapter/waiver/",
    "// capability/doubles tables and its own base directory through VectorSeam. A",
    "// vector with no adapter and no explicit waiver is a hard failure — conformance",
    "// never skips silently.",
    "//",
    "// EMITTED-TYPE OWNER (not Option A): unlike the nominally-typed targets",
    "// (Go/C#/Rust), which import an authored seam's port TYPES, Java emits its own",
    "// port types here (Invoke/Normalizer/Capability/VectorAdapter/VectorContext/",
    "// VectorException). The runtime-authored adapter class named by",
    "// 'vector-adapter-path' imports them from this class and supplies only the",
    "// registries, injected via VectorSeam.",
    "//",
    "// Serialization-agnostic: the runner drives the built-in JSON value model",
    "// (TypraJson/TypraMaps — Map/List/String/Number/Boolean/null), so it is emitted",
    "// for every serialization backend rather than gated on Jackson. Adapters receive",
    "// and return that same Object tree.",
    "//",
    "// Adapter contract: `invoke` may return a JSON value (Object) or a",
    "// Future/CompletableFuture of one; the runner awaits (joins) an awaitable before",
    "// comparing. Each vector performs exactly one awaited invocation and must not",
    "// spawn its own concurrency, so conformance stays deterministic.",
    "//",
    "// Classification is ENFORCED: an operation marked `@sync` (the sync argument",
    "// threaded from each per-vector test) must resolve synchronously — if its adapter",
    "// returns a Future the vector is a hard failure. An async-capable operation (the",
    "// default) stays permissive: a plain value or a Future both pass.",
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
    "public final class VectorRunner {",
    "  private VectorRunner() { }",
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
    "  @FunctionalInterface",
    "  public interface Capability {",
    "    boolean test(VectorContext ctx);",
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
    "  // Runtime-authored seam tables injected by the harness. The runner reads none",
    "  // of these directly from the authored class; everything flows through here.",
    "  // `capabilities` is populated by the harness only when a vector declares",
    "  // `requires` (otherwise an empty map, never consulted), keeping",
    "  // requirement-free harnesses byte-identical.",
    "  public static final class VectorSeam {",
    "    public final Map<String, VectorAdapter> adapters;",
    "    public final Map<String, String> waivers;",
    "    public final Object doubles;",
    "    public final Map<String, Capability> capabilities;",
    "    public final Path baseDir;",
    "    public VectorSeam(Map<String, VectorAdapter> adapters, Map<String, String> waivers,",
    "        Object doubles, Map<String, Capability> capabilities, Path baseDir) {",
    "      this.adapters = adapters;",
    "      this.waivers = waivers;",
    "      this.doubles = doubles;",
    "      this.capabilities = capabilities;",
    "      this.baseDir = baseDir;",
    "    }",
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
    "  // Walks a deterministic field-access path (e.g. `agent.template.format.kind`)",
    "  // over a resolved vector input to read the @dispatch discriminator value that",
    "  // selects the concrete seam implementation. Returns null if any hop is missing",
    "  // or the terminal value is not a string, so the caller can fail loudly.",
    "  private static String resolveDispatchKey(Object root, String dotted) {",
    "    Object node = root;",
    '    for (String key : dotted.split("\\\\.")) {',
    "      node = field(node, key);",
    "      if (node == null) { return null; }",
    "    }",
    "    return node instanceof String s ? s : null;",
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
    "  public static void runVector(String contract, String operation, Object vector,",
    "      boolean sync, VectorSeam seam) throws Exception {",
    "    runVector(contract, operation, vector, sync, seam, null);",
    "  }",
    "",
    "  // Behavioral polymorphic dispatch (@dispatch): dispatchPath (non-null for a",
    "  // dispatched seam) is the discriminator access path. The concrete impl is",
    "  // resolved once from the discriminator value read at that path on the vector",
    "  // input and looked up in the seam's per-key registry (adapters keyed",
    "  // `Contract.operation#key`). An impl absent for a valid key reuses the",
    "  // capability-absent skip. Undispatched seams pass null and keep the single",
    "  // adapter lookup unchanged.",
    "  public static void runVector(String contract, String operation, Object vector,",
    "      boolean sync, VectorSeam seam, String dispatchPath) throws Exception {",
    '    String operationKey = contract + "." + operation;',
    "    if (vector == null) { vector = new LinkedHashMap<String, Object>(); }",
    '    String vectorName = text(field(vector, "name"), "unnamed");',
    '    String vectorId = operationKey + ":" + vectorName;',
    "",
    `    Map<String, VectorAdapter> adapters = seam.adapters;`,
    "    VectorAdapter adapter;",
    "    if (dispatchPath != null && !dispatchPath.isEmpty()) {",
    '      Object dispatchInput = resolveRefs(deepCopy(field(vector, "input")), seam.baseDir);',
    "      String dispatchKey = resolveDispatchKey(dispatchInput, dispatchPath);",
    "      if (dispatchKey == null) {",
    "        throw new AssertionError(vectorId + \": @dispatch path '\" + dispatchPath",
    "            + \"' did not resolve to a string discriminator on the vector input.\");",
    "      }",
    '      adapter = adapters.get(operationKey + "#" + dispatchKey);',
    '      if (adapter == null) { adapter = adapters.get(operation + "#" + dispatchKey); }',
    "      if (adapter == null) {",
    '        System.out.println("SKIP " + vectorId + " (requirement unavailable: " + dispatchKey + ")");',
    "        return;",
    "      }",
    "    } else {",
    "      adapter = adapters.get(operationKey);",
    "      if (adapter == null) { adapter = adapters.get(operation); }",
    "      if (adapter == null) {",
    `        Map<String, String> waivers = seam.waivers;`,
    "        String reason = waivers.get(operationKey);",
    "        if (reason == null) { reason = waivers.get(operation); }",
    "        if (reason != null && !reason.isEmpty()) {",
    '          System.out.println("SKIP " + vectorId + " (waived: " + reason + ")");',
    "          return;",
    "        }",
    '        throw new AssertionError("No vector adapter registered for " + operationKey',
    "            + \". Register it in the class referenced by 'vector-adapter-path', or add \"",
    '            + "an explicit waiver. @vector conformance never skips silently.");',
    "      }",
    "    }",
    "",
    "    // Requirement guard (emitted unconditionally; inert when a vector declares",
    "    // no `requires`): a vector may declare abstract capability tokens in",
    "    // \"requires\". Each is resolved against the seam-injected capability table",
    "    // (populated by the harness only when some vector declares `requires`)",
    "    // BEFORE the adapter runs. An unregistered token is a hard failure",
    "    // (never skip silently); an unavailable one yields a clean skip so an absent",
    "    // credential never reaches invoke as an empty value.",
    '    Object requiresRaw = field(vector, "requires");',
    "    if (requiresRaw instanceof List<?> requiresList && !requiresList.isEmpty()) {",
    `      Map<String, Capability> capabilities = seam.capabilities;`,
    "      for (Object item : requiresList) {",
    "        if (item instanceof String token && !capabilities.containsKey(token)) {",
    '          throw new AssertionError("No capability predicate registered for requirement token \\"" + token',
    "              + \"\\\". Register it in the class referenced by 'vector-adapter-path'. \"",
    '              + "@vector conformance never skips silently.");',
    "        }",
    "      }",
    "      Path capDir = seam.baseDir;",
    '      Object capProvider = field(vector, "provider");',
    '      Object capTargetApi = field(vector, "targetApi");',
    "      VectorContext capCtx = new VectorContext(contract, operation, deepCopy(vector),",
    "          capProvider instanceof String p ? p : null,",
    "          capTargetApi instanceof String t ? t : null,",
    `          seam.doubles, capDir);`,
    "      for (Object item : requiresList) {",
    "        if (item instanceof String token && !capabilities.get(token).test(capCtx)) {",
    '          System.out.println("SKIP " + vectorId + " (requirement unavailable: " + token + ")");',
    "          return;",
    "        }",
    "      }",
    "    }",
    "",
    "    // Per-vector waiver, consulted even when an adapter IS registered. Keyed by",
    "    // the vector id (\"Contract.operation:name\") or \"operation:name\" so it never",
    "    // collides with an operation-level waiver. xfail: a waived vector that fails",
    "    // is an expected failure (green); xpass: a waived vector that passes is a hard",
    "    // failure so stale waivers get removed.",
    `    Map<String, String> vectorWaivers = seam.waivers;`,
    "    String vectorWaiver = vectorWaivers.get(vectorId);",
    "    if (vectorWaiver == null) {",
    '      vectorWaiver = vectorWaivers.get(operation + ":" + vectorName);',
    "    }",
    "    boolean waived = vectorWaiver != null && !vectorWaiver.isEmpty();",
    "",
    "    // Evaluate WITHOUT failing directly: capture any failure so the waiver",
    "    // decision below can turn it into an xfail.",
    "    Throwable vectorFailure = null;",
    "    try {",
    "    Path dir = seam.baseDir;",
    '    Object provider = field(vector, "provider");',
    '    Object targetApi = field(vector, "targetApi");',
    "    VectorContext ctx = new VectorContext(contract, operation, deepCopy(vector),",
    "        provider instanceof String p ? p : null,",
    "        targetApi instanceof String t ? t : null,",
    `        seam.doubles, dir);`,
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
    "    } catch (Throwable error) {",
    "      vectorFailure = error;",
    "    }",
    "    if (waived) {",
    "      if (vectorFailure != null) {",
    '        System.out.println("XFAIL " + vectorId + " (waived: " + vectorWaiver + ")");',
    "        return;",
    "      }",
    '      throw new AssertionError("XPASS " + vectorId + ": waived vector unexpectedly "',
    '          + "passed; remove the waiver (" + vectorWaiver + ").");',
    "    }",
    "    if (vectorFailure != null) {",
    "      if (vectorFailure instanceof RuntimeException re) { throw re; }",
    "      if (vectorFailure instanceof Error er) { throw er; }",
    '      throw new AssertionError(vectorFailure.getMessage(), vectorFailure);',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Emit the thin Java `@vector` conformance harness (VectorConformanceTests). The
 * interpreter lives in the sibling VectorRunner class; this suite only loads the
 * runtime-authored registry (a class named by the target's `vector-adapter-path`
 * option, default `<package>.VectorAdapters`), assembles the seam it owns, and
 * injects it into `VectorRunner.runVector` per vector. `baseDir()` stays here so
 * `$file`/`$json` inputs resolve relative to the test process. Per Decision #3 the
 * capability table is loaded into the seam only when a vector declares `requires`,
 * so requires-free harnesses regenerate byte-identical. `run()` is the entry point
 * the aggregate TypraGeneratedTests runner invokes.
 */
/**
 * Emit the provider INTERFACE for one dispatched seam: one accessor per
 * @dispatch variant. A consumer attaches impls by implementing this interface in
 * an external, non-emitted class, so a forgotten slot fails to compile (Java
 * requires every interface method be implemented) — the Java form of §5
 * control 2. Emitted as its own public top-level file (Java one-public-type rule).
 */
function emitJavaDispatchProvider(
  entry: DispatchedContract,
  packageName: string,
): string {
  const seam = entry.contract;
  const provider = `${seam}Provider`;
  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    `// Part III behavioral @dispatch provider for ${seam} — the consumer-attached`,
    "// surface for the resolver, one accessor per @dispatch variant. A consumer",
    "// implements this interface in an external, non-emitted class, so a forgotten",
    "// slot fails to compile.",
    "// See docs: reference/vector-conformance.",
    `package ${packageName};`,
    "",
    "/**",
    ` * Consumer-attached provider of ${seam} impls, one accessor per @dispatch`,
    " * variant. Return null to signal a valid-but-unimplemented variant to the",
    " * caller (e.g. the conformance harness skips it), never a silent miss.",
    " */",
    `public interface ${provider} {`,
  ];
  // Accessor names are the sanitized (keyword-safe) discriminator value. Every
  // fixture value today is a plain identifier (mustache/jinja2/liquid); a
  // collision between two values that sanitize alike would need a guard,
  // deferred until a fixture exercises one (reproduce-before-fix).
  for (const variant of entry.decl.variants) {
    lines.push(`  ${seam} ${javaMethodName(variant.value)}();`);
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/**
 * Emit the resolve switch for one dispatched seam: the twin of the shape
 * discriminator load switch, keyed on the discriminator value and dispatching to
 * the matching provider accessor. Emitted as its own public top-level file.
 */
function emitJavaDispatchResolver(
  entry: DispatchedContract,
  packageName: string,
): string {
  const seam = entry.contract;
  const provider = `${seam}Provider`;
  const resolver = `${seam}Resolver`;
  const field = entry.decl.discriminatorField;
  // Preserve the SAME variant order the shape load switch emits, keeping the two
  // switches a faithful twin without a locale-dependent comparator.
  const variants = entry.decl.variants;
  // Closed (no fallback, no default): an unknown discriminator is a hard error,
  // exactly as the shape switch throws. An open or default dispatch yields null
  // (harness explicit-skip); an abstract-open base routes unknowns to a carrier
  // in the shape loader, never throwing, so a bare `isClosedPolymorphicDispatch`
  // is the faithful twin of that throw arm.
  const rejectsUnknown = isClosedPolymorphicDispatch(entry.decl);

  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    `// Part III behavioral @dispatch resolver for ${seam} — the twin of the shape`,
    "// discriminator load switch, emitted into the library beside the seam",
    "// interface. Routes a discriminator value to the matching provider slot.",
    "// See docs: reference/vector-conformance.",
    `package ${packageName};`,
    "",
    "/**",
    ` * Maps a '${field}' discriminator value to the selected ${seam} impl — the`,
    " * behavioral twin of the shape discriminator load switch.",
    " */",
    `public final class ${resolver} {`,
    `  private ${resolver}() {}`,
    "",
    `  public static ${seam} resolve(String ${field}, ${provider} registry) {`,
    `    switch (${field}) {`,
  ];
  for (const variant of variants) {
    lines.push(`      case ${JSON.stringify(variant.value)}:`);
    lines.push(`        return registry.${javaMethodName(variant.value)}();`);
  }
  lines.push("      default:");
  if (rejectsUnknown) {
    lines.push(
      `        throw new IllegalArgumentException("Unknown ${seam} discriminator field '${field}' value: " + ${field});`,
    );
  } else {
    lines.push("        return null;");
  }
  lines.push("    }");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

function emitJavaVectorConformanceTest(
  vectors: NonNullable<GeneratorOptions["callableVectors"]>,
  packageName: string,
  adapterClass: string,
): string {
  const model = buildVectorConformanceCodeModel(vectors);
  const hasRequires = model.vectors.some(
    (entry) => (entry.vector.requires?.length ?? 0) > 0,
  );

  return [
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    "// Thin @vector behavioral conformance harness. The interpreter lives in the",
    "// sibling VectorRunner class; this suite only loads the runtime-authored",
    "// VectorAdapters class named by the target's 'vector-adapter-path' option,",
    "// assembles the seam it owns, and injects it into VectorRunner.runVector. A",
    "// vector with no adapter and no explicit waiver is a hard failure — conformance",
    "// never skips silently.",
    "// See docs: reference/vector-conformance.",
    `package ${packageName};`,
    "",
    "import java.nio.file.Path;",
    "import java.util.Map;",
    "",
    "public final class VectorConformanceTests {",
    "  private VectorConformanceTests() { }",
    "",
    "  // Resolves $file/$json vector inputs relative to the test process (computed",
    "  // here, not in the runner, so it points at the test environment).",
    "  private static Path baseDir() {",
    '    String dir = System.getProperty("typra.vector.base-dir",',
    '        System.getProperty("user.dir"));',
    "    return Path.of(dir);",
    "  }",
    "",
    "  // Assembles the runtime-authored seam the runner interprets. It reads the",
    `  // authored registries from the ${adapterClass} class and injects them; the`,
    "  // runner itself reads none of these directly. The capability table is loaded",
    "  // only when a vector declares `requires`, so requirement-free harnesses never",
    "  // reference the authored capabilities() and regenerate byte-identical.",
    "  private static VectorRunner.VectorSeam seam() {",
    "    return new VectorRunner.VectorSeam(",
    `        ${adapterClass}.adapters(),`,
    `        ${adapterClass}.waivers(),`,
    `        ${adapterClass}.doubles(),`,
    hasRequires
      ? `        ${adapterClass}.capabilities(),`
      : "        Map.of(),",
    "        baseDir());",
    "  }",
    "",
    "  @FunctionalInterface",
    "  private interface VectorCase {",
    "    void run() throws Exception;",
    "  }",
    "",
    "  // Run one vector, mirroring the pass/fail stdout protocol the runners expect:",
    "  // a clean return prints PASS; any throwable prints FAIL and counts one failure.",
    "  // SKIP/XFAIL markers are printed by VectorRunner.runVector itself before it returns.",
    "  private static int runCase(String vectorId, VectorCase test) {",
    "    try {",
    "      test.run();",
    '      System.out.println("PASS " + vectorId);',
    "      return 0;",
    "    } catch (Throwable error) {",
    '      System.out.println("FAIL " + vectorId + ": " + error.getMessage());',
    "      return 1;",
    "    }",
    "  }",
    ...model.vectors.flatMap((entry, index) => {
      const vectorJson = JSON.stringify(entry.vector);
      const chunks = javaPayloadLiteralChunks(vectorJson);
      return [
        "",
        `  private static void ${javaVectorSlug(index, entry)}() throws Exception {`,
        "    StringBuilder sb = new StringBuilder();",
        ...chunks.map((chunk) => `    sb.append("${chunk}");`),
        "    Object vector = TypraJson.parse(sb.toString());",
        `    VectorRunner.runVector(${JSON.stringify(entry.contract)}, ${JSON.stringify(
          entry.operation,
        )}, vector, ${entry.sync ? "true" : "false"}, seam()${
          entry.dispatch ? `, ${JSON.stringify(entry.dispatch.path)}` : ""
        });`,
        "  }",
      ];
    }),
    "",
    "  public static void run() {",
    "    int failed = 0;",
    ...model.vectors.map((entry, index) => {
      const vectorName = entry.vector.name ?? "unnamed";
      const vectorId = `${entry.contract}.${entry.operation}:${vectorName}`;
      return `    failed += runCase(${JSON.stringify(
        vectorId,
      )}, VectorConformanceTests::${javaVectorSlug(index, entry)});`;
    }),
    "    if (failed > 0) {",
    '      throw new AssertionError(failed + " @vector conformance failure(s)");',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Emit the Part III TYPED per-interface conformance suite for one dispatched seam
 * — the `@vector` twin of the per-model `${Type}GeneratedTest` class (issue #282
 * §8). Where the monolithic `VectorConformanceTests` feeds the JSON interpreter a
 * stringly `Contract.operation#value` route, this suite is fully typed: each
 * per-vector method builds the operation inputs from the vector JSON via the
 * emitted models' `load`, reads the SAME discriminator the shape load switch reads
 * (through the typed accessor chain), routes it through the emitted
 * `${Interface}Resolver.resolve` against a consumer-attached provider, invokes the
 * typed seam method, and asserts the result reproduces `expected`.
 *
 * The provider VALUE is authored by the consumer OUTSIDE the conformance tree — a
 * static `VectorProviders.${iface}()` accessor returning the generated
 * `${Interface}Provider` — so a dropped `@dispatch` slot fails to COMPILE
 * (implementing the provider interface obliges every accessor; §5 control 2). Only
 * the per-vector methods are emitted here; the resolver + provider TYPE live in the
 * colocated `${Interface}Resolver`/`${Interface}Provider` library files. Like the
 * model tests, this class exposes a static `run()` orchestrated by
 * `TypraGeneratedTests`.
 */
function emitJavaInterfaceConformanceTest(
  dispatched: DispatchedContract,
  entries: CallableVectorSnapshotEntry[],
  packageName: string,
  adapterClass: string,
): string {
  const iface = dispatched.contract;
  const resolver = `${iface}Resolver`;
  const field = dispatched.decl.discriminatorField;
  const camelSeam = iface.charAt(0).toLowerCase() + iface.slice(1);
  // The consumer authors the provider VALUE in a `VectorProviders` class beside
  // the `VectorAdapters` class named by 'vector-adapter-path'. Reference it by its
  // fully-qualified name unless it shares the conformance package, mirroring how
  // the monolith references the adapter class.
  const providersFqn = adapterClass.replace(/[^.]+$/, "VectorProviders");
  const providersPkg = providersFqn.includes(".")
    ? providersFqn.replace(/\.[^.]+$/, "")
    : "";
  const providersRef =
    providersPkg === packageName ? "VectorProviders" : providersFqn;

  // §8.5: sort by vector name so regen is byte-stable regardless of snapshot order.
  const sorted = [...entries].sort((left, right) =>
    (left.vector.name ?? "").localeCompare(right.vector.name ?? ""),
  );
  const needsNotNull = sorted.some(
    (entry) => typeof entry.vector.expected !== "string",
  );

  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    `// Part III TYPED @vector conformance for ${iface} — the per-interface twin of`,
    "// the per-model GeneratedTest class (issue #282 §8). Each per-vector method",
    "// builds the operation inputs from the vector JSON, reads the shape",
    `// discriminator, routes it through the emitted ${resolver} against the`,
    `// consumer-attached '${providersRef}.${camelSeam}()' provider, invokes the`,
    "// typed seam, and asserts the result reproduces `expected`. A dropped",
    "// @dispatch slot fails to compile, so conformance never silently skips.",
    "// See docs: reference/vector-conformance.",
    `package ${packageName};`,
    "",
    `public final class ${iface}ConformanceTests {`,
    `  private ${iface}ConformanceTests() { }`,
    "",
  ];

  sorted.forEach((entry, index) => {
    assertTypedDispatchSupported(entry);
    const method = javaMethodName(entry.operation);
    const paramNames = Object.keys(entry.params);
    // Sanitize operation-parameter locals the same way the models sanitize field
    // names, so a param named like a Java keyword stays a legal, consistent
    // identifier at its declaration, the discriminator head, and the call site.
    const locals = new Map(
      paramNames.map((paramName) => [paramName, javaPropertyName(paramName)]),
    );
    const fieldLocal = javaPropertyName(field);
    const accessor = javaDiscriminatorAccessor(entry.dispatch!.path, locals);
    const chunks = javaPayloadLiteralChunks(
      JSON.stringify(entry.vector.input ?? {}),
    );
    const expected = entry.vector.expected;
    const vectorName = entry.vector.name ?? `vector ${index}`;
    // A generic cast (`(Map<String, Object>) input.get(...)`) is unchecked; guard
    // the method so the conformance class compiles clean under -Xlint:unchecked.
    const needsUnchecked = paramNames.some((paramName) => {
      const shape = classifyCallableParam(entry.params[paramName]);
      return !shape.bareModel && javaScalarType(entry.params[paramName]).includes("<");
    });

    if (needsUnchecked) {
      lines.push('  @SuppressWarnings("unchecked")');
    }
    lines.push(
      `  private static void ${javaVectorSlug(index, entry)}() throws Exception {`,
      "    StringBuilder sb = new StringBuilder();",
      ...chunks.map((chunk) => `    sb.append("${chunk}");`),
      "    Object payload = TypraJson.parse(sb.toString());",
      "    java.util.Map<?, ?> input = (java.util.Map<?, ?>) payload;",
    );
    for (const paramName of paramNames) {
      const shape = classifyCallableParam(entry.params[paramName]);
      const local = locals.get(paramName);
      const key = JSON.stringify(paramName);
      if (shape.bareModel) {
        lines.push(
          `    ${entry.params[paramName]} ${local} = ${entry.params[paramName]}.load(input.get(${key}), null);`,
        );
      } else {
        // Non-model param (scalar, `Record<unknown>`, optional, array) cast from
        // the parsed map into the mapped Java type the seam signature expects.
        const javaType = javaScalarType(entry.params[paramName]);
        lines.push(`    ${javaType} ${local} = (${javaType}) input.get(${key});`);
      }
    }
    lines.push(
      `    String ${fieldLocal} = ${accessor};`,
      `    ${iface} impl = ${resolver}.resolve(${fieldLocal}, ${providersRef}.${camelSeam}());`,
      `    if (impl == null) throw new AssertionError(${JSON.stringify(
        `${vectorName}: no ${iface} attached for `,
      )} + ${fieldLocal});`,
      `    Object actual = impl.${method}(${paramNames
        .map((paramName) => locals.get(paramName))
        .join(", ")});`,
    );
    if (typeof expected === "string") {
      lines.push(
        `    assertEquals(${JSON.stringify(expected)}, actual, ${JSON.stringify(
          vectorName,
        )});`,
      );
    } else {
      // No scalar `expected` (the eligibility guard already rejects the vector
      // shapes that would need richer comparison); reaching here means the route
      // resolved and the seam ran (reproduce-before-fix).
      lines.push(`    assertNotNull(actual, ${JSON.stringify(vectorName)});`);
    }
    lines.push("  }", "");
  });

  lines.push("  public static void run() {");
  lines.push("    int failed = 0;");
  sorted.forEach((entry, index) => {
    const vectorName = entry.vector.name ?? "unnamed";
    const vectorId = `${entry.contract}.${entry.operation}:${vectorName}`;
    lines.push(
      `    failed += runCase(${JSON.stringify(
        vectorId,
      )}, ${iface}ConformanceTests::${javaVectorSlug(index, entry)});`,
    );
  });
  lines.push(
    "    if (failed > 0) {",
    `      throw new AssertionError(failed + " @vector conformance failure(s)");`,
    "    }",
    "  }",
    "",
    "  @FunctionalInterface",
    "  private interface VectorCase {",
    "    void run() throws Exception;",
    "  }",
    "",
    "  // Run one vector, mirroring the pass/fail stdout protocol the model tests use.",
    "  private static int runCase(String vectorId, VectorCase test) {",
    "    try {",
    "      test.run();",
    '      System.out.println("PASS " + vectorId);',
    "      return 0;",
    "    } catch (Throwable error) {",
    '      System.out.println("FAIL " + vectorId + ": " + error.getMessage());',
    "      return 1;",
    "    }",
    "  }",
    "",
    "  private static void assertEquals(Object expected, Object actual, String message) {",
    "    if (expected == null ? actual != null : !expected.equals(actual)) {",
    '      throw new AssertionError(message + ": expected " + expected + ", got " + actual);',
    "    }",
    "  }",
  );
  if (needsNotNull) {
    lines.push(
      "",
      "  private static void assertNotNull(Object actual, String message) {",
      "    if (actual == null) {",
      '      throw new AssertionError(message + ": expected non-null result");',
      "    }",
      "  }",
    );
  }
  lines.push("}", "");
  return lines.join("\n");
}

/**
 * Render the typed discriminator accessor a Java test reads to route a vector. The
 * first path segment is the operation parameter (a local built via `.load`, using
 * the sanitized local name); the remaining segments are the emitted models'
 * fields, sanitized the same way the models emit them (e.g.
 * `agent.template.format.kind`).
 */
function javaDiscriminatorAccessor(
  path: string,
  locals: Map<string, string>,
): string {
  const [head, ...rest] = path.split(".");
  const headLocal = locals.get(head) ?? javaPropertyName(head);
  return [headLocal, ...rest.map(javaPropertyName)].join(".");
}

/**
 * Build a unique Java method name for a vector's per-vector test. Each vector is
 * emitted as its own straight-line method (mirroring how the model/sample tests
 * inline each example) rather than iterating a monolithic embedded payload.
 */
function javaVectorSlug(
  index: number,
  entry: { contract: string; operation: string; vector: { name?: string } },
): string {
  const name = entry.vector.name ?? "unnamed";
  const raw = `${entry.contract} ${entry.operation} ${name}`;
  const camel = raw
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word, i) =>
      i === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join("");
  return `vector${index}${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}
