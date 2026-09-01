import { EmitContext, resolvePath } from "@typespec/compiler";
import { execFileSync } from "child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { resolve } from "path";
import { EmitTarget, TypraEmitterOptions } from "../../lib.js";
import { BaseTestContext, enumerateTypes, TypeNode } from "../../ir/ast.js";
import { GeneratorOptions, filterNodes } from "../../emitter.js";
import { TypeRegistry } from "../../ir/expansion.js";
import { RustExprVisitor } from "./visitor.js";
import {
  buildBaseTestContext,
  rustTestOptions,
} from "../../testing/test-context.js";
import { toSnakeCase } from "../../ir/utilities.js";
import { scalarRuntimeKind } from "../../ir/scalar-kinds.js";
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
  isBridgeEligible,
} from "../../ir/vector.js";
import {
  lowerFile,
  collectPolymorphicTypeNames,
  computeSerializationClosure,
} from "../../ir/lower.js";
import {
  emitRustFile as emitRustFileDecl,
  RUST_ALLOW_ATTR,
  protocolRustType,
} from "./emitter.js";
import { emitGeneratedFile } from "../../cleanup/generated-file.js";
import {
  resolveCustomFormatters,
  runCustomFormatters,
} from "../formatter-runner.js";
import {
  applyNamespaceGroups,
  projectNamespace,
  restoreNamespaceGroups,
} from "../../ir/namespace.js";
import {
  collectProtocolNodes,
  emitRustProtocolScaffolds,
  shouldEmitCompileOnlyProtocolScaffolds,
} from "../../protocol-scaffolds.js";
import { buildVectorConformanceCodeModel } from "../../ir/code-model.js";

/**
 * Type mapping from TypeSpec scalar types to Rust types.
 * Retained for use by the test template context.
 */
export const rustTypeMapper: Record<string, string> = {
  string: "String",
  number: "f64",
  array: "Vec<serde_json::Value>",
  object: "serde_json::Value",
  boolean: "bool",
  int64: "i64",
  int32: "i32",
  float64: "f64",
  float32: "f32",
  integer: "i64",
  float: "f64",
  numeric: "f64",
  any: "serde_json::Value",
  dictionary: "serde_json::Value",
};

const RUST_KEYWORDS = new Set([
  "as",
  "break",
  "const",
  "continue",
  "crate",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "async",
  "await",
  "dyn",
]);

function rustFieldName(name: string): string {
  const snake = toSnakeCase(name);
  return RUST_KEYWORDS.has(snake) ? `r#${snake}` : snake;
}

/**
 * Stale generated files are removed centrally by `pruneStaleGeneratedFiles`, which uses the
 * previous run's manifest to decide ownership rather than guessing from file names.
 */

/**
 * Main entry point for Rust code generation.
 */
export const generateRust = async (
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
    target: "rust",
    semanticRoot: options?.rootNamespace,
    emitTarget,
    namespaceOutput: options?.namespaceOutput,
  });
  const requestedNativeSerialization = emitTarget["native-serialization"];
  const nativeSerialization =
    requestedNativeSerialization === "none" ? "none" : "serde";
  const namespaceProjection = projectNamespace({
    target: "rust",
    sourceNamespace: node.typeName.namespace,
    semanticRoot: options?.rootNamespace,
    emitTarget,
  });

  // Build the expression IR infrastructure for this compilation
  const registry = TypeRegistry.fromTypeGraph(allTypes);
  const visitor = new RustExprVisitor(registry);

  // Collect all polymorphic type names across all nodes
  const polymorphicTypeNames = new Set<string>();
  for (const n of nodes) {
    for (const name of collectPolymorphicTypeNames(n, registry)) {
      polymorphicTypeNames.add(name);
    }
  }
  // Build a map from polymorphic child type names to their parent type names.
  // In Rust, child types become enum variants, not standalone structs.
  // When importing a child type, we need to import ParentKind instead.
  const childToParent = new Map<string, string>();
  for (const n of nodes) {
    if (n.discriminator && n.childTypes.length > 0) {
      for (const child of n.childTypes) {
        childToParent.set(child.typeName.name, n.typeName.name);
      }
    }
  }

  // Index every lowered type declaration by simple name. This is the global decl
  // universe (all files), needed by two lowering-aware paths that must resolve a
  // referenced type living in a DIFFERENT file:
  //  1. the per-interface conformance emitter walks a @dispatch container path and
  //     unwraps the Rust `Option<…>` intermediates it crosses;
  //  2. the per-field load emitter expands a value-backed coerce union's bare-string
  //     shorthand (`model:"gpt-4"` → `{"id":"gpt-4"}`) at load time by reading the
  //     referenced type's string `@coerce` template — otherwise the value-backed
  //     lowering stores the raw string and Rust alone diverges from every runtime
  //     that hydrates a typed child on load.
  // Serialization is opt-in via `@serializable`: compute the closure once and
  // thread it so only its members emit load/save.
  const serializationClosure = computeSerializationClosure(nodes, registry);

  const rustDeclsByName = new Map<string, TypeDecl>(
    nodes
      .filter((n) => !n.base)
      .flatMap(
        (n) =>
          lowerFile(n, registry, polymorphicTypeNames, serializationClosure)
            .types,
      )
      .map((decl) => [decl.typeName.name, decl]),
  );

  // Render context.rs
  const contextContent = emitRustContext("Prompty Context");
  await emitRustFile(
    context,
    "context.rs",
    contextContent,
    emitTarget["output-dir"],
  );

  // Group root nodes by semantic group folder
  const groupMap = new Map<string, TypeNode[]>();
  for (const n of nodes) {
    if (!n.base) {
      const g = n.group || "";
      if (!groupMap.has(g)) groupMap.set(g, []);
      groupMap.get(g)!.push(n);
    }
  }

  // Render each base type and its children as a single file, into group subfolder
  const groupModuleNames = new Map<string, string[]>(); // group → module names
  const testGroupModuleNames = new Map<string, string[]>(); // group → test module names
  for (const n of nodes) {
    if (!n.base) {
      const group = n.group || "";
      const fileDecl = lowerFile(
        n,
        registry,
        polymorphicTypeNames,
        serializationClosure,
      );
      const fileContent = emitRustFileDecl(
        fileDecl,
        visitor,
        polymorphicTypeNames,
        childToParent,
        {
          enumParsing: emitTarget["enum-parsing"] ?? "case-sensitive",
          cancellationTokenPath: emitTarget["cancellation-token-path"],
          nativeSerialization,
        },
        rustDeclsByName,
      );
      const fileName = toSnakeCase(n.typeName.name) + ".rs";
      const outDir = group
        ? `${emitTarget["output-dir"]}/${group}`
        : emitTarget["output-dir"];
      await emitRustFile(
        context,
        fileName,
        fileContent,
        outDir,
        emitTarget["output-dir"],
      );

      if (!groupModuleNames.has(group)) groupModuleNames.set(group, []);
      groupModuleNames.get(group)!.push(toSnakeCase(n.typeName.name));
    }

    // Render test file — skip children of polymorphic hierarchies (they're enum variants now) and protocols
    if (
      emitTarget["test-dir"] &&
      !childToParent.has(n.typeName.name) &&
      !n.isProtocol
    ) {
      const importPath = namespaceProjection.importPath!;
      const testContext = buildTestContext(n, registry);
      const isPolymorphicBase = !!(n.discriminator && n.childTypes.length > 0);
      const testContent = emitRustTest({
        ...testContext,
        importPath,
        isPolymorphicBase,
        nativeSerialization,
      });
      const testFileName = toSnakeCase(n.typeName.name) + "_test.rs";
      const testGroup = n.group || "";
      const testDir = testGroup
        ? `${emitTarget["test-dir"]}/${testGroup}`
        : emitTarget["test-dir"];
      await emitRustFile(
        context,
        testFileName,
        testContent,
        testDir,
        emitTarget["test-dir"],
      );
      if (!testGroupModuleNames.has(testGroup))
        testGroupModuleNames.set(testGroup, []);
      testGroupModuleNames
        .get(testGroup)!
        .push(toSnakeCase(n.typeName.name) + "_test");
    }
  }

  if (
    emitTarget["test-dir"] &&
    shouldEmitCompileOnlyProtocolScaffolds(emitTarget)
  ) {
    const importPath = namespaceProjection.importPath!;
    const scaffoldContent = emitRustProtocolScaffolds(
      collectProtocolNodes(nodes),
      importPath,
      emitTarget["cancellation-token-path"],
    );
    await emitRustFile(
      context,
      "protocol_scaffolds_test.rs",
      scaffoldContent,
      emitTarget["test-dir"],
      emitTarget["test-dir"],
    );
    if (!testGroupModuleNames.has("")) testGroupModuleNames.set("", []);
    testGroupModuleNames.get("")!.push("protocol_scaffolds_test");
  }

  // Typed @vector conformance entrypoints (issue #511 Cat 1) are emitted as a
  // library module of the model crate; collect their module name(s) so the root
  // mod.rs declares them (declare-only, not glob-re-exported).
  const conformanceEntrypointModules: string[] = [];

  if (
    emitTarget["test-dir"] &&
    (options?.callableVectors?.vectors.length ?? 0) > 0
  ) {
    const allVectors = options!.callableVectors!.vectors;
    // A `@dispatch` seam routes through the typed resolver rail (issue #282 §8):
    // its vectors get a per-interface, typed `${iface}_conformance_test.rs` file
    // that CONSUMES the emitted `${seam}_resolver`. Undispatched seams —
    // INCLUDING a @dispatch whose discriminator model is not polymorphic (no
    // `decl`, so no typed rail) — keep the stringly JSON interpreter
    // (vector_runner) + monolithic vector_conformance_test.rs, so no vector is
    // dropped from both rails.
    const undispatched = allVectors.filter(
      (entry) => !isTypedDispatchEntry(entry),
    );

    if (undispatched.length > 0) {
      // Option A relocate: the seam-agnostic interpreter lives in its own module
      // (tests/vector_runner/mod.rs — a subdirectory so cargo never compiles it
      // as a standalone integration-test crate) and the harness stays thin. The
      // runner is emitted into a subdir and included by the harness via #[path].
      await emitRustFile(
        context,
        "mod.rs",
        emitRustVectorRunner(),
        `${emitTarget["test-dir"]}/vector_runner`,
        emitTarget["test-dir"],
      );
      await emitRustFile(
        context,
        "vector_conformance_test.rs",
        emitRustVectorConformanceTest(
          { ...options!.callableVectors!, vectors: undispatched },
          emitTarget["vector-adapter-path"] ?? "vector_adapters.rs",
        ),
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
      if (!testGroupModuleNames.has("")) testGroupModuleNames.set("", []);
      testGroupModuleNames.get("")!.push("vector_conformance_test");
    }

    // Typed conformance entrypoint (issue #511 Cat 1): a library module of the
    // model crate exposing `run_<seam>_conformance<S: <Seam>>(seam: &S)` for every
    // eligible undispatched seam. Additive — the stringly runner above is
    // untouched; a consumer migrates a seam by calling this with their typed impl
    // and deleting that seam's `vector_adapters` registration.
    const entrypointEligible = allVectors.filter(isScalarSeamEntry);
    if (entrypointEligible.length > 0) {
      await emitRustFile(
        context,
        "vector_conformance.rs",
        emitRustVectorConformanceEntrypoint(
          { ...options!.callableVectors!, vectors: entrypointEligible },
          emitTarget["import-path"] ?? "crate::model",
        ),
        emitTarget["output-dir"],
      );
      conformanceEntrypointModules.push("vector_conformance");
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
      const moduleName = `${toSnakeCase(dispatched.contract)}_conformance_test`;
      await emitRustFile(
        context,
        `${moduleName}.rs`,
        emitRustInterfaceConformanceTest(
          dispatched,
          ifaceVectors,
          emitTarget["import-path"] ?? "crate::model",
          emitTarget["vector-adapter-path"] ?? "vector_adapters.rs",
          rustDeclsByName,
          polymorphicTypeNames,
        ),
        `${emitTarget["test-dir"]}/${dispatched.group}`,
        emitTarget["test-dir"],
      );
      if (!testGroupModuleNames.has(dispatched.group))
        testGroupModuleNames.set(dispatched.group, []);
      testGroupModuleNames.get(dispatched.group)!.push(moduleName);
    }
  }

  // Part III typed @dispatch resolver: for each dispatched seam, emit a library
  // module (beside the seam trait) carrying a consumer-implemented provider trait
  // + a resolve() fn that twins the shape discriminator `match`. Declared in the
  // seam's group `mod.rs` (but NOT glob-re-exported — see emitRustLib) so the
  // provider trait is part of the crate's public surface, exactly the contract a
  // downstream implements, reached via the qualified `<seam>_resolver::` path.
  // NOTE: emission currently rides the presence of @vector cases; decoupling it
  // to emit for every dispatched contract regardless of test coverage is a
  // tracked follow-up (issue #282).
  const resolverModuleNames = new Map<string, string[]>();
  if ((options?.callableVectors?.vectors.length ?? 0) > 0) {
    for (const dispatched of collectDispatchedContracts(
      options!.callableVectors!.vectors,
    )) {
      const moduleName = `${toSnakeCase(dispatched.contract)}_resolver`;
      const outDir = dispatched.group
        ? `${emitTarget["output-dir"]}/${dispatched.group}`
        : emitTarget["output-dir"];
      await emitRustFile(
        context,
        `${moduleName}.rs`,
        emitRustDispatchResolver(dispatched),
        outDir,
        emitTarget["output-dir"],
      );
      if (!resolverModuleNames.has(dispatched.group))
        resolverModuleNames.set(dispatched.group, []);
      resolverModuleNames.get(dispatched.group)!.push(moduleName);
    }
  }

  // Render per-group mod.rs files (source)
  const sourceGroupPaths = collectRustGroupPaths([
    ...groupModuleNames.keys(),
    ...resolverModuleNames.keys(),
  ]);
  for (const group of sourceGroupPaths) {
    const typeModules = groupModuleNames.get(group) ?? [];
    const childSubgroups = immediateChildModules(group, sourceGroupPaths);
    const groupChildren = [
      ...typeModules.map((name) => ({ name, exposes: [] as string[] })),
      ...childSubgroups.map((name) => ({
        name,
        exposes: exposedModuleNames(
          `${group}/${name}`,
          sourceGroupPaths,
          groupModuleNames,
        ),
      })),
    ];
    const groupModContent = emitRustGroupMod(
      typeModules,
      childSubgroups,
      disambiguateGlobReexports(groupChildren),
      resolverModuleNames.get(group) ?? [],
    );
    await emitRustFile(
      context,
      "mod.rs",
      groupModContent,
      `${emitTarget["output-dir"]}/${group}`,
      emitTarget["output-dir"],
    );
  }

  // Render test group mod.rs files and test main.rs
  if (emitTarget["test-dir"]) {
    // Emit per-group mod.rs (test)
    const testGroupPaths = collectRustGroupPaths(testGroupModuleNames.keys());
    for (const group of testGroupPaths) {
      const groupModContent = emitRustTestGroupMod(
        testGroupModuleNames.get(group) ?? [],
        immediateChildModules(group, testGroupPaths),
      );
      await emitRustFile(
        context,
        "mod.rs",
        groupModContent,
        `${emitTarget["test-dir"]}/${group}`,
        emitTarget["test-dir"],
      );
    }
    // Emit root-level test files (no group)
    const rootTestMods = testGroupModuleNames.get("") || [];
    const testGroups = immediateChildModules("", testGroupPaths);
    const allTopLevel = [
      ...rootTestMods.map((m) => `mod ${m};`),
      ...testGroups.sort().map((g) => `mod ${g};`),
    ];
    const mainContent =
      "// Code generated by Typra emitter; DO NOT EDIT.\n\n" +
      RUST_ALLOW_ATTR +
      "\n\n" +
      allTopLevel.join("\n") +
      "\n";
    await emitRustFile(context, "main.rs", mainContent, emitTarget["test-dir"]);
  }

  // Render root mod.rs
  const rootModules = groupModuleNames.get("") || [];
  const groups = immediateChildModules("", sourceGroupPaths);
  const rootChildren = [
    ...["context", ...rootModules].map((name) => ({
      name,
      exposes: [] as string[],
    })),
    ...groups.map((name) => ({
      name,
      exposes: exposedModuleNames(name, sourceGroupPaths, groupModuleNames),
    })),
  ];
  const libContent = emitRustLib(
    ["context", ...rootModules],
    groups,
    disambiguateGlobReexports(rootChildren),
    [...(resolverModuleNames.get("") ?? []), ...conformanceEntrypointModules],
  );
  await emitRustFile(context, "mod.rs", libContent, emitTarget["output-dir"]);

  // Format emitted files
  if (emitTarget.format !== false) {
    const outputDir = emitTarget["output-dir"]
      ? resolve(process.cwd(), emitTarget["output-dir"])
      : context.emitterOutputDir;
    const custom = resolveCustomFormatters(emitTarget.format);
    if (custom) {
      const testDir = emitTarget["test-dir"]
        ? resolve(process.cwd(), emitTarget["test-dir"])
        : undefined;
      runCustomFormatters(custom, { dir: outputDir, testDir });
    } else {
      formatRustFiles(outputDir);
    }
  }
  restoreNamespaceGroups(namespaceGroupSnapshots);
};

/**
 * Format Rust files using cargo fmt.
 */
function formatRustFiles(outputDir: string): void {
  // Run cargo fmt if Cargo.toml exists in parent
  const cargoToml = resolve(outputDir, "../Cargo.toml");
  if (existsSync(cargoToml)) {
    try {
      execFileSync("cargo", ["fmt", "--manifest-path", cargoToml], {
        stdio: "pipe",
        encoding: "utf-8",
      });
      normalizeRustFileEndings(resolve(outputDir, ".."));
    } catch (error) {
      console.warn(`Warning: cargo fmt failed. You may need to install Rust.`);
    }
  }
}

function normalizeRustFileEndings(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const fullPath = resolve(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      normalizeRustFileEndings(fullPath);
      continue;
    }
    if (!entry.endsWith(".rs")) {
      continue;
    }
    const content = readFileSync(fullPath, "utf-8");
    writeFileSync(fullPath, `${content.trimEnd()}\n`, "utf-8");
  }
}

/**
 * Build context for rendering a test file.
 */
function buildTestContext(
  node: TypeNode,
  registry: TypeRegistry,
): BaseTestContext {
  return buildBaseTestContext(node, undefined, rustTestOptions, (name) =>
    registry.get(name),
  );
}

/**
 * Write generated Rust content to file.
 */
async function emitRustFile(
  context: EmitContext<TypraEmitterOptions>,
  filename: string,
  content: string,
  outputDir?: string,
  outputRoot?: string,
): Promise<void> {
  outputDir = outputDir || `${context.emitterOutputDir}/rust`;
  const filePath = resolvePath(outputDir, filename);
  await emitGeneratedFile(context, filePath, `${content.trimEnd()}\n`, {
    outputRoot: outputRoot || outputDir,
  });
}

/**
 * Emit the context.rs file content (LoadContext/SaveContext structs).
 */
function emitRustContext(header: string): string {
  return `// Code generated by Typra emitter; DO NOT EDIT.
// ${header}

${RUST_ALLOW_ATTR}

/// Callback type for pre-processing input data before parsing.
pub type PreProcessFn = Box<dyn Fn(serde_json::Value) -> serde_json::Value + Send + Sync>;

/// Callback type for post-processing the result after instantiation.
pub type PostProcessFn = Box<dyn Fn(serde_json::Value) -> serde_json::Value + Send + Sync>;

/// Callback type for pre-processing an object before serialization.
pub type PreSaveFn = Box<dyn Fn(serde_json::Value) -> serde_json::Value + Send + Sync>;

/// Callback type for post-processing a dictionary after serialization.
pub type PostSaveFn = Box<dyn Fn(serde_json::Value) -> serde_json::Value + Send + Sync>;

/// Context for customizing the loading process of agent definitions.
///
/// Provides hooks for pre-processing input data before parsing and
/// post-processing output data after instantiation.
pub struct LoadContext {
    /// Optional callback to transform input data before parsing.
    pub pre_process: Option<PreProcessFn>,
    /// Optional callback to transform the result after instantiation.
    pub post_process: Option<PostProcessFn>,
}

impl std::fmt::Debug for LoadContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoadContext")
            .field("pre_process", &self.pre_process.as_ref().map(|_| "..."))
            .field("post_process", &self.post_process.as_ref().map(|_| "..."))
            .finish()
    }
}

impl Default for LoadContext {
    fn default() -> Self {
        Self {
            pre_process: None,
            post_process: None,
        }
    }
}

impl LoadContext {
    /// Create a new empty LoadContext.
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply pre-processing to input data if a pre_process callback is set.
    ///
    /// # Arguments
    /// * \`data\` - The raw input value to process.
    ///
    /// # Returns
    /// The processed value, or the original if no callback is set.
    pub fn process_input(&self, data: serde_json::Value) -> serde_json::Value {
        if let Some(ref f) = self.pre_process {
            f(data)
        } else {
            data
        }
    }

    /// Apply post-processing to the result if a post_process callback is set.
    ///
    /// # Arguments
    /// * \`result\` - The instantiated value to process.
    ///
    /// # Returns
    /// The processed result, or the original if no callback is set.
    pub fn process_output(&self, result: serde_json::Value) -> serde_json::Value {
        if let Some(ref f) = self.post_process {
            f(result)
        } else {
            result
        }
    }
}

/// Context for customizing the serialization process of agent definitions.
///
/// Provides hooks for pre-processing the object before serialization and
/// post-processing the dictionary after serialization.
pub struct SaveContext {
    /// Optional callback to transform the object before serialization.
    pub pre_save: Option<PreSaveFn>,
    /// Optional callback to transform the dictionary after serialization.
    pub post_save: Option<PostSaveFn>,
    /// Output format for collections: "object" (name as key) or "array" (list of dicts).
    /// Defaults to "object".
    pub collection_format: String,
    /// Use shorthand scalar representation when possible.
    /// Defaults to true.
    pub use_shorthand: bool,
}

impl std::fmt::Debug for SaveContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SaveContext")
            .field("pre_save", &self.pre_save.as_ref().map(|_| "..."))
            .field("post_save", &self.post_save.as_ref().map(|_| "..."))
            .field("collection_format", &self.collection_format)
            .field("use_shorthand", &self.use_shorthand)
            .finish()
    }
}

impl Default for SaveContext {
    fn default() -> Self {
        Self {
            pre_save: None,
            post_save: None,
            collection_format: "object".to_string(),
            use_shorthand: true,
        }
    }
}

impl SaveContext {
    /// Create a new SaveContext with defaults.
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply pre-processing to the object if a pre_save callback is set.
    ///
    /// # Arguments
    /// * \`obj\` - The value to process before serialization.
    ///
    /// # Returns
    /// The processed value, or the original if no callback is set.
    pub fn process_object(&self, obj: serde_json::Value) -> serde_json::Value {
        if let Some(ref f) = self.pre_save {
            f(obj)
        } else {
            obj
        }
    }

    /// Apply post-processing to the dictionary if a post_save callback is set.
    ///
    /// # Arguments
    /// * \`data\` - The serialized value to process.
    ///
    /// # Returns
    /// The processed value, or the original if no callback is set.
    pub fn process_dict(&self, data: serde_json::Value) -> serde_json::Value {
        if let Some(ref f) = self.post_save {
            f(data)
        } else {
            data
        }
    }

    /// Convert a value to a YAML string.
    pub fn to_yaml(&self, data: &serde_json::Value) -> Result<String, serde_yaml::Error> {
        serde_yaml::to_string(data)
    }

    /// Convert a value to a JSON string.
    pub fn to_json(&self, data: &serde_json::Value, indent: bool) -> Result<String, serde_json::Error> {
        if indent {
            serde_json::to_string_pretty(data)
        } else {
            serde_json::to_string(data)
        }
    }
}
`;
}

/**
 * Emit the root mod.rs file content (module declarations).
 *
 * @param rootModules - Module names emitted directly in the root (e.g. ["context"])
 * @param groups - Group subfolder names (e.g. ["connection", "tools"])
 */
export function emitRustLib(
  rootModules: string[],
  groups: string[] = [],
  disambiguations: string[] = [],
  declareOnlyModules: string[] = [],
): string {
  let out =
    "// Code generated by Typra emitter; DO NOT EDIT.\n\n" +
    RUST_ALLOW_ATTR +
    "\n";
  for (const module of rootModules) {
    out += `\npub mod ${module};\npub use ${module}::*;\n`;
  }
  for (const group of groups) {
    out += `\npub mod ${group};\npub use ${group}::*;\n`;
  }
  // Declare-only modules are exposed WITHOUT a glob re-export. The @dispatch
  // resolver modules each export a `resolve` fn (and a `<Seam>Provider` trait);
  // glob-re-exporting two of them would raise `ambiguous_glob_reexports` on the
  // flattened `resolve` name. Consumers reach them by the qualified module path
  // (`<seam>_resolver::resolve`), so no flattening is needed.
  for (const module of [...declareOnlyModules].sort()) {
    out += `\npub mod ${module};\n`;
  }
  for (const line of disambiguations) {
    out += `\n${line}\n`;
  }
  return `${out.trimEnd()}\n`;
}

/**
 * Emit a per-group mod.rs file that declares and re-exports all modules in that group.
 */
export function emitRustGroupMod(
  moduleNames: string[],
  childModuleNames: string[] = [],
  disambiguations: string[] = [],
  declareOnlyModules: string[] = [],
): string {
  let out =
    "// Code generated by Typra emitter; DO NOT EDIT.\n\n" +
    RUST_ALLOW_ATTR +
    "\n";
  for (const module of [...moduleNames, ...childModuleNames].sort()) {
    out += `\npub mod ${module};\npub use ${module}::*;\n`;
  }
  // See emitRustLib: resolver modules are declared without a glob re-export so
  // their same-named `resolve` fns never collide when flattened.
  for (const module of [...declareOnlyModules].sort()) {
    out += `\npub mod ${module};\n`;
  }
  for (const line of disambiguations) {
    out += `\n${line}\n`;
  }
  return out;
}

function emitRustTestGroupMod(
  moduleNames: string[],
  childModuleNames: string[] = [],
): string {
  return (
    "// Code generated by Typra emitter; DO NOT EDIT.\n\n" +
    RUST_ALLOW_ATTR +
    "\n\n" +
    [...moduleNames, ...childModuleNames]
      .sort()
      .map((m) => `mod ${m};`)
      .join("\n") +
    "\n"
  );
}

function collectRustGroupPaths(groups: Iterable<string>): string[] {
  const paths = new Set<string>();
  for (const group of groups) {
    const parts = group.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      paths.add(parts.slice(0, i).join("/"));
    }
  }
  paths.delete("");
  return Array.from(paths).sort();
}

function immediateChildModules(group: string, groups: Iterable<string>): string[] {
  const children = new Set<string>();
  const prefix = group ? `${group}/` : "";
  const depth = group ? group.split("/").filter(Boolean).length : 0;
  for (const candidate of groups) {
    if (!candidate || !candidate.startsWith(prefix) || candidate === group) {
      continue;
    }
    const parts = candidate.split("/").filter(Boolean);
    if (parts.length === depth + 1) {
      children.add(parts[depth]);
    }
  }
  return Array.from(children).sort();
}

/**
 * Rust flattens grouped modules with glob re-exports (`pub use <group>::*`). When
 * two sibling modules that are both glob-re-exported expose a public item of the
 * same name — most commonly a same-named leaf submodule under different grouping
 * namespaces, e.g. `contracts/pipeline` and `operations/pipeline` — rustc raises
 * `ambiguous_glob_reexports` and the flattened path (`model::pipeline`) fails to
 * resolve with E0659 at every use site. Emit a deterministic explicit re-export
 * (`pub use <winner>::<name>;`) so the name binds unambiguously; the
 * lexicographically-first exposer wins, which is stable across runs and preserves
 * the pre-existing binding when a colliding leaf is newly introduced alongside it.
 */
export function disambiguateGlobReexports(
  children: Array<{ name: string; exposes: string[] }>,
): string[] {
  const exposers = new Map<string, string[]>();
  for (const child of children) {
    for (const name of child.exposes) {
      const list = exposers.get(name) ?? [];
      list.push(child.name);
      exposers.set(name, list);
    }
  }
  const lines: string[] = [];
  for (const name of [...exposers.keys()].sort()) {
    const owners = exposers.get(name)!;
    if (owners.length < 2) continue;
    const winner = [...owners].sort()[0];
    lines.push(`pub use ${winner}::${name};`);
  }
  return lines;
}

/**
 * The direct child module names that `pub use <groupPath>::*` re-exports into its
 * parent scope: the group's immediate sub-group folders plus the snake-cased type
 * modules emitted directly in that group.
 */
function exposedModuleNames(
  groupPath: string,
  allGroupPaths: Iterable<string>,
  groupModuleNames: Map<string, string[]>,
): string[] {
  return [
    ...immediateChildModules(groupPath, allGroupPaths),
    ...(groupModuleNames.get(groupPath) ?? []),
  ];
}
function factoryParamTestValue(typeStr: string): string {
  switch (typeStr) {
    case "string":
      return '"test".to_string()';
    case "boolean":
      return "true";
    case "integer":
    case "int32":
      return "42";
    case "int64":
      return "42i64";
    case "float":
    case "float64":
      return "3.14";
    case "unknown":
      return 'serde_json::json!("test")';
    default:
      return 'serde_json::json!("test")';
  }
}

function rustAssertionValue(
  node: TypeNode,
  key: string,
  value: unknown,
  delimiter: string,
): string {
  if (
    delimiter !== "" ||
    typeof value !== "number" ||
    !Number.isInteger(value)
  ) {
    return `${delimiter}${value}${delimiter}`;
  }

  const prop = node.properties.find((p) => rustFieldName(p.name) === key);
  const scalar = prop?.typeName.name;
  if (
    scalar === "float" ||
    scalar === "float32" ||
    scalar === "float64" ||
    scalar === "number" ||
    scalar === "numeric"
  ) {
    return `${value}.0`;
  }

  return `${value}`;
}

export interface RustTestContext extends BaseTestContext {
  importPath: string;
  isPolymorphicBase: boolean;
  nativeSerialization?: "none" | "serde";
}

/**
 * True if a sample value contains any non-integer number anywhere in its tree.
 * Such values (e.g. f32 `0.7`) may be re-printed by serde with different precision
 * than the canonical JSON text, so a byte-identical `value == canonical` assertion
 * is not safe for types whose sample carries them.
 */
function hasNonIntegerNumber(v: unknown): boolean {
  if (typeof v === "number") return !Number.isInteger(v);
  if (Array.isArray(v)) return v.some(hasNonIntegerNumber);
  if (v && typeof v === "object") {
    return Object.values(v as Record<string, unknown>).some(
      hasNonIntegerNumber,
    );
  }
  return false;
}

/**
 * Emit an integration test file for a TypeSpec model type.
 */
export function emitRustTest(ctx: RustTestContext): string {
  const {
    node,
    isAbstract,
    examples,
    coercions,
    factories,
    importPath,
    isPolymorphicBase,
    nativeSerialization,
  } = ctx;
  const typeName = node.typeName.name;
  const snakeName = toSnakeCase(typeName);
  let out = "";

  // Collect enum types referenced in properties (for use imports)
  const enumImports = new Set<string>();
  for (const prop of node.properties) {
    if (prop.enumName && node.discriminator !== prop.name) {
      enumImports.add(prop.enumName);
    }
  }

  out += "// Code generated by Typra emitter; DO NOT EDIT.\n";
  out += "\n";
  out += RUST_ALLOW_ATTR + "\n";
  out += "\n";
  out += `use ${importPath}::${typeName};\n`;
  for (const enumName of [...enumImports].sort()) {
    if (enumName !== typeName) {
      out += `use ${importPath}::${enumName};\n`;
    }
  }
  out += `use ${importPath}::context::{LoadContext, SaveContext};\n`;
  out += "\n";

  // Example tests (load JSON, load YAML, roundtrip)
  for (let i = 0; i < examples.length; i++) {
    const sample = examples[i];
    const suffix = i === 0 ? "" : `_${i}`;

    // JSON load test
    out += "#[test]\n";
    out += `fn test_${snakeName}_load_json${suffix}() {\n`;
    out += '    let json = r####"\n';
    for (const line of sample.json) {
      out += `${line}\n`;
    }
    out += '"####;\n';
    out += "    let ctx = LoadContext::default();\n";
    out += `    let result = ${typeName}::from_json(json, &ctx);\n`;
    out +=
      '    assert!(result.is_ok(), "Failed to load from JSON: {:?}", result.err());\n';
    if (!isAbstract) {
      out += "    let instance = result.unwrap();\n";
      if (sample.validations.length > 0) {
        for (const v of sample.validations) {
          if (v.isOptional) {
            out += `    assert!(instance.${v.key}.is_some(), "Expected ${v.key} to be Some");\n`;
            out += `    assert_eq!(instance.${v.key}.as_ref().unwrap(), &${rustAssertionValue(node, v.key, v.value, v.delimiter)});\n`;
          } else if (isPolymorphicBase && v.key === "kind") {
            out += `    assert_eq!(instance.kind_str(), ${rustAssertionValue(node, v.key, v.value, v.delimiter)});\n`;
          } else {
            out += `    assert_eq!(instance.${v.key}, ${rustAssertionValue(node, v.key, v.value, v.delimiter)});\n`;
          }
        }
      } else {
        out +=
          "    let _ = instance; // load succeeded, no scalar properties to validate\n";
      }
    }
    out += "}\n";
    out += "\n";

    // YAML load test
    out += "#[test]\n";
    out += `fn test_${snakeName}_load_yaml${suffix}() {\n`;
    out += '    let yaml = r####"\n';
    for (const line of sample.yaml) {
      out += `${line}\n`;
    }
    out += '"####;\n';
    out += "    let ctx = LoadContext::default();\n";
    out += `    let result = ${typeName}::from_yaml(yaml, &ctx);\n`;
    out +=
      '    assert!(result.is_ok(), "Failed to load from YAML: {:?}", result.err());\n';
    if (!isAbstract) {
      out += "    let instance = result.unwrap();\n";
      if (sample.validations.length > 0) {
        for (const v of sample.validations) {
          if (v.isOptional) {
            out += `    assert!(instance.${v.key}.is_some(), "Expected ${v.key} to be Some");\n`;
          } else if (isPolymorphicBase && v.key === "kind") {
            out += `    assert_eq!(instance.kind_str(), ${rustAssertionValue(node, v.key, v.value, v.delimiter)});\n`;
          } else {
            out += `    assert_eq!(instance.${v.key}, ${rustAssertionValue(node, v.key, v.value, v.delimiter)});\n`;
          }
        }
      } else {
        out +=
          "    let _ = instance; // load succeeded, no scalar properties to validate\n";
      }
    }
    out += "}\n";
    out += "\n";

    // Roundtrip test
    out += "#[test]\n";
    out += `fn test_${snakeName}_roundtrip${suffix}() {\n`;
    out += '    let json = r####"\n';
    for (const line of sample.json) {
      out += `${line}\n`;
    }
    out += '"####;\n';
    out += "    let load_ctx = LoadContext::default();\n";
    out += `    let result = ${typeName}::from_json(json, &load_ctx);\n`;
    out +=
      '    assert!(result.is_ok(), "Failed to load: {:?}", result.err());\n';
    if (!isAbstract) {
      out += "    let instance = result.unwrap();\n";
      out += "    let save_ctx = SaveContext::default();\n";
      out += "    let json_output = instance.to_json(&save_ctx);\n";
      out +=
        '    assert!(json_output.is_ok(), "Failed to serialize to JSON: {:?}", json_output.err());\n';
    }
    out += "}\n";
    out += "\n";

    // Serde round-trip test: deserialize EXTERNAL canonical JSON via serde,
    // re-serialize via serde, and deserialize again — proving Serialize +
    // Deserialize + PartialEq all work and that the discriminated union's `kind`
    // survives the serde path with its exact canonical wire value. With the old
    // externally-tagged derive this would fail to even deserialize nested
    // discriminated values (e.g. `{"kind":"text",...}`).
    if (!isAbstract && nativeSerialization !== "none") {
      out += '#[cfg(feature = "serde")]\n';
      out += "#[test]\n";
      out += `fn test_${snakeName}_serde_roundtrip${suffix}() {\n`;
      out += '    let json = r####"\n';
      for (const line of sample.json) {
        out += `${line}\n`;
      }
      out += '"####;\n';
      out += `    let instance: ${typeName} = serde_json::from_str(json)\n`;
      out += '        .expect("serde should deserialize canonical JSON");\n';
      out += "    let value = serde_json::to_value(&instance)\n";
      out += '        .expect("serde should serialize");\n';
      // Parse the ORIGINAL canonical (internally-tagged) JSON so we can assert the
      // serde-re-serialized polymorphic sub-values are byte-identical to it — this is
      // the acceptance gate: it proves serde produces canonical internally-tagged wire
      // (`{"kind":"text",...}`), NOT the externally-tagged derive form
      // (`{"kind":{"TextContent":{...}}}`), with empty-omission preserved.
      out +=
        "    let canonical: serde_json::Value = serde_json::from_str(json)\n";
      out += '        .expect("canonical json parses");\n';
      // Delegation-equivalence (ALWAYS): the uniform manual serde impls route Serialize
      // through `to_value` and Deserialize through `load_from_value`, so serde output/input
      // MUST equal the canonical context-aware form for EVERY type — independent of whether
      // the `@sample` is complete, how collections are shaped, or int-vs-float rendering.
      // This is the sample-agnostic invariant that holds for arbitrary consumer models
      // (whose `@sample` annotates only some fields); the byte-identity assertions below are
      // ADDITIONALLY emitted only for complete, byte-safe samples (typra's own fixtures).
      out +=
        '    assert_eq!(value, instance.to_value(&SaveContext::default()), "serde serialize must equal canonical to_value");\n';
      out += `    assert_eq!(instance, ${typeName}::load_from_value(&canonical, &LoadContext::default()), "serde deserialize must equal canonical load_from_value");\n`;
      // A whole-object/nested byte-identity assertion against the `@sample` JSON is only
      // valid when the sample is a canonical fixed point: every REQUIRED field is present
      // (otherwise `to_value` correctly emits required fields the partial sample omits) and
      // no float-typed field is sampled with an integer literal (`12` canonicalizes to
      // `12.0`, which serde_json::Value compares unequal). Consumer models annotate partial
      // samples and must fall back to the delegation-equivalence above; typra's own fixtures
      // author complete samples and keep the stronger byte-identity checks.
      const floatScalarNames = new Set([
        "float",
        "float32",
        "float64",
        "number",
        "numeric",
      ]);
      const isByteSafeSample = (
        tn: TypeNode | undefined,
        sv: unknown,
        path: Set<string>,
      ): boolean => {
        if (!tn) return true; // element type unresolved (cycle quirk) — cannot verify, don't block
        if (!sv || typeof sv !== "object" || Array.isArray(sv)) return true;
        const key = `${tn.typeName.namespace}.${tn.typeName.name}`;
        if (path.has(key)) return true; // cycle — stop descending
        path.add(key);
        try {
          const obj = sv as Record<string, unknown>;
          for (const p of tn.properties) {
            // A field that `to_value` ALWAYS emits — required (no `?`) OR carrying a
            // default (materialized on load, so present on save even when the `@sample`
            // omits it, e.g. prompty's `status`/`contextState`) — must be present in the
            // sample for whole-object byte-identity vs that sample to be valid.
            if ((!p.isOptional || p.hasExplicitDefault) && !(p.name in obj))
              return false;
            const pv = obj[p.name];
            // Cause D (mirror image of the above): a REQUIRED field authored in the sample
            // at its zero/empty value is OMITTED by to_value — required string == "", int
            // == 0, float == 0.0, and empty collections are all dropped (see emitScalarSave /
            // emitSaveField omission guards). So the sample is not a canonical fixed point and
            // whole-object byte-identity vs it is invalid (e.g. prompty's validation_result
            // `errors:[]`, turn_model_request `iteration:0`). Optional fields authored at zero
            // ARE emitted (`Some(0)`), so this only applies to required (non-`?`) fields.
            if (!p.isOptional && p.name in obj) {
              if (p.isCollection && Array.isArray(pv) && pv.length === 0)
                return false;
              if (
                p.isScalar &&
                !p.isCollection &&
                typeof pv === "string" &&
                pv === ""
              )
                return false;
              if (
                p.isScalar &&
                !p.isCollection &&
                typeof pv === "number" &&
                pv === 0
              )
                return false;
            }
            if (
              p.isScalar &&
              !p.isCollection &&
              floatScalarNames.has(p.typeName.name) &&
              typeof pv === "number" &&
              Number.isInteger(pv)
            ) {
              return false;
            }
            if (pv && typeof pv === "object" && !Array.isArray(pv)) {
              if (!isByteSafeSample(p.type, pv, path)) return false;
            } else if (Array.isArray(pv) && p.type) {
              for (const el of pv) {
                if (!isByteSafeSample(p.type, el, path)) return false;
              }
            }
          }
          return true;
        } finally {
          path.delete(key);
        }
      };
      const byteSafeSample = isByteSafeSample(node, sample.sample, new Set());
      const kindV = sample.validations.find(
        (v) => v.key === "kind" && !v.isOptional,
      );
      if (isPolymorphicBase && kindV) {
        out += `    assert_eq!(value.get("kind").and_then(|v| v.as_str()), Some(${rustAssertionValue(node, "kind", kindV.value, kindV.delimiter)}), "discriminator must round-trip to its canonical wire value");\n`;
        // A directly-sampled polymorphic type must re-serialize byte-identical to its
        // canonical internally-tagged input — but only when the sample is byte-safe
        // (complete + no int/float ambiguity). Partial consumer samples rely on the
        // delegation-equivalence assertions above instead.
        if (byteSafeSample) {
          out +=
            '    assert_eq!(value, canonical, "polymorphic type must re-serialize to byte-identical canonical internally-tagged JSON");\n';
        }
      }
      // Nested discriminated-union canonicity (discriminator string + exact sub-value
      // wire) is proven sample-independently by the delegation-equivalence assertion above
      // (`value == instance.to_value(..)` compares the ENTIRE wire, including every nested
      // discriminator, so an externally-tagged regression fails loudly) and, for complete
      // byte-safe samples, by the whole-object byte-identity below. We deliberately do NOT
      // navigate into sampled collections by integer index to re-assert discriminators:
      // that is redundant and, for keyed (property-bag) collections whose canonical wire is
      // a name-keyed MAP, `value[prop][0]` navigates into an object → None and mis-fails.
      // Only Record<T>|Named<T>[] explicitly opts into keyed-map wire semantics.
      // A regular list whose element happens to have a `name` field must remain an
      // ordered array so duplicate names are not collapsed.
      const isKeyedCollection = (
        prop: TypeNode["properties"][number],
      ): boolean => prop.isCollection && prop.isNamedCollection;
      // Keyed-collection canonicalization for the explicit property-bag pattern
      // (e.g. prompty's `inputs`/`outputs`/`parameters`, declared as the union
      // `Record<T> | Named<T>[]`) that a plain
      // `#[derive(serde::Serialize/Deserialize)]` on a `Vec<T>` field CANNOT
      // reproduce — the derive emits/demands a JSON array and REJECTS the canonical
      // map on load with "invalid type: map, expected a sequence". Prove the manual
      // delegating serde produces the canonical map: assert the field serialized to a
      // JSON object keyed by name. Handles a sample authored in either MAP form
      // (`{"alpha":{...}}` — keys ARE the names) or ARRAY shorthand
      // (`[{"name":"alpha",...}]`).
      for (const prop of node.properties) {
        if (!isKeyedCollection(prop)) continue;
        const sampleVal = sample.sample ? sample.sample[prop.name] : undefined;
        let keys: string[] = [];
        if (Array.isArray(sampleVal)) {
          keys = sampleVal
            .map((e) =>
              e && typeof e === "object"
                ? (e as Record<string, unknown>).name
                : undefined,
            )
            .filter((k): k is string => typeof k === "string");
        } else if (sampleVal && typeof sampleVal === "object") {
          keys = Object.keys(sampleVal as Record<string, unknown>);
        } else {
          continue;
        }
        if (keys.length === 0) continue;
        out += `    assert!(value.get(${JSON.stringify(prop.name)}).map(|v| v.is_object()).unwrap_or(false), "keyed collection must serialize to canonical name-keyed map, not an array");\n`;
        out += `    assert!(value.get(${JSON.stringify(prop.name)}).and_then(|v| v.get(${JSON.stringify(keys[0])})).is_some(), "keyed collection map must be keyed by the element name");\n`;
      }
      // Whole-object byte-identity: for byte-stable types the serde re-serialization
      // must equal the canonical wire EXACTLY. This proves flat structs honor the
      // canonical to_value/load_from_value semantics — most importantly EMPTY-OMISSION
      // (unset optionals are dropped, NOT emitted as `null`/`[]` as a plain
      // `#[derive(serde::Serialize)]` would). We skip types that legitimately differ
      // from their canonical input: those with scalar-coercion shorthand (a complex
      // field sampled as a bare scalar that expands on load) and those carrying
      // non-integer floats (serde may re-print the precision differently).
      const assertedFullEquality = isPolymorphicBase && !!kindV;
      if (!assertedFullEquality) {
        let byteStable = coercions.length === 0;
        if (byteStable) {
          for (const prop of node.properties) {
            const sv = sample.sample ? sample.sample[prop.name] : undefined;
            // A keyed collection sampled in ARRAY shorthand (`[{"name":..}]`) has a
            // canonical wire (name-keyed MAP) that legitimately differs from the sample
            // text, so whole-object byte-identity is invalid — the keyed-map assertion
            // above + the synthesized map-input round-trip below cover it.
            if (isKeyedCollection(prop) && Array.isArray(sv)) {
              byteStable = false;
              break;
            }
            if (sv === undefined || sv === null) continue;
            const isPrimitive =
              typeof sv === "string" ||
              typeof sv === "number" ||
              typeof sv === "boolean";
            const isComplexModel =
              !prop.isScalar && !prop.isCollection && !prop.enumName;
            if (isPrimitive && isComplexModel) {
              byteStable = false;
              break;
            }
          }
        }
        const hasFloat = sample.sample
          ? hasNonIntegerNumber(sample.sample)
          : false;
        if (byteStable && !hasFloat && byteSafeSample) {
          out += `    assert_eq!(value, canonical, "serde must serialize to byte-identical canonical wire (empty-omission preserved; no plain-derive divergence)");\n`;
        }
      }
      out += `    let reparsed: ${typeName} = serde_json::from_value(value)\n`;
      out += '        .expect("serde should re-deserialize");\n';
      out +=
        '    assert_eq!(instance, reparsed, "serde round-trip must be stable");\n';
      // Synthesized MAP-form input regression (Rust-only). The canonical wire form of a
      // keyed collection (property bag) is a name-keyed MAP, but a fixture may author its
      // `@sample` in ARRAY shorthand so the shared cross-language gate (incl. Swift, which
      // is array-only) stays green. Here we synthesize the equivalent MAP-form JSON and
      // prove the uniform delegating serde DESERIALIZES it — the exact input that a plain
      // `#[derive(serde::Deserialize)]` on a `Vec<T>` field REJECTS with
      // "invalid type: map, expected a sequence" (prompty's real `Prompty`/`inputs` failure).
      {
        const keyedMapProps: string[] = [];
        const mapSample: Record<string, unknown> = { ...(sample.sample ?? {}) };
        for (const prop of node.properties) {
          if (!isKeyedCollection(prop)) continue;
          const sv = sample.sample ? sample.sample[prop.name] : undefined;
          if (!Array.isArray(sv) || sv.length === 0) continue;
          const asMap: Record<string, unknown> = {};
          let ok = true;
          for (const el of sv) {
            if (!el || typeof el !== "object" || Array.isArray(el)) {
              ok = false;
              break;
            }
            const rec = el as Record<string, unknown>;
            const nm = rec.name;
            if (typeof nm !== "string") {
              ok = false;
              break;
            }
            const rest: Record<string, unknown> = { ...rec };
            delete rest.name;
            asMap[nm] = rest;
          }
          if (!ok) continue;
          mapSample[prop.name] = asMap;
          keyedMapProps.push(prop.name);
        }
        if (keyedMapProps.length > 0) {
          const mapJson = JSON.stringify(mapSample, null, 2);
          out += '    let map_json = r####"\n';
          for (const line of mapJson.split("\n")) {
            out += `${line}\n`;
          }
          out += '"####;\n';
          out += `    let from_map: ${typeName} = serde_json::from_str(map_json)\n`;
          out +=
            '        .expect("serde must deserialize the canonical name-keyed MAP form (a plain Vec derive fails here with \\"invalid type: map, expected a sequence\\")");\n';
          out +=
            '    assert_eq!(from_map, instance, "map-form and array-form inputs must load to equal instances");\n';
          out += "    let map_value = serde_json::to_value(&from_map)\n";
          out +=
            '        .expect("serde should serialize the map-loaded instance");\n';
          for (const name of keyedMapProps) {
            out += `    assert!(map_value.get(${JSON.stringify(name)}).map(|v| v.is_object()).unwrap_or(false), "keyed collection loaded from a MAP must re-serialize to the canonical name-keyed map");\n`;
          }
        }
      }
      out += "}\n";
      out += "\n";
    }
  }
  // Coercion tests
  for (let i = 0; i < coercions.length; i++) {
    const alt = coercions[i];
    const suffix = i === 0 ? "" : `_${i + 1}`;

    out += "#[test]\n";
    out += `fn test_${snakeName}_from_${alt.title.toLowerCase()}${suffix}() {\n`;
    out += `    let value = serde_json::json!(${alt.value});\n`;
    out += "    let ctx = LoadContext::default();\n";
    out += `    let instance = ${typeName}::load_from_value(&value, &ctx);\n`;
    if (!isAbstract) {
      if (alt.validations.length > 0) {
        for (const item of alt.validations) {
          if (item.isOptional) {
            out += `    assert!(instance.${item.key}.is_some());\n`;
          } else if (isPolymorphicBase && item.key === "kind") {
            out += `    assert_eq!(instance.kind_str(), ${rustAssertionValue(node, item.key, item.value, item.delimiter)});\n`;
          } else {
            out += `    assert_eq!(instance.${item.key}, ${rustAssertionValue(node, item.key, item.value, item.delimiter)});\n`;
          }
        }
      } else {
        out +=
          "    let _ = instance; // load succeeded, no scalar properties to validate\n";
      }
    } else {
      out += "    let saved = instance.to_value(&SaveContext::default());\n";
      out += `    let reloaded = ${typeName}::load_from_value(&saved, &ctx);\n`;
      out +=
        '    assert_eq!(reloaded, instance, "scalar-coerced abstract models must survive save/reload");\n';
    }
    out += "}\n";
    out += "\n";
  }

  // Factory tests
  for (const factory of factories) {
    const factorySnake = toSnakeCase(factory.name);
    const paramEntries = Object.entries(factory.params);
    const paramValues = paramEntries
      .map(([, pType]) => factoryParamTestValue(pType))
      .join(", ");

    out += "#[test]\n";
    out += `fn test_${snakeName}_factory_${factorySnake}() {\n`;
    out += `    let instance = ${typeName}::${factorySnake}(${paramValues});\n`;

    for (const [propName, value] of Object.entries(factory.sets)) {
      if (value === true) {
        out += `    assert!(instance.${toSnakeCase(propName)});\n`;
      } else if (value === false) {
        out += `    assert!(!instance.${toSnakeCase(propName)});\n`;
      }
    }

    for (const [pName] of paramEntries) {
      const prop = node.properties.find((p) => p.name === pName);
      if (prop && prop.isOptional) {
        out += `    assert!(instance.${toSnakeCase(pName)}.is_some());\n`;
      }
    }

    out += "}\n";
    out += "\n";
  }

  return out;
}

/**
 * Escape arbitrary text into the body of a double-quoted Rust string literal.
 * Every non-ASCII code point is emitted as `\u{..}` so the generated source is
 * pure ASCII — this sidesteps both the Rust raw-string `#`-fence ceiling and the
 * `text_direction_codepoint_in_literal` deny-lint (bidi controls such as U+202E
 * are rejected even inside raw strings). The unescaped &str still carries the
 * exact original characters, so `serde_json::from_str` sees faithful JSON.
 */
function rustStringLiteralBody(text: string): string {
  let out = "";
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
  return out;
}

/**
 * Build a Rust test-function identifier for a vector: a unique `test_vector_N_*`
 * snake_case name discovered by `cargo test`.
 */
function rustVectorSlug(
  index: number,
  entry: { contract: string; operation: string; vector: { name?: string } },
): string {
  const name = entry.vector.name ?? "unnamed";
  const slug = `${entry.contract}_${entry.operation}_${name}`
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `test_vector_${index}_${slug || "unnamed"}`;
}

/**
 * One dispatched seam contract: the discriminated interface plus the lowered
 * `PolymorphicDispatchDecl` its `@dispatch` resolves on, and the namespace/group
 * that places its resolver module in the crate tree. Shared with the other
 * language emitters as `DispatchedContract` (see `../../ir/vector.js`).
 */

/**
 * Emit the Part III behavioral @dispatch resolver for one seam — the Rust twin
 * of the shape discriminator `match` (`emitter.ts:1125`). Where the shape match
 * maps a discriminator value to a constructed variant, this maps it to a
 * selected BEHAVIOR (`&dyn <Seam>`) drawn from a consumer-implemented provider
 * trait whose methods ARE the `dispatch.variants`.
 *
 * The provider trait is the compile-time completeness control (issue #282 §5
 * control 2): a downstream `impl <Seam>Provider for _` that omits a variant
 * method fails to compile (E0046, "not all trait items implemented"). Methods
 * return `Option` so a consumer signals a valid-but-unimplemented variant with
 * `None`, and the conformance harness does an explicit skip rather than a silent
 * registration miss.
 *
 * The unknown-value arm twins the shape layer: `load_from_value`
 * (`emitter.ts:1745`) panics on an unknown discriminator for a closed/abstract
 * base, so a closed dispatch panics here too; a default/open dispatch has no
 * base impl and yields `None`.
 */
function emitRustDispatchResolver(entry: DispatchedContract): string {
  const seam = entry.contract;
  const providerTrait = `${seam}Provider`;
  const field = entry.decl.discriminatorField;
  // Preserve the SAME variant order the shape match emits (`emitter.ts:1112`
  // iterates `dispatch.variants` directly) so the two switches stay a faithful,
  // deterministic twin.
  const variants = entry.decl.variants;
  // Closed (no fallback, no default): an unknown discriminator is a hard error,
  // exactly as the shape match arm throws. An open or default dispatch yields
  // None (harness explicit-skip); an abstract-open base routes unknowns to a
  // carrier in the shape loader, never panicking, so a bare
  // `isClosedPolymorphicDispatch` is the faithful twin of that throw arm.
  const rejectsUnknown = isClosedPolymorphicDispatch(entry.decl);
  // An open dispatch with a declared wildcard child (`CustomModel { provider:
  // "*" }`) gains a default trait method; an unknown discriminator routes to it
  // instead of yielding None — the behavioral twin of the shape loader's
  // `*`-tolerant fallback. Closed / open-self-reference dispatch keeps its
  // panic/None arm (no distinct child method).
  const defaultSlotBase = dispatchDefaultSlotBase(entry.decl);
  const defaultSlot = defaultSlotBase ? toSnakeCase(defaultSlotBase) : null;

  const lines: string[] = [
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    `// Part III behavioral @dispatch resolver for \`${seam}\` — the twin of the`,
    "// shape discriminator match. The provider trait below has one method per",
    "// @dispatch variant; a consumer attaches concrete impls by implementing it,",
    "// so a forgotten slot fails to compile (E0046).",
    "// See docs: reference/vector-conformance.",
    "",
    RUST_ALLOW_ATTR,
    "",
    `use super::${toSnakeCase(seam)}::${seam};`,
    "",
    `/// Consumer-attached provider of \`${seam}\` impls, one method per @dispatch`,
    "/// variant. Returns `None` to signal a valid-but-unimplemented variant to the",
    "/// caller (e.g. the conformance harness skips it), never a silent miss.",
    `pub trait ${providerTrait} {`,
  ];
  // Method names are the snake_case of the discriminator value. Every fixture
  // value today is a plain identifier; a value colliding with a Rust keyword
  // would need a raw identifier (r#kw). Deferred until a fixture needs it.
  for (const variant of variants) {
    lines.push(
      `    fn ${toSnakeCase(variant.value)}(&self) -> Option<&dyn ${seam}>;`,
    );
  }
  if (defaultSlot) {
    lines.push(
      `    /// Catch-all for an unknown discriminator (the declared \`*\` child).`,
    );
    lines.push(`    fn ${defaultSlot}(&self) -> Option<&dyn ${seam}>;`);
  }
  lines.push("}");
  lines.push("");
  lines.push(
    `/// Map a \`${field}\` discriminator value to the selected \`${seam}\` impl —`,
  );
  lines.push("/// the behavioral twin of the shape discriminator match.");
  lines.push(
    `pub fn resolve<'a>(${toSnakeCase(field)}: &str, registry: &'a dyn ${providerTrait}) -> Option<&'a dyn ${seam}> {`,
  );
  lines.push(`    match ${toSnakeCase(field)} {`);
  for (const variant of variants) {
    lines.push(
      `        ${JSON.stringify(variant.value)} => registry.${toSnakeCase(
        variant.value,
      )}(),`,
    );
  }
  if (rejectsUnknown) {
    lines.push(
      `        other => panic!("Unknown ${seam} discriminator '${field}' value: {}", other),`,
    );
  } else if (defaultSlot) {
    lines.push(`        _ => registry.${defaultSlot}(),`);
  } else {
    lines.push("        _ => None,");
  }
  lines.push("    }");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/**
 * Emit the seam-agnostic Rust `@vector` runner module (tests/vector_runner/mod.rs).
 *
 * Relocate-only extraction of the inline interpreter. The runner reads ZERO
 * authored values: the adapter/waiver/capability/doubles tables and the harness
 * base directory are injected through `VectorSeam`, which the thin harness
 * assembles from the runtime-authored `vector_adapters` module. Per Decision #2
 * the requirement guard is emitted unconditionally (inert when a vector declares
 * no `requires`); per Decision #3 only the harness conditionally loads the
 * capability table, so requires-free harnesses regenerate byte-identical.
 *
 * Option-A asymmetry (documented in the emitted header, do not "fix"): as a
 * nominally-typed target the runner imports the authored seam's port TYPES ONLY
 * (`Context`/`Adapter`/`Invoke`/`VectorError`) via `super::vector_adapters`. A
 * type-only import reads no authored state, so the value-independence the
 * closed-loop tests verify is preserved. The runner lives under a `tests/`
 * SUBDIRECTORY so cargo never compiles it as a standalone integration-test
 * crate; `super` resolves whether the harness is the crate root (standalone) or
 * a submodule of an aggregating `main.rs`.
 */
function emitRustVectorRunner(): string {
  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    "// Seam-agnostic @vector conformance interpreter. This module reads ZERO",
    "// runtime-authored values; the harness injects the adapter/waiver/capability/",
    "// doubles tables and its own base directory through `VectorSeam`. A vector",
    "// with no adapter and no explicit waiver is a hard failure — conformance",
    "// never skips silently.",
    "//",
    "// Option-A asymmetry (INTENTIONAL — do not 'fix'): as a nominally-typed",
    "// target this runner imports the authored seam's port TYPES ONLY",
    "// (`Context`/`Adapter`/`Invoke`/`VectorError`) via `super::vector_adapters`.",
    "// A type-only import reads no authored state, so the value-independence the",
    "// closed-loop tests verify is preserved. The module lives under a `tests/`",
    "// subdirectory so cargo never builds it as a standalone test crate; `super`",
    "// resolves whether the harness is the crate root or a submodule of main.rs.",
    "//",
    "// Adapter contract: `invoke` is either `Invoke::Sync(fn)` (a bare synchronous",
    "// fn — no boxing, no blocking bridge) or `Invoke::Async(..)` (a boxed future,",
    "// registered via `Adapter::asynchronous`). The runner awaits it exactly once",
    "// on this test's current-thread tokio runtime; a sync adapter resolves without",
    "// touching the runtime. An async body owns its inputs (the future is `'static`),",
    "// and no vector may spawn its own concurrency, so conformance stays",
    "// deterministic.",
    "//",
    "// Classification is ENFORCED: an operation marked `@sync` (the sync argument",
    "// threaded from each per-vector test) must be registered `Invoke::Sync` —",
    "// registering it `Invoke::Async` is a hard failure. An async-capable operation",
    "// (the default) accepts either variant.",
    "// See docs: reference/vector-conformance.",
    "",
    "#![allow(unused_imports, dead_code, non_camel_case_types, unused_variables, unexpected_cfgs, clippy::all)]",
    "",
    "use serde_json::Value;",
    "use std::collections::HashMap;",
    "",
    "// Option A: import the authored seam's port TYPES ONLY. No authored value",
    "// (adapters/waivers/doubles/capabilities) is read here — those arrive via the",
    "// injected VectorSeam below.",
    "use super::vector_adapters;",
    "",
    "// Runtime-authored seam tables injected by the harness. The runner reads none",
    "// of these directly from the authored module; everything flows through here.",
    "// `capabilities` is populated only when a vector declares `requires` (otherwise",
    "// left None and never consulted), keeping requirement-free harnesses",
    "// byte-identical.",
    "pub struct VectorSeam {",
    "    pub adapters: HashMap<&'static str, vector_adapters::Adapter>,",
    "    pub waivers: HashMap<&'static str, &'static str>,",
    "    pub doubles: Value,",
    "    pub capabilities:",
    "        Option<HashMap<&'static str, fn(&vector_adapters::Context) -> bool>>,",
    "    pub base_dir: String,",
    "}",
    "",
    "fn vc_resolve_refs(value: &Value, dir: &std::path::Path) -> Value {",
    "    match value {",
    "        Value::Array(items) => {",
    "            Value::Array(items.iter().map(|item| vc_resolve_refs(item, dir)).collect())",
    "        }",
    "        Value::Object(map) => {",
    "            if map.len() == 1 {",
    "                if let Some((key, Value::String(raw))) = map.iter().next() {",
    "                    match key.as_str() {",
    '                        "$env" => {',
    "                            return Value::String(std::env::var(raw).unwrap_or_default());",
    "                        }",
    '                        "$file" => {',
    "                            let text = std::fs::read_to_string(dir.join(raw))",
    '                                .expect("failed to read $file");',
    "                            return Value::String(text);",
    "                        }",
    '                        "$json" => {',
    "                            let text = std::fs::read_to_string(dir.join(raw))",
    '                                .expect("failed to read $json");',
    "                            return serde_json::from_str(&text)",
    '                                .expect("failed to parse $json");',
    "                        }",
    "                        _ => {}",
    "                    }",
    "                }",
    "            }",
    "            let mut out = serde_json::Map::new();",
    "            for (k, v) in map {",
    "                out.insert(k.clone(), vc_resolve_refs(v, dir));",
    "            }",
    "            Value::Object(out)",
    "        }",
    "        other => other.clone(),",
    "    }",
    "}",
    "",
    "async fn vc_invoke(",
    "    adapter: &vector_adapters::Adapter,",
    "    input: &Value,",
    "    ctx: &vector_adapters::Context,",
    ") -> Result<Value, vector_adapters::VectorError> {",
    "    // Await exactly once, on this test's tokio runtime. A sync adapter resolves",
    "    // immediately; an async adapter drives real async work on the live loop.",
    "    match &adapter.invoke {",
    "        vector_adapters::Invoke::Sync(f) => f(input, ctx),",
    "        vector_adapters::Invoke::Async(f) => f(input, ctx).await,",
    "    }",
    "}",
    "",
    "// Walks a deterministic field-access path (e.g. `agent.template.format.kind`)",
    "// over a resolved vector input to read the @dispatch discriminator value that",
    "// selects the concrete seam implementation. Returns None if any hop is missing",
    "// or the terminal value is not a string, so the caller can fail loudly.",
    "fn vc_resolve_dispatch_key(root: &Value, dotted: &str) -> Option<String> {",
    "    let mut node = root;",
    "    for key in dotted.split('.') {",
    "        node = node.get(key)?;",
    "    }",
    "    node.as_str().map(|s| s.to_string())",
    "}",
    "",
    "pub async fn vc_run_vector(",
    "    contract: &str,",
    "    operation: &str,",
    "    vector: Value,",
    "    sync: bool,",
    "    seam: VectorSeam,",
    ") {",
    "    vc_run_vector_dispatched(contract, operation, vector, sync, seam, None).await;",
    "}",
    "",
    "// Behavioral polymorphic dispatch (@dispatch): dispatch_path (Some for a",
    "// dispatched seam) is the discriminator access path. The concrete impl is",
    "// resolved once from the discriminator value read at that path on the vector",
    "// input and looked up in the seam's per-key registry (adapters keyed",
    "// `Contract.operation#key`). An impl absent for a valid key reuses the",
    "// capability-absent skip. Undispatched seams pass None and keep the single",
    "// adapter lookup unchanged.",
    "pub async fn vc_run_vector_dispatched(",
    "    contract: &str,",
    "    operation: &str,",
    "    vector: Value,",
    "    sync: bool,",
    "    seam: VectorSeam,",
    "    dispatch_path: Option<&str>,",
    ") {",
    '    let operation_key = format!("{}.{}", contract, operation);',
    '    let vector_name = vector.get("name").and_then(|v| v.as_str()).unwrap_or("unnamed");',
    '    let vector_id = format!("{}:{}", operation_key, vector_name);',
    "",
    "    let adapters = &seam.adapters;",
    "    let adapter = match dispatch_path {",
    "        Some(dispatch_path) if !dispatch_path.is_empty() => {",
    "            let dispatch_base = std::path::PathBuf::from(&seam.base_dir);",
    "            let dispatch_input =",
    '                vc_resolve_refs(vector.get("input").unwrap_or(&Value::Null), &dispatch_base);',
    "            let dispatch_key = match vc_resolve_dispatch_key(&dispatch_input, dispatch_path) {",
    "                Some(key) => key,",
    "                None => panic!(",
    `                    "{}: @dispatch path '{}' did not resolve to a string discriminator \\`,
    "on the vector input.\",",
    "                    vector_id, dispatch_path",
    "                ),",
    "            };",
    "            let dispatched = adapters",
    '                .get(format!("{}#{}", operation_key, dispatch_key).as_str())',
    '                .or_else(|| adapters.get(format!("{}#{}", operation, dispatch_key).as_str()));',
    "            match dispatched {",
    "                Some(adapter) => adapter,",
    "                None => {",
    '                    println!("SKIP {} (requirement unavailable: {})", vector_id, dispatch_key);',
    "                    return;",
    "                }",
    "            }",
    "        }",
    "        _ => {",
    "            let adapter = adapters",
    "                .get(operation_key.as_str())",
    "                .or_else(|| adapters.get(operation));",
    "            match adapter {",
    "                Some(adapter) => adapter,",
    "                None => {",
    "                    let waivers = &seam.waivers;",
    "                    let waiver = waivers",
    "                        .get(operation_key.as_str())",
    "                        .or_else(|| waivers.get(operation));",
    "                    if let Some(reason) = waiver {",
    "                        if !reason.is_empty() {",
    '                            println!("SKIP {} (waived: {})", vector_id, reason);',
    "                            return;",
    "                        }",
    "                    }",
    "                    panic!(",
    '                        "No vector adapter registered for {}. Register it in the module \\',
    "referenced by 'vector-adapter-path', or add an explicit waiver. @vector \\",
    'conformance never skips silently.",',
    "                        operation_key",
    "                    );",
    "                }",
    "            }",
    "        }",
    "    };",
    "",
    "    // @sync enforcement: the Invoke enum tag is the classification. A @sync op",
    "    // registered as Invoke::Async would resolve on the runtime instead of",
    "    // synchronously, so reject it before running the vector.",
    "    if sync {",
    "        if let vector_adapters::Invoke::Async(_) = adapter.invoke {",
    '            panic!(',
    '                "{}: operation is @sync but its adapter is registered Invoke::Async. \\',
    "A @sync operation must resolve synchronously — register it Invoke::Sync (drop \\",
    '@sync to keep it async-capable).",',
    "                vector_id",
    "            );",
    "        }",
    "    }",
    "",
    "    let base_dir = std::path::PathBuf::from(&seam.base_dir);",
    "    let ctx = vector_adapters::Context {",
    "        contract: contract.to_string(),",
    "        operation: operation.to_string(),",
    "        vector: vector.clone(),",
    '        provider: vector.get("provider").and_then(|v| v.as_str()).map(|s| s.to_string()),',
    '        target_api: vector.get("targetApi").and_then(|v| v.as_str()).map(|s| s.to_string()),',
    "        doubles: seam.doubles.clone(),",
    "        base_dir: seam.base_dir.clone(),",
    "    };",
    "",
    "    // Requirement guard (emitted unconditionally; inert when a vector declares",
    "    // no `requires`): a vector may declare abstract capability tokens in",
    "    // \"requires\". Each is resolved against the seam-injected capability table",
    "    // (populated by the harness only when some vector declares `requires`)",
    "    // BEFORE the adapter runs. An unregistered token is a hard failure (never",
    "    // skip silently). Rust has no runtime-conditional skip (#[ignore] is",
    "    // compile-time), so an unavailable token is a best-effort skip: print SKIP",
    "    // and return, passing the test while recording intent on stdout.",
    "    let requires = vector",
    '        .get("requires")',
    "        .and_then(|v| v.as_array())",
    "        .cloned()",
    "        .unwrap_or_default();",
    "    if !requires.is_empty() {",
    "        let capabilities = seam.capabilities.as_ref();",
    "        for token in &requires {",
    "            if let Some(token) = token.as_str() {",
    "                if !capabilities.map_or(false, |c| c.contains_key(token)) {",
    '                    panic!(',
    '                        "No capability predicate registered for requirement token \\"{}\\". \\',
    "Register it in the module referenced by 'vector-adapter-path'. @vector \\",
    'conformance never skips silently.",',
    "                        token",
    "                    );",
    "                }",
    "            }",
    "        }",
    "        for token in &requires {",
    "            if let Some(token) = token.as_str() {",
    "                if let Some(predicate) = capabilities.and_then(|c| c.get(token)) {",
    "                    if !predicate(&ctx) {",
    '                        println!("SKIP {} (requirement unavailable: {})", vector_id, token);',
    "                        return;",
    "                    }",
    "                }",
    "            }",
    "        }",
    "    }",
    "",
    '    let input = vc_resolve_refs(vector.get("input").unwrap_or(&Value::Null), &base_dir);',
    "    let normalize = |value: Value| -> Value {",
    "        match adapter.normalize {",
    "            Some(f) => f(&value, &ctx),",
    "            None => value,",
    "        }",
    "    };",
    "",
    "",
    "    // Per-vector waiver, consulted even when an adapter IS registered. Keyed by",
    "    // the vector id (\"Contract.operation:name\") or \"operation:name\" so it never",
    "    // collides with an operation-level waiver. xfail: a waived vector that fails",
    "    // is an expected failure (green); xpass: a waived vector that passes panics",
    "    // so stale waivers get removed.",
    "    let vector_waivers = &seam.waivers;",
    "    let vector_waiver = vector_waivers",
    "        .get(vector_id.as_str())",
    '        .or_else(|| vector_waivers.get(format!("{}:{}", operation, vector_name).as_str()))',
    "        .filter(|reason| !reason.is_empty())",
    "        .cloned();",
    "",
    "    // Evaluate WITHOUT panicking: None == match, Some(message) == mismatch, so",
    "    // the waiver decision below can turn a failure into an xfail.",
    '    let mismatch: Option<String> = if vector.get("expectedError").is_some() {',
    "        match vc_invoke(adapter, &input, &ctx).await {",
    "            Ok(_) => Some(format!(",
    '                "{}: expected the adapter to signal an error, but it returned a value.",',
    "                vector_id",
    "            )),",
    "            Err(err) => {",
    "                let observed = err",
    "                    .payload",
    "                    .clone()",
    '                    .unwrap_or_else(|| serde_json::json!({ "message": err.message }));',
    '                let expected = vector.get("expectedError").cloned().unwrap_or(Value::Null);',
    "                let got = normalize(observed);",
    "                if got != expected {",
    '                    Some(format!("{} error mismatch: expected {:?} but got {:?}", vector_id, expected, got))',
    "                } else {",
    "                    None",
    "                }",
    "            }",
    "        }",
    "    } else {",
    "        match vc_invoke(adapter, &input, &ctx).await {",
    "            Ok(observed) => {",
    '                let expected = vector.get("expected").cloned().unwrap_or(Value::Null);',
    "                let got = normalize(observed);",
    "                if got != expected {",
    '                    Some(format!("{} mismatch: expected {:?} but got {:?}", vector_id, expected, got))',
    "                } else {",
    "                    None",
    "                }",
    "            }",
    "            Err(err) => Some(format!(",
    '                "{}: adapter returned an unexpected error: {}",',
    "                vector_id, err.message",
    "            )),",
    "        }",
    "    };",
    "",
    "    match vector_waiver {",
    "        Some(reason) => match mismatch {",
    '            Some(_) => println!("XFAIL {} (waived: {})", vector_id, reason),',
    "            None => panic!(",
    '                "XPASS {}: waived vector unexpectedly passed; remove the waiver ({})",',
    "                vector_id, reason",
    "            ),",
    "        },",
    "        None => {",
    "            if let Some(message) = mismatch {",
    '                panic!("{}", message);',
    "            }",
    "        }",
    "    }",
    "}",
    "",
  ];

  return lines.join("\n");
}

/**
 * Emit the thin Rust `@vector` conformance harness (tests/vector_conformance_test.rs).
 *
 * The interpreter lives in the sibling `vector_runner` module (included via
 * `#[path]`). This suite only includes the runtime-authored adapter module named
 * by the target's `vector-adapter-path` option, assembles the seam it owns, and
 * calls `vector_runner::vc_run_vector` per vector. `vc_base_dir` stays here so
 * `file!()` resolves to the harness's own location. Per Decision #3 the
 * capability table is loaded into the seam only when a vector declares
 * `requires`, so requires-free harnesses regenerate byte-identical.
 */
function emitRustVectorConformanceTest(
  vectors: NonNullable<GeneratorOptions["callableVectors"]>,
  adapterPath: string,
): string {
  const model = buildVectorConformanceCodeModel(vectors);
  const hasRequires = model.vectors.some(
    (entry) => (entry.vector.requires?.length ?? 0) > 0,
  );

  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    "// Thin @vector behavioral conformance harness. The interpreter lives in the",
    "// sibling vector_runner module; this suite only includes the runtime-authored",
    "// adapter module named by the target's 'vector-adapter-path' option, builds",
    "// the seam it owns, and injects it into vector_runner::vc_run_vector. A vector",
    "// with no adapter and no explicit waiver is a hard failure — conformance never",
    "// skips silently.",
    "// See docs: reference/vector-conformance.",
    "",
    "#![allow(unused_imports, dead_code, non_camel_case_types, unused_variables, unexpected_cfgs, clippy::all)]",
    "",
    `#[path = ${JSON.stringify(adapterPath)}]`,
    "mod vector_adapters;",
    "",
    "// The seam-agnostic interpreter. Lives under a tests/ subdirectory so cargo",
    "// never compiles it as a standalone integration-test crate; included here via",
    "// an explicit #[path] relative to this harness file's directory.",
    '#[path = "vector_runner/mod.rs"]',
    "mod vector_runner;",
    "",
    "use serde_json::Value;",
    "",
    "// Resolves $file/$json vector inputs relative to THIS harness file (computed",
    "// here, not in the runner, so file!() points at the test directory).",
    "fn vc_base_dir() -> std::path::PathBuf {",
    '    let joined = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file!());',
    "    joined",
    "        .parent()",
    "        .map(|p| p.to_path_buf())",
    '        .unwrap_or_else(|| std::path::PathBuf::from("."))',
    "}",
    "",
    "// Assembles the runtime-authored seam the runner interprets. It reads the",
    "// authored registries from the vector_adapters module and injects them; the",
    "// runner itself reads none of these directly.",
    "fn vc_seam() -> vector_runner::VectorSeam {",
    "    vector_runner::VectorSeam {",
    "        adapters: vector_adapters::adapters(),",
    "        waivers: vector_adapters::waivers(),",
    "        doubles: vector_adapters::doubles(),",
    hasRequires
      ? "        capabilities: Some(vector_adapters::capabilities()),"
      : "        capabilities: None,",
    "        base_dir: vc_base_dir().to_string_lossy().to_string(),",
    "    }",
    "}",
    "",
  ];

  model.vectors.forEach((entry, index) => {
    const vectorLiteral = `"${rustStringLiteralBody(JSON.stringify(entry.vector))}"`;
    lines.push("#[tokio::test]");
    lines.push(`async fn ${rustVectorSlug(index, entry)}() {`);
    lines.push(`    let vector: Value = serde_json::from_str(${vectorLiteral})`);
    lines.push('        .expect("failed to decode vector");');
    lines.push(
      entry.dispatch
        ? `    vector_runner::vc_run_vector_dispatched(${JSON.stringify(
            entry.contract,
          )}, ${JSON.stringify(entry.operation)}, vector, ${
            entry.sync ? "true" : "false"
          }, vc_seam(), Some(${JSON.stringify(entry.dispatch.path)})).await;`
        : `    vector_runner::vc_run_vector(${JSON.stringify(
            entry.contract,
          )}, ${JSON.stringify(entry.operation)}, vector, ${
            entry.sync ? "true" : "false"
          }, vc_seam()).await;`,
    );
    lines.push("}");
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * First-slice eligibility for the typed conformance entrypoint (issue #511 Cat 1).
 *
 * The entrypoint decodes vector input with `serde_json::from_str` and re-encodes
 * the seam's result with `serde_json::to_value` for structural comparison. On the
 * PLAIN (non-serde) Rust target, models derive only `Debug, Clone, PartialEq` — NOT
 * `Serialize`/`Deserialize` — so those calls only compile when every param and the
 * return are serde-native SCALARS (`String`, integers, floats, bool, and their
 * `Option`/`Vec` wrappers). Model params/returns, `Record<…>`, and `unknown` need
 * the model's own `from_json`/`to_value` seam and structural normalization that is
 * a deferred follow-up, so this slice restricts to fully-scalar seams. This keeps
 * the slice additive and zero-diff on the integration surface (whose one eligible
 * plain seam takes a model array) while the dedicated `typed-seam-conformance`
 * fixture exercises the typed path red-first.
 */
function isScalarSeamEntry(entry: CallableVectorSnapshotEntry): boolean {
  if (!isBridgeEligible(entry)) return false;
  const isScalar = (typeRef: string): boolean =>
    scalarRuntimeKind(classifyCallableParam(typeRef).base) !== null;
  return (
    Object.values(entry.params).every(isScalar) && isScalar(entry.returns)
  );
}

/**
 * Emit the TYPED `@vector` conformance ENTRYPOINT (issue #511 Cat 1) — the
 * idiomatic replacement for the stringly `HashMap<&str, Adapter>` runner + the
 * consumer-authored `vector_adapters.rs` registry. For each undispatched,
 * non-cancellable, non-optional seam it emits ONE generic fn
 * `run_<seam>_conformance<S: <Seam> + ?Sized>(seam: &S)` with the seam's vectors
 * baked in: decode typed params, invoke the trait method DIRECTLY, and assert the
 * result. The consumer's authored surface collapses to their real `impl <Seam>`
 * plus a one-line typed call — no registry, no string keys, no boxed `Adapter`
 * closures, no marshalling bridge. `S: <Seam>` makes the compiler prove every op
 * is implemented (E0046), so conformance completeness is a COMPILE-TIME guarantee
 * rather than a runtime map lookup. Structural `serde_json::Value` comparison
 * absorbs field-order normalization for free.
 *
 * The module references ONLY the model crate + serde_json + std, so it carries no
 * dependency on the consumer's test module (no cycle). It is emitted ADDITIVELY
 * beside the existing stringly runner: a seam a consumer has not yet migrated
 * keeps its `vector_adapters.rs`; the emitted entrypoint is simply an available
 * `pub async fn` until a typed test calls it.
 *
 * Scope of this slice: `expected` (structural compare) and `expectedError` on
 * ASYNC ops. A `@sync` op has no error channel (its trait method returns a bare
 * value), so an `expectedError` vector on a sync op is skipped with a note;
 * `requires`/capability gating, `normalization`, and provider/targetApi routing
 * are deferred follow-ups (not exercised by the typed-seam fixture).
 */
function emitRustVectorConformanceEntrypoint(
  vectors: NonNullable<GeneratorOptions["callableVectors"]>,
  importPath: string,
): string {
  const eligible = vectors.vectors.filter(isScalarSeamEntry);
  // Group eligible vectors by seam contract; a seam's entrypoint carries all of
  // its eligible vectors so `S: <Seam>` enforces the WHOLE seam is implemented.
  const bySeam = new Map<string, CallableVectorSnapshotEntry[]>();
  for (const entry of eligible) {
    if (!bySeam.has(entry.contract)) bySeam.set(entry.contract, []);
    bySeam.get(entry.contract)!.push(entry);
  }

  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    "// Typed @vector conformance entrypoints (issue #511 Cat 1). Each generic fn",
    "// takes a consumer's REAL typed seam impl and runs the seam's baked-in vectors",
    "// by calling trait methods directly — the idiomatic replacement for the",
    "// stringly HashMap<&str, Adapter> runner + vector_adapters.rs registry. The",
    "// `S: <Seam>` bound makes the compiler prove every op is implemented (E0046),",
    "// so completeness is checked at COMPILE time, not by a runtime map lookup.",
    "// References only the model crate + serde_json + std (no vector_adapters, so",
    "// no cycle); emitted additively beside the stringly runner.",
    "// See docs: reference/vector-conformance.",
    "",
    "#![allow(unused_imports, dead_code, non_camel_case_types, unused_variables, unexpected_cfgs, clippy::all)]",
    "",
    "use serde_json::Value;",
    "",
  ];

  const seamNames = [...bySeam.keys()].sort();
  seamNames.forEach((seam, seamIndex) => {
    const entries = [...bySeam.get(seam)!].sort((left, right) =>
      (left.vector.name ?? "").localeCompare(right.vector.name ?? ""),
    );
    const fn = `run_${toSnakeCase(seam)}_conformance`;
    const seamIsAsync = entries.some((entry) => !entry.sync);
    const needsCtx = entries.some((entry) =>
      Object.values(entry.params).some(
        (paramType) => classifyCallableParam(paramType).bareModel,
      ),
    );

    lines.push(
      `/// Typed @vector conformance for ${seam}. Pass your real \`impl ${seam}\`; the`,
    );
    lines.push(
      `/// \`S: ${seam}\` bound makes the compiler prove every op is implemented. Call`,
    );
    lines.push(
      `/// from a test, e.g. \`${fn}(&${seam}Impl).await;\` (or without \`.await\` when sync).`,
    );
    lines.push(
      `pub ${seamIsAsync ? "async " : ""}fn ${fn}<S: ${importPath}::${seam} + ?Sized>(seam: &S) {`,
    );
    if (needsCtx) {
      lines.push(`    let ctx = ${importPath}::context::LoadContext::default();`);
    }

    entries.forEach((entry) => {
      const method = toSnakeCase(entry.operation);
      const paramNames = Object.keys(entry.params);
      const label = entry.vector.name ?? entry.operation;
      const input = (entry.vector.input ?? {}) as Record<string, unknown>;
      const hasExpectedError = entry.vector.expectedError !== undefined;
      const isAsyncOp = !entry.sync;

      // A sync op has no error channel (bare-value return), so it cannot express
      // expectedError in the typed path — skip that vector with a breadcrumb.
      if (hasExpectedError && !isAsyncOp) {
        lines.push(
          `    // skipped: ${label} — expectedError on a @sync op has no typed error channel`,
        );
        return;
      }

      lines.push(`    // vector: ${label}`);
      lines.push("    {");
      for (const paramName of paramNames) {
        const paramType = entry.params[paramName];
        const shape = classifyCallableParam(paramType);
        const local = rustFieldName(paramName);
        const paramJson = JSON.stringify(input[paramName] ?? {}, null, 2);
        if (shape.bareModel) {
          lines.push(`        let ${local} = ${importPath}::${paramType}::from_json(`);
          lines.push(`            r####"`);
          lines.push(paramJson);
          lines.push(`"####,`);
          lines.push("            &ctx,");
          lines.push("        )");
          lines.push(`        .expect(${JSON.stringify(`${paramName} parses`)});`);
        } else {
          lines.push(
            `        let ${local}: ${protocolRustType(paramType)} = serde_json::from_str(`,
          );
          lines.push(`            r####"`);
          lines.push(paramJson);
          lines.push(`"####,`);
          lines.push("        )");
          lines.push(`        .expect(${JSON.stringify(`${paramName} parses`)});`);
        }
      }
      const callArgs = paramNames
        .map((name) => `&${rustFieldName(name)}`)
        .join(", ");
      const invocation = `seam.${method}(${callArgs})${isAsyncOp ? ".await" : ""}`;

      if (hasExpectedError) {
        // Async op only reaches here. Assert the awaited Result erred; when
        // expectedError is a string, also require the message to contain it.
        lines.push(`        let result = ${invocation};`);
        lines.push(
          `        assert!(result.is_err(), ${JSON.stringify(`${label}: expected an error`)});`,
        );
        if (typeof entry.vector.expectedError === "string") {
          lines.push("        let message = result.unwrap_err().to_string();");
          lines.push(
            `        assert!(message.contains(${JSON.stringify(
              entry.vector.expectedError,
            )}), ${JSON.stringify(`${label}: error message mismatch`)});`,
          );
        }
      } else {
        // `expected` present (or absent). Async op unwraps the awaited Result; a
        // sync op returns the value directly.
        const bind = isAsyncOp
          ? `${invocation}.expect(${JSON.stringify(`${label}: seam ok`)})`
          : invocation;
        lines.push(`        let actual = ${bind};`);
        if (entry.vector.expected !== undefined) {
          lines.push(
            `        let actual_value = serde_json::to_value(actual).expect(${JSON.stringify(
              `${label}: serialize`,
            )});`,
          );
          const expectedJson = JSON.stringify(entry.vector.expected, null, 2);
          lines.push("        let expected: Value = serde_json::from_str(");
          lines.push(`            r####"`);
          lines.push(expectedJson);
          lines.push(`"####,`);
          lines.push("        )");
          lines.push(`        .expect(${JSON.stringify(`${label}: expected parses`)});`);
          lines.push(
            `        assert_eq!(actual_value, expected, ${JSON.stringify(
              `${label} misrouted`,
            )});`,
          );
        } else {
          // No scalar expected: reaching here without error IS the assertion.
          lines.push("        let _ = actual;");
        }
      }
      lines.push("    }");
    });

    lines.push("}");
    if (seamIndex < seamNames.length - 1) lines.push("");
  });

  return lines.join("\n") + "\n";
}

/**
 * (tests/${iface}_conformance_test.rs) — the per-interface twin of the per-model
 * ${model}_test.rs file (issue #282 §8). Each test loads the operation params
 * from the vector JSON, reads the shape discriminator off the TYPED graph, routes
 * it through the emitted `${seam}_resolver::resolve` against the consumer-attached
 * provider (`vector_adapters::${snake(seam)}_provider()`), invokes the typed seam,
 * and asserts the result reproduces `expected`. Missing an @dispatch slot fails to
 * COMPILE (E0046) on the consumer's provider impl, so conformance never silently
 * skips — the compile-time completeness control §5 control 2.
 */
function emitRustInterfaceConformanceTest(
  dispatched: DispatchedContract,
  entries: CallableVectorSnapshotEntry[],
  importPath: string,
  adapterPath: string,
  declsByName: Map<string, TypeDecl>,
  polymorphicTypeNames: Set<string>,
): string {
  const seam = dispatched.contract;
  const providerTrait = `${seam}Provider`;
  const resolverModule = `${toSnakeCase(seam)}_resolver`;
  const providerFactory = `${toSnakeCase(seam)}_provider`;
  // §8.5: sort by vector name so regen is byte-stable regardless of snapshot order.
  const sorted = [...entries].sort((left, right) =>
    (left.vector.name ?? "").localeCompare(right.vector.name ?? ""),
  );
  // Import the seam plus every MODEL param type it operates on, deduped and
  // sorted so the `use` line is deterministic. Non-model params (scalars,
  // `Record<unknown>`, optionals, arrays) have no importable symbol — their raw
  // TypeSpec spelling would break `cargo fmt` — so they are decoded inline
  // against the mapped Rust type instead.
  const typeNames = new Set<string>([seam]);
  for (const entry of sorted) {
    for (const typeName of Object.values(entry.params)) {
      if (classifyCallableParam(typeName).bareModel) typeNames.add(typeName);
    }
  }
  const importedTypes = [...typeNames].sort();
  const seen = new Map<string, number>();

  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    `// Part III TYPED @vector conformance for ${seam} — the per-interface twin of`,
    "// the per-model ${model}_test.rs file (issue #282 §8). Each test reads the",
    `// shape discriminator off the TYPED graph, routes it through ${resolverModule}::resolve`,
    `// against the consumer-attached provider (vector_adapters::${providerFactory}()),`,
    "// invokes the typed seam, and asserts the result reproduces `expected`. A",
    "// forgotten @dispatch slot fails to COMPILE (E0046) on the provider impl, so",
    "// conformance never silently skips.",
    "// See docs: reference/vector-conformance.",
    "",
    "#![allow(unused_imports, dead_code, non_camel_case_types, unused_variables, unexpected_cfgs, clippy::all)]",
    "",
    "// The consumer-authored provider attachment. Included via #[path] so the",
    "// harness stays a thin CONSUMER of the emitted resolver, never authoring the",
    "// provider itself.",
    `#[path = ${JSON.stringify(adapterPath)}]`,
    "mod vector_adapters;",
    "",
    `use ${importPath}::{${importedTypes.join(", ")}};`,
    `use ${importPath}::context::LoadContext;`,
    `use ${importPath}::${resolverModule}::{self, ${providerTrait}};`,
    "",
  ];

  sorted.forEach((entry, index) => {
    assertTypedDispatchSupported(entry);
    const paramNames = Object.keys(entry.params);
    const method = toSnakeCase(entry.operation);
    const accessor = rustDiscriminatorAccessor(
      entry.dispatch!.path,
      declsByName,
      entry.params[entry.dispatch!.path.split(".")[0]],
      polymorphicTypeNames,
    );
    const label = entry.vector.name ?? entry.operation;
    const expected = entry.vector.expected;
    const input = (entry.vector.input ?? {}) as Record<string, unknown>;

    lines.push(entry.sync ? "#[test]" : "#[tokio::test]");
    lines.push(
      `${entry.sync ? "fn" : "async fn"} ${uniqueRustTestName(
        seam,
        entry,
        index,
        seen,
      )}() {`,
    );
    lines.push("    let ctx = LoadContext::default();");
    for (const paramName of paramNames) {
      const paramType = entry.params[paramName];
      const shape = classifyCallableParam(paramType);
      const local = rustFieldName(paramName);
      const paramJson = JSON.stringify(input[paramName] ?? {}, null, 2);
      if (shape.bareModel) {
        lines.push(`    let ${local} = ${paramType}::from_json(`);
        lines.push(`        r####"`);
        lines.push(paramJson);
        lines.push(`"####,`);
        lines.push("        &ctx,");
        lines.push("    )");
        lines.push(`    .expect(${JSON.stringify(`${paramName} parses`)});`);
      } else {
        // A non-model seam param (scalar, `Record<unknown>`, optional, array) has
        // no generated `from_json`; decode it into the mapped Rust type with
        // serde — the same type the seam trait signature uses for the param.
        lines.push(
          `    let ${local}: ${protocolRustType(paramType)} = serde_json::from_str(`,
        );
        lines.push(`        r####"`);
        lines.push(paramJson);
        lines.push(`"####,`);
        lines.push("    )");
        lines.push(`    .expect(${JSON.stringify(`${paramName} parses`)});`);
      }
    }
    lines.push(`    let kind = ${accessor};`);
    lines.push(`    let provider = vector_adapters::${providerFactory}();`);
    lines.push(`    let seam_impl = ${resolverModule}::resolve(kind, &provider)`);
    lines.push(
      `        .unwrap_or_else(|| panic!(${JSON.stringify(
        `${label}: no ${seam} attached for {kind}`,
      )}));`,
    );
    const callArgs = paramNames
      .map((name) => `&${rustFieldName(name)}`)
      .join(", ");
    // A seam method is async => `-> Result<T, _>` (unwrap the awaited Result); a
    // sync seam method returns the value directly (rust/emitter.ts:2568), so it
    // has neither `.await` nor a Result to `.expect`.
    const invocationTail = entry.sync
      ? ""
      : `.await.expect(${JSON.stringify("seam invocation")})`;
    lines.push(
      `    let actual = seam_impl.${method}(${callArgs})${invocationTail};`,
    );
    if (typeof expected === "string") {
      lines.push(
        `    assert_eq!(actual, ${JSON.stringify(
          expected,
        )}, ${JSON.stringify(`${label} misrouted`)});`,
      );
    } else {
      // No scalar `expected`: reaching here means the route resolved and the seam
      // ran without error, which is the assertion. `actual` is referenced to
      // satisfy the compiler. A dispatched fixture needing richer comparison
      // extends this arm (reproduce-before-fix).
      lines.push("    let _ = actual;");
    }
    lines.push("}");
    lines.push("");
  });

  return lines.join("\n");
}

/**
 * Read the shape discriminator off a LOADED param for the typed Rust conformance
 * harness. A Rust polymorphic union field is `serde_json::Value` (see
 * dispatch-resolver.typed-rust.test.ts), so navigate the typed param graph to the
 * union then read the raw wire field via `.get(field).as_str()`. The path head is
 * a param local (guaranteed by assertTypedDispatchSupported); middle segments
 * navigate snake_case struct fields.
 *
 * Optionality-aware AND lowering-aware: an intermediate whose lowered `FieldDecl`
 * is a Rust `Option<…>` must be unwrapped with `.as_ref().expect("<field> present")`
 * before the next field access. But a value-backed coerce/polymorphic-union field
 * (`FormatConfig | string`, `Model | string`, `unknown`) lowers to a BARE
 * `serde_json::Value` even when the schema marks it optional — Rust drops the
 * `Option` because `Value::Null` is the absent sentinel (see `fieldType`). Such a
 * field must therefore be read directly (`agent.model.get("provider")…`), never
 * `.as_ref()`-unwrapped (E0599: no method `as_ref` on `serde_json::Value`). So the
 * unwrap is gated on the LOWERED type actually being `Option<T>`: optional AND not
 * value-backed. This is the Rust twin of `swiftDiscriminatorAccessor`'s `!` — but
 * Swift keeps its optional through the lowering, so Swift unwraps where Rust must
 * not. A required field, or a field we cannot resolve, gets no unwrap.
 */
function rustDiscriminatorAccessor(
  path: string,
  declsByName: Map<string, TypeDecl>,
  rootTypeName: string | undefined,
  polymorphicTypeNames: Set<string>,
): string {
  const segments = path.split(".");
  const rawField = segments[segments.length - 1];
  const containerSegments = segments.slice(1, -1);
  let currentType = rootTypeName ? declsByName.get(rootTypeName) : undefined;
  const parts = [rustFieldName(segments[0])];
  for (const segment of containerSegments) {
    const field = currentType?.fields.find((f) => f.name === segment);
    const access = rustFieldName(segment);
    // A value-backed complex field (polymorphic/coerce union or `unknown`) lowers
    // to a bare `serde_json::Value`, so its optionality is erased — read it
    // directly. Only a genuinely `Option<T>`-lowered field is unwrapped.
    const fieldTypeName =
      field?.category.kind === "complex" ||
      field?.category.kind === "collection_complex"
        ? field.category.typeName
        : undefined;
    const isValueBacked =
      fieldTypeName !== undefined &&
      (polymorphicTypeNames.has(fieldTypeName) || fieldTypeName === "unknown");
    parts.push(
      field?.isOptional && !isValueBacked
        ? `${access}.as_ref().expect(${JSON.stringify(`${segment} present`)})`
        : access,
    );
    currentType = field ? declsByName.get(field.typeName.name) : undefined;
  }
  const container = parts.join(".");
  return `${container}\n        .get(${JSON.stringify(
    rawField,
  )})\n        .and_then(|v| v.as_str())\n        .expect("discriminator present")`;
}

/**
 * A collision-safe snake_case Rust test fn name for a per-interface conformance
 * vector: `test_${seam}_${operation}_${vectorName}`, with a numeric suffix on the
 * rare identifier collision so two vector names never emit duplicate fns.
 */
function uniqueRustTestName(
  seam: string,
  entry: { operation: string; vector: { name?: string } },
  index: number,
  seen: Map<string, number>,
): string {
  const raw = `${seam} ${entry.operation} ${entry.vector.name ?? "unnamed"}`;
  const base =
    `test_${toSnakeCase(raw.replace(/[^A-Za-z0-9]+/g, "_"))}` || `test_${index}`;
  const prior = seen.get(base);
  if (prior === undefined) {
    seen.set(base, 0);
    return base;
  }
  seen.set(base, prior + 1);
  return `${base}_${prior + 1}`;
}
