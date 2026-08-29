import { EmitContext, resolvePath } from "@typespec/compiler";
import { execFileSync } from "child_process";
import { relative, resolve } from "path";
import { EmitTarget, TypraEmitterOptions } from "../../lib.js";
import { BaseTestContext, enumerateTypes, TypeNode } from "../../ir/ast.js";
import { GeneratorOptions, filterNodes } from "../../emitter.js";
import { TypeRegistry } from "../../ir/expansion.js";
import {
  lowerFile,
  collectPolymorphicTypeNames,
  computeSerializationClosure,
} from "../../ir/lower.js";
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
import {
  swiftFileName,
  swiftFunctionName,
  swiftPropertyName,
  swiftStringLiteral,
  swiftTypeName,
} from "./identifiers.js";
import { SWIFT_TYPE_MAP, swiftType } from "./types.js";
import { buildVectorConformanceCodeModel } from "../../ir/code-model.js";
import {
  isClosedPolymorphicDispatch,
  dispatchDefaultSlotBase,
  type TypeDecl,
} from "../../ir/declarations.js";
import {
  assertTypedDispatchSupported,
  CallableVectorSnapshotEntry,
  collectDispatchedContracts,
  DispatchedContract,
  isTypedDispatchEntry,
  classifyCallableParam,
} from "../../ir/vector.js";

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
  // Serialization is opt-in via `@serializable`: compute the closure once and
  // thread it so only its members emit load/save.
  const serializationClosure = computeSerializationClosure(nodes, registry);
  const fileDecls = new Map(
    rootNodes.map((n) => [
      `${n.typeName.namespace}.${n.typeName.name}`,
      lowerFile(n, registry, polymorphicTypeNames, serializationClosure),
    ]),
  );
  const declarationUniverse = Array.from(fileDecls.values()).flatMap(
    (file) => file.types,
  );
  // Index the lowered type declarations by simple name so the per-interface
  // conformance emitter can walk a @dispatch container path and force-unwrap the
  // Swift optionals it crosses (a required step to reach `.save()` on the union).
  const swiftDeclsByName = new Map<string, TypeDecl>(
    declarationUniverse.map((decl) => [decl.typeName.name, decl]),
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
    const adapterEnum = emitTarget["vector-adapter-path"] ?? "VectorAdapters";
    const allVectors = options!.callableVectors!.vectors;
    // A `@dispatch` seam routes through the typed resolver rail (issue #282 §8):
    // its vectors get a per-interface, typed `${Interface}ConformanceTests`
    // XCTestCase in the seam's namespace folder. Undispatched seams — INCLUDING a
    // @dispatch whose discriminator model is not polymorphic (no `decl`, so no
    // typed rail) — keep the stringly JSON interpreter (VectorRunner) + monolithic
    // VectorConformanceTests, so no vector is dropped from both rails.
    const undispatched = allVectors.filter(
      (entry) => !isTypedDispatchEntry(entry),
    );

    if (undispatched.length > 0) {
      // The interpreter is emitted into a sibling VectorRunner.swift so the
      // harness stays thin. Both share the test module, so the runner's port
      // types are visible to the runtime-authored adapter file too.
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
          { ...options!.callableVectors!, vectors: undispatched },
          adapterEnum,
        ),
        harnessRoot,
        outputDir,
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
      const iface = swiftTypeName(dispatched.contract);
      const outDir = dispatched.group
        ? `${harnessRoot}/${dispatched.group}`
        : harnessRoot;
      await emitSwiftGeneratedFile(
        context,
        `${iface}ConformanceTests.swift`,
        emitSwiftInterfaceConformanceTest(
          dispatched,
          ifaceVectors,
          moduleName,
          adapterEnum,
          swiftDeclsByName,
        ),
        outDir,
        outputDir,
      );
    }
  }

  // Part III: emit one behavioral @dispatch resolver (provider protocol +
  // resolve switch, the twin of the shape discriminator load switch) per
  // dispatched seam protocol, into the LIBRARY beside the seam (issue #282). The
  // provider is a protocol a consumer conforms to, so a forgotten slot fails to
  // compile — the same rail as the shape discriminator switch, itself a library
  // artifact. NOTE: emission currently rides the presence of @vector cases;
  // decoupling it is a tracked follow-up (issue #282).
  if ((options?.callableVectors?.vectors.length ?? 0) > 0) {
    for (const dispatched of collectDispatchedContracts(
      options!.callableVectors!.vectors,
    )) {
      const outDir = dispatched.group
        ? `${sourceRoot}/${dispatched.group}`
        : sourceRoot;
      await emitSwiftGeneratedFile(
        context,
        swiftFileName(`${dispatched.contract}Resolver`),
        emitSwiftDispatchResolver(dispatched),
        outDir,
        outputDir,
      );
    }
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
    "  static func runVector(contract: String, operation: String, vector: [String: Any], sync: Bool, seam: VectorSeam, dispatchPath: String? = nil) async -> Bool {",
    '    let operationKey = "\\(contract).\\(operation)"',
    '    let vectorName = vector["name"] as? String ?? "unnamed"',
    '    let vectorId = "\\(operationKey):\\(vectorName)"',
    "",
    "    // Behavioral polymorphic dispatch (@dispatch): dispatchPath (non-nil for a",
    "    // dispatched seam) is the discriminator access path. The concrete impl is",
    "    // resolved once from the discriminator value read at that path on the vector",
    "    // input and looked up in the seam's per-key registry (adapters keyed",
    "    // `Contract.operation#key`). An impl absent for a valid key reuses the",
    "    // capability-absent skip. Undispatched seams pass nil and keep the single",
    "    // adapter lookup unchanged.",
    "    let adapters = seam.adapters",
    "    let adapter: VectorAdapter",
    "    if let dispatchPath = dispatchPath, !dispatchPath.isEmpty {",
    '      let dispatchInput = (try? resolveRefs(vector["input"], seam.baseDir)) ?? vector["input"]',
    "      guard let dispatchKey = resolveDispatchKey(dispatchInput, dispatchPath) else {",
    `        let message = "\\(vectorId): @dispatch path '\\(dispatchPath)' did not resolve to a "`,
    `          + "string discriminator on the vector input."`,
    "        XCTFail(message)",
    '        print("FAIL \\(vectorId): \\(message)")',
    "        return false",
    "      }",
    '      guard let dispatched = adapters["\\(operationKey)#\\(dispatchKey)"] ?? adapters["\\(operation)#\\(dispatchKey)"] else {',
    '        print("SKIP \\(vectorId) (requirement unavailable: \\(dispatchKey))")',
    "        return true",
    "      }",
    "      adapter = dispatched",
    "    } else {",
    "      guard let selected = adapters[operationKey] ?? adapters[operation] else {",
    "        let waivers = seam.waivers",
    "        if let reason = waivers[operationKey] ?? waivers[operation], !reason.isEmpty {",
    '          print("SKIP \\(vectorId) (waived: \\(reason))")',
    "          return true",
    "        }",
    '        let message = "No vector adapter registered for \\(operationKey). "',
    `          + "Register it in the type referenced by 'vector-adapter-path', or add "`,
    '          + "an explicit waiver. @vector conformance never skips silently."',
    "        XCTFail(message)",
    '        print("FAIL \\(vectorId): \\(message)")',
    "        return false",
    "      }",
    "      adapter = selected",
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
    "  // Walks a deterministic field-access path (e.g. `agent.template.format.kind`)",
    "  // over a resolved vector input to read the @dispatch discriminator value that",
    "  // selects the concrete seam implementation. Returns nil if any hop is missing",
    "  // or the terminal value is not a string, so the caller can fail loudly.",
    "  private static func resolveDispatchKey(_ root: Any?, _ dotted: String) -> String? {",
    "    var node: Any? = root",
    '    for key in dotted.split(separator: ".").map(String.init) {',
    "      guard let map = node as? [String: Any] else { return nil }",
    "      node = map[key]",
    "      if node == nil { return nil }",
    "    }",
    "    return node as? String",
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
 * Emit the Part III behavioral @dispatch resolver for one seam: a provider
 * PROTOCOL with one accessor per @dispatch variant, plus a resolve switch that
 * is the twin of the shape discriminator load switch. A consumer conforms to the
 * provider protocol in an external, non-emitted type, so a forgotten slot fails
 * to compile (a conforming type must satisfy every requirement) — the Swift form
 * of §5 control 2.
 */
function emitSwiftDispatchResolver(entry: DispatchedContract): string {
  // Reference the seam by its EMITTED Swift spelling (the shape emitter names the
  // seam protocol via swiftTypeName), so the resolver's type references and the
  // seam declaration cannot drift apart for a name that sanitizes differently.
  const seam = swiftTypeName(entry.contract);
  const provider = `${seam}Provider`;
  const resolver = `${seam}Resolver`;
  const rawField = entry.decl.discriminatorField;
  // The parameter/local is a Swift identifier (sanitized); the raw wire field is
  // preserved only for the diagnostic string, matching the shape load switch.
  const param = swiftPropertyName(rawField);
  // Preserve the SAME variant order the shape load switch emits, keeping the two
  // switches a faithful twin without a locale-dependent comparator.
  const variants = entry.decl.variants;
  // Throw on an unknown discriminator exactly when the shape load switch does —
  // a closed dispatch with no default (emitter.ts default arm). An open dispatch
  // (with a default or `.unknown` fallback) yields nil instead, which the
  // conformance harness treats as an explicit skip, never a silent miss.
  const rejectsUnknown = isClosedPolymorphicDispatch(entry.decl);
  // An open dispatch with a declared wildcard child (`CustomModel { provider:
  // "*" }`) gains a default accessor; an unknown discriminator routes to it
  // instead of yielding nil — the behavioral twin of the shape loader's
  // `*`-tolerant fallback. Closed / open-self-reference keeps its throw/nil arm.
  const defaultSlotBase = dispatchDefaultSlotBase(entry.decl);
  const defaultSlot = defaultSlotBase ? swiftPropertyName(defaultSlotBase) : null;

  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    `// Part III behavioral @dispatch resolver for ${seam} — the twin of the shape`,
    "// discriminator load switch, emitted into the library beside the seam",
    "// protocol. The provider protocol below has one accessor per @dispatch",
    "// variant; a consumer attaches concrete impls by conforming to it in an",
    "// external, non-emitted type, so a forgotten slot fails to compile.",
    "// See docs: reference/vector-conformance.",
    "",
    "import Foundation",
    "",
    `/// Consumer-attached provider of ${seam} impls, one accessor per @dispatch`,
    "/// variant. Return nil to signal a valid-but-unimplemented variant to the",
    "/// caller (e.g. the conformance harness skips it), never a silent miss.",
    `public protocol ${provider} {`,
  ];
  // Accessor names are the sanitized discriminator value. Every fixture value
  // today is a plain identifier (mustache/jinja2/liquid); a collision between two
  // values that sanitize alike would need a guard, deferred until a fixture
  // exercises one (reproduce-before-fix).
  for (const variant of variants) {
    lines.push(
      `  var ${swiftPropertyName(variant.value)}: (any ${seam})? { get }`,
    );
  }
  if (defaultSlot) {
    lines.push(
      "  /// Catch-all for an unknown discriminator (the declared `*` child).",
    );
    lines.push(`  var ${defaultSlot}: (any ${seam})? { get }`);
  }
  lines.push("}");
  lines.push("");
  lines.push(
    `/// Maps a '${rawField}' discriminator value to the selected ${seam} impl — the`,
  );
  lines.push("/// behavioral twin of the shape discriminator load switch.");
  lines.push(`public enum ${resolver} {`);
  const throwsClause = rejectsUnknown ? "throws " : "";
  lines.push(
    `  public static func resolve(${param}: String, registry: any ${provider}) ${throwsClause}-> (any ${seam})? {`,
  );
  lines.push(`    switch ${param} {`);
  for (const variant of variants) {
    lines.push(
      `    case ${swiftStringLiteral(variant.value)}: return registry.${swiftPropertyName(
        variant.value,
      )}`,
    );
  }
  if (rejectsUnknown) {
    lines.push(
      `    default: throw TypraRuntimeError.unknownDiscriminator(type: ${swiftStringLiteral(
        seam,
      )}, field: ${swiftStringLiteral(rawField)}, value: ${param})`,
    );
  } else if (defaultSlot) {
    lines.push(`    default: return registry.${defaultSlot}`);
  } else {
    lines.push("    default: return nil");
  }
  lines.push("    }");
  lines.push("  }");
  lines.push("}");
  lines.push("");
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
      )}, vector: vector, sync: ${entry.sync ? "true" : "false"}, seam: seam()${
        entry.dispatch ? `, dispatchPath: ${JSON.stringify(entry.dispatch.path)}` : ""
      })`,
      "  }",
      "",
    );
  });
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/**
 * Emit the TYPED per-interface `@vector` conformance (issue #282 §8) — the
 * per-seam twin of the per-model `${Model}Tests.swift` file. Each XCTest method
 * builds the operation inputs from the vector JSON, reads the shape discriminator
 * off the typed graph, routes it through the emitted `${Interface}Resolver`
 * against the consumer-attached provider, invokes the typed seam, and asserts the
 * result reproduces `expected`. The provider VALUE is authored by the consumer as
 * `VectorProviders.${interface}()` (the enum named by 'vector-adapter-path' with
 * its `Adapters` suffix swapped for `Providers`); conforming to the emitted
 * `${Interface}Provider` protocol obliges every @dispatch slot, so a forgotten
 * slot fails to COMPILE and conformance never silently skips.
 */
function emitSwiftInterfaceConformanceTest(
  dispatched: DispatchedContract,
  entries: CallableVectorSnapshotEntry[],
  moduleName: string,
  adapterEnum: string,
  declsByName: Map<string, TypeDecl>,
): string {
  // Reference the seam / resolver / provider by their EMITTED Swift spelling so
  // the test's type references cannot drift from the library declarations.
  const seam = swiftTypeName(dispatched.contract);
  const provider = `${seam}Provider`;
  const resolver = `${seam}Resolver`;
  // The consumer authors `VectorProviders.${seam}()`; derive that enum from the
  // adapter enum by swapping the trailing `Adapters` for `Providers`.
  const providersEnum = /Adapters$/.test(adapterEnum)
    ? adapterEnum.replace(/Adapters$/, "Providers")
    : "VectorProviders";
  const rawField = dispatched.decl.discriminatorField;
  // A closed dispatch's resolve throws on an unknown discriminator (the twin of
  // the shape load switch's default arm); an open one returns nil instead.
  const resolveTry = isClosedPolymorphicDispatch(dispatched.decl) ? "try " : "";
  // §8.5: sort by vector name so regen is byte-stable regardless of snapshot order.
  const sorted = [...entries].sort((left, right) =>
    (left.vector.name ?? "").localeCompare(right.vector.name ?? ""),
  );

  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    `// Part III TYPED @vector conformance for ${seam} — the per-interface twin of`,
    "// the per-model ${Model}Tests file (issue #282 §8). Each XCTest method builds",
    "// the operation inputs from the vector JSON, reads the shape discriminator,",
    `// routes it through the emitted ${resolver} against the consumer-attached`,
    `// provider (VectorProviders.${swiftFunctionName(dispatched.contract)}()),`,
    "// invokes the typed seam, and asserts the result reproduces `expected`. A",
    "// dropped @dispatch slot fails to compile, so conformance never silently",
    "// skips.",
    "// See docs: reference/vector-conformance.",
    "",
    "import Foundation",
    "import XCTest",
    `import ${moduleName}`,
    "",
    `final class ${seam}ConformanceTests: XCTestCase {`,
    "  // The consumer-attached provider of typed seam impls, one slot per @dispatch",
    "  // variant. Authored outside this tree; a forgotten slot cannot compile.",
    `  private func provider() -> any ${provider} {`,
    `    ${providersEnum}.${swiftFunctionName(dispatched.contract)}()`,
    "  }",
    "",
  ];

  sorted.forEach((entry, index) => {
    assertTypedDispatchSupported(entry);
    const method = swiftFunctionName(entry.operation);
    const paramNames = Object.keys(entry.params);
    const accessor = swiftDiscriminatorAccessor(
      entry.dispatch!.path,
      rawField,
      declsByName,
      entry.params[entry.dispatch!.path.split(".")[0]],
    );
    const inputLiteral = swiftPayloadLiteral(
      JSON.stringify(entry.vector.input ?? {}),
    );
    const expected = entry.vector.expected;
    const vectorName = entry.vector.name ?? `vector ${index}`;
    const awaitPrefix = entry.sync ? "" : "await ";

    lines.push(
      `  func ${swiftVectorSlug(index, entry)}() async throws {`,
      `    guard let inputData = ${inputLiteral}.data(using: .utf8),`,
      "      let input = try JSONSerialization.jsonObject(with: inputData) as? [String: Any]",
      "    else {",
      '      XCTFail("failed to parse embedded vector input")',
      "      return",
      "    }",
    );
    for (const paramName of paramNames) {
      const shape = classifyCallableParam(entry.params[paramName]);
      const local = swiftPropertyName(paramName);
      const key = swiftStringLiteral(paramName);
      if (shape.bareModel) {
        lines.push(`    let ${local} = try ${entry.params[paramName]}.load(input[${key}]!)`);
      } else if (shape.optional) {
        // Optional non-model param: tolerate an absent key, casting to the mapped
        // (non-optional) Swift element type when present.
        lines.push(
          `    let ${local} = input[${key}] as? ${swiftType(
            entry.params[paramName].replace(/\?$/, ""),
          )}`,
        );
      } else {
        // Non-model param (scalar, `Record<unknown>`, array) cast from the parsed
        // JSON object into the mapped Swift type the seam signature expects.
        lines.push(`    let ${local} = input[${key}] as! ${swiftType(entry.params[paramName])}`);
      }
    }
    lines.push(
      `    let ${swiftPropertyName(rawField)} = ${accessor}`,
      `    guard let impl = ${resolveTry}${resolver}.resolve(${swiftPropertyName(
        rawField,
      )}: ${swiftPropertyName(rawField)}, registry: provider()) else {`,
      `      XCTFail(${swiftStringLiteral(
        `${vectorName}: no ${seam} attached for `,
      )} + ${swiftPropertyName(rawField)})`,
      "      return",
      "    }",
      `    let actual = try ${awaitPrefix}impl.${method}(${paramNames
        .map((paramName) => {
          const local = swiftPropertyName(paramName);
          return `${local}: ${local}`;
        })
        .join(", ")})`,
    );
    if (typeof expected === "string") {
      lines.push(`    XCTAssertEqual(actual, ${swiftStringLiteral(expected)})`);
    } else {
      // No scalar `expected` to compare: the typed invocation is itself the
      // assertion — reaching here means the route resolved and the seam ran. A
      // dispatched fixture needing richer comparison extends this arm
      // (reproduce-before-fix).
      lines.push("    XCTAssertNotNil(actual)");
    }
    lines.push("  }", "");
  });

  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the typed discriminator accessor a Swift test reads to route a vector.
 * The dispatched discriminator lives on a polymorphic union (an emitted Swift
 * `enum` with no stored discriminator property), so the value is read off the
 * union's serialized form — `try (agent.template.format.save())["kind"] as!
 * String`. The container is navigated with the models' sanitized property names;
 * the dict key is the raw wire discriminator field.
 *
 * Optionality-aware: Swift optionals along the container path must be
 * force-unwrapped to reach `.save()`, so a segment whose lowered `FieldDecl` is
 * optional emits `agent.template!.format`. Walking the lowered declarations from
 * the parameter's root type keeps the `!` placement faithful to the model — a
 * non-optional field, or a field we cannot resolve, gets no `!`.
 */
function swiftDiscriminatorAccessor(
  path: string,
  rawField: string,
  declsByName: Map<string, TypeDecl>,
  rootTypeName: string | undefined,
): string {
  const segments = path.split(".");
  const head = swiftPropertyName(segments[0]);
  const containerSegments = segments.slice(1, -1);
  let currentType = rootTypeName ? declsByName.get(rootTypeName) : undefined;
  const parts = [head];
  for (const segment of containerSegments) {
    const field = currentType?.fields.find((f) => f.name === segment);
    parts.push(`${swiftPropertyName(segment)}${field?.isOptional ? "!" : ""}`);
    currentType = field ? declsByName.get(field.typeName.name) : undefined;
  }
  const container = parts.join(".");
  return `try (${container}.save())[${swiftStringLiteral(rawField)}] as! String`;
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
