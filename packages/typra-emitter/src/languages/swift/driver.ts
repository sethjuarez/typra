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
import { warnFormatterUnavailable } from "../formatter-warning.js";
import {
  resolveCustomFormatters,
  runCustomFormatters,
} from "../formatter-runner.js";
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
import { buildVectorConformanceCodeModel } from "../../ir/code-model.js";

export const swiftTypeMapper: Record<string, string> = SWIFT_TYPE_MAP;

type SwiftNativeSerialization = "none" | "codable";

export const generateSwift = async (
  context: EmitContext<TypraEmitterOptions>,
  node: TypeNode,
  emitTarget: EmitTarget,
  options?: GeneratorOptions,
): Promise<void> => {
  const allTypes = Array.from(enumerateTypes(node));
  // filterNodes appends namespace-discovered `additionalModels` (types not
  // reachable from the root object). Run it first so namespace projection also
  // covers those additional models, not just the root-reachable subgraph.
  const nodes = filterNodes(allTypes, options);
  const namespaceGroupSnapshots = applyNamespaceGroups(nodes, {
    target: "swift",
    semanticRoot: options?.rootNamespace,
    emitTarget,
    namespaceOutput: options?.namespaceOutput,
  });
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
    emitSwiftPackage(moduleName, packageTestPath, emitTarget["test-resources"]),
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

  const harnessRoot = emitTarget["harness-test-dir"] ?? testRoot;
  if (harnessRoot && (options?.callableVectors?.vectors.length ?? 0) > 0) {
    // A split-package runtime can point the harness at a separate SDK/aggregate
    // package (via 'harness-test-dir') so every stage's adapter is reachable.
    // The file is still owned by this Swift target's stable outputDir root, so
    // cleanup reconciles it across config changes (a relocated, removed, or
    // now-empty harness leaves no orphan) while only ever pruning marker-owned
    // files — never the SDK's hand-written tests.
    //
    // The interpreter is emitted into a sibling VectorRunner.swift so the harness
    // stays thin. Both share the test module, so the runner's port types are
    // visible to the runtime-authored adapter file too.
    await emitSwiftGeneratedFile(
      context,
      "VectorRunner.swift",
      emitSwiftVectorRunner(),
      harnessRoot,
      outputDir,
    );
    await emitSwiftGeneratedFile(
      context,
      "VectorConformanceTests.swift",
      emitSwiftVectorConformanceTest(
        options!.callableVectors!,
        emitTarget["vector-adapter-path"] ?? "VectorAdapters",
      ),
      harnessRoot,
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
    const custom = resolveCustomFormatters(emitTarget.format);
    if (custom) {
      const testDir = testRoot
        ? resolve(process.cwd(), testRoot)
        : undefined;
      runCustomFormatters(custom, { dir: resolvedOutput, testDir });
    } else {
      formatSwiftFiles(resolvedOutput);
    }
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
  } catch (error) {
    // swift-format is optional; deterministic emitter formatting is the fallback.
    // Warn loudly so the presence-dependent output drift is attributable rather
    // than silently swallowed.
    warnFormatterUnavailable("swift-format", outputDir, error);
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

/**
 * Render a JSON payload as an ASCII-only Swift string literal. Every non-ASCII code
 * point becomes a `\u{XXXX}` escape (Swift accepts a full scalar value, so astral
 * code points need no surrogate pair), keeping generated source free of bidi
 * controls and literal multibyte characters while decoding to the exact runtime
 * string at compile time.
 */
function swiftPayloadLiteral(text: string): string {
  let out = '"';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') {
      out += '\\"';
    } else if (ch === "\\") {
      out += "\\\\";
    } else if (cp === 0x0a) {
      out += "\\n";
    } else if (cp === 0x0d) {
      out += "\\r";
    } else if (cp === 0x09) {
      out += "\\t";
    } else if (cp >= 0x20 && cp <= 0x7e) {
      out += ch;
    } else {
      out += `\\u{${cp.toString(16)}}`;
    }
  }
  return out + '"';
}

/**
 * Emit the seam-agnostic Swift `@vector` conformance interpreter
 * (VectorRunner.swift). As an emitted-type target (unlike Go/C#/Rust, which
 * import an authored seam's port types) this module OWNS the port types
 * (VectorContext/VectorError/VectorInvoke/VectorAdapter); because every file in
 * the test target shares the module, the runtime-authored adapter file resolves
 * the same types. The interpreter reads ZERO authored values: the adapter/waiver/
 * capability/doubles tables and the harness base directory all arrive through the
 * injected `VectorSeam`, so it is value-independent. A vector with no adapter and
 * no explicit waiver is a hard `XCTFail` — this suite never skips silently; a
 * non-empty waiver prints a visible `SKIP` marker and passes.
 */
function emitSwiftVectorRunner(): string {
  const lines: string[] = [
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    "// Seam-agnostic @vector behavioral conformance interpreter. This module reads",
    "// ZERO runtime-authored values; the harness injects the adapter/waiver/",
    "// capability/doubles tables and its own base directory through `VectorSeam`. A",
    "// vector with no adapter and no explicit waiver is a hard failure — conformance",
    "// never skips silently.",
    "//",
    "// EMITTED-TYPE OWNER (not Option A): unlike the nominally-typed targets",
    "// (Go/C#/Rust), which import an authored seam's port TYPES, Swift emits its own",
    "// port types here (VectorContext/VectorError/VectorInvoke/VectorAdapter). Every",
    "// file in the test target shares the module, so the runtime-authored adapter",
    "// file named by 'vector-adapter-path' resolves these same types; it supplies",
    "// only the registries, injected via VectorSeam.",
    "//",
    "// Adapter contract: `invoke` is either `.sync` (a synchronous `throws` closure)",
    "// or `.asynchronous` (an `async throws` closure that may await real runtime work",
    "// on XCTest's own runtime). The harness runs it exactly once and must not spawn",
    "// its own concurrency, keeping conformance deterministic.",
    "//",
    "// Classification is ENFORCED: an operation marked `@sync` (the sync argument",
    "// threaded from each per-vector test) must be registered with the `sync:`",
    "// initializer — an `asynchronous:` adapter is a hard failure. An async-capable",
    "// operation (the default) accepts either form.",
    "// See docs: reference/vector-conformance.",
    "",
    "import Foundation",
    "import XCTest",
    "",
    "struct VectorContext {",
    "  let contract: String",
    "  let operation: String",
    "  let vector: [String: Any]",
    "  let provider: String?",
    "  let targetApi: String?",
    "  let doubles: Any?",
    "  let baseDir: URL",
    "}",
    "",
    "struct VectorError: Error {",
    "  let message: String",
    "  let payload: Any?",
    "  init(_ message: String, payload: Any? = nil) {",
    "    self.message = message",
    "    self.payload = payload",
    "  }",
    "}",
    "",
    "// Raised when a @sync operation is wired with an asynchronous adapter. A distinct",
    "// type so the expectedError path never mistakes it for an adapter-signalled error.",
    "struct VectorClassificationError: Error, CustomStringConvertible {",
    "  let message: String",
    "  init(_ message: String) { self.message = message }",
    "  var description: String { message }",
    "}",
    "",
    "// Tagged invocation: `.sync` resolves without a runtime hop; `.asynchronous`",
    "// awaits. The tag is the @sync classification, mirroring the other targets.",
    "enum VectorInvoke {",
    "  case sync((Any?, VectorContext) throws -> Any?)",
    "  case asynchronous((Any?, VectorContext) async throws -> Any?)",
    "}",
    "",
    "struct VectorAdapter {",
    "  let invoke: VectorInvoke",
    "  let normalize: ((Any?, VectorContext) -> Any?)?",
    "  init(",
    "    sync: @escaping (Any?, VectorContext) throws -> Any?,",
    "    normalize: ((Any?, VectorContext) -> Any?)? = nil",
    "  ) {",
    "    self.invoke = .sync(sync)",
    "    self.normalize = normalize",
    "  }",
    "  init(",
    "    asynchronous: @escaping (Any?, VectorContext) async throws -> Any?,",
    "    normalize: ((Any?, VectorContext) -> Any?)? = nil",
    "  ) {",
    "    self.invoke = .asynchronous(asynchronous)",
    "    self.normalize = normalize",
    "  }",
    "}",
    "",
    "// Runtime-authored seam tables injected by the harness. The runner reads none",
    "// of these directly from the authored module; everything flows through here.",
    "// `capabilities` is populated only when a vector declares `requires` (otherwise",
    "// left nil and never consulted), keeping requirement-free harnesses",
    "// byte-identical.",
    "struct VectorSeam {",
    "  let adapters: [String: VectorAdapter]",
    "  let waivers: [String: String]",
    "  let doubles: Any?",
    "  let capabilities: [String: (VectorContext) -> Bool]?",
    "  let baseDir: URL",
    "}",
    "",
    "enum VectorRunner {",
    "  static func runVector(contract: String, operation: String, vector: [String: Any], sync: Bool, seam: VectorSeam) async -> Bool {",
    '    let operationKey = "\\(contract).\\(operation)"',
    '    let vectorName = vector["name"] as? String ?? "unnamed"',
    '    let vectorId = "\\(operationKey):\\(vectorName)"',
    "",
    "    let adapters = seam.adapters",
    "    guard let adapter = adapters[operationKey] ?? adapters[operation] else {",
    "      let waivers = seam.waivers",
    "      if let reason = waivers[operationKey] ?? waivers[operation], !reason.isEmpty {",
    '        print("SKIP \\(vectorId) (waived: \\(reason))")',
    "        return true",
    "      }",
    '      let message = "No vector adapter registered for \\(operationKey). "',
    `        + "Register it in the type referenced by 'vector-adapter-path', or add "`,
    '        + "an explicit waiver. @vector conformance never skips silently."',
    "      XCTFail(message)",
    '      print("FAIL \\(vectorId): \\(message)")',
    "      return false",
    "    }",
    "",
    "    let ctx = VectorContext(",
    "      contract: contract,",
    "      operation: operation,",
    "      vector: vector,",
    '      provider: vector["provider"] as? String,',
    '      targetApi: vector["targetApi"] as? String,',
    `      doubles: seam.doubles,`,
    "      baseDir: seam.baseDir",
    "    )",
    "",
    "    // Requirement guard (emitted unconditionally; inert when a vector declares",
    "    // no `requires`): a vector may declare abstract capability tokens in",
    "    // \"requires\". Each is resolved against the seam-injected capability table",
    "    // (populated by the harness only when some vector declares `requires`)",
    "    // BEFORE the adapter runs. An unregistered token is a hard failure",
    "    // (never skip silently); an unavailable one yields a clean skip so an absent",
    "    // credential never reaches invoke as an empty value.",
    '    let requires = vector["requires"] as? [Any] ?? []',
    "    if !requires.isEmpty {",
    "      let capabilities = seam.capabilities ?? [:]",
    "      for case let token as String in requires {",
    "        if capabilities[token] == nil {",
    '          let message = "No capability predicate registered for requirement token \\"\\(token)\\". "',
    "            + \"Register it in the type referenced by 'vector-adapter-path'. \"",
    '            + "@vector conformance never skips silently."',
    "          XCTFail(message)",
    '          print("FAIL \\(vectorId): \\(message)")',
    "          return false",
    "        }",
    "      }",
    "      for case let token as String in requires {",
    "        if let predicate = capabilities[token], !predicate(ctx) {",
    '          print("SKIP \\(vectorId) (requirement unavailable: \\(token))")',
    "          return true",
    "        }",
    "      }",
    "    }",
    "",
    "    // Per-vector waiver, consulted even when an adapter IS registered. Keyed by",
    "    // the vector id (\"Contract.operation:name\") or \"operation:name\" so it never",
    "    // collides with an operation-level waiver. xfail: a waived vector that fails",
    "    // is an expected failure (green); xpass: a waived vector that passes is a",
    "    // hard failure so stale waivers get removed.",
    "    let vectorWaivers = seam.waivers",
    '    var vectorWaiver = vectorWaivers[vectorId] ?? vectorWaivers["\\(operation):\\(vectorName)"]',
    "    if let reason = vectorWaiver, reason.isEmpty { vectorWaiver = nil }",
    "",
    "    // Evaluate WITHOUT failing the test: nil == match, non-nil == mismatch",
    "    // message, so the waiver decision below can turn a failure into an xfail.",
    "    let mismatch = await evaluateVector(adapter, vector, ctx, sync: sync, vectorId: vectorId)",
    "",
    "    if let reason = vectorWaiver {",
    "      if mismatch != nil {",
    '        print("XFAIL \\(vectorId) (waived: \\(reason))")',
    "        return true",
    "      }",
    '      let message = "XPASS \\(vectorId): waived vector unexpectedly passed; "',
    '        + "remove the waiver (\\(reason))"',
    "      XCTFail(message)",
    "      print(message)",
    "      return false",
    "    }",
    "    if let message = mismatch {",
    "      XCTFail(message)",
    '      print("FAIL \\(message)")',
    "      return false",
    "    }",
    '    print("PASS \\(vectorId)")',
    "    return true",
    "  }",
    "",
    "  // Evaluate a vector against its adapter, returning nil on a match or a",
    "  // mismatch message on any failure. Never fails the test directly so the caller",
    "  // can apply an xfail/xpass waiver decision.",
    "  private static func evaluateVector(_ adapter: VectorAdapter, _ vector: [String: Any],",
    "    _ ctx: VectorContext, sync: Bool, vectorId: String) async -> String? {",
    "    do {",
    '      let input = try resolveRefs(vector["input"], ctx.baseDir)',
    '      if vector.keys.contains("expectedError") {',
    '        let expected = vector["expectedError"] ?? NSNull()',
    "        do {",
    "          _ = try await invokeAdapter(adapter, input, ctx, sync: sync, vectorId: vectorId)",
    '          return "\\(vectorId): expected the adapter to signal an error, "',
    '            + "but it returned a value."',
    "        } catch let err as VectorError {",
    '          let observed = err.payload ?? ["message": err.message]',
    "          return vectorMismatch(vectorId, expected, normalize(adapter, observed, ctx))",
    "        }",
    "      }",
    "      let observed = try await invokeAdapter(adapter, input, ctx, sync: sync, vectorId: vectorId)",
    '      return vectorMismatch(vectorId, vector["expected"] ?? NSNull(),',
    "        normalize(adapter, observed, ctx))",
    "    } catch {",
    '      return "\\(vectorId): \\(error)"',
    "    }",
    "  }",
    "",
    "  // Exactly one invocation, with @sync classification enforced before running.",
    "  private static func invokeAdapter(_ adapter: VectorAdapter, _ input: Any?,",
    "    _ ctx: VectorContext, sync: Bool, vectorId: String) async throws -> Any? {",
    "    if sync, case .asynchronous = adapter.invoke {",
    "      throw VectorClassificationError(",
    '        "\\(vectorId): operation is @sync but its adapter is registered "',
    '        + "asynchronous. A @sync operation must resolve synchronously — register "',
    '        + "it with `sync:` (drop @sync to keep it async-capable).")',
    "    }",
    "    switch adapter.invoke {",
    "    case .sync(let f): return try f(input, ctx)",
    "    case .asynchronous(let f): return try await f(input, ctx)",
    "    }",
    "  }",
    "",
    "  private static func normalize(_ adapter: VectorAdapter, _ value: Any?,",
    "    _ ctx: VectorContext) -> Any? {",
    "    guard let normalizer = adapter.normalize else { return value }",
    "    return normalizer(value, ctx)",
    "  }",
    "",
    "  private static func vectorMismatch(_ vectorId: String, _ expected: Any?,",
    "    _ observed: Any?) -> String? {",
    "    let left = canonical(expected)",
    "    let right = canonical(observed)",
    "    if left != right {",
    '      return "\\(vectorId): expected \\(left) but got \\(right)"',
    "    }",
    "    return nil",
    "  }",
    "",
    "  private static func resolveRefs(_ value: Any?, _ dir: URL) throws -> Any? {",
    "    if let arr = value as? [Any] {",
    "      return try arr.map { try resolveRefs($0, dir) }",
    "    }",
    "    if let obj = value as? [String: Any] {",
    "      if obj.count == 1, let (key, inner) = obj.first, let raw = inner as? String {",
    "        switch key {",
    '        case "$env":',
    "          return ProcessInfo.processInfo.environment[raw] ?? \"\"",
    '        case "$file":',
    "          return try String(contentsOf: dir.appendingPathComponent(raw),",
    "            encoding: .utf8)",
    '        case "$json":',
    "          let text = try String(contentsOf: dir.appendingPathComponent(raw),",
    "            encoding: .utf8)",
    "          return try JSONSerialization.jsonObject(with: Data(text.utf8))",
    "        default:",
    "          break",
    "        }",
    "      }",
    "      var out: [String: Any] = [:]",
    "      for (mapKey, mapValue) in obj {",
    "        out[mapKey] = try resolveRefs(mapValue, dir)",
    "      }",
    "      return out",
    "    }",
    "    return value",
    "  }",
    "",
    "  private static func canonical(_ value: Any?) -> String {",
    '    guard let value = value, !(value is NSNull) else { return "null" }',
    "    if let dict = value as? [String: Any] {",
    "      let parts = dict.keys.sorted().map {",
    '        canonicalString($0) + ":" + canonical(dict[$0] ?? NSNull())',
    "      }",
    '      return "{" + parts.joined(separator: ",") + "}"',
    "    }",
    "    if let arr = value as? [Any] {",
    '      return "[" + arr.map { canonical($0) }.joined(separator: ",") + "]"',
    "    }",
    "    if let text = value as? String {",
    "      return canonicalString(text)",
    "    }",
    "    if let num = value as? NSNumber {",
    "      let objcType = String(cString: num.objCType)",
    '      if objcType == "c" || objcType == "B" {',
    '        return num.boolValue ? "true" : "false"',
    "      }",
    '      if objcType == "d" || objcType == "f" {',
    "        return String(num.doubleValue)",
    "      }",
    "      return num.stringValue",
    "    }",
    "    if let flag = value as? Bool { return flag ? \"true\" : \"false\" }",
    "    if let int = value as? Int { return String(int) }",
    "    if let dbl = value as? Double { return String(dbl) }",
    "    // A value that is not JSON-representable can never equal a canonical JSON",
    "    // scalar, so surface it as an unquoted sentinel that forces a mismatch",
    "    // rather than risk a false match against an expected string.",
    '    return "<unencodable: \\(type(of: value))>"',
    "  }",
    "",
    "  private static func canonicalString(_ text: String) -> String {",
    '    var out = "\\""',
    "    for scalar in text.unicodeScalars {",
    "      switch scalar {",
    '      case "\\"": out += "\\\\\\""',
    '      case "\\\\": out += "\\\\\\\\"',
    '      case "\\n": out += "\\\\n"',
    '      case "\\r": out += "\\\\r"',
    '      case "\\t": out += "\\\\t"',
    "      default:",
    "        if scalar.value < 0x20 {",
    '          out += String(format: "\\\\u%04x", scalar.value)',
    "        } else {",
    "          out.unicodeScalars.append(scalar)",
    "        }",
    "      }",
    "    }",
    '    return out + "\\""',
    "  }",
    "}",
    "",
  ];

  return lines.join("\n");
}

/**
 * Emit the thin Swift `@vector` conformance harness (VectorConformanceTests.swift).
 * The interpreter lives in the sibling VectorRunner module; this suite only loads
 * the runtime-authored registry (an enum named by the target's
 * `vector-adapter-path` option, default `VectorAdapters`), assembles the seam it
 * owns, and injects it into `VectorRunner.runVector` per vector. `baseDir()` stays
 * here so `$file`/`$json` inputs resolve relative to the test process. Per
 * Decision #3 the capability table is loaded into the seam only when a vector
 * declares `requires`, so requires-free harnesses regenerate byte-identical. The
 * harness parses and canonicalizes the embedded vectors with Foundation's
 * `JSONSerialization`, so it is independent of the model's serialization mode.
 */
function emitSwiftVectorConformanceTest(
  vectors: NonNullable<GeneratorOptions["callableVectors"]>,
  adapterEnum: string,
): string {
  const model = buildVectorConformanceCodeModel(vectors);
  const hasRequires = model.vectors.some(
    (entry) => (entry.vector.requires?.length ?? 0) > 0,
  );

  const lines: string[] = [
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    "// Thin @vector behavioral conformance harness. The interpreter lives in the",
    "// sibling VectorRunner module; this suite only loads the runtime-authored",
    `// '${adapterEnum}' registry named by the target's 'vector-adapter-path' option,`,
    "// assembles the seam it owns, and injects it into VectorRunner.runVector. A",
    "// vector with no adapter and no explicit waiver is a hard failure — conformance",
    "// never skips silently.",
    "// See docs: reference/vector-conformance.",
    "",
    "import Foundation",
    "import XCTest",
    "",
    "final class VectorConformanceTests: XCTestCase {",
    "  // Resolves $file/$json vector inputs relative to the test process (computed",
    "  // here, not in the runner, so it points at the test environment).",
    "  private func baseDir() -> URL {",
    '    let dir = ProcessInfo.processInfo.environment["TYPRA_VECTOR_BASE_DIR"]',
    "      ?? FileManager.default.currentDirectoryPath",
    "    return URL(fileURLWithPath: dir)",
    "  }",
    "",
    "  // Assembles the runtime-authored seam the runner interprets. It reads the",
    `  // authored registries from the ${adapterEnum} enum and injects them; the`,
    "  // runner itself reads none of these directly.",
    "  private func seam() -> VectorSeam {",
    "    VectorSeam(",
    `      adapters: ${adapterEnum}.adapters(),`,
    `      waivers: ${adapterEnum}.waivers(),`,
    `      doubles: ${adapterEnum}.doubles(),`,
    hasRequires
      ? `      capabilities: ${adapterEnum}.capabilities(),`
      : "      capabilities: nil,",
    "      baseDir: baseDir()",
    "    )",
    "  }",
    "",
  ];

  model.vectors.forEach((entry, index) => {
    const vectorLiteral = swiftPayloadLiteral(JSON.stringify(entry.vector));
    lines.push(
      `  func ${swiftVectorSlug(index, entry)}() async throws {`,
      `    guard let vectorData = ${vectorLiteral}.data(using: .utf8),`,
      "      let vector = try JSONSerialization.jsonObject(with: vectorData) as? [String: Any]",
      "    else {",
      '      XCTFail("failed to parse embedded vector")',
      "      return",
      "    }",
      `    _ = await VectorRunner.runVector(contract: ${JSON.stringify(
        entry.contract,
      )}, operation: ${JSON.stringify(
        entry.operation,
      )}, vector: vector, sync: ${entry.sync ? "true" : "false"}, seam: seam())`,
      "  }",
      "",
    );
  });
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/**
 * Build a unique XCTest method name for a vector. XCTest discovers methods whose
 * name begins with `test`, so each vector gets its own `testVectorN…` method.
 */
function swiftVectorSlug(
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
  return `testVector${index}${pascal || "Unnamed"}`;
}
