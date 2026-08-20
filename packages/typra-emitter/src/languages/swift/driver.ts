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

  if (testRoot && (options?.callableVectors?.vectors.length ?? 0) > 0) {
    await emitSwiftGeneratedFile(
      context,
      "VectorConformanceTests.swift",
      emitSwiftVectorConformanceTest(
        options!.callableVectors!,
        emitTarget["vector-adapter-path"] ?? "VectorAdapters",
      ),
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
    const custom = resolveCustomFormatters(emitTarget.format);
    if (custom) {
      runCustomFormatters(custom, { dir: resolvedOutput });
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
 * Emit the Swift closed-loop `@vector` behavioral conformance suite. Each vector is
 * replayed through a runtime-authored registry (an enum named by the target's
 * `vector-adapter-path` option, default `VectorAdapters`) that lives beside the
 * generated files in the same test target. A vector with no adapter and no explicit
 * waiver is a hard `XCTFail` — this suite never skips silently; a non-empty waiver
 * prints a visible `SKIP` marker and passes. The harness parses and canonicalizes
 * the embedded vectors with Foundation's `JSONSerialization`, so it is independent
 * of the model's serialization mode.
 */
function emitSwiftVectorConformanceTest(
  vectors: NonNullable<GeneratorOptions["callableVectors"]>,
  adapterEnum: string,
): string {
  const model = buildVectorConformanceCodeModel(vectors);
  const payload = swiftPayloadLiteral(JSON.stringify(model.vectors));

  return [
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    "// Enforced @vector behavioral conformance. Each vector is replayed through a",
    `// runtime-authored '${adapterEnum}' registry named by the target's`,
    "// 'vector-adapter-path' option. A vector with no adapter and no explicit waiver",
    "// is a hard failure — this suite never skips silently.",
    "// See docs: reference/vector-conformance.",
    "",
    "import Foundation",
    "import XCTest",
    "",
    `private let typraVectorPayload = ${payload}`,
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
    "struct VectorAdapter {",
    "  let invoke: (Any?, VectorContext) throws -> Any?",
    "  let normalize: ((Any?, VectorContext) -> Any?)?",
    "  init(",
    "    _ invoke: @escaping (Any?, VectorContext) throws -> Any?,",
    "    normalize: ((Any?, VectorContext) -> Any?)? = nil",
    "  ) {",
    "    self.invoke = invoke",
    "    self.normalize = normalize",
    "  }",
    "}",
    "",
    "final class VectorConformanceTests: XCTestCase {",
    "  func testVectorConformance() throws {",
    "    guard let data = typraVectorPayload.data(using: .utf8),",
    "      let entries = try JSONSerialization.jsonObject(with: data) as? [Any]",
    "    else {",
    '      XCTFail("failed to parse embedded vectors")',
    "      return",
    "    }",
    "    var failures = 0",
    "    for raw in entries {",
    "      guard let entry = raw as? [String: Any] else {",
    '        XCTFail("vector entry is not an object: \\(raw)")',
    '        print("FAIL <malformed>: vector entry is not an object")',
    "        failures += 1",
    "        continue",
    "      }",
    "      if !runVector(entry) { failures += 1 }",
    "    }",
    '    XCTAssertEqual(failures, 0, "\\(failures) @vector conformance failure(s)")',
    "  }",
    "",
    "  private func baseDir() -> URL {",
    '    let dir = ProcessInfo.processInfo.environment["TYPRA_VECTOR_BASE_DIR"]',
    "      ?? FileManager.default.currentDirectoryPath",
    "    return URL(fileURLWithPath: dir)",
    "  }",
    "",
    "  private func runVector(_ entry: [String: Any]) -> Bool {",
    '    let contract = entry["contract"] as? String ?? ""',
    '    let operation = entry["operation"] as? String ?? ""',
    '    let operationKey = "\\(contract).\\(operation)"',
    '    let vector = entry["vector"] as? [String: Any] ?? [:]',
    '    let vectorName = vector["name"] as? String ?? "unnamed"',
    '    let vectorId = "\\(operationKey):\\(vectorName)"',
    "",
    `    let adapters = ${adapterEnum}.adapters()`,
    "    guard let adapter = adapters[operationKey] ?? adapters[operation] else {",
    `      let waivers = ${adapterEnum}.waivers()`,
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
    `      doubles: ${adapterEnum}.doubles(),`,
    "      baseDir: baseDir()",
    "    )",
    "    do {",
    '      let input = try resolveRefs(vector["input"], ctx.baseDir)',
    '      if vector.keys.contains("expectedError") {',
    '        let expected = vector["expectedError"] ?? NSNull()',
    "        do {",
    "          _ = try adapter.invoke(input, ctx)",
    '          let message = "\\(vectorId): expected the adapter to signal an error, "',
    '            + "but it returned a value."',
    "          XCTFail(message)",
    '          print("FAIL \\(message)")',
    "          return false",
    "        } catch let err as VectorError {",
    '          let observed = err.payload ?? ["message": err.message]',
    "          return assertEqual(vectorId, expected, normalize(adapter, observed, ctx))",
    "        }",
    "      }",
    "      let observed = try adapter.invoke(input, ctx)",
    '      return assertEqual(vectorId, vector["expected"] ?? NSNull(),',
    "        normalize(adapter, observed, ctx))",
    "    } catch {",
    '      XCTFail("\\(vectorId): \\(error)")',
    '      print("FAIL \\(vectorId): \\(error)")',
    "      return false",
    "    }",
    "  }",
    "",
    "  private func normalize(_ adapter: VectorAdapter, _ value: Any?,",
    "    _ ctx: VectorContext) -> Any? {",
    "    guard let normalizer = adapter.normalize else { return value }",
    "    return normalizer(value, ctx)",
    "  }",
    "",
    "  private func assertEqual(_ vectorId: String, _ expected: Any?,",
    "    _ observed: Any?) -> Bool {",
    "    let left = canonical(expected)",
    "    let right = canonical(observed)",
    "    if left != right {",
    '      let message = "\\(vectorId): expected \\(left) but got \\(right)"',
    "      XCTFail(message)",
    '      print("FAIL \\(message)")',
    "      return false",
    "    }",
    '    print("PASS \\(vectorId)")',
    "    return true",
    "  }",
    "",
    "  private func resolveRefs(_ value: Any?, _ dir: URL) throws -> Any? {",
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
    "  private func canonical(_ value: Any?) -> String {",
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
    "  private func canonicalString(_ text: String) -> String {",
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
  ].join("\n");
}
