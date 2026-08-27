/**
 * Rust code emitter — Declaration IR → Rust source code.
 *
 * Replaces `file.rs.njk` + `_macros.njk` (~1,072 lines of Nunjucks templates)
 * with a typed TypeScript function that walks the FileDecl tree.
 *
 * The emitter produces Rust code using the struct + enum pattern for
 * polymorphic types. Output is post-processed by `cargo fmt`.
 *
 * Key Rust-specific patterns:
 *   - Polymorphic types use struct + XxxKind enum (not inheritance)
 *   - Variant-specific fields live on enum variants, not child classes
 *   - Polymorphic single-ref fields → serde_json::Value
 *   - Ownership: String, Option<T>, Vec<T>
 *   - Pattern matching for load/save of variant fields
 *
 * Structural blocks emitted (in order):
 *   1. Header comment (auto-generated warning)
 *   2. Imports (context, referenced types)
 *   3. For each polymorphic type:
 *      a. XxxKind enum with inline struct variants
 *      b. impl Default for XxxKind
 *   4. For each type:
 *      a. Struct definition with #[derive(Debug, Clone, Default)]
 *      b. impl block:
 *         - new(), from_json(), from_yaml()
 *         - load_from_value()
 *         - kind_str() (polymorphic only)
 *         - to_value(), to_json(), to_yaml()
 *         - to_wire() (when wire mappings exist)
 *         - Collection helpers
 *         - Factory methods
 *         - Method stubs (as trait)
 */

import {
  FileDecl,
  TypeDecl,
  FieldDecl,
  EnumDef,
  LoadAssignment,
  SaveAssignment,
  CollectionHelperDecl,
  PolymorphicDispatchDecl,
  PolymorphicVariant,
  FactoryDecl,
  CoercionDecl,
  PropertyCategory,
  MethodStubDecl,
  WireDecl,
  isClosedPolymorphicDispatch,
} from "../../ir/declarations.js";
import {
  shouldGuardMissingRequiredField,
  shouldMaterializeCollectionDefault,
  shouldOmitAbsentOnSave,
  shouldPreserveOptionalAbsence,
} from "../../ir/field-emission-policy.js";
import {
  INTEGRAL_SCALAR_TYPES,
  FRACTIONAL_SCALAR_TYPES,
  scalarRuntimeKind,
  orderedEntryShorthandCases,
  entryShorthandTarget,
} from "../../ir/scalar-kinds.js";
import { ExprVisitor } from "../../ir/visitor.js";
import { toSnakeCase } from "../../ir/utilities.js";

/**
 * Crate-level lint allowances applied to the top of every generated Rust file.
 *
 * `unexpected_cfgs` is included so consumers whose Cargo.toml does not declare a
 * `serde` feature are not warned once per `#[cfg(feature = "serde")]` site.
 * Rust 1.80+ checks feature cfgs against the crate manifest, so an undeclared
 * `serde` feature would otherwise emit a warning for each gated item. The lint
 * has been recognized since Rust 1.51, so allowing it is safe on all supported
 * toolchains and is a no-op when the feature IS declared (e.g. the rust-serde
 * target or the fixture harness).
 */
export const RUST_ALLOW_ATTR =
  "#![allow(unused_imports, dead_code, non_camel_case_types, unused_variables, unexpected_cfgs, clippy::all)]";

export interface RustEmitterOptions {
  enumParsing?: "case-sensitive" | "case-insensitive";
  cancellationTokenPath?: string;
  nativeSerialization?: "none" | "serde";
}

/**
 * Emit a description as a single-line `///` doc comment.
 * Multi-line descriptions are collapsed to a single line.
 */
function emitDocComment(
  description: string,
  indent: string,
  lines: string[],
): void {
  // Collapse multi-line descriptions to a single line
  const oneLine = description
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  lines.push(`${indent}/// ${oneLine}`);
}

function renderLines(lines: string[]): string {
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Convert a string literal value to a PascalCase Rust variant name.
 * e.g., "system" → "System", "tool" → "Tool", "text" → "Text"
 */
function toPascalCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

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
 * Emit a Rust enum for a named string-literal type.
 * Uses serde rename for string ↔ enum round-tripping.
 */
function emitStringEnum(
  enumDef: EnumDef,
  lines: string[],
  options: RustEmitterOptions,
): void {
  const firstVariant = toPascalCase(enumDef.values[0]);
  if (enumDef.isOpen) {
    // Open enums carry String data in Other variant — no Copy
    lines.push("#[derive(Debug, Clone, PartialEq, Eq, Hash)]");
  } else {
    lines.push("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]");
  }
  lines.push(`pub enum ${enumDef.name} {`);
  for (const value of enumDef.values) {
    const variant = toPascalCase(value);
    lines.push(`    ${variant},`);
  }
  if (enumDef.isOpen) {
    lines.push("    /// Unknown variant (open enum — accepts any string).");
    lines.push("    Other(String),");
  }
  lines.push("}");
  lines.push("");

  // impl Default — first variant (only for closed enums; open enums use first variant too)
  lines.push(`impl Default for ${enumDef.name} {`);
  lines.push("    fn default() -> Self {");
  lines.push(`        Self::${firstVariant}`);
  lines.push("    }");
  lines.push("}");
  lines.push("");

  // impl Display
  lines.push(`impl std::fmt::Display for ${enumDef.name} {`);
  lines.push(
    "    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {",
  );
  lines.push("        match self {");
  for (const value of enumDef.values) {
    lines.push(
      `            Self::${toPascalCase(value)} => write!(f, "${value}"),`,
    );
  }
  if (enumDef.isOpen) {
    lines.push('            Self::Other(s) => write!(f, "{}", s),');
  }
  lines.push("        }");
  lines.push("    }");
  lines.push("}");
  lines.push("");

  // impl From<&str>
  lines.push(`impl ${enumDef.name} {`);
  lines.push("    pub fn from_str_opt(s: &str) -> Option<Self> {");
  if (options.enumParsing === "case-insensitive") {
    lines.push("        Self::from_str_ignore_case_opt(s)");
    lines.push("    }");
    lines.push("");
  } else {
    lines.push("        match s {");
    for (const value of enumDef.values) {
      lines.push(
        `            "${value}" => Some(Self::${toPascalCase(value)}),`,
      );
    }
    for (const [canonical, aliases] of Object.entries(enumDef.parseAliases)) {
      for (const alias of aliases) {
        lines.push(
          `            "${alias}" => Some(Self::${toPascalCase(canonical)}),`,
        );
      }
    }
    if (enumDef.isOpen) {
      lines.push("            other => Some(Self::Other(other.to_string())),");
    } else {
      lines.push("            _ => None,");
    }
    lines.push("        }");
    lines.push("    }");
    lines.push("");
  }
  lines.push("    pub fn from_str_ignore_case_opt(s: &str) -> Option<Self> {");
  for (const value of enumDef.values) {
    lines.push(`        if s.eq_ignore_ascii_case("${value}") {`);
    lines.push(`            return Some(Self::${toPascalCase(value)});`);
    lines.push("        }");
  }
  for (const [canonical, aliases] of Object.entries(enumDef.parseAliases)) {
    for (const alias of aliases) {
      lines.push(`        if s.eq_ignore_ascii_case("${alias}") {`);
      lines.push(`            return Some(Self::${toPascalCase(canonical)});`);
      lines.push("        }");
    }
  }
  if (enumDef.isOpen) {
    lines.push("        Some(Self::Other(s.to_string()))");
  } else {
    lines.push("        None");
  }
  lines.push("    }");
  lines.push("");
  lines.push("    pub fn as_str(&self) -> &str {");
  lines.push("        match self {");
  for (const value of enumDef.values) {
    lines.push(`            Self::${toPascalCase(value)} => "${value}",`);
  }
  if (enumDef.isOpen) {
    lines.push("            Self::Other(s) => s.as_str(),");
  }
  lines.push("        }");
  lines.push("    }");
  lines.push("}");
  lines.push("");

  if (options.nativeSerialization !== "none") {
    // First-class serde support: round-trip as the plain string value (matching `as_str`
    // / `Display`). Implemented manually so open enums correctly capture unknown strings
    // into `Other(..)` — a plain derive cannot express that catch-all.
    lines.push('#[cfg(feature = "serde")]');
    lines.push(`impl serde::Serialize for ${enumDef.name} {`);
    lines.push(
      "    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {",
    );
    lines.push("        serializer.serialize_str(self.as_str())");
    lines.push("    }");
    lines.push("}");
    lines.push("");
    lines.push('#[cfg(feature = "serde")]');
    lines.push(`impl<'de> serde::Deserialize<'de> for ${enumDef.name} {`);
    lines.push(
      "    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {",
    );
    lines.push(
      "        let s = <String as serde::Deserialize>::deserialize(deserializer)?;",
    );
    lines.push("        Self::from_str_opt(&s)");
    lines.push(
      `            .ok_or_else(|| serde::de::Error::custom(format!("invalid ${enumDef.name} value: {}", s)))`,
    );
    lines.push("    }");
    lines.push("}");
    lines.push("");
  }
}

/**
 * Type mapping from TypeSpec scalar types to Rust types.
 */
const RUST_TYPE_MAP: Record<string, string> = {
  string: "String",
  boolean: "bool",
  int32: "i32",
  int64: "i64",
  float32: "f32",
  float64: "f64",
  integer: "i64",
  float: "f64",
  numeric: "f64",
  number: "f64",
  any: "serde_json::Value",
  unknown: "serde_json::Value",
  object: "serde_json::Value",
  dictionary: "serde_json::Value",
  array: "Vec<serde_json::Value>",
};

/**
 * Emit a complete Rust source file from a FileDecl.
 *
 * @param file - File declaration to emit
 * @param visitor - Expression visitor
 * @param polymorphicTypeNames - Set of type names that have polymorphic dispatch
 * @param childToParent - Map from child variant name to parent type name
 */
export function emitRustFile(
  file: FileDecl,
  visitor: ExprVisitor,
  polymorphicTypeNames: Set<string>,
  childToParent: Map<string, string> = new Map(),
  options: RustEmitterOptions = {},
): string {
  const lines: string[] = [];
  const hasNonProtocol = file.types.some((t) => !t.isProtocol);
  const hasRuntimeCancellation = file.types.some((type) =>
    type.methods.some((method) => method.runtimeCancellable),
  );
  const group = file.group || "";

  // Header
  lines.push("// Code generated by Typra emitter; DO NOT EDIT.");
  lines.push("");
  lines.push(RUST_ALLOW_ATTR);
  lines.push("");
  if (hasNonProtocol) {
    // Context is always at the model root.
    const contextPath = relativeRustModulePath(group, "", "context");
    lines.push(`use ${contextPath}::{LoadContext, SaveContext};`);
  }
  if (hasRuntimeCancellation) {
    lines.push(
      rustCancellationTokenImport(
        options.cancellationTokenPath ?? "crate::engine::CancellationToken",
      ),
    );
  }

  function rustCancellationTokenImport(path: string): string {
    return path.endsWith("::CancellationToken")
      ? `use ${path};`
      : `use ${path} as CancellationToken;`;
  }

  // Imports — post-process for Rust specifics
  // In Rust, polymorphic child types are enum variants (not standalone structs),
  // so we import ParentKind instead.
  for (const imp of file.imports) {
    const processedNames: string[] = [];

    for (const name of imp.names) {
      // Check if this name is a polymorphic child → import ParentKind
      const parentName = childToParent.get(name);
      if (parentName) {
        const kindName = parentName + "Kind";
        if (!processedNames.includes(kindName)) {
          processedNames.push(kindName);
        }
        continue;
      }
      processedNames.push(name);
    }
    if (processedNames.length === 0) continue;
    lines.push("");
    const names = processedNames.sort().join(", ");

    // Build the Rust module path based on group relationship
    let modPath: string;
    if (imp.group === group) {
      // Same group (or both root): sibling module via super
      modPath = `super::${toSnakeCase(imp.module)}`;
    } else if (imp.group) {
      // Different non-empty group: go up to model root, then into the group
      modPath = relativeRustModulePath(
        group,
        imp.group,
        toSnakeCase(imp.module),
      );
    } else {
      // Root-level module accessed from inside a group subfolder
      modPath = relativeRustModulePath(group, "", toSnakeCase(imp.module));
    }

    if (processedNames.length === 1) {
      lines.push(`use ${modPath}::${names};`);
    } else {
      lines.push(`use ${modPath}::{${names}};`);
    }

  }

  lines.push("");

  // String-literal enum types
  for (const enumDef of file.enums) {
    emitStringEnum(enumDef, lines, options);
  }

  // Find the base type (the one that owns the polymorphic dispatch)
  const baseType =
    file.types.find((t) => t.polymorphicDispatch) || file.types[0];
  const childTypes = file.types.filter((t) => t !== baseType);

  // Protocol types → emit as trait (no struct, no impl)
  if (baseType.isProtocol) {
    emitProtocolTrait(baseType, lines);
    lines.push("");
    return renderLines(lines);
  }

  // Collect base field names for variant field extraction
  const baseFieldNames = new Set(baseType.fields.map((f) => f.name));

  // Emit enum for polymorphic types
  if (baseType.polymorphicDispatch) {
    emitKindEnum(
      baseType,
      childTypes,
      baseFieldNames,
      polymorphicTypeNames,
      lines,
    );
  }

  // Emit struct + impl for the base type (only one struct per file in Rust)
  emitStruct(baseType, polymorphicTypeNames, lines);
  emitImpl(
    baseType,
    childTypes,
    baseFieldNames,
    visitor,
    polymorphicTypeNames,
    lines,
  );

  if (options.nativeSerialization !== "none") {
    // Manual serde impls for EVERY data struct: serde delegates to the canonical
    // to_value/load_from_value so its output/input always equals the canonical wire
    // form — polymorphic discriminators, scalar-coercion shorthand, map<->list
    // normalization, empty-omission, etc. This is the single robust invariant
    // (serde == canonical), replacing the earlier flat-vs-polymorphic classification.
    emitDelegatingSerde(baseType, lines);
  }

  // Method stubs as trait
  if (baseType.methods.length > 0) {
    emitMethodTrait(baseType, lines);
  }

  // Trailing newlines for child types that were folded into the enum
  for (const _ of childTypes) {
    lines.push("");
  }

  lines.push("");
  return renderLines(lines);
}

// ============================================================================
// Kind Enum
// ============================================================================

function emitKindEnum(
  baseType: TypeDecl,
  childTypes: TypeDecl[],
  baseFieldNames: Set<string>,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  const dispatch = baseType.polymorphicDispatch!;
  const enumName = baseType.typeName.name + "Kind";

  lines.push("");
  lines.push(
    `/// Variant-specific data for [\`${baseType.typeName.name}\`], discriminated by \`${dispatch.discriminatorField}\`.`,
  );
  // No serde derive here: the default derived enum representation is externally
  // tagged (`{"VariantName": {...}}`) and would emit Rust variant names instead of
  // the canonical `${dispatch.discriminatorField}` wire value. Serde for the
  // discriminated union is provided by a manual impl on the parent struct
  // (see emitPolymorphicSerde) that delegates to the canonical to_value/load_from_value.
  lines.push("#[derive(Debug, Clone, PartialEq)]");
  lines.push(`pub enum ${enumName} {`);

  // Named variants
  for (const variant of dispatch.variants) {
    const childType = childTypes.find(
      (ct) => ct.typeName.name === variant.typeName.name,
    );
    const variantName =
      variant.typeName.name.replace(baseType.typeName.name, "") ||
      variant.typeName.name;
    const variantFields = childType
      ? childType.fields.filter(
          (f) =>
            f.name !== dispatch.discriminatorField &&
            !baseFieldNames.has(f.name),
        )
      : [];

    lines.push(
      `    /// \`${dispatch.discriminatorField}\` = \`"${variant.value}"\``,
    );
    if (variantFields.length === 0) {
      lines.push(`    ${variantName},`);
    } else {
      lines.push(`    ${variantName} {`);
      for (const field of variantFields) {
        if (field.description) {
          emitDocComment(field.description, "        ", lines);
        }
        lines.push(
          `        ${rustFieldName(field.name)}: ${fieldType(field, polymorphicTypeNames, true)},`,
        );
      }
      lines.push(`    },`);
    }
  }

  // Wildcard/default variant
  if (dispatch.defaultVariant) {
    const defaultType = childTypes.find(
      (ct) => ct.typeName.name === dispatch.defaultVariant!.typeName.name,
    );
    const isSelfRef = dispatch.defaultVariant.isSelfReference;
    const variantName = isSelfRef
      ? "Custom"
      : dispatch.defaultVariant.typeName.name.replace(
          baseType.typeName.name,
          "",
        ) || "Custom";

    const variantFields = isSelfRef
      ? []
      : defaultType
        ? defaultType.fields.filter(
            (f) =>
              f.name !== dispatch.discriminatorField &&
              !baseFieldNames.has(f.name),
          )
        : [];

    lines.push(
      `    /// Wildcard / catch-all variant for unrecognized \`${dispatch.discriminatorField}\` values.`,
    );
    // Wildcard/default fallbacks retain unmodeled payload for lossless saves.
    if (variantFields.length === 0) {
      lines.push(`    ${variantName} {`);
      lines.push(
        `        /// The raw \`${dispatch.discriminatorField}\` string for this unknown variant.`,
      );
      lines.push(
        `        ${toSnakeCase(dispatch.discriminatorField)}_name: String,`,
      );
      lines.push(
        "        /// Unmodeled fields preserved for forward-compatible round trips.",
      );
      lines.push("        raw: serde_json::Map<String, serde_json::Value>,");
      lines.push(`    },`);
    } else {
      lines.push(`    ${variantName} {`);
      for (const field of variantFields) {
        if (field.description) {
          emitDocComment(field.description, "        ", lines);
        }
        lines.push(
          `        ${rustFieldName(field.name)}: ${fieldType(field, polymorphicTypeNames, true)},`,
        );
      }
      lines.push(
        `        /// The raw \`${dispatch.discriminatorField}\` string for this unknown variant.`,
      );
      lines.push(
        `        ${toSnakeCase(dispatch.discriminatorField)}_name: String,`,
      );
      lines.push(
        "        /// Unmodeled fields preserved for forward-compatible round trips.",
      );
      lines.push("        raw: serde_json::Map<String, serde_json::Value>,");
      lines.push(`    },`);
    }
  } else if (!isClosedPolymorphicDispatch(dispatch)) {
    lines.push(
      `    /// Lossless fallback for unrecognized \`${dispatch.discriminatorField}\` values.`,
    );
    lines.push("    Unknown {");
    lines.push(
      `        /// The raw \`${dispatch.discriminatorField}\` string for this unknown variant.`,
    );
    lines.push(
      `        ${toSnakeCase(dispatch.discriminatorField)}_name: String,`,
    );
    lines.push(
      "        /// Unmodeled fields preserved for forward-compatible round trips.",
    );
    lines.push("        raw: serde_json::Map<String, serde_json::Value>,");
    lines.push("    },");
  }

  lines.push("}");
  lines.push("");

  // impl Default for the enum
  emitEnumDefault(
    baseType,
    childTypes,
    baseFieldNames,
    dispatch,
    polymorphicTypeNames,
    lines,
  );
}

function emitEnumDefault(
  baseType: TypeDecl,
  childTypes: TypeDecl[],
  baseFieldNames: Set<string>,
  dispatch: PolymorphicDispatchDecl,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  const enumName = baseType.typeName.name + "Kind";

  lines.push(`impl Default for ${enumName} {`);
  lines.push("    fn default() -> Self {");

  if (dispatch.defaultVariant) {
    // Default to the wildcard/custom variant
    const isSelfRef = dispatch.defaultVariant.isSelfReference;
    const variantName = isSelfRef
      ? "Custom"
      : dispatch.defaultVariant.typeName.name.replace(
          baseType.typeName.name,
          "",
        ) || "Custom";

    const defaultType = childTypes.find(
      (ct) => ct.typeName.name === dispatch.defaultVariant!.typeName.name,
    );
    const variantFields = isSelfRef
      ? []
      : defaultType
        ? defaultType.fields.filter(
            (f) =>
              f.name !== dispatch.discriminatorField &&
              !baseFieldNames.has(f.name),
          )
        : [];

    if (variantFields.length === 0) {
      lines.push(`        ${enumName}::${variantName} {`);
      lines.push(
        `            ${toSnakeCase(dispatch.discriminatorField)}_name: String::new(),`,
      );
      lines.push("            raw: serde_json::Map::new(),");
      lines.push("        }");
    } else {
      lines.push(`        ${enumName}::${variantName} {`);
      for (const field of variantFields) {
        lines.push(
          `            ${rustFieldName(field.name)}: ${fieldDefault(field, polymorphicTypeNames)},`,
        );
      }
      lines.push(
        `            ${toSnakeCase(dispatch.discriminatorField)}_name: String::new(),`,
      );
      lines.push("            raw: serde_json::Map::new(),");
      lines.push("        }");
    }
  } else if (!isClosedPolymorphicDispatch(dispatch)) {
    lines.push(`        ${enumName}::Unknown {`);
    lines.push(
      `            ${toSnakeCase(dispatch.discriminatorField)}_name: String::new(),`,
    );
    lines.push("            raw: serde_json::Map::new(),");
    lines.push("        }");
  } else if (dispatch.variants.length > 0) {
    // Default to the first named variant
    const firstVariant = dispatch.variants[0];
    const childType = childTypes.find(
      (ct) => ct.typeName.name === firstVariant.typeName.name,
    );
    const variantName =
      firstVariant.typeName.name.replace(baseType.typeName.name, "") ||
      firstVariant.typeName.name;
    const variantFields = childType
      ? childType.fields.filter(
          (f) =>
            f.name !== dispatch.discriminatorField &&
            !baseFieldNames.has(f.name),
        )
      : [];

    if (variantFields.length === 0) {
      lines.push(`        ${enumName}::${variantName}`);
    } else {
      lines.push(`        ${enumName}::${variantName} {`);
      for (const field of variantFields) {
        lines.push(
          `            ${rustFieldName(field.name)}: ${fieldDefault(field, polymorphicTypeNames)},`,
        );
      }
      lines.push("        }");
    }
  }

  lines.push("    }");
  lines.push("}");
}

// ============================================================================
// Struct Definition
// ============================================================================

function emitStruct(
  type: TypeDecl,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  if (type.description) {
    emitDocComment(type.description, "", lines);
  }
  // Data structs are first-class serde types: they round-trip through
  // Serialize/Deserialize and support `==` (PartialEq). Serde is provided by a
  // MANUAL impl (emitDelegatingSerde) that delegates to the canonical
  // to_value/load_from_value — NOT a `#[derive(serde::...)]`. A field-by-field
  // derive cannot reproduce the canonical wire semantics the emitter bakes into
  // to_value/load_from_value (polymorphic discriminators, scalar-coercion
  // shorthand, map<->list normalization of keyed collections, empty-omission on
  // save, provider wire-name remaps, ...), so ALL data structs — flat ones
  // included — route serde through that single canonical path. The derives below
  // are additive and coexist with the context-aware LoadContext/load_from_value API.
  lines.push("#[derive(Debug, Clone, Default, PartialEq)]");
  lines.push(`pub struct ${type.typeName.name} {`);

  for (const field of type.fields) {
    // Skip discriminator field — it's represented by the XxxKind enum field
    if (
      type.polymorphicDispatch &&
      field.name === type.polymorphicDispatch.discriminatorField
    )
      continue;
    if (field.description) {
      emitDocComment(field.description, "    ", lines);
    }
    lines.push(
      `    pub ${rustFieldName(field.name)}: ${fieldType(field, polymorphicTypeNames)},`,
    );
  }

  // Add kind field for polymorphic types
  if (type.polymorphicDispatch) {
    lines.push(
      `    /// Variant-specific data, discriminated by \`${type.polymorphicDispatch.discriminatorField}\`.`,
    );
    lines.push(
      `    pub ${rustFieldName(type.polymorphicDispatch.discriminatorField)}: ${type.typeName.name}Kind,`,
    );
  }

  lines.push("}");
}

// ============================================================================
// Manual (delegating) serde support
// ============================================================================

/**
 * Emit manual `serde::Serialize` / `serde::Deserialize` impls for a data struct,
 * delegating to the canonical `to_value` / `load_from_value` logic. This is emitted
 * for EVERY data struct (flat, polymorphic, and scalar-coercible alike) so that
 * serde's wire form always equals the canonical form — a field-by-field derive
 * cannot reproduce the semantics the emitter bakes into to_value/load_from_value:
 *  - discriminated unions round-trip to their exact flat wire form
 *    (`{"<discriminator>": "<value>", ...}`) with the canonical discriminator string
 *    (e.g. `"key"`), not the Rust variant name;
 *  - scalar-coercible structs accept their bare-scalar shorthand on deserialize;
 *  - keyed collections normalize between their map and list wire forms;
 *  - empty/optional fields are omitted on save; provider wire-name remaps apply; etc.
 *
 * A default (no-op) context is used, so no `${env:}` / `${file:}` resolution
 * happens on the serde path; the context-aware LoadContext/SaveContext API
 * remains fully intact and is used by the explicit from_json/to_json helpers.
 */
function emitDelegatingSerde(type: TypeDecl, lines: string[]): void {
  const name = type.typeName.name;
  const reason = type.polymorphicDispatch
    ? `the \`${type.polymorphicDispatch.discriminatorField}\` discriminator round-trips to its exact wire value`
    : type.coercionProperty !== null
      ? `its scalar-coercion shorthand round-trips through the canonical semantics`
      : `its serde wire form always equals the canonical to_value/load_from_value form`;

  lines.push("");
  lines.push(
    `// Serde for \`${name}\` delegates to the canonical to_value/load_from_value`,
  );
  lines.push(
    `// logic so ${reason}. Uses a default (no-op) context — no \${env:}/\${file:}`,
  );
  lines.push(
    `// resolution here — leaving the context-aware LoadContext/SaveContext API intact.`,
  );
  lines.push('#[cfg(feature = "serde")]');
  lines.push(`impl serde::Serialize for ${name} {`);
  lines.push(
    `    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {`,
  );
  lines.push(
    `        serde::Serialize::serialize(&self.to_value(&SaveContext::default()), serializer)`,
  );
  lines.push(`    }`);
  lines.push(`}`);
  lines.push("");
  lines.push('#[cfg(feature = "serde")]');
  lines.push(`impl<'de> serde::Deserialize<'de> for ${name} {`);
  lines.push(
    `    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {`,
  );
  lines.push(
    `        let value = <serde_json::Value as serde::Deserialize>::deserialize(deserializer)?;`,
  );
  lines.push(
    '        Self::validate_input_at(&value, "").map_err(serde::de::Error::custom)?;',
  );
  lines.push(
    `        Ok(Self::load_from_value(&value, &LoadContext::default()))`,
  );
  lines.push(`    }`);
  lines.push(`}`);

  // For polymorphic types, the `XxxKind` enum is ALSO independently serde-serializable
  // to the SAME canonical, internally-tagged wire form. We do this by wrapping the bare
  // variant back into its parent struct and delegating to the parent's to_value /
  // load_from_value — NOT by deriving serde on the enum (the derived, externally-tagged
  // repr `{"Variant": {...}}` is a different, non-canonical wire format).
  if (type.polymorphicDispatch) {
    const kindName = `${name}Kind`;
    const discField = rustFieldName(
      type.polymorphicDispatch.discriminatorField,
    );
    const discWire = type.polymorphicDispatch.discriminatorField;
    lines.push("");
    lines.push(
      `// Serde for \`${kindName}\` wraps the variant into its parent \`${name}\` and delegates`,
    );
    lines.push(
      `// to the canonical to_value/load_from_value logic, so a bare \`${kindName}\``,
    );
    lines.push(
      `// serializes to internally-tagged \`{"${discWire}": "<value>", ...}\` — the same wire`,
    );
    lines.push(
      `// form as its parent — instead of serde's externally-tagged \`{"<Variant>": {...}}\`.`,
    );
    lines.push('#[cfg(feature = "serde")]');
    lines.push(`impl serde::Serialize for ${kindName} {`);
    lines.push(
      `    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {`,
    );
    lines.push(
      `        let parent = ${name} { ${discField}: self.clone(), ..Default::default() };`,
    );
    lines.push(
      `        serde::Serialize::serialize(&parent.to_value(&SaveContext::default()), serializer)`,
    );
    lines.push(`    }`);
    lines.push(`}`);
    lines.push("");
    lines.push('#[cfg(feature = "serde")]');
    lines.push(`impl<'de> serde::Deserialize<'de> for ${kindName} {`);
    lines.push(
      `    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {`,
    );
    lines.push(
      `        let value = <serde_json::Value as serde::Deserialize>::deserialize(deserializer)?;`,
    );
    lines.push(
      `        ${name}::validate_input_at(&value, "").map_err(serde::de::Error::custom)?;`,
    );
    lines.push(
      `        Ok(${name}::load_from_value(&value, &LoadContext::default()).${discField})`,
    );
    lines.push(`    }`);
    lines.push(`}`);
  }
}

function emitImpl(
  type: TypeDecl,
  childTypes: TypeDecl[],
  baseFieldNames: Set<string>,
  visitor: ExprVisitor,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  const name = type.typeName.name;
  lines.push("");
  lines.push(`impl ${name} {`);

  // new()
  lines.push(`    /// Create a new ${name} with default values.`);
  lines.push("    pub fn new() -> Self {");
  lines.push("        Self::default()");
  lines.push("    }");
  lines.push("");

  // from_json()
  emitFromJson(name, type, lines);

  // from_yaml()
  emitFromYaml(name, type, lines);

  // try_load_from_value() — fallible sibling of load_from_value (#210)
  emitTryLoadFromValue(name, type, lines);

  // load_from_value()
  emitLoadFromValue(
    name,
    type,
    childTypes,
    baseFieldNames,
    polymorphicTypeNames,
    lines,
  );
  emitInputValidation(type, childTypes, lines);
  if (
    type.polymorphicDispatch &&
    isClosedPolymorphicDispatch(type.polymorphicDispatch)
  ) {
    emitClosedDiscriminatorValidation(type, lines);
  }

  // kind_str() for polymorphic types
  if (type.polymorphicDispatch) {
    emitKindStr(type, childTypes, lines);
  }

  // to_value()
  emitToValue(
    name,
    type,
    childTypes,
    baseFieldNames,
    polymorphicTypeNames,
    lines,
  );

  // to_json() / to_yaml()
  emitToJson(name, lines);
  emitToYaml(name, lines);

  // to_wire() (only when wire mappings exist)
  if (type.wire) {
    emitToWireMethod(type, lines);
    emitFromWireMethod(type, lines);
  }

  // Dict accessor helpers (only for dict-category fields, not scalar value types)
  for (const field of type.fields) {
    if (
      field.category.kind === "dict" &&
      (!field.category.valueType || field.category.valueType === "unknown")
    ) {
      emitDictAccessor(field, lines);
    }
  }

  // Collection helpers — include both base type and child type helpers
  // (in Rust, child types are enum variants, so their helpers live on the parent impl)
  const emittedHelpers = new Set<string>();
  const allHelpers = [...type.collectionHelpers];
  for (const child of childTypes) {
    for (const h of child.collectionHelpers) {
      if (!emittedHelpers.has(h.propertyName)) {
        allHelpers.push(h);
      }
    }
  }
  for (const helper of allHelpers) {
    if (emittedHelpers.has(helper.propertyName)) continue;
    emittedHelpers.add(helper.propertyName);
    emitCollectionLoadHelper(helper, polymorphicTypeNames, lines);
    emitCollectionSaveHelper(helper, lines);
  }

  // Factories
  for (const factory of type.factories) {
    emitFactory(name, factory, visitor, lines);
  }

  lines.push("}");

  // Method trait stubs (handled separately)
}

// ============================================================================
// from_json / from_yaml
// ============================================================================

function emitFromJson(name: string, type: TypeDecl, lines: string[]): void {
  lines.push(`    /// Load ${name} from a JSON string.`);
  lines.push(
    `    pub fn from_json(json: &str, ctx: &LoadContext) -> Result<Self, serde_json::Error> {`,
  );
  lines.push(
    "        let value: serde_json::Value = serde_json::from_str(json)?;",
  );
  lines.push('        Self::validate_input_at(&value, "")');
  lines.push(
    "            .map_err(|message| <serde_json::Error as serde::de::Error>::custom(message))?;",
  );
  lines.push("        Ok(Self::load_from_value(&value, ctx))");
  lines.push("    }");
  lines.push("");
}

function emitFromYaml(name: string, type: TypeDecl, lines: string[]): void {
  lines.push(`    /// Load ${name} from a YAML string.`);
  lines.push(
    `    pub fn from_yaml(yaml: &str, ctx: &LoadContext) -> Result<Self, serde_yaml::Error> {`,
  );
  lines.push(
    "        let value: serde_json::Value = serde_yaml::from_str(yaml)?;",
  );
  lines.push('        Self::validate_input_at(&value, "")');
  lines.push(
    "            .map_err(|message| <serde_yaml::Error as serde::de::Error>::custom(message))?;",
  );
  lines.push("        Ok(Self::load_from_value(&value, ctx))");
  lines.push("    }");
  lines.push("");
}

// Fallible sibling of `load_from_value` for callers that already hold a
// `serde_json::Value` and want `Result` ergonomics instead of the panicking
// infallible path. Routes through the same `validate_input_at` policy as
// `from_json`, so validation semantics (and error messages) are identical —
// only the input shape (a parsed value vs a string) differs. See issue #210.
function emitTryLoadFromValue(
  name: string,
  type: TypeDecl,
  lines: string[],
): void {
  lines.push(
    `    /// Load ${name} from an already-parsed JSON value, returning an error`,
  );
  lines.push(
    "    /// instead of panicking on invalid input. Fallible companion to",
  );
  lines.push(
    "    /// `load_from_value` with the same validation policy as `from_json`.",
  );
  lines.push(
    "    pub fn try_load_from_value(",
  );
  lines.push("        value: &serde_json::Value,");
  lines.push("        ctx: &LoadContext,");
  lines.push("    ) -> Result<Self, serde_json::Error> {");
  lines.push('        Self::validate_input_at(value, "")');
  lines.push(
    "            .map_err(|message| <serde_json::Error as serde::de::Error>::custom(message))?;",
  );
  lines.push("        Ok(Self::load_from_value(value, ctx))");
  lines.push("    }");
  lines.push("");
}

function emitClosedDiscriminatorValidation(
  type: TypeDecl,
  lines: string[],
): void {
  const dispatch = type.polymorphicDispatch!;
  const name = type.typeName.name;
  const knownValues = dispatch.variants
    .map((variant) => `"${variant.value}"`)
    .join(" | ");
  lines.push(
    "    fn validate_discriminator(value: &serde_json::Value) -> Result<(), String> {",
  );
  lines.push(
    `        let discriminator = value.get("${dispatch.discriminatorField}")`,
  );
  lines.push("            .and_then(|candidate| candidate.as_str())");
  lines.push(
    `            .ok_or_else(|| "Missing ${name} discriminator property: '${dispatch.discriminatorField}'".to_string())?;`,
  );
  lines.push("        match discriminator {");
  lines.push(`            ${knownValues} => Ok(()),`);
  lines.push(
    `            _ => Err(format!("Unknown ${name} discriminator field '${dispatch.discriminatorField}' value: {}", discriminator)),`,
  );
  lines.push("        }");
  lines.push("    }");
  lines.push("");
}

function emitInputValidation(
  type: TypeDecl,
  childTypes: TypeDecl[],
  lines: string[],
): void {
  const closed =
    type.polymorphicDispatch &&
    isClosedPolymorphicDispatch(type.polymorphicDispatch);
  lines.push(
    "    pub(crate) fn validate_input_at(value: &serde_json::Value, path: &str) -> Result<(), String> {",
  );
  if (type.load.coercions.length > 0) {
    lines.push("        if !value.is_object() {");
    lines.push("            return Ok(());");
    lines.push("        }");
  }
  if (closed) {
    lines.push("        Self::validate_discriminator(value)?;");
  }
  // The dispatch owns discriminator validation: validate_discriminator() when the dispatch is
  // closed, and the Unknown/fallback arm when it is open. Validating the discriminator again as
  // an ordinary field would additionally check it against its declared type, which for an open
  // union (`"a" | "b" | string`) rejects the very values the open dispatch exists to absorb —
  // making the fallback arm unreachable.
  const discriminatorField = type.polymorphicDispatch?.discriminatorField;
  const baseAssignments =
    discriminatorField === undefined
      ? type.load.assignments
      : type.load.assignments.filter(
          (assignment) => assignment.sourceName !== discriminatorField,
        );
  emitFieldInputValidation(type, baseAssignments, lines, "        ");
  if (type.polymorphicDispatch) {
    const dispatch = type.polymorphicDispatch;
    const declaredDefault =
      dispatch.defaultVariant && !dispatch.defaultVariant.isSelfReference;
    if (declaredDefault) {
      // Open union with a DECLARED wildcard `*` variant: tolerate an absent/blank
      // discriminator and route the missing/blank value to its fallback (`_`)
      // arm — the same catch-all the load path selects via `unwrap_or("")`.
      // Erroring here would make the coerce shorthand (object with no
      // discriminator) fail validation.
      lines.push(
        `        let discriminator = value.get("${dispatch.discriminatorField}").and_then(|candidate| candidate.as_str()).unwrap_or("");`,
      );
    } else {
      // Closed union, abstract open carrier, or a non-abstract open union that
      // falls back to its own base by self-reference: an absent/blank/non-string
      // discriminator cannot name a variant and is rejected up front. (A closed
      // union has additionally been rejected by validate_discriminator() above.)
      // Unknown NON-blank values still pass and route to the `_` arm below.
      lines.push(
        `        let discriminator = value.get("${dispatch.discriminatorField}")`,
      );
      lines.push(
        `            .ok_or_else(|| "Missing ${type.typeName.name} discriminator property: '${dispatch.discriminatorField}'".to_string())?;`,
      );
      lines.push("        let discriminator = match discriminator {");
      lines.push(
        "            serde_json::Value::String(value) if !value.is_empty() => value.as_str(),",
      );
      lines.push(
        `            _ => return Err("Invalid ${type.typeName.name} discriminator field '${dispatch.discriminatorField}': expected non-blank string".to_string()),`,
      );
      lines.push("        };");
    }
    lines.push("        match discriminator {");
    for (const variant of dispatch.variants) {
      const childType = childTypes.find(
        (candidate) => candidate.typeName.name === variant.typeName.name,
      );
      lines.push(`            "${variant.value}" => {`);
      if (childType)
        emitFieldInputValidation(
          childType,
          childType.load.assignments,
          lines,
          "                ",
        );
      lines.push("            }");
    }
    if (dispatch.defaultVariant && !dispatch.defaultVariant.isSelfReference) {
      const defaultType = childTypes.find(
        (candidate) =>
          candidate.typeName.name === dispatch.defaultVariant!.typeName.name,
      );
      lines.push("            _ => {");
      if (defaultType)
        emitFieldInputValidation(
          defaultType,
          defaultType.load.assignments,
          lines,
          "                    ",
        );
      lines.push("            }");
    } else {
      lines.push("            _ => {}");
    }
    lines.push("        }");
  }
  lines.push("        Ok(())");
  lines.push("    }");
  lines.push("");
}

function emitFieldInputValidation(
  type: TypeDecl,
  assignments: LoadAssignment[],
  lines: string[],
  indent: string,
): void {
  for (const assignment of assignments) {
    const field = assignment.sourceName;
    const category = assignment.category;
    const helper = type.collectionHelpers.find(
      (candidate) => candidate.propertyName === field,
    );
    if (category.kind === "complex") {
      const fieldDecl = type.fields.find(
        (candidate) => candidate.name === assignment.fieldName,
      );
      lines.push(
        `${indent}let child_path = if path.is_empty() { "${field}".to_string() } else { format!("{}.${field}", path) };`,
      );
      if (shouldGuardMissingRequiredField(fieldDecl)) {
        lines.push(
          `${indent}let child = value.get("${field}").filter(|candidate| !candidate.is_null())`,
        );
        lines.push(
          `${indent}    .ok_or_else(|| format!("{}: missing required field", child_path))?;`,
        );
        lines.push(
          `${indent}${category.typeName}::validate_input_at(child, &child_path)?;`,
        );
      } else {
        lines.push(`${indent}if let Some(child) = value.get("${field}") {`);
        lines.push(
          `${indent}    ${category.typeName}::validate_input_at(child, &child_path)?;`,
        );
        lines.push(`${indent}}`);
      }
    } else if (
      category.kind === "collection_complex" &&
      helper?.hasNameProperty
    ) {
      const shorthandField = helper.innerFields[0] || "value";
      lines.push(`${indent}if let Some(collection) = value.get("${field}") {`);
      lines.push(
        `${indent}    let collection_path = if path.is_empty() { "${field}".to_string() } else { format!("{}.${field}", path) };`,
      );
      lines.push(`${indent}    match collection {`);
      lines.push(`${indent}        serde_json::Value::Object(entries) => {`);
      lines.push(`${indent}            for (name, entry) in entries {`);
      lines.push(
        `${indent}                let entry_path = format!("{}.{}", collection_path, name);`,
      );
      lines.push(`${indent}                if entry.is_array() {`);
      lines.push(
        `${indent}                    return Err(format!("{}: invalid named collection entry category array", entry_path));`,
      );
      lines.push(`${indent}                }`);
      lines.push(
        `${indent}                let mut candidate = if entry.is_object() {`,
      );
      lines.push(`${indent}                    entry.clone()`);
      lines.push(`${indent}                } else {`);
      lines.push(
        `${indent}                    serde_json::json!({ "${shorthandField}": entry })`,
      );
      lines.push(`${indent}                };`);
      lines.push(
        `${indent}                if let serde_json::Value::Object(ref mut map) = candidate {`,
      );
      lines.push(
        `${indent}                    map.insert("name".to_string(), serde_json::Value::String(name.clone()));`,
      );
      lines.push(`${indent}                }`);
      lines.push(
        `${indent}                ${category.typeName}::validate_input_at(&candidate, &entry_path)?;`,
      );
      lines.push(`${indent}            }`);
      lines.push(`${indent}        }`);
      lines.push(`${indent}        serde_json::Value::Array(entries) => {`);
      lines.push(
        `${indent}            for (index, entry) in entries.iter().enumerate() {`,
      );
      lines.push(
        `${indent}                let entry_path = format!("{}[{}]", collection_path, index);`,
      );
      lines.push(
        `${indent}                ${category.typeName}::validate_input_at(entry, &entry_path)?;`,
      );
      lines.push(`${indent}            }`);
      lines.push(`${indent}        }`);
      lines.push(`${indent}        _ => {}`);
      lines.push(`${indent}    }`);
      lines.push(`${indent}}`);
    } else if (category.kind === "collection_complex") {
      lines.push(
        `${indent}if let Some(entries) = value.get("${field}").and_then(|candidate| candidate.as_array()) {`,
      );
      lines.push(
        `${indent}    let collection_path = if path.is_empty() { "${field}".to_string() } else { format!("{}.${field}", path) };`,
      );
      lines.push(
        `${indent}    for (index, entry) in entries.iter().enumerate() {`,
      );
      lines.push(
        `${indent}        let entry_path = format!("{}[{}]", collection_path, index);`,
      );
      lines.push(
        `${indent}        ${category.typeName}::validate_input_at(entry, &entry_path)?;`,
      );
      lines.push(`${indent}    }`);
      lines.push(`${indent}}`);
    }
  }
}

// ============================================================================
// load_from_value
// ============================================================================

function emitLoadFromValue(
  name: string,
  type: TypeDecl,
  childTypes: TypeDecl[],
  baseFieldNames: Set<string>,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  lines.push(`    /// Load ${name} from a \`serde_json::Value\`.`);
  lines.push("    ///");
  lines.push("    /// Calls `ctx.process_input` before field extraction.");
  lines.push(
    "    pub fn load_from_value(value: &serde_json::Value, ctx: &LoadContext) -> Self {",
  );
  lines.push("        let value = ctx.process_input(value.clone());");
  lines.push(
    '        if let Err(message) = Self::validate_input_at(&value, "") {',
  );
  lines.push('            panic!("{}", message);');
  lines.push("        }");

  // Coercions.
  //
  // Numeric coercions are emitted as one bridged block rather than one `if let` each.
  // `serde_json::Value::as_f64()` succeeds for whole numbers too, so an independent
  // fractional branch placed before an integral one swallows every integer and reports
  // the wrong primitive kind. This mirrors the Go backend's decoder-native bridging
  // (#39) so both backends classify an identical payload identically.
  const numericCoercions = type.load.coercions.filter(
    (c) =>
      INTEGRAL_SCALAR_TYPES.has(c.scalarType) ||
      FRACTIONAL_SCALAR_TYPES.has(c.scalarType),
  );
  for (const c of type.load.coercions) {
    if (numericCoercions.includes(c)) continue;
    emitCoercionBranch(
      name,
      c,
      type,
      childTypes,
      baseFieldNames,
      polymorphicTypeNames,
      lines,
    );
  }
  emitNumericCoercionBridge(
    name,
    numericCoercions,
    type,
    childTypes,
    baseFieldNames,
    polymorphicTypeNames,
    lines,
  );

  // Polymorphic dispatch
  if (type.polymorphicDispatch) {
    emitPolymorphicLoad(
      name,
      type,
      childTypes,
      baseFieldNames,
      polymorphicTypeNames,
      lines,
    );
  } else {
    // Simple struct construction
    lines.push("        Self {");
    for (const a of type.load.assignments) {
      lines.push(
        `            ${rustFieldName(a.fieldName)}: ${loadExpr(a, polymorphicTypeNames)},`,
      );
    }
    lines.push("        }");
  }

  lines.push("    }");
  lines.push("");
}

function emitCoercionBranch(
  typeName: string,
  c: CoercionDecl,
  type: TypeDecl,
  childTypes: TypeDecl[],
  baseFieldNames: Set<string>,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  const check = rustCoercionCheck(c.scalarType);
  if (!check) return;

  lines.push(`        ${check.ifLet} {`);

  // For string coercions, rebind `s` → `value` so downstream references work
  if (c.scalarType === "string") {
    lines.push("            let value = s.to_string();");
  }

  lines.push(
    coercionReturnStatement(
      typeName,
      c,
      type,
      childTypes,
      baseFieldNames,
      polymorphicTypeNames,
      "            ",
    ),
  );
  lines.push("        }");
}

function relativeRustModulePath(
  fromGroup: string,
  toGroup: string,
  moduleName: string,
): string {
  if (fromGroup === toGroup) {
    return `super::${moduleName}`;
  }
  const depth = fromGroup ? fromGroup.split("/").filter(Boolean).length : 0;
  const prefix = Array.from({ length: depth + 1 }, () => "super").join("::");
  const target = toGroup
    ? `${toGroup.split("/").filter(Boolean).join("::")}::${moduleName}`
    : moduleName;
  return `${prefix}::${target}`;
}

/**
 * Emit the numeric coercions of a type as one ordered, decoder-native block.
 *
 * `serde_json::Value::as_f64()` returns `Some` for whole numbers as well as fractional ones,
 * so a fractional branch emitted before an integral one swallows every integer and reports the
 * wrong primitive kind. Unlike Go's `encoding/json` — which decodes every JSON number as
 * `float64` and must therefore reconstruct integrality with `math.Trunc` — `serde_json` keeps
 * the token's own int/float distinction, so `as_i64()` tested first is both simpler and exactly
 * what "stores the unmodified scalar" asks for: `4` stays `4` rather than becoming `4.0`.
 */
function emitNumericCoercionBridge(
  typeName: string,
  coercions: CoercionDecl[],
  type: TypeDecl,
  childTypes: TypeDecl[],
  baseFieldNames: Set<string>,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  if (coercions.length === 0) return;

  const integral = coercions.filter((c) =>
    INTEGRAL_SCALAR_TYPES.has(c.scalarType),
  );
  const fractional = coercions.filter((c) =>
    FRACTIONAL_SCALAR_TYPES.has(c.scalarType),
  );

  const statement = (c: CoercionDecl): string =>
    coercionReturnStatement(
      typeName,
      c,
      type,
      childTypes,
      baseFieldNames,
      polymorphicTypeNames,
      "            ",
    );

  // Integral first — `as_f64()` also matches whole numbers, so the reverse order is unreachable.
  if (integral.length > 0) {
    lines.push("        if let Some(value) = value.as_i64() {");
    lines.push(statement(integral[0]));
    lines.push("        }");
  }
  if (fractional.length > 0) {
    lines.push("        if let Some(value) = value.as_f64() {");
    lines.push(statement(fractional[0]));
    lines.push("        }");
  }
}

/**
 * Build the `return <Type> { ... };` statement for one coercion branch.
 */
function coercionReturnStatement(
  typeName: string,
  c: CoercionDecl,
  type: TypeDecl,
  childTypes: TypeDecl[],
  baseFieldNames: Set<string>,
  polymorphicTypeNames: Set<string>,
  indent: string,
): string {
  const dispatch = type.polymorphicDispatch;
  const discField = dispatch?.discriminatorField;
  const enumName = typeName + "Kind";

  // Build field assignments, handling discriminator → enum variant construction
  const fieldAssignments = c.assignments.map((a) => {
    const snake = rustFieldName(a.fieldName);
    if (a.isInput) {
      // Check if the target field is optional or an enum
      const targetField = type.fields.find((f) => f.name === a.fieldName);
      const isOptional = targetField?.isOptional ?? false;
      // If target field is a named enum, use from_str_opt instead of .into()
      if (targetField?.enumName && targetField.allowedValues.length > 0) {
        const defaultVal = String(
          targetField.defaultValue || targetField.allowedValues[0],
        );
        const enumExpr = `${targetField.enumName}::from_str_opt(&value).unwrap_or(${targetField.enumName}::${toPascalCase(defaultVal)})`;
        return isOptional
          ? `${snake}: Some(${enumExpr})`
          : `${snake}: ${enumExpr}`;
      }
      // `value` is bound as f64 for every numeric coercion so the decoded scalar reaches the
      // target unmodified. Narrow only when the destination field is genuinely f32; widening
      // a f32 back to f64 is what turned 3.14 into 3.140000104904175.
      const valueExpr =
        FRACTIONAL_SCALAR_TYPES.has(c.scalarType) &&
        targetField?.category.kind === "scalar" &&
        targetField.category.scalarType === "float32"
          ? "(value as f32).into()"
          : "value.into()";
      const expr = isOptional ? `Some(${valueExpr})` : valueExpr;
      return `${snake}: ${expr}`;
    }
    // Check if this field is the discriminator — must construct enum variant
    if (dispatch && a.fieldName === discField) {
      const discSnake = toSnakeCase(discField);
      // Find if the literal matches a named variant
      const matchingVariant = dispatch.variants.find(
        (v) => v.value === a.literalValue,
      );
      if (matchingVariant) {
        const variantName =
          matchingVariant.typeName.name.replace(typeName, "") ||
          matchingVariant.typeName.name;
        // Check if variant has fields — unit variants don't get braces
        const childType = childTypes.find(
          (ct) => ct.typeName.name === matchingVariant.typeName.name,
        );
        const variantFields = childType
          ? childType.fields.filter(
              (f) =>
                f.name !== dispatch!.discriminatorField &&
                !baseFieldNames.has(f.name),
            )
          : [];
        if (variantFields.length === 0) {
          return `${discSnake}: ${enumName}::${variantName}`;
        }
        return `${discSnake}: ${enumName}::${variantName} { ..Default::default() }`;
      }
      // Otherwise use the wildcard/custom variant
      if (dispatch.defaultVariant) {
        const isSelfRef = dispatch.defaultVariant.isSelfReference;
        const dvName = isSelfRef
          ? "Custom"
          : dispatch.defaultVariant.typeName.name.replace(typeName, "") ||
            "Custom";
        return `${discSnake}: ${enumName}::${dvName} { ${discSnake}_name: "${a.literalValue}".to_string(), raw: serde_json::Map::new() }`;
      }
      if (!isClosedPolymorphicDispatch(dispatch)) {
        return `${discSnake}: ${enumName}::Unknown { ${discSnake}_name: "${a.literalValue}".to_string(), raw: serde_json::Map::new() }`;
      }
      return `${discSnake}: ${enumName}::default()`;
    }
    const targetField = type.fields.find((f) => f.name === a.fieldName);
    const literalExpr = `"${a.literalValue}".to_string()`;
    return targetField?.isOptional
      ? `${snake}: Some(${literalExpr})`
      : `${snake}: ${literalExpr}`;
  });

  return `${indent}return ${typeName} { ${fieldAssignments.join(", ")}, ..Default::default() };`;
}

/**
 * Get the Rust coercion check pattern for a scalar type.
 *
 * Numeric scalars are handled by `emitNumericCoercionBridge` and never reach here;
 * they are deliberately absent so the lossy `as f32` narrowing cannot come back.
 */
function rustCoercionCheck(scalarType: string): { ifLet: string } | null {
  switch (scalarType) {
    case "string":
      return { ifLet: "if let Some(s) = value.as_str()" };
    case "boolean":
      return { ifLet: "if let Some(value) = value.as_bool()" };
    default:
      return null;
  }
}

function emitPolymorphicLoad(
  name: string,
  type: TypeDecl,
  childTypes: TypeDecl[],
  baseFieldNames: Set<string>,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  const dispatch = type.polymorphicDispatch!;
  const discSnake = rustFieldName(dispatch.discriminatorField);
  const enumName = name + "Kind";

  lines.push(
    `        let ${discSnake}_str = value.get("${dispatch.discriminatorField}").and_then(|v| v.as_str()).unwrap_or("");`,
  );
  lines.push(`        let ${discSnake} = match ${discSnake}_str {`);

  // Named variants
  for (const variant of dispatch.variants) {
    const childType = childTypes.find(
      (ct) => ct.typeName.name === variant.typeName.name,
    );
    const variantName =
      variant.typeName.name.replace(name, "") || variant.typeName.name;
    const variantFields = childType
      ? childType.fields.filter(
          (f) =>
            f.name !== dispatch.discriminatorField &&
            !baseFieldNames.has(f.name),
        )
      : [];

    if (variantFields.length === 0) {
      lines.push(
        `            "${variant.value}" => ${enumName}::${variantName},`,
      );
    } else {
      lines.push(
        `            "${variant.value}" => ${enumName}::${variantName} {`,
      );
      for (const field of variantFields) {
        const assignment = variantLoadExpr(field, name, polymorphicTypeNames);
        lines.push(
          `                ${rustFieldName(field.name)}: ${assignment},`,
        );
      }
      lines.push(`            },`);
    }
  }

  // Default / wildcard
  if (dispatch.defaultVariant) {
    const isSelfRef = dispatch.defaultVariant.isSelfReference;
    const variantName = isSelfRef
      ? "Custom"
      : dispatch.defaultVariant.typeName.name.replace(name, "") || "Custom";
    const defaultType = childTypes.find(
      (ct) => ct.typeName.name === dispatch.defaultVariant!.typeName.name,
    );
    const variantFields = isSelfRef
      ? []
      : defaultType
        ? defaultType.fields.filter(
            (f) =>
              f.name !== dispatch.discriminatorField &&
              !baseFieldNames.has(f.name),
          )
        : [];

    if (variantFields.length === 0) {
      lines.push(`            _ => ${enumName}::${variantName} {`);
      lines.push(
        `                ${discSnake}_name: ${discSnake}_str.to_string(),`,
      );
      lines.push("                raw: {");
      lines.push(
        "                    let mut raw = value.as_object().cloned().unwrap_or_default();",
      );
      for (const fieldName of baseFieldNames) {
        lines.push(`                    raw.remove("${fieldName}");`);
      }
      lines.push("                    raw");
      lines.push("                },");
      lines.push("            },");
    } else {
      lines.push(`            _ => ${enumName}::${variantName} {`);
      for (const field of variantFields) {
        const assignment = variantLoadExpr(field, name, polymorphicTypeNames);
        lines.push(
          `                ${rustFieldName(field.name)}: ${assignment},`,
        );
      }
      lines.push(
        `                ${discSnake}_name: ${discSnake}_str.to_string(),`,
      );
      lines.push("                raw: {");
      lines.push(
        "                    let mut raw = value.as_object().cloned().unwrap_or_default();",
      );
      for (const fieldName of [
        ...baseFieldNames,
        ...variantFields.map((field) => field.name),
      ]) {
        lines.push(`                    raw.remove("${fieldName}");`);
      }
      lines.push("                    raw");
      lines.push("                },");
      lines.push(`            },`);
    }
  } else if (isClosedPolymorphicDispatch(dispatch)) {
    lines.push(
      `            _ => panic!("Unknown ${name} discriminator field '${dispatch.discriminatorField}' value: {}", ${discSnake}_str),`,
    );
  } else {
    lines.push(`            _ => ${enumName}::Unknown {`);
    lines.push(
      `                ${discSnake}_name: ${discSnake}_str.to_string(),`,
    );
    lines.push("                raw: {");
    lines.push(
      "                    let mut raw = value.as_object().cloned().unwrap_or_default();",
    );
    for (const fieldName of baseFieldNames) {
      lines.push(`                    raw.remove("${fieldName}");`);
    }
    lines.push("                    raw");
    lines.push("                },");
    lines.push("            },");
  }

  lines.push("        };");

  // Construct the struct with base fields + kind
  lines.push("        Self {");
  for (const a of type.load.assignments) {
    // Skip discriminator — it's stored in the enum field
    if (a.fieldName === dispatch.discriminatorField) continue;
    lines.push(
      `            ${rustFieldName(a.fieldName)}: ${loadExpr(a, polymorphicTypeNames)},`,
    );
  }
  lines.push(`            ${discSnake}: ${discSnake},`);
  lines.push("        }");
}

// ============================================================================
// kind_str
// ============================================================================

function emitKindStr(
  type: TypeDecl,
  childTypes: TypeDecl[],
  lines: string[],
): void {
  const dispatch = type.polymorphicDispatch!;
  const baseFieldNames = new Set(type.fields.map((f) => f.name));
  const enumName = type.typeName.name + "Kind";
  const discSnake = rustFieldName(dispatch.discriminatorField);

  lines.push(
    `    /// Returns the \`${dispatch.discriminatorField}\` discriminator string for this instance.`,
  );
  lines.push(`    pub fn ${discSnake}_str(&self) -> &str {`);
  lines.push(`        match &self.${discSnake} {`);

  for (const variant of dispatch.variants) {
    const variantName =
      variant.typeName.name.replace(type.typeName.name, "") ||
      variant.typeName.name;
    const childType = childTypes.find(
      (ct) => ct.typeName.name === variant.typeName.name,
    );
    const variantFields = childType
      ? childType.fields.filter(
          (f) =>
            f.name !== dispatch.discriminatorField &&
            !baseFieldNames.has(f.name),
        )
      : [];
    if (variantFields.length === 0) {
      lines.push(
        `            ${enumName}::${variantName} => "${variant.value}",`,
      );
    } else {
      lines.push(
        `            ${enumName}::${variantName} { .. } => "${variant.value}",`,
      );
    }
  }

  if (dispatch.defaultVariant) {
    const isSelfRef = dispatch.defaultVariant.isSelfReference;
    const variantName = isSelfRef
      ? "Custom"
      : dispatch.defaultVariant.typeName.name.replace(type.typeName.name, "") ||
        "Custom";
    lines.push(
      `            ${enumName}::${variantName} { ${discSnake}_name, .. } => ${discSnake}_name.as_str(),`,
    );
  } else if (!isClosedPolymorphicDispatch(dispatch)) {
    lines.push(
      `            ${enumName}::Unknown { ${discSnake}_name, .. } => ${discSnake}_name.as_str(),`,
    );
  }

  lines.push("        }");
  lines.push("    }");
  lines.push("");
}

// ============================================================================
// to_value
// ============================================================================

function emitToValue(
  name: string,
  type: TypeDecl,
  childTypes: TypeDecl[],
  baseFieldNames: Set<string>,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  lines.push(`    /// Serialize ${name} to a \`serde_json::Value\`.`);
  lines.push("    ///");
  lines.push("    /// Calls `ctx.process_dict` after serialization.");
  lines.push(
    "    pub fn to_value(&self, ctx: &SaveContext) -> serde_json::Value {",
  );
  lines.push("        let mut result = serde_json::Map::new();");

  // Write discriminator first
  if (type.polymorphicDispatch) {
    const discSnake = rustFieldName(
      type.polymorphicDispatch.discriminatorField,
    );
    lines.push(`        // Write the discriminator`);
    lines.push(
      `        result.insert("${type.polymorphicDispatch.discriminatorField}".to_string(), serde_json::Value::String(self.${discSnake}_str().to_string()));`,
    );
  }

  // Write base fields
  if (type.save.assignments.length > 0) {
    lines.push(`        // Write base fields`);
  }
  for (const a of type.save.assignments) {
    // Skip discriminator — it's written explicitly above from kind_str()
    if (
      type.polymorphicDispatch &&
      a.fieldName === type.polymorphicDispatch.discriminatorField
    )
      continue;
    emitSaveField(a, "self.", polymorphicTypeNames, lines, "        ");
  }

  // Write variant-specific fields
  if (type.polymorphicDispatch) {
    emitVariantSave(
      type,
      childTypes,
      baseFieldNames,
      polymorphicTypeNames,
      lines,
    );
  }

  lines.push("        ctx.process_dict(serde_json::Value::Object(result))");
  lines.push("    }");
  lines.push("");
}

function emitVariantSave(
  type: TypeDecl,
  childTypes: TypeDecl[],
  baseFieldNames: Set<string>,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  const dispatch = type.polymorphicDispatch!;
  const enumName = type.typeName.name + "Kind";
  const discSnake = rustFieldName(dispatch.discriminatorField);

  lines.push("        // Write variant-specific fields");
  lines.push(`        match &self.${discSnake} {`);

  for (const variant of dispatch.variants) {
    const childType = childTypes.find(
      (ct) => ct.typeName.name === variant.typeName.name,
    );
    const variantName =
      variant.typeName.name.replace(type.typeName.name, "") ||
      variant.typeName.name;
    const variantFields = childType
      ? childType.fields.filter(
          (f) =>
            f.name !== dispatch.discriminatorField &&
            !baseFieldNames.has(f.name),
        )
      : [];

    if (variantFields.length === 0) {
      lines.push(`            ${enumName}::${variantName} => {`);
      lines.push("            }");
    } else {
      const destructure = variantFields
        .map((f) => rustFieldName(f.name))
        .join(", ");
      lines.push(
        `            ${enumName}::${variantName} { ${destructure},  .. } => {`,
      );
      for (const field of variantFields) {
        const helper = childType?.collectionHelpers.find(
          (candidate) => candidate.propertyName === field.name,
        );
        emitVariantSaveField(
          field,
          polymorphicTypeNames,
          type.typeName.name,
          lines,
          helper,
        );
      }
      lines.push("            }");
    }
  }

  // Wildcard variant
  if (dispatch.defaultVariant) {
    const isSelfRef = dispatch.defaultVariant.isSelfReference;
    const variantName = isSelfRef
      ? "Custom"
      : dispatch.defaultVariant.typeName.name.replace(type.typeName.name, "") ||
        "Custom";
    const defaultType = childTypes.find(
      (ct) => ct.typeName.name === dispatch.defaultVariant!.typeName.name,
    );
    const variantFields = isSelfRef
      ? []
      : defaultType
        ? defaultType.fields.filter(
            (f) =>
              f.name !== dispatch.discriminatorField &&
              !baseFieldNames.has(f.name),
          )
        : [];

    const rawSkipFields = Array.from(
      new Set([...baseFieldNames, ...variantFields.map((field) => field.name)]),
    );
    const rawFieldPattern = rawSkipFields
      .map((fieldName) => `"${fieldName}"`)
      .join(" | ");
    if (isSelfRef) {
      lines.push(`            ${enumName}::${variantName} { raw, .. } => {`);
      lines.push("                for (key, value) in raw {");
      lines.push(
        `                    if matches!(key.as_str(), ${rawFieldPattern}) { continue; }`,
      );
      lines.push(
        "                    result.insert(key.clone(), value.clone());",
      );
      lines.push("                }");
      lines.push("            }");
    } else if (variantFields.length === 0) {
      lines.push(`            ${enumName}::${variantName} { raw, .. } => {`);
      lines.push("                for (key, value) in raw {");
      lines.push(
        `                    if matches!(key.as_str(), ${rawFieldPattern}) { continue; }`,
      );
      lines.push(
        "                    result.insert(key.clone(), value.clone());",
      );
      lines.push("                }");
      lines.push("            }");
    } else {
      const destructure = variantFields
        .map((f) => rustFieldName(f.name))
        .join(", ");
      lines.push(
        `            ${enumName}::${variantName} { ${destructure}, raw, .. } => {`,
      );
      for (const field of variantFields) {
        const helper = defaultType?.collectionHelpers.find(
          (candidate) => candidate.propertyName === field.name,
        );
        emitVariantSaveField(
          field,
          polymorphicTypeNames,
          type.typeName.name,
          lines,
          helper,
        );
      }
      lines.push("                for (key, value) in raw {");
      lines.push(
        `                    if matches!(key.as_str(), ${rawFieldPattern}) { continue; }`,
      );
      lines.push(
        "                    result.insert(key.clone(), value.clone());",
      );
      lines.push("                }");
      lines.push("            }");
    }
  } else if (!isClosedPolymorphicDispatch(dispatch)) {
    lines.push(`            ${enumName}::Unknown { raw, .. } => {`);
    lines.push("                for (key, value) in raw {");
    const baseFieldPattern = Array.from(baseFieldNames)
      .map((fieldName) => `"${fieldName}"`)
      .join(" | ");
    lines.push(
      `                    if matches!(key.as_str(), ${baseFieldPattern}) { continue; }`,
    );
    lines.push(
      "                    result.insert(key.clone(), value.clone());",
    );
    lines.push("                }");
    lines.push("            }");
  }

  lines.push("        }");
}

// ============================================================================
// to_json / to_yaml
// ============================================================================

function emitToJson(name: string, lines: string[]): void {
  lines.push(`    /// Serialize ${name} to a JSON string.`);
  lines.push(
    `    pub fn to_json(&self, ctx: &SaveContext) -> Result<String, serde_json::Error> {`,
  );
  lines.push("        serde_json::to_string_pretty(&self.to_value(ctx))");
  lines.push("    }");
  lines.push("");
}

function emitToYaml(name: string, lines: string[]): void {
  lines.push(`    /// Serialize ${name} to a YAML string.`);
  lines.push(
    `    pub fn to_yaml(&self, ctx: &SaveContext) -> Result<String, serde_yaml::Error> {`,
  );
  lines.push("        serde_yaml::to_string(&self.to_value(ctx))");
  lines.push("    }");
}

// ============================================================================
// to_wire — provider-specific wire format conversion
// ============================================================================

/**
 * Emit a `to_wire(&self, provider: &str) -> serde_json::Value` method that
 * serializes the struct via Typra's canonical `to_value`, then remaps field names
 * according to provider-specific wire mappings.
 *
 * Only emitted when `type.wire` is non-null.
 */
function emitToWireMethod(type: TypeDecl, lines: string[]): void {
  const wire = type.wire!;
  const name = type.typeName.name;

  lines.push("");
  lines.push(`    /// Convert to provider-specific wire format.`);
  lines.push(
    `    pub fn to_wire(&self, provider: &str) -> serde_json::Value {`,
  );
  lines.push(`        let data = self.to_value(&SaveContext::default());`);
  lines.push(`        let mut result = serde_json::Map::new();`);

  // Build the wire_map HashMap literal
  lines.push(
    `        let wire_map: std::collections::HashMap<&str, std::collections::HashMap<&str, &str>> = std::collections::HashMap::from([`,
  );
  for (const mapping of wire.mappings) {
    const entries = Object.entries(mapping.wireNames);
    const inner = entries
      .map(([provider, wireName]) => `("${provider}", "${wireName}")`)
      .join(", ");
    lines.push(
      `            ("${mapping.fieldName}", std::collections::HashMap::from([${inner}])),`,
    );
  }
  lines.push(`        ]);`);

  // Iterate over serialized keys and remap (strict: only emit mapped fields)
  lines.push(`        if let serde_json::Value::Object(map) = data {`);
  lines.push(`            for (key, value) in map {`);
  lines.push(
    `                if let Some(mapping) = wire_map.get(key.as_str()) {`,
  );
  lines.push(
    `                    if let Some(wire_name) = mapping.get(provider) {`,
  );
  lines.push(
    `                        result.insert(wire_name.to_string(), value);`,
  );
  lines.push(`                    }`);
  lines.push(`                }`);
  lines.push(`            }`);
  lines.push(`        }`);
  lines.push(`        serde_json::Value::Object(result)`);
  lines.push(`    }`);
}

function emitFromWireMethod(type: TypeDecl, lines: string[]): void {
  const wire = type.wire!;

  lines.push("");
  lines.push(`    /// Load from a provider-specific wire-format payload.`);
  lines.push(
    `    pub fn from_wire(provider: &str, data: &serde_json::Value, ctx: &LoadContext) -> Self {`,
  );
  lines.push(
    `        let wire_map: std::collections::HashMap<&str, std::collections::HashMap<&str, &str>> = std::collections::HashMap::from([`,
  );
  for (const mapping of wire.mappings) {
    const entries = Object.entries(mapping.wireNames);
    const inner = entries
      .map(([provider, wireName]) => `("${provider}", "${wireName}")`)
      .join(", ");
    lines.push(
      `            ("${mapping.fieldName}", std::collections::HashMap::from([${inner}])),`,
    );
  }
  lines.push(`        ]);`);
  lines.push(
    `        let mut inverse: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();`,
  );
  lines.push(`        for (field, mapping) in &wire_map {`);
  lines.push(`            if let Some(wire_name) = mapping.get(provider) {`);
  lines.push(`                inverse.insert(*wire_name, *field);`);
  lines.push(`            }`);
  lines.push(`        }`);
  lines.push(`        let mut canonical = serde_json::Map::new();`);
  lines.push(`        if let serde_json::Value::Object(map) = data {`);
  lines.push(`            for (key, value) in map {`);
  lines.push(
    `                let field = inverse.get(key.as_str()).copied().unwrap_or(key.as_str());`,
  );
  lines.push(
    `                canonical.insert(field.to_string(), value.clone());`,
  );
  lines.push(`            }`);
  lines.push(`        }`);
  lines.push(
    `        Self::load_from_value(&serde_json::Value::Object(canonical), ctx)`,
  );
  lines.push(`    }`);
}

// ============================================================================
// Dict accessor helpers
// ============================================================================

function emitDictAccessor(field: FieldDecl, lines: string[]): void {
  const snake = rustFieldName(field.name);
  lines.push(
    `    /// Returns typed reference to the map if the field is an object.`,
  );
  lines.push(`    /// Returns \`None\` if the field is null or not an object.`);
  lines.push(
    `    pub fn as_${snake}_dict(&self) -> Option<&serde_json::Map<String, serde_json::Value>> {`,
  );
  lines.push(`        self.${snake}.as_object()`);
  lines.push("    }");
  lines.push("");
}

// ============================================================================
// Collection helpers
// ============================================================================

function emitCollectionLoadHelper(
  helper: CollectionHelperDecl,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  const fnName = `load_${toSnakeCase(helper.propertyName)}`;
  const elemType = helper.elementTypeName.name;

  lines.push("");
  lines.push(`    /// Load a collection of ${elemType} from a JSON value.`);
  if (helper.hasNameProperty) {
    lines.push(
      `    /// Handles both array format \`[{...}]\` and dict format \`{"name": {...}}\`.`,
    );
  } else {
    lines.push(`    /// Handles both array format \`[{...}]\`.`);
  }
  lines.push(
    `    fn ${fnName}(data: &serde_json::Value, ctx: &LoadContext) -> Vec<${elemType}> {`,
  );
  lines.push("        match data {");
  lines.push("            serde_json::Value::Array(arr) => {");
  lines.push(
    `                arr.iter().map(|v| ${elemType}::load_from_value(v, ctx)).collect()`,
  );
  lines.push("            }");
  lines.push("");

  if (helper.hasNameProperty) {
    // Dict format with name keys
    const shorthandField = entryShorthandTarget(helper);
    lines.push("            serde_json::Value::Object(obj) => {");
    lines.push("                obj.iter()");
    lines.push("                    .map(|(name, value)| {");
    lines.push("                        if value.is_array() {");
    lines.push(
      `                            panic!("${helper.propertyName}.{}: invalid named collection entry category array", name);`,
    );
    lines.push("                        }");
    lines.push("                        let mut v = if value.is_object() {");
    lines.push("                            value.clone()");
    emitEntryShorthandArms(helper, shorthandField, lines);
    lines.push("                        };");
    lines.push(
      "                        if let serde_json::Value::Object(ref mut m) = v {",
    );
    lines.push(
      '                            m.entry("name".to_string()).or_insert_with(|| serde_json::Value::String(name.clone()));',
    );
    lines.push("                        }");
    lines.push(`                        ${elemType}::load_from_value(&v, ctx)`);
    lines.push("                    })");
    lines.push("                    .collect()");
    lines.push("            }");
  }

  lines.push("            _ => Vec::new(),");
  lines.push("");
  lines.push("        }");
  lines.push("    }");
  lines.push("");

  // Save helper
}

/**
 * Emit the immediate-scalar arms of a name-keyed collection entry.
 *
 * When `@entryShorthand` is declared, each `@coerce` scalar type gets its own arm
 * that applies that coercion's constant assignments (the discriminator) and routes
 * the raw scalar to the declared value field. Integral checks precede fractional
 * ones for the same reason as the coercion bridge: `serde_json` preserves the
 * token's int/float distinction and classifying in the wrong order collapses
 * integers into floats.
 *
 * Without the declaration this falls back to the historical single-field shorthand.
 */
function emitEntryShorthandArms(
  helper: CollectionHelperDecl,
  shorthandField: string,
  lines: string[],
): void {
  const shorthand = helper.entryShorthand;
  const indent = "                        ";

  if (!shorthand || shorthand.cases.length === 0) {
    lines.push(`${indent}} else {`);
    lines.push(
      `${indent}    serde_json::json!({ "${shorthandField}": value })`,
    );
    return;
  }

  const ordered = orderedEntryShorthandCases(shorthand.cases);

  for (const entryCase of ordered) {
    const check = rustScalarValueCheck(entryCase.scalarType);
    if (!check) continue;
    const fields = entryCase.assignments
      .map((a) => `"${a.fieldName}": ${JSON.stringify(a.literalValue)}`)
      .concat(`"${shorthand.valueField}": value`)
      .join(", ");
    lines.push(`${indent}} else if value.${check} {`);
    lines.push(`${indent}    serde_json::json!({ ${fields} })`);
  }

  lines.push(`${indent}} else {`);
  lines.push(
    `${indent}    serde_json::json!({ "${shorthand.valueField}": value })`,
  );
}

/** serde_json predicate that recognises a JSON token of the given TypeSpec scalar type. */
function rustScalarValueCheck(scalarType: string): string | null {
  switch (scalarRuntimeKind(scalarType)) {
    case "integral":
      return "is_i64()";
    case "fractional":
      return "is_f64()";
    case "string":
      return "is_string()";
    case "boolean":
      return "is_boolean()";
    default:
      return null;
  }
}

function emitCollectionSaveHelper(
  helper: CollectionHelperDecl,
  lines: string[],
): void {
  const fnName = `save_${toSnakeCase(helper.propertyName)}`;
  const elemType = helper.elementTypeName.name;

  lines.push(`    /// Save a collection of ${elemType} to a JSON value.`);
  lines.push(
    `    fn ${fnName}(items: &[${elemType}], ctx: &SaveContext) -> serde_json::Value {`,
  );

  if (helper.hasNameProperty) {
    lines.push("");
    lines.push(
      "        let mut serialized = items.iter().map(|item| item.to_value(ctx)).collect::<Vec<_>>();",
    );
    lines.push("        for item_data in &mut serialized {");
    lines.push(
      "            if let serde_json::Value::Object(map) = item_data {",
    );
    lines.push(
      '                if matches!(map.get("name"), Some(serde_json::Value::String(name)) if name.is_empty()) { map.remove("name"); }',
    );
    lines.push("            }");
    lines.push("        }");
    lines.push("");
    lines.push('        if ctx.collection_format == "array" {');
    lines.push("            return serde_json::Value::Array(serialized);");
    lines.push("        }");
    lines.push("        let mut names = std::collections::HashSet::new();");
    lines.push("        for item_data in &serialized {");
    lines.push(
      '            let Some(name) = item_data.get("name").and_then(|value| value.as_str()) else {',
    );
    lines.push("                return serde_json::Value::Array(serialized);");
    lines.push("            };");
    lines.push(
      "            if name.is_empty() || !names.insert(name.to_string()) {",
    );
    lines.push("                return serde_json::Value::Array(serialized);");
    lines.push("            }");
    lines.push("        }");
    lines.push("        // Object format: use name as key");
    lines.push("        let mut result = serde_json::Map::new();");
    lines.push("        for item_data in serialized {");
    lines.push("            let mut item_data = match item_data {");
    lines.push("                serde_json::Value::Object(m) => m,");
    lines.push(
      '                other => { let mut m = serde_json::Map::new(); m.insert("value".to_string(), other); m },',
    );
    lines.push("            };");
    lines.push(
      '            let serde_json::Value::String(name) = item_data.remove("name").expect("validated named collection item") else { unreachable!() };',
    );
    if (helper.coercionProperty) {
      // Mirror of the shared save-side contract: when the only surviving field is the
      // scalar-coercion target, the entry collapses back to the bare scalar it loaded
      // from. Without this the Rust backend emitted the expanded object form while
      // every other backend emitted shorthand, so a name-keyed collection did not
      // round-trip byte-identically across languages.
      lines.push("            if ctx.use_shorthand && item_data.len() == 1 {");
      lines.push(
        `                if let Some(shorthand) = item_data.get(${JSON.stringify(helper.coercionProperty)}) {`,
      );
      lines.push("                    result.insert(name, shorthand.clone());");
      lines.push("                    continue;");
      lines.push("                }");
      lines.push("            }");
    }
    lines.push(
      "            result.insert(name, serde_json::Value::Object(item_data));",
    );
    lines.push("        }");
    lines.push("        serde_json::Value::Object(result)");
  } else {
    lines.push("");
    lines.push(
      "        serde_json::Value::Array(items.iter().map(|item| item.to_value(ctx)).collect::<Vec<_>>())",
    );
  }

  lines.push("");
  lines.push("    }");
}

// ============================================================================
// Factory methods
// ============================================================================

function emitFactory(
  parentName: string,
  factory: FactoryDecl,
  visitor: ExprVisitor,
  lines: string[],
): void {
  const params = Object.entries(factory.params)
    .map(
      ([pName, pType]) => `${toSnakeCase(pName)}: ${factoryParamType(pType)}`,
    )
    .join(", ");

  lines.push(`    /// Create a ${parentName} with preset field values.`);
  lines.push(`    pub fn ${factory.name}(${params}) -> Self {`);
  lines.push(`        ${visitor.visitExpr(factory.body)}`);
  lines.push("    }");
}

function factoryParamType(typeStr: string): string {
  switch (typeStr) {
    case "string":
      return "impl Into<String>";
    case "unknown":
    case "any":
      return "impl Into<serde_json::Value>";
    case "boolean":
      return "bool";
    case "int32":
      return "i32";
    case "int64":
    case "integer":
      return "i64";
    case "float32":
      return "f32";
    case "float64":
    case "float":
      return "f64";
    default:
      return `impl Into<${typeStr}>`;
  }
}

// ============================================================================
// Method stub trait
// ============================================================================

function emitMethodTrait(type: TypeDecl, lines: string[]): void {
  lines.push(
    `/// Helpers for [\`${type.typeName.name}\`]. Implement in a separate file.`,
  );
  lines.push(`pub trait ${type.typeName.name}Helpers {`);
  for (const method of type.methods) {
    if (method.description) {
      emitDocComment(method.description, "    ", lines);
    }
    const params = Object.entries(method.params).map(
      ([pName, pType]) => `${toSnakeCase(pName)}: &${protocolRustType(pType)}`,
    );
    if (method.runtimeCancellable) {
      params.push("cancellation: &CancellationToken");
    }
    const signatureParams = params.length > 0 ? `, ${params.join(", ")}` : "";
    lines.push(
      `    fn ${toSnakeCase(method.name)}(&self${signatureParams}) -> ${methodReturnType(method)};`,
    );
  }
  lines.push("}");
}

function methodReturnType(method: MethodStubDecl): string {
  return protocolRustType(method.returns);
}

// ============================================================================
// Protocol trait emission
// ============================================================================

/** Map a protocol type string to a Rust type. */
export function protocolRustType(typeStr: string): string {
  // Handle nullable types
  if (typeStr.endsWith("?")) {
    const inner = typeStr.slice(0, -1);
    return `Option<${protocolRustType(inner)}>`;
  }
  // Handle array types
  if (typeStr.endsWith("[]")) {
    const inner = typeStr.slice(0, -2);
    return `Vec<${protocolRustType(inner)}>`;
  }
  if (typeStr === "Record<unknown>" || typeStr === "dictionary")
    return "serde_json::Value";
  if (typeStr === "unknown" || typeStr === "any") return "serde_json::Value";
  if (typeStr === "void") return "()";
  if (typeStr === "string") return "String";
  return RUST_TYPE_MAP[typeStr] || typeStr;
}

/**
 * Emit a Rust trait for a protocol type.
 * Uses #[async_trait] for async method support.
 */
function emitProtocolTrait(type: TypeDecl, lines: string[]): void {
  const name = type.typeName.name;

  if (type.description) {
    emitDocComment(type.description, "", lines);
  }
  lines.push("#[async_trait::async_trait]");
  lines.push(`pub trait ${name}: Send + Sync {`);

  for (const method of type.methods) {
    if (method.description) {
      emitDocComment(method.description, "    ", lines);
    }
    const params = Object.entries(method.params).map(
      ([pName, pType]) => `${toSnakeCase(pName)}: &${protocolRustType(pType)}`,
    );
    if (method.runtimeCancellable) {
      params.push("cancellation: &CancellationToken");
    }
    const signatureParams = params.length > 0 ? `, ${params.join(", ")}` : "";
    const ret = protocolRustType(method.returns);

    if (method.sync) {
      // Synchronous method
      if (method.optional) {
        // An optional op supplies a default body. When the return already carries
        // nullability (Option<T>) or is unit, "not provided" is representable in the
        // return type itself. For a value return (e.g. `String`) there is no in-band
        // sentinel, so diverge with `unimplemented!()` — the sync analogue of the async
        // path's `Err(...)` — instead of emitting a type-incorrect `None`.
        lines.push(
          `    fn ${toSnakeCase(method.name)}(&self${signatureParams}) -> ${ret} {`,
        );
        if (ret === "()") {
          lines.push("        ()");
        } else if (ret.startsWith("Option<")) {
          lines.push("        None");
        } else {
          lines.push(
            `        unimplemented!("${toSnakeCase(method.name)} is an optional operation with no default")`,
          );
        }
        lines.push("    }");
      } else {
        lines.push(
          `    fn ${toSnakeCase(method.name)}(&self${signatureParams}) -> ${ret};`,
        );
      }
    } else {
      // Async method
      if (method.optional) {
        // Default implementation returns an error — providers override with real streaming
        lines.push(
          `    async fn ${toSnakeCase(method.name)}(&self${signatureParams}) -> Result<${ret}, Box<dyn std::error::Error + Send + Sync>> {`,
        );
        lines.push(`        Err("not supported".into())`);
        lines.push("    }");
      } else {
        lines.push(
          `    async fn ${toSnakeCase(method.name)}(&self${signatureParams}) -> Result<${ret}, Box<dyn std::error::Error + Send + Sync>>;`,
        );
      }
    }
  }

  lines.push("}");
}

// ============================================================================
// Field type rendering
// ============================================================================

/**
 * A `complex` field whose declared type has no generated Rust counterpart —
 * a polymorphic base (carried as raw JSON so subtype data survives) or the
 * `unknown` placeholder. These are represented as `serde_json::Value`.
 */
function isValueBackedComplex(
  typeName: string,
  polymorphicTypeNames: Set<string>,
): boolean {
  return polymorphicTypeNames.has(typeName) || typeName === "unknown";
}

function fieldType(
  field: FieldDecl,
  polymorphicTypeNames: Set<string>,
  inVariant: boolean = false,
): string {
  // Named enum field — use the enum type
  if (field.enumName && field.allowedValues.length > 0) {
    return field.isOptional ? `Option<${field.enumName}>` : field.enumName;
  }
  const cat = field.category;
  switch (cat.kind) {
    case "scalar": {
      const rustType = RUST_TYPE_MAP[cat.scalarType] || cat.scalarType;
      // dict category handles always-Value separately; for scalar value types
      // (any, object, unknown), optional fields are Option<Value>, required are Value.
      // dictionary scalar is always Value (never Option) since it's a map type.
      if (cat.scalarType === "dictionary") {
        return "serde_json::Value";
      }
      return field.isOptional ? `Option<${rustType}>` : rustType;
    }
    case "complex": {
      // Polymorphic references and "unknown" have no generated Rust type of their
      // own, so they are carried as serde_json::Value.
      //
      // Struct fields keep Value::Null as the "absent" sentinel, which is a stable
      // part of the generated API. Enum variant fields cannot: their load and save
      // paths construct and match an Option (a variant field is moved out of the
      // enum, so there is no place to put a Null default), so an optional one must
      // be declared Option<Value> or the generated crate fails to compile (E0308).
      if (isValueBackedComplex(cat.typeName, polymorphicTypeNames)) {
        return inVariant && field.isOptional
          ? "Option<serde_json::Value>"
          : "serde_json::Value";
      }
      return field.isOptional ? `Option<${cat.typeName}>` : cat.typeName;
    }
    case "collection_scalar": {
      const elemType = RUST_TYPE_MAP[cat.scalarType] || cat.scalarType;
      const isOptional = shouldPreserveOptionalAbsence(field);
      if (isValueType(cat.scalarType)) {
        return isOptional
          ? "Option<Vec<serde_json::Value>>"
          : "Vec<serde_json::Value>";
      }
      return isOptional ? `Option<Vec<${elemType}>>` : `Vec<${elemType}>`;
    }
    case "collection_complex": {
      const elemType =
        cat.typeName === "unknown" ? "serde_json::Value" : cat.typeName;
      return shouldPreserveOptionalAbsence(field)
        ? `Option<Vec<${elemType}>>`
        : `Vec<${elemType}>`;
    }
    case "dict": {
      if (!cat.valueType || cat.valueType === "unknown")
        return "serde_json::Value";
      const mapType = `std::collections::HashMap<String, ${rustDictValueType(cat.valueType)}>`;
      return field.isOptional ? `Option<${mapType}>` : mapType;
    }
  }
}

function isValueType(scalarType: string): boolean {
  return (
    scalarType === "any" ||
    scalarType === "object" ||
    scalarType === "dictionary" ||
    scalarType === "unknown"
  );
}

function fieldDefault(
  field: FieldDecl,
  polymorphicTypeNames: Set<string>,
): string {
  // Named enum — default to field default value or first variant
  if (field.enumName && field.allowedValues.length > 0) {
    if (field.isOptional) return "None";
    const dv =
      typeof field.defaultValue === "string" ? field.defaultValue : null;
    const defaultVal =
      dv && field.allowedValues.includes(dv) ? dv : field.allowedValues[0];
    return `${field.enumName}::${toPascalCase(defaultVal)}`;
  }
  const cat = field.category;
  switch (cat.kind) {
    case "scalar": {
      if (isValueType(cat.scalarType)) {
        // dictionary is always Value (never Option); other value types may be optional
        if (cat.scalarType !== "dictionary" && field.isOptional) return "None";
        return "serde_json::Value::Null";
      }
      if (field.isOptional) return "None";
      const rustType = RUST_TYPE_MAP[cat.scalarType] || cat.scalarType;
      if (rustType === "String") return 'String::from("")';
      if (rustType === "bool") return "false";
      if (rustType === "i32" || rustType === "i64") return "0";
      if (rustType === "f32" || rustType === "f64") return "0.0";
      return "Default::default()";
    }
    case "complex": {
      // Struct fields keep Value::Null as the "absent" sentinel (see fieldType).
      if (isValueBackedComplex(cat.typeName, polymorphicTypeNames))
        return "serde_json::Value::Null";
      return field.isOptional ? "None" : "Default::default()";
    }
    case "collection_scalar":
    case "collection_complex":
      return shouldMaterializeCollectionDefault(field) ? "Vec::new()" : "None";
    case "dict":
      if (!cat.valueType || cat.valueType === "unknown")
        return "serde_json::Value::Null";
      return field.isOptional ? "None" : "std::collections::HashMap::new()";
  }
}

function rustDictValueType(valueType: string): string {
  return RUST_TYPE_MAP[valueType] || valueType;
}

// ============================================================================
// Load expression rendering (per-field)
// ============================================================================

function loadExpr(
  a: LoadAssignment,
  polymorphicTypeNames: Set<string>,
): string {
  const key = a.sourceName;
  const cat = a.category;

  // Named enum — parse from string via from_str_opt
  if (a.enumName && a.allowedValues.length > 0) {
    const dv = typeof a.defaultValue === "string" ? a.defaultValue : null;
    const defaultVal =
      dv && a.allowedValues.includes(dv) ? dv : a.allowedValues[0];
    if (a.isOptional) {
      return `value.get("${key}").and_then(|v| v.as_str()).and_then(|s| ${a.enumName}::from_str_opt(s))`;
    }
    return `value.get("${key}").and_then(|v| v.as_str()).and_then(|s| ${a.enumName}::from_str_opt(s)).unwrap_or(${a.enumName}::${toPascalCase(defaultVal)})`;
  }

  switch (cat.kind) {
    case "scalar":
      return scalarLoadExpr(key, cat.scalarType, a.isOptional);
    case "complex": {
      if (isValueBackedComplex(cat.typeName, polymorphicTypeNames)) {
        // Struct fields keep Value::Null as the "absent" sentinel (see fieldType).
        return `value.get("${key}").cloned().unwrap_or(serde_json::Value::Null)`;
      }
      if (a.isOptional) {
        return `value.get("${key}").filter(|v| v.is_object() || v.is_array() || v.is_string()).map(|v| ${cat.typeName}::load_from_value(v, ctx))`;
      }
      return `value.get("${key}").filter(|v| v.is_object() || v.is_array() || v.is_string()).map(|v| ${cat.typeName}::load_from_value(v, ctx)).unwrap_or_default()`;
    }
    case "collection_scalar": {
      return collectionScalarLoadExpr(
        key,
        cat.scalarType,
        shouldPreserveOptionalAbsence(a),
      );
    }
    case "collection_complex": {
      const loaded = `value.get("${key}").map(|v| Self::load_${toSnakeCase(a.fieldName)}(v, ctx))`;
      return shouldPreserveOptionalAbsence(a)
        ? loaded
        : `${loaded}.unwrap_or_default()`;
    }
    case "dict":
      return dictLoadExpr(key, cat.valueType, a.isOptional);
  }
}

function dictLoadExpr(
  key: string,
  valueType: string | undefined,
  isOptional: boolean,
): string {
  if (!valueType || valueType === "unknown") {
    return `value.get("${key}").cloned().unwrap_or(serde_json::Value::Null)`;
  }
  const loaded = `value.get("${key}").and_then(|v| v.as_object()).map(|items| items.iter().map(|(key, item)| (key.clone(), ${rustDictValueLoadExpr("item", valueType)})).collect())`;
  return isOptional ? loaded : `${loaded}.unwrap_or_default()`;
}

function rustDictValueLoadExpr(valueExpr: string, valueType: string): string {
  switch (RUST_TYPE_MAP[valueType]) {
    case "String":
      return `${valueExpr}.as_str().unwrap_or_default().to_string()`;
    case "bool":
      return `${valueExpr}.as_bool().unwrap_or_default()`;
    case "i32":
      return `${valueExpr}.as_i64().unwrap_or_default() as i32`;
    case "i64":
      return `${valueExpr}.as_i64().unwrap_or_default()`;
    case "f32":
      return `${valueExpr}.as_f64().unwrap_or_default() as f32`;
    case "f64":
      return `${valueExpr}.as_f64().unwrap_or_default()`;
    case "serde_json::Value":
      return `${valueExpr}.clone()`;
    default:
      return `${valueType}::load_from_value(${valueExpr}, ctx)`;
  }
}

function scalarLoadExpr(
  key: string,
  scalarType: string,
  isOptional: boolean,
): string {
  if (isValueType(scalarType)) {
    // dictionary is never optional; any/object/unknown may be optional
    if (scalarType === "dictionary") {
      return `value.get("${key}").cloned().unwrap_or(serde_json::Value::Null)`;
    }
    return isOptional
      ? `value.get("${key}").cloned()`
      : `value.get("${key}").cloned().unwrap_or(serde_json::Value::Null)`;
  }

  switch (scalarType) {
    case "string":
      return isOptional
        ? `value.get("${key}").and_then(|v| v.as_str()).map(|s| s.to_string())`
        : `value.get("${key}").and_then(|v| v.as_str()).unwrap_or_default().to_string()`;
    case "boolean":
      return isOptional
        ? `value.get("${key}").and_then(|v| v.as_bool())`
        : `value.get("${key}").and_then(|v| v.as_bool()).unwrap_or(false)`;
    case "int32":
      return isOptional
        ? `value.get("${key}").and_then(|v| v.as_i64()).map(|v| v as i32)`
        : `value.get("${key}").and_then(|v| v.as_i64()).unwrap_or(0) as i32`;
    case "int64":
    case "integer":
      return isOptional
        ? `value.get("${key}").and_then(|v| v.as_i64())`
        : `value.get("${key}").and_then(|v| v.as_i64()).unwrap_or(0)`;
    case "float64":
    case "float":
    case "number":
    case "numeric":
      return isOptional
        ? `value.get("${key}").and_then(|v| v.as_f64())`
        : `value.get("${key}").and_then(|v| v.as_f64()).unwrap_or(0.0)`;
    case "float32":
      return isOptional
        ? `value.get("${key}").and_then(|v| v.as_f64()).map(|v| v as f32)`
        : `value.get("${key}").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32`;
    default:
      return `value.get("${key}").cloned().unwrap_or(serde_json::Value::Null)`;
  }
}

function collectionScalarLoadExpr(
  key: string,
  scalarType: string,
  isOptional: boolean,
): string {
  if (isValueType(scalarType)) {
    return isOptional
      ? `value.get("${key}").and_then(|v| v.as_array()).map(|arr| arr.to_vec())`
      : `value.get("${key}").and_then(|v| v.as_array()).map(|arr| arr.to_vec()).unwrap_or_default()`;
  }

  switch (scalarType) {
    case "string":
      return isOptional
        ? `value.get("${key}").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())`
        : `value.get("${key}").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()).unwrap_or_default()`;
    default:
      return isOptional
        ? `value.get("${key}").and_then(|v| v.as_array()).map(|arr| arr.to_vec())`
        : `value.get("${key}").and_then(|v| v.as_array()).map(|arr| arr.to_vec()).unwrap_or_default()`;
  }
}

/**
 * Load expression for a variant field (used inside match arms).
 */
function variantLoadExpr(
  field: FieldDecl,
  parentTypeName: string,
  polymorphicTypeNames: Set<string>,
): string {
  // Delegate to the same patterns as base field loading, but with "value" as the source
  const key = field.name;
  const cat = field.category;

  // Named enum — parse from string via from_str_opt
  if (field.enumName && field.allowedValues.length > 0) {
    const defaultVal = String(field.defaultValue || field.allowedValues[0]);
    if (field.isOptional) {
      return `value.get("${key}").and_then(|v| v.as_str()).and_then(|s| ${field.enumName}::from_str_opt(s))`;
    }
    return `value.get("${key}").and_then(|v| v.as_str()).and_then(|s| ${field.enumName}::from_str_opt(s)).unwrap_or(${field.enumName}::${toPascalCase(defaultVal)})`;
  }

  switch (cat.kind) {
    case "scalar":
      return scalarLoadExpr(key, cat.scalarType, field.isOptional);
    case "complex": {
      if (isValueBackedComplex(cat.typeName, polymorphicTypeNames)) {
        return field.isOptional
          ? `value.get("${key}").cloned()`
          : `value.get("${key}").cloned().unwrap_or(serde_json::Value::Null)`;
      }
      if (field.isOptional) {
        return `value.get("${key}").filter(|v| v.is_object() || v.is_array() || v.is_string()).map(|v| ${cat.typeName}::load_from_value(v, ctx))`;
      }
      return `value.get("${key}").filter(|v| v.is_object() || v.is_array() || v.is_string()).map(|v| ${cat.typeName}::load_from_value(v, ctx)).unwrap_or_default()`;
    }
    case "collection_scalar": {
      return collectionScalarLoadExpr(
        key,
        cat.scalarType,
        shouldPreserveOptionalAbsence(field),
      );
    }
    case "collection_complex": {
      // Collection in a variant — use the parent type's helper
      const loaded = `value.get("${key}").map(|v| Self::load_${toSnakeCase(field.name)}(v, ctx))`;
      return shouldPreserveOptionalAbsence(field)
        ? loaded
        : `${loaded}.unwrap_or_default()`;
    }
    case "dict":
      return dictLoadExpr(key, cat.valueType, field.isOptional);
  }
}

// ============================================================================
// Save expression rendering (per-field)
// ============================================================================

function emitSaveField(
  a: SaveAssignment,
  prefix: string,
  polymorphicTypeNames: Set<string>,
  lines: string[],
  indent: string,
): void {
  const key = a.targetName;
  const fieldRef = `${prefix}${rustFieldName(a.fieldName)}`;
  const cat = a.category;

  // Named enum — serialize via .to_string()
  if (a.enumName) {
    if (shouldOmitAbsentOnSave(a)) {
      lines.push(`${indent}if let Some(val) = ${fieldRef}.as_ref() {`);
      lines.push(
        `${indent}    result.insert("${key}".to_string(), serde_json::Value::String(val.to_string()));`,
      );
      lines.push(`${indent}}`);
    } else {
      lines.push(
        `${indent}result.insert("${key}".to_string(), serde_json::Value::String(${fieldRef}.to_string()));`,
      );
    }
    return;
  }

  switch (cat.kind) {
    case "scalar":
      emitScalarSave(
        key,
        fieldRef,
        cat.scalarType,
        shouldOmitAbsentOnSave(a),
        lines,
        indent,
      );
      return;
    case "complex": {
      if (isValueBackedComplex(cat.typeName, polymorphicTypeNames)) {
        // Struct fields keep Value::Null as the "absent" sentinel (see fieldType).
        // Save may omit exactly the fields that load does not require.
        if (shouldOmitAbsentOnSave(a, "rust-value-sentinel")) {
          lines.push(`${indent}if !${fieldRef}.is_null() {`);
          lines.push(
            `${indent}    result.insert("${key}".to_string(), ${fieldRef}.clone());`,
          );
          lines.push(`${indent}}`);
        } else {
          lines.push(
            `${indent}result.insert("${key}".to_string(), ${fieldRef}.clone());`,
          );
        }
        return;
      }
      if (shouldOmitAbsentOnSave(a)) {
        lines.push(`${indent}if let Some(val) = ${fieldRef}.as_ref() {`);
        lines.push(`${indent}    let nested = val.to_value(ctx);`);
        lines.push(`${indent}    if !nested.is_null() {`);
        lines.push(
          `${indent}        result.insert("${key}".to_string(), nested);`,
        );
        lines.push(`${indent}    }`);
        lines.push(`${indent}}`);
      } else {
        lines.push(`${indent}{`);
        lines.push(`${indent}    let nested = ${fieldRef}.to_value(ctx);`);
        lines.push(`${indent}    result.insert("${key}".to_string(), nested);`);
        lines.push(`${indent}}`);
      }
      return;
    }
    case "collection_scalar": {
      if (shouldOmitAbsentOnSave(a, "rust-collection-default")) {
        lines.push(`${indent}if let Some(items) = ${fieldRef}.as_ref() {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), serde_json::to_value(items).unwrap_or(serde_json::Value::Null));`,
        );
        lines.push(`${indent}}`);
      } else if (shouldMaterializeCollectionDefault(a, "explicit-only")) {
        const borrowed = prefix ? `&${fieldRef}` : fieldRef;
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::to_value(${borrowed}).unwrap_or(serde_json::Value::Null));`,
        );
      } else {
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::to_value(&${fieldRef}).unwrap_or(serde_json::Value::Null));`,
        );
      }
      return;
    }
    case "collection_complex": {
      if (shouldOmitAbsentOnSave(a, "rust-collection-default")) {
        lines.push(`${indent}if let Some(items) = ${fieldRef}.as_ref() {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), Self::save_${toSnakeCase(a.fieldName)}(items, ctx));`,
        );
        lines.push(`${indent}}`);
      } else if (shouldMaterializeCollectionDefault(a, "explicit-only")) {
        const borrowed = prefix ? `&${fieldRef}` : fieldRef;
        lines.push(
          `${indent}result.insert("${key}".to_string(), Self::save_${toSnakeCase(a.fieldName)}(${borrowed}, ctx));`,
        );
      } else {
        lines.push(
          `${indent}result.insert("${key}".to_string(), Self::save_${toSnakeCase(a.fieldName)}(&${fieldRef}, ctx));`,
        );
      }
      return;
    }
    case "dict": {
      if (!cat.valueType || cat.valueType === "unknown") {
        if (shouldOmitAbsentOnSave(a)) {
          lines.push(`${indent}if !${fieldRef}.is_null() {`);
          lines.push(
            `${indent}    result.insert("${key}".to_string(), ${fieldRef}.clone());`,
          );
          lines.push(`${indent}}`);
        } else {
          lines.push(
            `${indent}result.insert("${key}".to_string(), ${fieldRef}.clone());`,
          );
        }
      } else if (shouldOmitAbsentOnSave(a)) {
        lines.push(`${indent}if let Some(items) = ${fieldRef}.as_ref() {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), ${rustDictSaveExpr("items", cat.valueType)});`,
        );
        lines.push(`${indent}}`);
      } else {
        lines.push(
          `${indent}result.insert("${key}".to_string(), ${rustDictSaveExpr(`&${fieldRef}`, cat.valueType)});`,
        );
      }
      return;
    }
  }
}

function rustDictSaveExpr(valueExpr: string, valueType: string): string {
  if (RUST_TYPE_MAP[valueType]) {
    return `serde_json::to_value(${valueExpr}).unwrap_or(serde_json::Value::Null)`;
  }
  return `serde_json::Value::Object((${valueExpr}).iter().map(|(key, item)| (key.clone(), item.to_value(ctx))).collect())`;
}

function emitScalarSave(
  key: string,
  fieldRef: string,
  scalarType: string,
  omitAbsentOnSave: boolean,
  lines: string[],
  indent: string,
): void {
  if (isValueType(scalarType)) {
    if (scalarType !== "dictionary" && omitAbsentOnSave) {
      // Optional value types (any, object, unknown) are Option<Value>
      lines.push(`${indent}if let Some(val) = ${fieldRef}.as_ref() {`);
      lines.push(
        `${indent}    result.insert("${key}".to_string(), val.clone());`,
      );
      lines.push(`${indent}}`);
    } else if (omitAbsentOnSave) {
      // Optional dictionary fields use Value::Null as the absent sentinel.
      lines.push(`${indent}if !${fieldRef}.is_null() {`);
      lines.push(
        `${indent}    result.insert("${key}".to_string(), ${fieldRef}.clone());`,
      );
      lines.push(`${indent}}`);
    } else {
      lines.push(
        `${indent}result.insert("${key}".to_string(), ${fieldRef}.clone());`,
      );
    }
    return;
  }

  switch (scalarType) {
    case "string":
      if (omitAbsentOnSave) {
        lines.push(`${indent}if let Some(val) = ${fieldRef}.as_ref() {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), serde_json::Value::String(val.clone()));`,
        );
        lines.push(`${indent}}`);
      } else {
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::Value::String(${fieldRef}.clone()));`,
        );
      }
      return;
    case "boolean":
      if (omitAbsentOnSave) {
        lines.push(`${indent}if let Some(val) = ${fieldRef}.as_ref() {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), serde_json::Value::Bool(*val));`,
        );
        lines.push(`${indent}}`);
      } else {
        // Always write booleans
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::Value::Bool(${fieldRef}));`,
        );
      }
      return;
    case "int32":
    case "int64":
    case "integer":
      if (omitAbsentOnSave) {
        lines.push(`${indent}if let Some(val) = ${fieldRef}.as_ref() {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), serde_json::Value::Number(serde_json::Number::from(*val)));`,
        );
        lines.push(`${indent}}`);
      } else {
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::Value::Number(serde_json::Number::from(${fieldRef})));`,
        );
      }
      return;
    case "float32":
    case "float64":
    case "float":
    case "number":
    case "numeric":
      if (omitAbsentOnSave) {
        lines.push(`${indent}if let Some(val) = ${fieldRef}.as_ref() {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), serde_json::Number::from_f64(*val as f64).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null));`,
        );
        lines.push(`${indent}}`);
      } else {
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::Number::from_f64(${fieldRef} as f64).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null));`,
        );
      }
      return;
  }
}

/**
 * Emit a save expression for a variant field (destructured in a match arm).
 */
function emitVariantSaveField(
  field: FieldDecl,
  polymorphicTypeNames: Set<string>,
  parentTypeName: string,
  lines: string[],
  collectionHelper?: CollectionHelperDecl,
): void {
  const key = field.name;
  const fieldRef = rustFieldName(field.name);
  const cat = field.category;
  const indent = "                ";

  // Named enum — serialize via .to_string()
  if (field.enumName && field.allowedValues.length > 0) {
    if (shouldOmitAbsentOnSave(field)) {
      lines.push(`${indent}if let Some(val) = ${fieldRef}.as_ref() {`);
      lines.push(
        `${indent}    result.insert("${key}".to_string(), serde_json::Value::String(val.to_string()));`,
      );
      lines.push(`${indent}}`);
    } else {
      lines.push(
        `${indent}result.insert("${key}".to_string(), serde_json::Value::String(${fieldRef}.to_string()));`,
      );
    }
    return;
  }

  switch (cat.kind) {
    case "scalar":
      emitVariantScalarSave(
        key,
        fieldRef,
        cat.scalarType,
        shouldOmitAbsentOnSave(field),
        lines,
        indent,
      );
      return;
    case "complex": {
      if (isValueBackedComplex(cat.typeName, polymorphicTypeNames)) {
        // Save may omit exactly the fields that load does not require.
        if (shouldOmitAbsentOnSave(field)) {
          lines.push(`${indent}if let Some(val) = ${fieldRef} {`);
          lines.push(
            `${indent}    result.insert("${key}".to_string(), val.clone());`,
          );
          lines.push(`${indent}}`);
        } else if (shouldOmitAbsentOnSave(field, "rust-value-sentinel")) {
          lines.push(`${indent}if !${fieldRef}.is_null() {`);
          lines.push(
            `${indent}    result.insert("${key}".to_string(), ${fieldRef}.clone());`,
          );
          lines.push(`${indent}}`);
        } else {
          lines.push(
            `${indent}result.insert("${key}".to_string(), ${fieldRef}.clone());`,
          );
        }
        return;
      }
      if (shouldOmitAbsentOnSave(field)) {
        lines.push(`${indent}if let Some(val) = ${fieldRef} {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), val.to_value(ctx));`,
        );
        lines.push(`${indent}}`);
      } else {
        lines.push(`${indent}{`);
        lines.push(`${indent}    let nested = ${fieldRef}.to_value(ctx);`);
        lines.push(`${indent}    result.insert("${key}".to_string(), nested);`);
        lines.push(`${indent}}`);
      }
      return;
    }
    case "collection_scalar": {
      if (shouldOmitAbsentOnSave(field, "rust-collection-default")) {
        lines.push(`${indent}if let Some(items) = ${fieldRef}.as_ref() {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), serde_json::to_value(items).unwrap_or(serde_json::Value::Null));`,
        );
        lines.push(`${indent}}`);
      } else if (shouldMaterializeCollectionDefault(field, "explicit-only")) {
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::to_value(${fieldRef}).unwrap_or(serde_json::Value::Null));`,
        );
      } else {
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::to_value(${fieldRef}).unwrap_or(serde_json::Value::Null));`,
        );
      }
      return;
    }
    case "collection_complex": {
      if (collectionHelper?.hasNameProperty) {
        const saveHelper = `Self::save_${toSnakeCase(field.name)}`;
        if (shouldOmitAbsentOnSave(field, "rust-collection-default")) {
          lines.push(`${indent}if let Some(items) = ${fieldRef}.as_ref() {`);
          lines.push(
            `${indent}    result.insert("${key}".to_string(), ${saveHelper}(items, ctx));`,
          );
          lines.push(`${indent}}`);
        } else if (shouldMaterializeCollectionDefault(field, "explicit-only")) {
          lines.push(
            `${indent}result.insert("${key}".to_string(), ${saveHelper}(${fieldRef}, ctx));`,
          );
        } else {
          lines.push(
            `${indent}result.insert("${key}".to_string(), ${saveHelper}(${fieldRef}, ctx));`,
          );
        }
        return;
      }
      if (shouldOmitAbsentOnSave(field, "rust-collection-default")) {
        lines.push(`${indent}if let Some(items) = ${fieldRef}.as_ref() {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), serde_json::Value::Array(items.iter().map(|item| item.to_value(ctx)).collect()));`,
        );
        lines.push(`${indent}}`);
      } else if (shouldMaterializeCollectionDefault(field, "explicit-only")) {
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::Value::Array(${fieldRef}.iter().map(|item| item.to_value(ctx)).collect()));`,
        );
      } else {
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::Value::Array(${fieldRef}.iter().map(|item| item.to_value(ctx)).collect()));`,
        );
      }
      return;
    }
    case "dict": {
      if (!cat.valueType || cat.valueType === "unknown") {
        if (shouldOmitAbsentOnSave(field)) {
          lines.push(`${indent}if !${fieldRef}.is_null() {`);
          lines.push(
            `${indent}    result.insert("${key}".to_string(), ${fieldRef}.clone());`,
          );
          lines.push(`${indent}}`);
        } else {
          lines.push(
            `${indent}result.insert("${key}".to_string(), ${fieldRef}.clone());`,
          );
        }
      } else if (shouldOmitAbsentOnSave(field)) {
        lines.push(`${indent}if let Some(items) = ${fieldRef}.as_ref() {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), ${rustDictSaveExpr("items", cat.valueType)});`,
        );
        lines.push(`${indent}}`);
      } else {
        lines.push(
          `${indent}result.insert("${key}".to_string(), ${rustDictSaveExpr(fieldRef, cat.valueType)});`,
        );
      }
      return;
    }
  }
}

function emitVariantScalarSave(
  key: string,
  fieldRef: string,
  scalarType: string,
  omitAbsentOnSave: boolean,
  lines: string[],
  indent: string,
): void {
  if (isValueType(scalarType)) {
    if (scalarType !== "dictionary" && omitAbsentOnSave) {
      // Optional value types — variant fields are references, use direct pattern
      lines.push(`${indent}if let Some(val) = ${fieldRef} {`);
      lines.push(
        `${indent}    result.insert("${key}".to_string(), val.clone());`,
      );
      lines.push(`${indent}}`);
    } else if (omitAbsentOnSave) {
      lines.push(`${indent}if !${fieldRef}.is_null() {`);
      lines.push(
        `${indent}    result.insert("${key}".to_string(), ${fieldRef}.clone());`,
      );
      lines.push(`${indent}}`);
    } else {
      lines.push(
        `${indent}result.insert("${key}".to_string(), ${fieldRef}.clone());`,
      );
    }
    return;
  }

  switch (scalarType) {
    case "string":
      if (omitAbsentOnSave) {
        lines.push(`${indent}if let Some(val) = ${fieldRef} {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), serde_json::Value::String(val.clone()));`,
        );
        lines.push(`${indent}}`);
      } else {
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::Value::String(${fieldRef}.clone()));`,
        );
      }
      return;
    case "boolean":
      if (omitAbsentOnSave) {
        lines.push(`${indent}if let Some(val) = ${fieldRef} {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), serde_json::Value::Bool(*val));`,
        );
        lines.push(`${indent}}`);
      } else {
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::Value::Bool(*${fieldRef}));`,
        );
      }
      return;
    case "int32":
    case "int64":
    case "integer":
      if (omitAbsentOnSave) {
        lines.push(`${indent}if let Some(val) = ${fieldRef} {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), serde_json::Value::Number(serde_json::Number::from(*val)));`,
        );
        lines.push(`${indent}}`);
      } else {
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::Value::Number(serde_json::Number::from(*${fieldRef})));`,
        );
      }
      return;
    case "float32":
    case "float64":
    case "float":
    case "number":
    case "numeric":
      if (omitAbsentOnSave) {
        lines.push(`${indent}if let Some(val) = ${fieldRef} {`);
        lines.push(
          `${indent}    result.insert("${key}".to_string(), serde_json::Number::from_f64(*val as f64).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null));`,
        );
        lines.push(`${indent}}`);
      } else {
        lines.push(
          `${indent}result.insert("${key}".to_string(), serde_json::Number::from_f64(*${fieldRef} as f64).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null));`,
        );
      }
      return;
  }
}
