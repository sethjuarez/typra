import { EmitContext, resolvePath } from "@typespec/compiler";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { resolve } from "path";
import { EmitTarget, TypraEmitterOptions } from "../../lib.js";
import {
  BaseTestContext,
  enumerateTypes,
  TypeNode,
} from "../../ir/ast.js";
import { GeneratorOptions, filterNodes } from "../../emitter.js";
import { TypeRegistry } from "../../ir/expansion.js";
import { RustExprVisitor } from "./visitor.js";
import { buildBaseTestContext, rustTestOptions } from "../../testing/test-context.js";
import { toSnakeCase } from "../../ir/utilities.js";
import { lowerFile, collectPolymorphicTypeNames } from "../../ir/lower.js";
import { emitRustFile as emitRustFileDecl } from "./emitter.js";
import { emitGeneratedFile } from "../../cleanup/generated-file.js";
import { collectProtocolNodes, emitRustProtocolScaffolds, shouldEmitCompileOnlyProtocolScaffolds } from "../../protocol-scaffolds.js";

/**
 * Type mapping from TypeSpec scalar types to Rust types.
 * Retained for use by the test template context.
 */
export const rustTypeMapper: Record<string, string> = {
  "string": "String",
  "number": "f64",
  "array": "Vec<serde_json::Value>",
  "object": "serde_json::Value",
  "boolean": "bool",
  "int64": "i64",
  "int32": "i32",
  "float64": "f64",
  "float32": "f32",
  "integer": "i64",
  "float": "f64",
  "numeric": "f64",
  "any": "serde_json::Value",
  "dictionary": "serde_json::Value",
};

const RUST_KEYWORDS = new Set([
  "as", "break", "const", "continue", "crate", "else", "enum", "extern",
  "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod",
  "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct",
  "super", "trait", "true", "type", "unsafe", "use", "where", "while",
  "async", "await", "dyn",
]);

function rustFieldName(name: string): string {
  const snake = toSnakeCase(name);
  return RUST_KEYWORDS.has(snake) ? `r#${snake}` : snake;
}


/**
 * Stale-file deletion is intentionally disabled until manifest cleanup is enabled.
 */
function cleanupFlatTypeFiles(relDir: string | undefined, isTypeFile: (name: string) => boolean): void {
  void relDir;
  void isTypeFile;
  return;
}

/**
 * Main entry point for Rust code generation.
 */
export const generateRust = async (
  context: EmitContext<TypraEmitterOptions>,
  node: TypeNode,
  emitTarget: EmitTarget,
  options?: GeneratorOptions
): Promise<void> => {
  const allTypes = Array.from(enumerateTypes(node));
  const nodes = filterNodes(allTypes, options);

  // Stale flat-file cleanup is disabled in this slice.
  cleanupFlatTypeFiles(emitTarget["output-dir"], name =>
    name.endsWith(".rs") && name !== "context.rs" && name !== "mod.rs" && name !== "lib.rs"
  );
  cleanupFlatTypeFiles(emitTarget["test-dir"], name =>
    name.endsWith(".rs") && name !== "mod.rs" && name !== "main.rs"
  );

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

  // Render context.rs
  const contextContent = emitRustContext("Prompty Context");
  await emitRustFile(context, 'context.rs', contextContent, emitTarget["output-dir"]);

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
      const fileDecl = lowerFile(n, registry, polymorphicTypeNames);
      const fileContent = emitRustFileDecl(fileDecl, visitor, polymorphicTypeNames, childToParent, {
        enumParsing: emitTarget["enum-parsing"] ?? "case-sensitive",
      });
      const fileName = toSnakeCase(n.typeName.name) + '.rs';
      const outDir = group ? `${emitTarget["output-dir"]}/${group}` : emitTarget["output-dir"];
      await emitRustFile(context, fileName, fileContent, outDir, emitTarget["output-dir"]);

      if (!groupModuleNames.has(group)) groupModuleNames.set(group, []);
      groupModuleNames.get(group)!.push(toSnakeCase(n.typeName.name));
    }

    // Render test file — skip children of polymorphic hierarchies (they're enum variants now) and protocols
    if (emitTarget["test-dir"] && !childToParent.has(n.typeName.name) && !n.isProtocol) {
      const importPath = emitTarget["import-path"] || "crate";
      const testContext = buildTestContext(n);
      const isPolymorphicBase = !!(n.discriminator && n.childTypes.length > 0);
      const testContent = emitRustTest({
        ...testContext,
        importPath,
        isPolymorphicBase,
      });
      const testFileName = toSnakeCase(n.typeName.name) + '_test.rs';
      const testGroup = n.group || "";
      const testDir = testGroup ? `${emitTarget["test-dir"]}/${testGroup}` : emitTarget["test-dir"];
      await emitRustFile(context, testFileName, testContent, testDir, emitTarget["test-dir"]);
      if (!testGroupModuleNames.has(testGroup)) testGroupModuleNames.set(testGroup, []);
      testGroupModuleNames.get(testGroup)!.push(toSnakeCase(n.typeName.name) + '_test');
    }
  }

  if (emitTarget["test-dir"] && shouldEmitCompileOnlyProtocolScaffolds(emitTarget)) {
    const importPath = emitTarget["import-path"] || "crate";
    const scaffoldContent = emitRustProtocolScaffolds(collectProtocolNodes(nodes), importPath);
    await emitRustFile(context, "protocol_scaffolds_test.rs", scaffoldContent, emitTarget["test-dir"], emitTarget["test-dir"]);
    if (!testGroupModuleNames.has("")) testGroupModuleNames.set("", []);
    testGroupModuleNames.get("")!.push("protocol_scaffolds_test");
  }

  // Render per-group mod.rs files (source)
  for (const [group, modules] of groupModuleNames) {
    if (!group) continue; // Root-level types handled in root mod.rs
    const groupModContent = emitRustGroupMod(modules);
    await emitRustFile(context, 'mod.rs', groupModContent, `${emitTarget["output-dir"]}/${group}`, emitTarget["output-dir"]);
  }

  // Render test group mod.rs files and test main.rs
  if (emitTarget["test-dir"]) {
    // Emit per-group mod.rs (test)
    const testGroups: string[] = [];
    for (const [group, testMods] of testGroupModuleNames) {
      if (group) {
        const groupModContent = '// Code generated by Typra emitter; DO NOT EDIT.\n\n#![allow(unused_imports, dead_code, non_camel_case_types, unused_variables, clippy::all)]\n\n'
          + testMods.map(m => `mod ${m};`).join('\n') + '\n';
        await emitRustFile(context, 'mod.rs', groupModContent, `${emitTarget["test-dir"]}/${group}`, emitTarget["test-dir"]);
        testGroups.push(group);
      }
    }
    // Emit root-level test files (no group)
    const rootTestMods = testGroupModuleNames.get("") || [];
    const allTopLevel = [...rootTestMods.map(m => `mod ${m};`), ...testGroups.sort().map(g => `mod ${g};`)];
    const mainContent = '// Code generated by Typra emitter; DO NOT EDIT.\n\n#![allow(unused_imports, dead_code, non_camel_case_types, unused_variables, clippy::all)]\n\n'
      + allTopLevel.join('\n') + '\n';
    await emitRustFile(context, 'main.rs', mainContent, emitTarget["test-dir"]);
  }

  // Render root mod.rs
  const rootModules = groupModuleNames.get("") || [];
  const groups = Array.from(groupModuleNames.keys()).filter(g => g !== "").sort();
  const libContent = emitRustLib(['context', ...rootModules], groups);
  await emitRustFile(context, 'mod.rs', libContent, emitTarget["output-dir"]);

  // Format emitted files
  if (emitTarget.format !== false) {
    const outputDir = emitTarget["output-dir"]
      ? resolve(process.cwd(), emitTarget["output-dir"])
      : context.emitterOutputDir;
    formatRustFiles(outputDir);
  }
};

/**
 * Format Rust files using cargo fmt.
 */
function formatRustFiles(outputDir: string): void {
  // Run cargo fmt if Cargo.toml exists in parent
  const cargoToml = resolve(outputDir, '../Cargo.toml');
  if (existsSync(cargoToml)) {
    try {
      execFileSync("cargo", ["fmt", "--manifest-path", cargoToml], {
        stdio: 'pipe',
        encoding: 'utf-8'
      });
      normalizeRustFileEndings(resolve(outputDir, '..'));
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
function buildTestContext(node: TypeNode): BaseTestContext {
  return buildBaseTestContext(node, undefined, rustTestOptions);
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
  await emitGeneratedFile(context, filePath, `${content.trimEnd()}\n`, { outputRoot: outputRoot || outputDir });
}

/**
 * Emit the context.rs file content (LoadContext/SaveContext structs).
 */
function emitRustContext(header: string): string {
  return `// Code generated by Typra emitter; DO NOT EDIT.
// ${header}

#![allow(unused_imports, dead_code, non_camel_case_types, unused_variables, clippy::all)]

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
export function emitRustLib(rootModules: string[], groups: string[] = []): string {
  let out = '// Code generated by Typra emitter; DO NOT EDIT.\n\n#![allow(unused_imports, dead_code, non_camel_case_types, unused_variables, clippy::all)]\n';
  for (const module of rootModules) {
    out += `\npub mod ${module};\npub use ${module}::*;\n`;
  }
  for (const group of groups) {
    out += `\npub mod ${group};\npub use ${group}::*;\n`;
  }
  return `${out.trimEnd()}\n`;
}

/**
 * Emit a per-group mod.rs file that declares and re-exports all modules in that group.
 */
export function emitRustGroupMod(moduleNames: string[]): string {
  let out = '// Code generated by Typra emitter; DO NOT EDIT.\n\n#![allow(unused_imports, dead_code, non_camel_case_types, unused_variables, clippy::all)]\n';
  for (const module of moduleNames) {
    out += `\npub mod ${module};\npub use ${module}::*;\n`;
  }
  return out;
}

/**
 * Map a factory parameter type string to a Rust test value literal.
 */
function factoryParamTestValue(typeStr: string): string {
  switch (typeStr) {
    case "string": return '"test".to_string()';
    case "boolean": return "true";
    case "integer":
    case "int32": return "42";
    case "int64": return "42i64";
    case "float":
    case "float64": return "3.14";
    case "unknown": return 'serde_json::json!("test")';
    default: return 'serde_json::json!("test")';
  }
}

function rustAssertionValue(node: TypeNode, key: string, value: unknown, delimiter: string): string {
  if (delimiter !== "" || typeof value !== "number" || !Number.isInteger(value)) {
    return `${delimiter}${value}${delimiter}`;
  }

  const prop = node.properties.find(p => rustFieldName(p.name) === key);
  const scalar = prop?.typeName.name;
  if (scalar === "float" || scalar === "float32" || scalar === "float64" || scalar === "number" || scalar === "numeric") {
    return `${value}.0`;
  }

  return `${value}`;
}

export interface RustTestContext extends BaseTestContext {
  importPath: string;
  isPolymorphicBase: boolean;
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
    return Object.values(v as Record<string, unknown>).some(hasNonIntegerNumber);
  }
  return false;
}

/**
 * Emit an integration test file for a TypeSpec model type.
 */
export function emitRustTest(ctx: RustTestContext): string {
  const { node, isAbstract, examples, coercions, factories, importPath, isPolymorphicBase } = ctx;
  const typeName = node.typeName.name;
  const snakeName = toSnakeCase(typeName);
  let out = '';

  // Collect enum types referenced in properties (for use imports)
  const enumImports = new Set<string>();
  for (const prop of node.properties) {
    if (prop.enumName && node.discriminator !== prop.name) {
      enumImports.add(prop.enumName);
    }
  }

  out += '// Code generated by Typra emitter; DO NOT EDIT.\n';
  out += '\n';
  out += '#![allow(unused_imports, dead_code, non_camel_case_types, unused_variables, clippy::all)]\n';
  out += '\n';
  out += `use ${importPath}::${typeName};\n`;
  for (const enumName of [...enumImports].sort()) {
    if (enumName !== typeName) {
      out += `use ${importPath}::${enumName};\n`;
    }
  }
  out += `use ${importPath}::context::{LoadContext, SaveContext};\n`;
  out += '\n';

  // Example tests (load JSON, load YAML, roundtrip)
  for (let i = 0; i < examples.length; i++) {
    const sample = examples[i];
    const suffix = i === 0 ? '' : `_${i}`;

    // JSON load test
    out += '#[test]\n';
    out += `fn test_${snakeName}_load_json${suffix}() {\n`;
    out += '    let json = r####"\n';
    for (const line of sample.json) {
      out += `${line}\n`;
    }
    out += '"####;\n';
    out += '    let ctx = LoadContext::default();\n';
    out += `    let result = ${typeName}::from_json(json, &ctx);\n`;
    out += '    assert!(result.is_ok(), "Failed to load from JSON: {:?}", result.err());\n';
    if (!isAbstract) {
      out += '    let instance = result.unwrap();\n';
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
        out += '    let _ = instance; // load succeeded, no scalar properties to validate\n';
      }
    }
    out += '}\n';
    out += '\n';

    // YAML load test
    out += '#[test]\n';
    out += `fn test_${snakeName}_load_yaml${suffix}() {\n`;
    out += '    let yaml = r####"\n';
    for (const line of sample.yaml) {
      out += `${line}\n`;
    }
    out += '"####;\n';
    out += '    let ctx = LoadContext::default();\n';
    out += `    let result = ${typeName}::from_yaml(yaml, &ctx);\n`;
    out += '    assert!(result.is_ok(), "Failed to load from YAML: {:?}", result.err());\n';
    if (!isAbstract) {
      out += '    let instance = result.unwrap();\n';
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
        out += '    let _ = instance; // load succeeded, no scalar properties to validate\n';
      }
    }
    out += '}\n';
    out += '\n';

    // Roundtrip test
    out += '#[test]\n';
    out += `fn test_${snakeName}_roundtrip${suffix}() {\n`;
    out += '    let json = r####"\n';
    for (const line of sample.json) {
      out += `${line}\n`;
    }
    out += '"####;\n';
    out += '    let load_ctx = LoadContext::default();\n';
    out += `    let result = ${typeName}::from_json(json, &load_ctx);\n`;
    out += '    assert!(result.is_ok(), "Failed to load: {:?}", result.err());\n';
    if (!isAbstract) {
      out += '    let instance = result.unwrap();\n';
      out += '    let save_ctx = SaveContext::default();\n';
      out += '    let json_output = instance.to_json(&save_ctx);\n';
      out += '    assert!(json_output.is_ok(), "Failed to serialize to JSON: {:?}", json_output.err());\n';
    }
    out += '}\n';
    out += '\n';

    // Serde round-trip test: deserialize EXTERNAL canonical JSON via serde,
    // re-serialize via serde, and deserialize again — proving Serialize +
    // Deserialize + PartialEq all work and that the discriminated union's `kind`
    // survives the serde path with its exact canonical wire value. With the old
    // externally-tagged derive this would fail to even deserialize nested
    // discriminated values (e.g. `{"kind":"text",...}`).
    if (!isAbstract) {
      out += '#[test]\n';
      out += `fn test_${snakeName}_serde_roundtrip${suffix}() {\n`;
      out += '    let json = r####"\n';
      for (const line of sample.json) {
        out += `${line}\n`;
      }
      out += '"####;\n';
      out += `    let instance: ${typeName} = serde_json::from_str(json)\n`;
      out += '        .expect("serde should deserialize canonical JSON");\n';
      out += '    let value = serde_json::to_value(&instance)\n';
      out += '        .expect("serde should serialize");\n';
      // Parse the ORIGINAL canonical (internally-tagged) JSON so we can assert the
      // serde-re-serialized polymorphic sub-values are byte-identical to it — this is
      // the acceptance gate: it proves serde produces canonical internally-tagged wire
      // (`{"kind":"text",...}`), NOT the externally-tagged derive form
      // (`{"kind":{"TextContent":{...}}}`), with empty-omission preserved.
      out += '    let canonical: serde_json::Value = serde_json::from_str(json)\n';
      out += '        .expect("canonical json parses");\n';
      // Delegation-equivalence (ALWAYS): the uniform manual serde impls route Serialize
      // through `to_value` and Deserialize through `load_from_value`, so serde output/input
      // MUST equal the canonical context-aware form for EVERY type — independent of whether
      // the `@sample` is complete, how collections are shaped, or int-vs-float rendering.
      // This is the sample-agnostic invariant that holds for arbitrary consumer models
      // (whose `@sample` annotates only some fields); the byte-identity assertions below are
      // ADDITIONALLY emitted only for complete, byte-safe samples (typra's own fixtures).
      out += '    assert_eq!(value, instance.to_value(&SaveContext::default()), "serde serialize must equal canonical to_value");\n';
      out += `    assert_eq!(instance, ${typeName}::load_from_value(&canonical, &LoadContext::default()), "serde deserialize must equal canonical load_from_value");\n`;
      // A whole-object/nested byte-identity assertion against the `@sample` JSON is only
      // valid when the sample is a canonical fixed point: every REQUIRED field is present
      // (otherwise `to_value` correctly emits required fields the partial sample omits) and
      // no float-typed field is sampled with an integer literal (`12` canonicalizes to
      // `12.0`, which serde_json::Value compares unequal). Consumer models annotate partial
      // samples and must fall back to the delegation-equivalence above; typra's own fixtures
      // author complete samples and keep the stronger byte-identity checks.
      const floatScalarNames = new Set(["float", "float32", "float64", "number", "numeric"]);
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
            if ((!p.isOptional || p.defaultValue != null) && !(p.name in obj)) return false;
            const pv = obj[p.name];
            // Cause D (mirror image of the above): a REQUIRED field authored in the sample
            // at its zero/empty value is OMITTED by to_value — required string == "", int
            // == 0, float == 0.0, and empty collections are all dropped (see emitScalarSave /
            // emitSaveField omission guards). So the sample is not a canonical fixed point and
            // whole-object byte-identity vs it is invalid (e.g. prompty's validation_result
            // `errors:[]`, turn_model_request `iteration:0`). Optional fields authored at zero
            // ARE emitted (`Some(0)`), so this only applies to required (non-`?`) fields.
            if (!p.isOptional && p.name in obj) {
              if (p.isCollection && Array.isArray(pv) && pv.length === 0) return false;
              if (p.isScalar && !p.isCollection && typeof pv === "string" && pv === "") return false;
              if (p.isScalar && !p.isCollection && typeof pv === "number" && pv === 0) return false;
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
      const kindV = sample.validations.find(v => v.key === "kind" && !v.isOptional);
      if (isPolymorphicBase && kindV) {
        out += `    assert_eq!(value.get("kind").and_then(|v| v.as_str()), Some(${rustAssertionValue(node, "kind", kindV.value, kindV.delimiter)}), "discriminator must round-trip to its canonical wire value");\n`;
        // A directly-sampled polymorphic type must re-serialize byte-identical to its
        // canonical internally-tagged input — but only when the sample is byte-safe
        // (complete + no int/float ambiguity). Partial consumer samples rely on the
        // delegation-equivalence assertions above instead.
        if (byteSafeSample) {
          out += '    assert_eq!(value, canonical, "polymorphic type must re-serialize to byte-identical canonical internally-tagged JSON");\n';
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
      // Element type names known to carry a `name` property (i.e. keyed collections),
      // used by the keyed-map assertion + synthesized map-input block below. Built once to
      // work around the cycle-prevention quirk where an element's `prop.type` is unset on a
      // later sibling of the same element type. `isNamedCollection` is the structural flag
      // set at IR resolution for `Record<T>|Named<..>[]` bags — authoritative even when
      // `prop.type` (the injected-`name` wrapper) was left unresolved on a later sibling.
      const namedElementTypes = new Set<string>();
      for (const p of node.properties) {
        if (p.isNamedCollection || (p.type && p.type.properties.some(t => t.name === "name"))) {
          namedElementTypes.add(p.typeName.name);
        }
      }
      const isKeyedCollection = (prop: TypeNode["properties"][number]): boolean =>
        prop.isCollection &&
        (prop.isNamedCollection ||
          (prop.type?.properties.some(t => t.name === "name") ?? false) ||
          namedElementTypes.has(prop.typeName.name));
      // Keyed-collection canonicalization: a collection whose element model has a
      // `name` property saves as a canonical name-keyed MAP. This is exactly the
      // property-bag pattern (e.g. prompty's `inputs`/`outputs`/`parameters`,
      // declared as the union `Record<T> | Named<T>[]`) that a plain
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
            .map(e =>
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
              typeof sv === "string" || typeof sv === "number" || typeof sv === "boolean";
            const isComplexModel = !prop.isScalar && !prop.isCollection && !prop.enumName;
            if (isPrimitive && isComplexModel) {
              byteStable = false;
              break;
            }
          }
        }
        const hasFloat = sample.sample ? hasNonIntegerNumber(sample.sample) : false;
        if (byteStable && !hasFloat && byteSafeSample) {
          out += `    assert_eq!(value, canonical, "serde must serialize to byte-identical canonical wire (empty-omission preserved; no plain-derive divergence)");\n`;
        }
      }
      out += `    let reparsed: ${typeName} = serde_json::from_value(value)\n`;
      out += '        .expect("serde should re-deserialize");\n';
      out += '    assert_eq!(instance, reparsed, "serde round-trip must be stable");\n';
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
          out += '        .expect("serde must deserialize the canonical name-keyed MAP form (a plain Vec derive fails here with \\"invalid type: map, expected a sequence\\")");\n';
          out += '    assert_eq!(from_map, instance, "map-form and array-form inputs must load to equal instances");\n';
          out += '    let map_value = serde_json::to_value(&from_map)\n';
          out += '        .expect("serde should serialize the map-loaded instance");\n';
          for (const name of keyedMapProps) {
            out += `    assert!(map_value.get(${JSON.stringify(name)}).map(|v| v.is_object()).unwrap_or(false), "keyed collection loaded from a MAP must re-serialize to the canonical name-keyed map");\n`;
          }
        }
      }
      out += '}\n';
      out += '\n';
    }
  }
  // Coercion tests
  for (let i = 0; i < coercions.length; i++) {
    const alt = coercions[i];
    const suffix = i === 0 ? '' : `_${i + 1}`;

    out += '#[test]\n';
    out += `fn test_${snakeName}_from_${alt.title.toLowerCase()}${suffix}() {\n`;
    out += `    let value = serde_json::json!(${alt.value});\n`;
    out += '    let ctx = LoadContext::default();\n';
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
        out += '    let _ = instance; // load succeeded, no scalar properties to validate\n';
      }
    } else {
      out += '    let _ = instance; // abstract type, load succeeded\n';
    }
    out += '}\n';
    out += '\n';
  }

  // Factory tests
  for (const factory of factories) {
    const factorySnake = toSnakeCase(factory.name);
    const paramEntries = Object.entries(factory.params);
    const paramValues = paramEntries.map(([, pType]) => factoryParamTestValue(pType)).join(', ');

    out += '#[test]\n';
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
      const prop = node.properties.find(p => p.name === pName);
      if (prop && prop.isOptional) {
        out += `    assert!(instance.${toSnakeCase(pName)}.is_some());\n`;
      }
    }

    out += '}\n';
    out += '\n';
  }

  return out;
}
