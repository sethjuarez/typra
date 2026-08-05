/**
 * Go code emitter — Declaration IR → Go source code.
 *
 * Replaces `file.go.njk` Nunjucks template with a typed TypeScript function
 * that walks the TypeDecl tree and produces a complete Go source file.
 *
 * Each file contains one type hierarchy (parent + children).
 * Go has no inheritance — child structs duplicate parent fields.
 * Polymorphic types use interface{} and type switches.
 *
 * Structural blocks emitted per type (in order):
 *   1. Description comment
 *   2. Struct definition
 *   3. Load function
 *   4. Save method
 *   5. ToJSON method
 *   6. ToYAML method
 *   7. FromJSON function
 *   8. FromYAML function
 */

import {
  TypeDecl,
  FieldDecl,
  EnumDef,
  LoadAssignment,
  SaveAssignment,
  PolymorphicDispatchDecl,
  CoercionDecl,
  CoercionAssignment,
  PropertyCategory,
  FactoryDecl,
  MethodStubDecl,
  WireDecl,
  CollectionHelperDecl,
  isClosedPolymorphicDispatch,
} from "../../ir/declarations.js";
import { ExprVisitor, toPascalCase } from "../../ir/visitor.js";
import { flattenInheritance } from "../../ir/inheritance.js";
import { buildGoFieldNames, goFieldName } from "./identifiers.js";

// ============================================================================
// Type maps
// ============================================================================

const GO_TYPE_MAP: Record<string, string> = {
  string: "string",
  number: "float64",
  boolean: "bool",
  int64: "int64",
  int32: "int32",
  float64: "float64",
  float32: "float32",
  integer: "int",
  float: "float64",
  numeric: "float64",
  any: "interface{}",
  unknown: "interface{}",
  dictionary: "map[string]interface{}",
};

/** Go types that need numeric type-switch coercion in Load. */
const NUMERIC_GO_TYPES = new Set(["int", "int32", "int64", "float32", "float64"]);

/** Float Go types get an identity case (v = n) in the type switch. */
const FLOAT_GO_TYPES = new Set(["float32", "float64"]);

/** Schema scalar types whose canonical JSON form is a whole number. */
const INTEGRAL_SCALAR_TYPES = new Set(["integer", "int32", "int64"]);

/** Schema scalar types whose canonical JSON form may carry a fraction. */
const FRACTIONAL_SCALAR_TYPES = new Set(["float", "float32", "float64", "number", "numeric"]);

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Emit a complete Go source file for a type hierarchy.
 *
 * @param types - All TypeDecls in this file (parent first, then children)
 * @param packageName - Go package name (lowercase)
 * @param visitor - Expression visitor for coercion rendering
 * @param polymorphicTypeNames - Set of type names that are polymorphic bases
 * @param enums - Enum definitions used in this file
 * @param group - Semantic group from TSP source subfolder (used as header comment only; Go stays flat)
 */
export function emitGoFileContent(
  types: TypeDecl[],
  packageName: string,
  visitor: ExprVisitor,
  polymorphicTypeNames: Set<string>,
  enums: EnumDef[] = [],
  group: string = "",
  scalarCoercibleTypeNames: Set<string> = new Set(types.filter(t => t.load.coercions.length > 0).map(t => t.typeName.name)),
  declarationUniverse: TypeDecl[] = types,
): string {
  const lines: string[] = [];

  // Go has no inheritance: flatten transitive base fields into each child struct
  // so inherited (non-discriminator) fields are not dropped. All ancestors live in
  // Ancestors can live in another emitted file, so resolve them from the complete
  // declaration universe rather than assuming every hierarchy is co-located.
  types = flattenInheritance(types, declarationUniverse);

  // Protocol-only files have a simpler header (no JSON/YAML imports)
  const hasNonProtocol = types.some(t => !t.isProtocol);
  const needsContext = types.some(type => type.methods.some(method => method.runtimeCancellable));
  const needsNamedCollections = types.some(type => type.collectionHelpers.some(helper => helper.hasNameProperty));
  const needsRequiredComplexValidation = types.some(type =>
    type.fields.some(field => field.category.kind === "complex" && !field.isOptional && !field.hasExplicitDefault)
  );
  const needsFmt = enums.some(enumDef => hasParseAliases(enumDef) && !enumDef.isOpen) ||
    types.some(type => type.polymorphicDispatch
      && (isClosedPolymorphicDispatch(type.polymorphicDispatch) || type.polymorphicDispatch.isAbstract)
      && !type.polymorphicDispatch.defaultVariant) ||
    needsNamedCollections ||
    needsRequiredComplexValidation;
  // math.Trunc is only referenced when a type coerces from both a whole-number and a
  // fractional scalar, since that is the only case needing integral discrimination.
  const needsMath = types.some(type =>
    type.load.coercions.some(c => INTEGRAL_SCALAR_TYPES.has(c.scalarType))
    && type.load.coercions.some(c => FRACTIONAL_SCALAR_TYPES.has(c.scalarType))
    && !type.load.coercions.some(c => (GO_TYPE_MAP[c.scalarType] || c.scalarType) === "float64")
  );
  if (hasNonProtocol) {
    emitHeader(lines, packageName, group, needsFmt, needsContext, needsNamedCollections, needsMath);
  } else {
    emitProtocolHeader(lines, packageName, group, needsContext);
  }

  // Emit enum type definitions
  for (const enumDef of enums) {
    emitGoEnum(enumDef, lines);
  }

  // Emit each type in the hierarchy
  for (const type of types) {
    emitTypeBlock(type, lines, visitor, polymorphicTypeNames, scalarCoercibleTypeNames);
  }

  return emitCleanGoLines(lines);
}

function emitCleanGoLines(lines: string[], suffix = ""): string {
  return lines.map(line => line.trimEnd()).join("\n") + suffix;
}

// ============================================================================
// File header
// ============================================================================

function emitHeader(
  lines: string[],
  packageName: string,
  group: string = "",
  needsFmt: boolean = false,
  needsContext: boolean = false,
  needsSort: boolean = false,
  needsMath: boolean = false,
): void {
  lines.push("// Code generated by Typra emitter; DO NOT EDIT.");
  if (group) {
    lines.push(`// Group: ${group}`);
  }
  lines.push("");
  lines.push(`package ${packageName}`);
  lines.push("");
  lines.push("import (");
  if (needsContext) {
    lines.push('\t"context"');
  }
  lines.push('\t"encoding/json"');
  if (needsFmt) {
    lines.push('\t"fmt"');
  }
  if (needsMath) {
    lines.push('\t"math"');
  }
  if (needsSort) {
    lines.push('\t"sort"');
  }
  lines.push("");
  lines.push('\t"gopkg.in/yaml.v3"');
  lines.push(")");
  lines.push("");
}

function emitProtocolHeader(lines: string[], packageName: string, group: string = "", needsContext: boolean = false): void {
  lines.push("// Code generated by Typra emitter; DO NOT EDIT.");
  if (group) {
    lines.push(`// Group: ${group}`);
  }
  lines.push("");
  lines.push(`package ${packageName}`);
  lines.push("");
  if (needsContext) {
    lines.push('import "context"');
    lines.push("");
  }
}

/**
 * Emit a Go enum type (type alias + const block).
 */
function emitGoEnum(enumDef: EnumDef, lines: string[]): void {
  lines.push(`// ${enumDef.name} represents the allowed values for ${enumDef.name}.`);
  lines.push(`type ${enumDef.name} string`);
  lines.push("");
  lines.push("const (");
  for (const value of enumDef.values) {
    const constName = `${enumDef.name}${toPascalCase(value)}`;
    lines.push(`\t${constName} ${enumDef.name} = "${value}"`);
  }
  lines.push(")");
  lines.push("");
  if (hasParseAliases(enumDef)) {
    if (enumDef.isOpen) {
      lines.push(`func Parse${enumDef.name}(value string) ${enumDef.name} {`);
    } else {
      lines.push(`func Parse${enumDef.name}(value string) (${enumDef.name}, error) {`);
    }
    lines.push("\tswitch value {");
    for (const value of enumDef.values) {
      lines.push(`\tcase ${JSON.stringify(value)}:`);
      lines.push(`\t\treturn ${enumDef.name}${toPascalCase(value)}${enumDef.isOpen ? "" : ", nil"}`);
    }
    for (const [canonical, aliases] of Object.entries(enumDef.parseAliases)) {
      for (const alias of aliases) {
        lines.push(`\tcase ${JSON.stringify(alias)}:`);
      }
      lines.push(`\t\treturn ${enumDef.name}${toPascalCase(canonical)}${enumDef.isOpen ? "" : ", nil"}`);
    }
    lines.push("\tdefault:");
    if (enumDef.isOpen) {
      lines.push(`\t\treturn ${enumDef.name}(value)`);
    } else {
      lines.push(`\t\treturn "", fmt.Errorf("invalid ${enumDef.name} value: %s", value)`);
    }
    lines.push("\t}");
    lines.push("}");
    lines.push("");
  }
}

function hasParseAliases(enumDef: EnumDef): boolean {
  return Object.values(enumDef.parseAliases).some(aliases => aliases.length > 0);
}

// ============================================================================
// Type block — one complete type definition
// ============================================================================

function emitTypeBlock(
  type: TypeDecl,
  lines: string[],
  visitor: ExprVisitor,
  polymorphicTypeNames: Set<string>,
  scalarCoercibleTypeNames: Set<string>,
): void {
  const typeName = type.typeName.name;
  const hasCoercions = type.load.coercions.length > 0;
  const fieldNames = buildGoFieldNames(type.fields.map(field => field.name));

  // Protocol types → emit as Go interface
  if (type.isProtocol) {
    emitProtocolInterface(type, lines);
    return;
  }

  const isPolymorphicBase = type.polymorphicDispatch !== null;

  // Description comment
  emitDescriptionComment(typeName, type.description, lines);

  // Struct definition
  emitStruct(type, lines, polymorphicTypeNames, fieldNames);
  if (type.polymorphicDispatch?.defaultVariant?.isSelfReference) {
    emitRawCloneHelper(typeName, lines);
  }

  // Load function
  emitLoadFunction(type, lines, polymorphicTypeNames, scalarCoercibleTypeNames, fieldNames);

  // Save method
  emitSaveMethod(type, lines, polymorphicTypeNames, fieldNames);

  // ToWire method (only when wire mappings exist)
  if (type.wire) {
    emitToWireMethod(type, lines);
  }

  // ToJSON method
  emitToJSON(typeName, lines);

  // ToYAML method
  emitToYAML(typeName, lines);

  // FromJSON function
  emitFromJSON(typeName, isPolymorphicBase, hasCoercions, lines);

  // FromYAML function
  emitFromYAML(typeName, isPolymorphicBase, hasCoercions, lines);

  // Factory functions
  if (type.factories.length > 0) {
    for (const factory of type.factories) {
      emitFactoryFunction(typeName, factory, visitor, lines);
    }
  }

  // Method stubs
  if (type.methods.length > 0) {
    emitMethodStubs(typeName, type.methods, lines);
  }
}

// ============================================================================
// Description comment
// ============================================================================

function emitDescriptionComment(typeName: string, description: string, lines: string[]): void {
  if (!description) {
    lines.push(`// ${typeName} represents a schema type`);
    return;
  }

  const descLines = description.split(/\r?\n/);
  const firstLine = descLines[0];
  lines.push(`// ${typeName} represents ${firstLine}`);

  for (let i = 1; i < descLines.length; i++) {
    const line = descLines[i];
    if (line.trim() === "") {
      lines.push("//");
    } else {
      lines.push(`// ${line}`);
    }
  }

  // Blank line after description (unless it's "a schema type")
  if (description !== "a schema type") {
    lines.push("");
  }
}

function emitRawCloneHelper(typeName: string, lines: string[]): void {
  lines.push(`func clone${typeName}RawValue(value interface{}) interface{} {`);
  lines.push("\tswitch value := value.(type) {");
  lines.push("\tcase map[string]interface{}:");
  lines.push("\t\tresult := make(map[string]interface{}, len(value))");
  lines.push("\t\tfor key, item := range value {");
  lines.push(`\t\t\tresult[key] = clone${typeName}RawValue(item)`);
  lines.push("\t\t}");
  lines.push("\t\treturn result");
  lines.push("\tcase []interface{}:");
  lines.push("\t\tresult := make([]interface{}, len(value))");
  lines.push("\t\tfor index, item := range value {");
  lines.push(`\t\t\tresult[index] = clone${typeName}RawValue(item)`);
  lines.push("\t\t}");
  lines.push("\t\treturn result");
  lines.push("\tdefault:");
  lines.push("\t\treturn value");
  lines.push("\t}");
  lines.push("}");
  lines.push("");
}

// ============================================================================
// Struct definition
// ============================================================================

function emitStruct(
  type: TypeDecl,
  lines: string[],
  polymorphicTypeNames: Set<string>,
  fieldNames: ReadonlyMap<string, string>,
): void {
  const typeName = type.typeName.name;
  lines.push(`type ${typeName} struct {`);

  for (const field of type.fields) {
    const goType = getGoFieldType(field.category, field.isOptional, polymorphicTypeNames, field.enumName);
    const fieldName = fieldNames.get(field.name) ?? goFieldName(field.name);
    const tag = getStructTag(field.name, field.isOptional, field.hasExplicitDefault);
    lines.push(`\t${fieldName} ${goType} ${tag}`);
  }
  if (type.polymorphicDispatch?.defaultVariant?.isSelfReference) {
    lines.push("\traw map[string]interface{}");
  }

  lines.push("}");
  lines.push("");
}

// ============================================================================
// Load function
// ============================================================================

function emitLoadFunction(
  type: TypeDecl,
  lines: string[],
  polymorphicTypeNames: Set<string>,
  scalarCoercibleTypeNames: Set<string>,
  fieldNames: ReadonlyMap<string, string>,
): void {
  const typeName = type.typeName.name;
  const isPolymorphicBase = type.polymorphicDispatch !== null;
  const hasTerminalDispatch = type.polymorphicDispatch !== null
    && (isClosedPolymorphicDispatch(type.polymorphicDispatch) || type.polymorphicDispatch.isAbstract)
    && !type.polymorphicDispatch.defaultVariant;
  const hasCoercions = type.load.coercions.length > 0;
  const returnType = isPolymorphicBase ? "interface{}" : typeName;

  // Comment
  lines.push(`// Load${typeName} creates a ${typeName} from a map[string]interface{}`);
  if (isPolymorphicBase) {
    lines.push("// Returns interface{} because this is a polymorphic base type that can resolve to different child types");
  }

  // Signature
  lines.push(`func Load${typeName}(data interface{}, ctx *LoadContext) (${returnType}, error) {`);
  lines.push("\tif ctx == nil {");
  lines.push("\t\tctx = NewLoadContext()");
  lines.push("\t}");
  if (!hasTerminalDispatch) {
    const explicitCollectionDefaults = type.fields.filter(field =>
      field.hasExplicitDefault &&
      (field.category.kind === "collection_scalar" || field.category.kind === "collection_complex")
    );
    if (explicitCollectionDefaults.length === 0) {
      lines.push(`\tresult := ${typeName}{}`);
    } else {
      lines.push(`\tresult := ${typeName}{`);
      for (const field of explicitCollectionDefaults) {
        lines.push(`\t\t${goFieldName(field.name)}: ${getGoFieldType(field.category, field.isOptional, polymorphicTypeNames, field.enumName)}{},`);
      }
      lines.push("\t}");
    }
    lines.push("");
  }

  // 1. Coercions
  if (hasCoercions) {
    emitCoercions(type.load.coercions, typeName, lines);
  }

  // 2. Polymorphic dispatch
  if (type.polymorphicDispatch) {
    emitPolymorphicDispatch(typeName, type.polymorphicDispatch, lines);
    if (hasTerminalDispatch) {
      lines.push("}");
      lines.push("");
      return;
    }
  }

  // 3. Map loading
  lines.push("\t// Load from map");
  lines.push("\tif m, ok := data.(map[string]interface{}); ok {");

  for (const assign of type.load.assignments) {
    const field = type.fields.find(candidate => candidate.name === assign.fieldName);
    if (field?.category.kind !== "complex" || field.isOptional || field.hasExplicitDefault) continue;
    const wildcardDiscriminator = type.fields.find(candidate => candidate.defaultValue === "*")?.name;
    if (wildcardDiscriminator) {
      lines.push(`\t\tif discriminatorValue, hasDiscriminator := m["${wildcardDiscriminator}"].(string); hasDiscriminator && discriminatorValue != "" {`);
    }
    const indent = wildcardDiscriminator ? "\t\t\t" : "\t\t";
    lines.push(`${indent}if requiredValue, exists := m["${assign.sourceName}"]; !exists || requiredValue == nil {`);
    lines.push(`${indent}\treturn result, fmt.Errorf("%s: missing required field", ctx.At("${assign.sourceName}").Path)`);
    lines.push(`${indent}}`);
    if (wildcardDiscriminator) {
      lines.push("\t\t}");
    }
  }

  for (const assign of type.load.assignments) {
    const helper = type.collectionHelpers.find(candidate => candidate.propertyName === assign.sourceName);
    emitLoadAssignment(assign, helper, polymorphicTypeNames, scalarCoercibleTypeNames, fieldNames, lines);
  }
  if (type.polymorphicDispatch?.defaultVariant?.isSelfReference) {
    lines.push("\t\tresult.raw = make(map[string]interface{}, len(m))");
    lines.push("\t\tfor key, value := range m {");
    lines.push(`\t\t\tresult.raw[key] = clone${typeName}RawValue(value)`);
    lines.push("\t\t}");
    for (const field of type.fields) {
      lines.push(`\t\tdelete(result.raw, "${field.name}")`);
    }
  }

  lines.push("\t}");
  lines.push("");
  lines.push("\treturn result, nil");
  lines.push("}");
  lines.push("");
}

// ============================================================================
// Polymorphic dispatch
// ============================================================================

function emitPolymorphicDispatch(typeName: string, dispatch: PolymorphicDispatchDecl, lines: string[]): void {
  const isClosed = isClosedPolymorphicDispatch(dispatch);
  lines.push("\t// Handle polymorphic types based on discriminator");
  lines.push("\tif m, ok := data.(map[string]interface{}); ok {");
  lines.push(`\t\tif discriminator, ok := m["${dispatch.discriminatorField}"]; ok {`);
  lines.push("\t\t\tswitch discriminator := discriminator.(type) {");
  lines.push("\t\t\tcase string:");
  lines.push("\t\t\t\tswitch discriminator {");

  for (const variant of dispatch.variants) {
    lines.push(`\t\t\t\tcase "${variant.value}":`);
    lines.push(`\t\t\t\t\treturn Load${variant.typeName.name}(data, ctx)`);
  }

  // Default variant
  if (dispatch.defaultVariant) {
    if (!dispatch.defaultVariant.isSelfReference) {
      lines.push("\t\t\t\tdefault:");
      lines.push(`\t\t\t\t\treturn Load${dispatch.defaultVariant.typeName.name}(data, ctx)`);
    }
  } else if (isClosed || dispatch.isAbstract) {
    lines.push("\t\t\t\tdefault:");
    lines.push(`\t\t\t\t\treturn nil, fmt.Errorf("unknown ${typeName} discriminator field '${dispatch.discriminatorField}' value: %s", discriminator)`);
  }

  lines.push("\t\t\t\t}");
  if ((isClosed || dispatch.isAbstract) && !dispatch.defaultVariant) {
    lines.push("\t\t\tdefault:");
    lines.push(`\t\t\t\treturn nil, fmt.Errorf("unknown ${typeName} discriminator field '${dispatch.discriminatorField}' value: %v", discriminator)`);
  } else if (dispatch.defaultVariant && !dispatch.defaultVariant.isSelfReference) {
    lines.push("\t\t\tdefault:");
    lines.push(`\t\t\t\treturn Load${dispatch.defaultVariant.typeName.name}(data, ctx)`);
  }
  lines.push("\t\t\t}");
  lines.push("\t\t}");
  lines.push("\t}");
  if ((isClosed || dispatch.isAbstract) && !dispatch.defaultVariant) {
    lines.push(`\treturn nil, fmt.Errorf("missing ${typeName} discriminator property: ${dispatch.discriminatorField}")`);
  }
}

// ============================================================================
// Coercions
// ============================================================================

function emitCoercions(coercions: CoercionDecl[], typeName: string, lines: string[]): void {
  lines.push("\t// Handle alternate scalar representations");
  lines.push("\tswitch v := data.(type) {");

  const emitted = new Set<string>();

  for (const coercion of coercions) {
    const goType = GO_TYPE_MAP[coercion.scalarType] || coercion.scalarType;
    emitted.add(goType);
    lines.push(`\tcase ${goType}:`);
    lines.push(`\t\t// Shorthand: ${goType} -> ${typeName}`);
    lines.push(`\t\texpansion := ${coercionExpansion(coercion)}`);
    lines.push(`\t\treturn Load${typeName}(expansion, ctx)`);
  }

  // Decoder-native numeric bridging.
  //
  // The declared scalar types above are the *schema's* nominal types, but a Go type switch
  // sees whatever the decoder produced: encoding/json yields float64 for every JSON number,
  // and gopkg.in/yaml.v3 yields int for integral YAML scalars. Without these cases an
  // `integer`/`float32` coercion never matches a decoded number and the value falls through
  // to the map branch, returning a zero-valued instance.
  const integral = coercions.find(c => INTEGRAL_SCALAR_TYPES.has(c.scalarType));
  const fractional = coercions.find(c => FRACTIONAL_SCALAR_TYPES.has(c.scalarType));

  if (integral || fractional) {
    if (!emitted.has("float64")) {
      lines.push("\tcase float64:");
      lines.push(`\t\t// Shorthand: JSON number -> ${typeName}`);
      if (integral && fractional) {
        // Preserve the author's intent: 4 is an integer, 3.14 is a float. Both arrive as
        // float64 from encoding/json, so discriminate on whether a fraction is present.
        lines.push("\t\tif v == math.Trunc(v) {");
        lines.push(`\t\t\texpansion := ${coercionExpansion(integral)}`);
        lines.push(`\t\t\treturn Load${typeName}(expansion, ctx)`);
        lines.push("\t\t}");
        lines.push(`\t\texpansion := ${coercionExpansion(fractional)}`);
        lines.push(`\t\treturn Load${typeName}(expansion, ctx)`);
      } else {
        lines.push(`\t\texpansion := ${coercionExpansion((integral ?? fractional)!)}`);
        lines.push(`\t\treturn Load${typeName}(expansion, ctx)`);
      }
    }
    if (!emitted.has("int")) {
      lines.push("\tcase int:");
      lines.push(`\t\t// Shorthand: YAML integer -> ${typeName}`);
      lines.push(`\t\texpansion := ${coercionExpansion((integral ?? fractional)!)}`);
      lines.push(`\t\treturn Load${typeName}(expansion, ctx)`);
    }
  }

  lines.push("\t}");
}

/** Render the `map[string]interface{}{...}` expansion literal for one coercion. */
function coercionExpansion(coercion: CoercionDecl): string {
  const entries: string[] = [];
  for (const assign of coercion.assignments) {
    if (assign.isInput) {
      entries.push(`"${assign.fieldName}": v`);
    } else {
      entries.push(`"${assign.fieldName}": "${assign.literalValue}"`);
    }
  }
  return `map[string]interface{}{${entries.join(", ")}}`;
}

// ============================================================================
// Load assignment (per-property)
// ============================================================================

function emitLoadAssignment(
  assign: LoadAssignment,
  helper: CollectionHelperDecl | undefined,
  polymorphicTypeNames: Set<string>,
  scalarCoercibleTypeNames: Set<string>,
  fieldNames: ReadonlyMap<string, string>,
  lines: string[],
): void {
  const fieldName = fieldNames.get(assign.fieldName) ?? goFieldName(assign.fieldName);
  const cat = assign.category;

  switch (cat.kind) {
    case "scalar":
      emitLoadScalar(assign, fieldName, cat.scalarType, lines);
      break;
    case "complex":
      emitLoadComplex(assign, fieldName, cat.typeName, polymorphicTypeNames, scalarCoercibleTypeNames, lines);
      break;
    case "collection_scalar":
      emitLoadCollectionScalar(assign, fieldName, cat.scalarType, lines);
      break;
    case "collection_complex":
      emitLoadCollectionComplex(assign, helper, fieldName, cat.typeName, polymorphicTypeNames, lines);
      break;
    case "dict":
      emitLoadDict(assign, fieldName, lines);
      break;
  }
}

function emitLoadScalar(
  assign: LoadAssignment,
  fieldName: string,
  scalarType: string,
  lines: string[],
): void {
  const goType = GO_TYPE_MAP[scalarType] || "interface{}";

  if (NUMERIC_GO_TYPES.has(goType)) {
    emitLoadNumeric(assign, fieldName, goType, lines);
    return;
  }

  if (goType === "interface{}") {
    // any/unknown type
    if (assign.isOptional) {
      lines.push(`\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`);
      lines.push(`\t\t\tresult.${fieldName} = &val`);
      lines.push("\t\t}");
    } else {
      lines.push(`\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`);
      lines.push(`\t\t\tresult.${fieldName} = val`);
      lines.push("\t\t}");
    }
    return;
  }

  if (goType === "bool") {
    if (assign.isOptional) {
      lines.push(`\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`);
      lines.push(`\t\t\tv := val.(bool)`);
      lines.push(`\t\t\tresult.${fieldName} = &v`);
      lines.push("\t\t}");
    } else {
      lines.push(`\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`);
      lines.push(`\t\t\tresult.${fieldName} = val.(bool)`);
      lines.push("\t\t}");
    }
    return;
  }

  // string (and others) — if the field is a named enum type, cast from string
  const castType = assign.enumName ?? goType;
  const useParser = assign.enumName && Object.keys(assign.parseAliases).length > 0;
  const parseExpr = useParser ? `Parse${assign.enumName}(val.(string))` : `${castType}(val.(string))`;
  if (assign.isOptional) {
    lines.push(`\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`);
    if (useParser && !assign.isOpenEnum) {
      lines.push(`\t\t\tv, err := ${parseExpr}`);
      lines.push("\t\t\tif err != nil {");
      lines.push("\t\t\t\treturn result, err");
      lines.push("\t\t\t}");
    } else {
      lines.push(`\t\t\tv := ${parseExpr}`);
    }
    lines.push(`\t\t\tresult.${fieldName} = &v`);
    lines.push("\t\t}");
  } else {
    lines.push(`\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`);
    if (useParser && !assign.isOpenEnum) {
      lines.push(`\t\t\tv, err := ${parseExpr}`);
      lines.push("\t\t\tif err != nil {");
      lines.push("\t\t\t\treturn result, err");
      lines.push("\t\t\t}");
      lines.push(`\t\t\tresult.${fieldName} = v`);
    } else {
      lines.push(`\t\t\tresult.${fieldName} = ${parseExpr}`);
    }
    lines.push("\t\t}");
  }
}

function emitLoadNumeric(
  assign: LoadAssignment,
  fieldName: string,
  goType: string,
  lines: string[],
): void {
  const isFloat = FLOAT_GO_TYPES.has(goType);

  // Build the coercion cases
  const cases: Array<{ caseType: string; expr: string }> = [];

  // int types: int, int32, int64, float64
  // float types: int, int32, int64, float32, float64
  cases.push({ caseType: "int", expr: `${goType}(n)` });
  cases.push({ caseType: "int32", expr: `${goType}(n)` });
  cases.push({ caseType: "int64", expr: `${goType}(n)` });

  if (isFloat) {
    // Identity case for float types uses direct assignment
    if (goType === "float32") {
      cases.push({ caseType: "float32", expr: "n" });
      cases.push({ caseType: "float64", expr: `${goType}(n)` });
    } else {
      // float64
      cases.push({ caseType: "float32", expr: `${goType}(n)` });
      cases.push({ caseType: "float64", expr: "n" });
    }
  } else {
    // int types don't include float32
    cases.push({ caseType: "float64", expr: `${goType}(n)` });
  }

  if (assign.isOptional) {
    lines.push(`\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil { // Handle various numeric types from JSON/YAML/roundtrip`);
    lines.push(`\t\t\tvar v ${goType}`);
    lines.push("\t\t\tswitch n := val.(type) {");
    for (const c of cases) {
      lines.push(`\t\t\tcase ${c.caseType}:`);
      lines.push(`\t\t\t\tv = ${c.expr}`);
    }
    lines.push("\t\t\t}");
    lines.push(`\t\t\tresult.${fieldName} = &v`);
    lines.push("\t\t}");
  } else {
    lines.push(`\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil { // Handle various numeric types from JSON/YAML/roundtrip`);
    lines.push(`\t\t\tvar v ${goType}`);
    lines.push("\t\t\tswitch n := val.(type) {");
    for (const c of cases) {
      lines.push(`\t\t\tcase ${c.caseType}:`);
      lines.push(`\t\t\t\tv = ${c.expr}`);
    }
    lines.push("\t\t\t}");
    lines.push(`\t\t\tresult.${fieldName} = v`);
    lines.push("\t\t}");
  }
}

function emitLoadComplex(
  assign: LoadAssignment,
  fieldName: string,
  typeName: string,
  polymorphicTypeNames: Set<string>,
  scalarCoercibleTypeNames: Set<string>,
  lines: string[],
): void {
  const isPolymorphic = polymorphicTypeNames.has(typeName);
  const acceptsScalarCoercion = scalarCoercibleTypeNames.has(typeName);

  lines.push(`\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`);
  lines.push(`\t\t\tif m, ok := val.(map[string]interface{}); ok {`);
  lines.push(`\t\t\t\tloaded, err := Load${typeName}(m, ctx.At("${assign.sourceName}"))`);
  lines.push("\t\t\t\tif err != nil {");
  lines.push("\t\t\t\t\treturn result, err");
  lines.push("\t\t\t\t}");

  if (isPolymorphic) {
    if (assign.isOptional) {
      lines.push(`\t\t\t\t// Polymorphic type - keep as interface{} (no pointer needed, interface{} can be nil)`);
    } else {
      lines.push(`\t\t\t\t// Polymorphic type - keep as interface{}`);
    }
    lines.push(`\t\t\t\tresult.${fieldName} = loaded`);
  } else {
    if (assign.isOptional) {
      lines.push(`\t\t\t\tresult.${fieldName} = &loaded`);
    } else {
      lines.push(`\t\t\t\tresult.${fieldName} = loaded`);
    }
  }

  if (acceptsScalarCoercion) {
    lines.push("\t\t\t} else {");
    lines.push(`\t\t\t\tloaded, err := Load${typeName}(val, ctx.At("${assign.sourceName}"))`);
    lines.push("\t\t\t\tif err != nil {");
    lines.push("\t\t\t\t\treturn result, err");
    lines.push("\t\t\t\t}");
    if (assign.isOptional && !isPolymorphic) {
      lines.push(`\t\t\t\tresult.${fieldName} = &loaded`);
    } else {
      lines.push(`\t\t\t\tresult.${fieldName} = loaded`);
    }
  }
  lines.push("\t\t\t}");
  lines.push("\t\t}");
}

function emitLoadCollectionScalar(
  assign: LoadAssignment,
  fieldName: string,
  scalarType: string,
  lines: string[],
): void {
  const goType = GO_TYPE_MAP[scalarType] || "interface{}";

  lines.push(`\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`);
  lines.push("\t\t\tswitch arr := val.(type) {");

  if (goType === "interface{}") {
    lines.push("\t\t\tcase []interface{}:");
    lines.push(`\t\t\t\tresult.${fieldName} = arr`);
  } else {
    lines.push("\t\t\tcase []interface{}:");
    lines.push(`\t\t\t\tresult.${fieldName} = make([]${goType}, len(arr))`);
    lines.push("\t\t\t\tfor i, v := range arr {");
    lines.push(`\t\t\t\t\tresult.${fieldName}[i] = v.(${goType})`);
    lines.push("\t\t\t\t}");
    lines.push(`\t\t\tcase []${goType}:`);
    lines.push(`\t\t\t\tresult.${fieldName} = arr`);
  }

  lines.push("\t\t\t}");
  lines.push("\t\t}");
}

function emitLoadCollectionComplex(
  assign: LoadAssignment,
  helper: CollectionHelperDecl | undefined,
  fieldName: string,
  typeName: string,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  const isPolymorphic = polymorphicTypeNames.has(typeName);
  const goElemType = isPolymorphic ? "interface{}" : typeName;

  lines.push(`\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`);
  if (helper?.hasNameProperty) {
    lines.push("\t\t\tif named, ok := val.(map[string]interface{}); ok {");
    lines.push("\t\t\t\tkeys := make([]string, 0, len(named))");
    lines.push("\t\t\t\tfor key := range named {");
    lines.push("\t\t\t\t\tkeys = append(keys, key)");
    lines.push("\t\t\t\t}");
    lines.push("\t\t\t\tsort.Strings(keys)");
    lines.push(`\t\t\t\tresult.${fieldName} = make([]${goElemType}, 0, len(keys))`);
    lines.push("\t\t\t\tfor _, key := range keys {");
    lines.push("\t\t\t\t\tentry := named[key]");
    lines.push("\t\t\t\t\tif _, invalid := entry.([]interface{}); invalid {");
    lines.push(`\t\t\t\t\t\treturn result, fmt.Errorf("%s: invalid named collection entry category array", ctx.At("${assign.sourceName}").At(key).Path)`);
    lines.push("\t\t\t\t\t}");
    lines.push("\t\t\t\t\titem, ok := entry.(map[string]interface{})");
    lines.push("\t\t\t\t\tif !ok {");
    lines.push("\t\t\t\t\t\titem = map[string]interface{}{}");
    lines.push(`\t\t\t\t\t\titem["${helper.coercionProperty ?? helper.innerFields[0] ?? "value"}"] = entry`);
    lines.push("\t\t\t\t\t} else {");
    lines.push("\t\t\t\t\t\tcopy := make(map[string]interface{}, len(item)+1)");
    lines.push("\t\t\t\t\t\tfor itemKey, itemValue := range item {");
    lines.push("\t\t\t\t\t\t\tcopy[itemKey] = itemValue");
    lines.push("\t\t\t\t\t\t}");
    lines.push("\t\t\t\t\t\titem = copy");
    lines.push("\t\t\t\t\t}");
    lines.push("\t\t\t\t\titem[\"name\"] = key");
    lines.push(`\t\t\t\t\tloaded, err := Load${typeName}(item, ctx.At("${assign.sourceName}").At(key))`);
    lines.push("\t\t\t\t\tif err != nil {");
    lines.push("\t\t\t\t\t\treturn result, err");
    lines.push("\t\t\t\t\t}");
    lines.push(`\t\t\t\t\tresult.${fieldName} = append(result.${fieldName}, loaded)`);
    lines.push("\t\t\t\t}");
    lines.push("\t\t\t} else if arr, ok := val.([]interface{}); ok {");
  } else {
    lines.push("\t\t\tif arr, ok := val.([]interface{}); ok {");
  }
  lines.push(`\t\t\t\tresult.${fieldName} = make([]${goElemType}, len(arr))`);
  lines.push("\t\t\t\tfor i, v := range arr {");
  lines.push("\t\t\t\t\tif item, ok := v.(map[string]interface{}); ok {");
  lines.push(`\t\t\t\t\t\tloaded, err := Load${typeName}(item, ctx.At("${assign.sourceName}"))`);
  lines.push("\t\t\t\t\t\tif err != nil {");
  lines.push("\t\t\t\t\t\t\treturn result, err");
  lines.push("\t\t\t\t\t\t}");

  if (isPolymorphic) {
    lines.push("\t\t\t\t\t\t// Polymorphic type - store as interface{}");
    lines.push(`\t\t\t\t\t\tresult.${fieldName}[i] = loaded`);
  } else {
    lines.push(`\t\t\t\t\t\tresult.${fieldName}[i] = loaded`);
  }

  lines.push("\t\t\t\t\t}");
  lines.push("\t\t\t\t}");
  lines.push("\t\t\t}");
  lines.push("\t\t}");
}

function emitLoadDict(
  assign: LoadAssignment,
  fieldName: string,
  lines: string[],
): void {
  lines.push(`\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`);
  lines.push("\t\t\tif m, ok := val.(map[string]interface{}); ok {");
  lines.push(`\t\t\t\tresult.${fieldName} = m`);
  lines.push("\t\t\t}");
  lines.push("\t\t}");
}

// ============================================================================
// Save method
// ============================================================================

function emitSaveMethod(
  type: TypeDecl,
  lines: string[],
  polymorphicTypeNames: Set<string>,
  fieldNames: ReadonlyMap<string, string>,
): void {
  const typeName = type.typeName.name;

  lines.push(`// Save serializes ${typeName} to map[string]interface{}`);
  lines.push(`func (obj ${typeName}) Save(ctx *SaveContext) map[string]interface{} {`);
  lines.push("\tresult := make(map[string]interface{})");
  if (type.polymorphicDispatch?.defaultVariant?.isSelfReference) {
    lines.push("\tfor key, value := range obj.raw {");
    lines.push(`\t\tresult[key] = clone${typeName}RawValue(value)`);
    lines.push("\t}");
  }

  for (const assign of type.save.assignments) {
    const helper = type.collectionHelpers.find(candidate => candidate.propertyName === assign.targetName);
    emitSaveAssignment(assign, helper, polymorphicTypeNames, fieldNames, lines);
  }

  lines.push("");
  lines.push("\treturn result");
  lines.push("}");
  lines.push("");
}

// ============================================================================
// Save assignment (per-property)
// ============================================================================

function emitSaveAssignment(
  assign: SaveAssignment,
  helper: CollectionHelperDecl | undefined,
  polymorphicTypeNames: Set<string>,
  fieldNames: ReadonlyMap<string, string>,
  lines: string[],
): void {
  const fieldName = fieldNames.get(assign.fieldName) ?? goFieldName(assign.fieldName);
  const cat = assign.category;

  switch (cat.kind) {
    case "scalar":
      emitSaveScalar(assign, fieldName, cat.scalarType, lines);
      break;
    case "complex":
      emitSaveComplex(assign, fieldName, cat.typeName, polymorphicTypeNames, lines);
      break;
    case "collection_scalar":
      emitSaveCollectionScalar(assign, fieldName, lines);
      break;
    case "collection_complex":
      emitSaveCollectionComplex(assign, helper, fieldName, cat.typeName, polymorphicTypeNames, lines);
      break;
    case "dict":
      emitSaveDict(assign, fieldName, lines);
      break;
  }
}

function emitSaveScalar(
  assign: SaveAssignment,
  fieldName: string,
  scalarType: string,
  lines: string[],
): void {
  const goType = GO_TYPE_MAP[scalarType] || "interface{}";

  // Named enum fields must be cast back to string so roundtrip Load can do val.(string)
  const saveExpr = assign.enumName ? `string(obj.${fieldName})` : `obj.${fieldName}`;
  const saveExprDeref = assign.enumName ? `string(*obj.${fieldName})` : `*obj.${fieldName}`;

  if (assign.isOptional) {
    lines.push(`\tif obj.${fieldName} != nil {`);
    lines.push(`\t\tresult["${assign.targetName}"] = ${saveExprDeref}`);
    lines.push("\t}");
  } else {
    lines.push(`\tresult["${assign.targetName}"] = ${saveExpr}`);
  }
}

function emitSaveComplex(
  assign: SaveAssignment,
  fieldName: string,
  typeName: string,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  const isPolymorphic = polymorphicTypeNames.has(typeName);

  if (isPolymorphic) {
    if (assign.isOptional) {
      // Optional polymorphic complex — double nil check pattern
      lines.push(`\tif obj.${fieldName} != nil {`);
      lines.push(`\t\t// Handle polymorphic type (stored as interface{} without pointer)`);
      lines.push(`\t\tif obj.${fieldName} != nil {`);
      lines.push(`\t\t\tswitch v := obj.${fieldName}.(type) {`);
      lines.push("\t\t\tcase interface {");
      lines.push("\t\t\t\tSave(*SaveContext) map[string]interface{}");
      lines.push("\t\t\t}:");
      lines.push(`\t\t\t\tresult["${assign.targetName}"] = v.Save(ctx)`);
      lines.push("\t\t\tdefault:");
      lines.push(`\t\t\t\tresult["${assign.targetName}"] = obj.${fieldName}`);
      lines.push("\t\t\t}");
      lines.push("\t\t}");
      lines.push("\t}");
    } else {
      // Required polymorphic complex — blank line before, type switch
      lines.push("");
      lines.push("\t// Handle polymorphic type via type switch");
      lines.push(`\tswitch v := obj.${fieldName}.(type) {`);
      lines.push("\tcase interface {");
      lines.push("\t\tSave(*SaveContext) map[string]interface{}");
      lines.push("\t}:");
      lines.push(`\t\tresult["${assign.targetName}"] = v.Save(ctx)`);
      lines.push("\tdefault:");
      lines.push(`\t\tresult["${assign.targetName}"] = obj.${fieldName}`);
      lines.push("\t}");
    }
  } else {
    if (assign.isOptional) {
      lines.push(`\tif obj.${fieldName} != nil {`);
      lines.push(`\t\tresult["${assign.targetName}"] = obj.${fieldName}.Save(ctx)`);
      lines.push("\t}");
    } else {
      // Required non-polymorphic complex — blank line before
      lines.push("");
      lines.push(`\tresult["${assign.targetName}"] = obj.${fieldName}.Save(ctx)`);
    }
  }
}

function emitSaveCollectionScalar(
  assign: SaveAssignment,
  fieldName: string,
  lines: string[],
): void {
  if (assign.isOptional) {
    lines.push(`\tif obj.${fieldName} != nil {`);
    lines.push(`\t\tresult["${assign.targetName}"] = obj.${fieldName}`);
    lines.push("\t}");
  } else {
    lines.push(`\tresult["${assign.targetName}"] = obj.${fieldName}`);
  }
}

function emitSaveCollectionComplex(
  assign: SaveAssignment,
  helper: CollectionHelperDecl | undefined,
  fieldName: string,
  typeName: string,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  const isPolymorphic = polymorphicTypeNames.has(typeName);

  lines.push(`\tif obj.${fieldName} != nil {`);

  lines.push(`\t\tarr := make([]interface{}, len(obj.${fieldName}))`);
  if (isPolymorphic) {
    lines.push(`\t\tfor i, item := range obj.${fieldName} {`);
    lines.push("\t\t\t// Handle polymorphic type via type switch");
    lines.push("\t\t\tswitch v := item.(type) {");
    lines.push("\t\t\tcase interface {");
    lines.push("\t\t\t\tSave(*SaveContext) map[string]interface{}");
    lines.push("\t\t\t}:");
    lines.push("\t\t\t\tarr[i] = v.Save(ctx)");
    lines.push("\t\t\tdefault:");
    lines.push("\t\t\t\tarr[i] = item");
    lines.push("\t\t\t}");
    lines.push("\t\t}");
  } else {
    lines.push(`\t\tfor i, item := range obj.${fieldName} {`);
    lines.push("\t\t\tarr[i] = item.Save(ctx)");
    lines.push("\t\t}");
  }

  if (helper?.hasNameProperty) {
    lines.push("\t\tseenNames := make(map[string]struct{}, len(arr))");
    lines.push("\t\tobjectItems := make(map[string]interface{}, len(arr))");
    lines.push("\t\tlosslessObject := true");
    lines.push("\t\tfor i, serialized := range arr {");
    lines.push("\t\t\titem, ok := serialized.(map[string]interface{})");
    lines.push("\t\t\tif !ok {");
    lines.push("\t\t\t\tlosslessObject = false");
    lines.push("\t\t\t\tcontinue");
    lines.push("\t\t\t}");
    lines.push("\t\t\tcopy := make(map[string]interface{}, len(item))");
    lines.push("\t\t\tfor key, value := range item {");
    lines.push("\t\t\t\tcopy[key] = value");
    lines.push("\t\t\t}");
    lines.push("\t\t\tname, hasName := copy[\"name\"].(string)");
    lines.push("\t\t\tif hasName && name == \"\" {");
    lines.push("\t\t\t\tdelete(copy, \"name\")");
    lines.push("\t\t\t\tarr[i] = copy");
    lines.push("\t\t\t\thasName = false");
    lines.push("\t\t\t}");
    lines.push("\t\t\tif !hasName || name == \"\" {");
    lines.push("\t\t\t\tlosslessObject = false");
    lines.push("\t\t\t\tcontinue");
    lines.push("\t\t\t}");
    lines.push("\t\t\tif _, duplicate := seenNames[name]; duplicate {");
    lines.push("\t\t\t\tlosslessObject = false");
    lines.push("\t\t\t\tcontinue");
    lines.push("\t\t\t}");
    lines.push("\t\t\tseenNames[name] = struct{}{}");
    lines.push("\t\t\tdelete(copy, \"name\")");
    if (helper.coercionProperty) {
      lines.push(`\t\t\tif (ctx == nil || ctx.UseShorthand) && len(copy) == 1 {`);
      lines.push(`\t\t\t\tif shorthand, ok := copy["${helper.coercionProperty}"]; ok {`);
      lines.push("\t\t\t\t\tobjectItems[name] = shorthand");
      lines.push("\t\t\t\t\tcontinue");
      lines.push("\t\t\t\t}");
      lines.push("\t\t\t}");
    }
    lines.push("\t\t\tobjectItems[name] = copy");
    lines.push("\t\t}");
    lines.push("\t\tif losslessObject && (ctx == nil || ctx.CollectionFormat != CollectionFormatArray) {");
    lines.push(`\t\t\tresult["${assign.targetName}"] = objectItems`);
    lines.push("\t\t} else {");
    lines.push(`\t\t\tresult["${assign.targetName}"] = arr`);
    lines.push("\t\t}");
  } else {
    lines.push(`\t\tresult["${assign.targetName}"] = arr`);
  }

  lines.push("\t}");
}

function emitSaveDict(
  assign: SaveAssignment,
  fieldName: string,
  lines: string[],
): void {
  if (assign.isOptional) {
    lines.push(`\tif obj.${fieldName} != nil {`);
    lines.push(`\t\tresult["${assign.targetName}"] = obj.${fieldName}`);
    lines.push("\t}");
  } else {
    lines.push(`\tresult["${assign.targetName}"] = obj.${fieldName}`);
  }
}

// ============================================================================
// ToWire method (provider-specific wire format)
// ============================================================================

function emitToWireMethod(type: TypeDecl, lines: string[]): void {
  const typeName = type.typeName.name;
  const wire = type.wire as WireDecl;

  lines.push(`// ToWire converts to provider-specific wire format.`);
  lines.push(`func (obj *${typeName}) ToWire(provider string) map[string]interface{} {`);
  lines.push(`\tdata := obj.Save(nil)`);
  lines.push(`\tresult := make(map[string]interface{})`);
  lines.push(`\twireMap := map[string]map[string]string{`);

  for (const mapping of wire.mappings) {
    const entries = Object.entries(mapping.wireNames)
      .map(([provider, wireName]) => `"${provider}": "${wireName}"`)
      .join(", ");
    lines.push(`\t\t"${mapping.fieldName}": {${entries}},`);
  }

  lines.push(`\t}`);
  lines.push(`\tfor key, value := range data {`);
  lines.push(`\t\tif mapping, ok := wireMap[key]; ok {`);
  lines.push(`\t\t\tif wireName, ok := mapping[provider]; ok {`);
  lines.push(`\t\t\t\tresult[wireName] = value`);
  lines.push(`\t\t\t}`);
  lines.push(`\t\t}`);
  lines.push(`\t}`);
  lines.push(`\treturn result`);
  lines.push(`}`);
  lines.push(``);
}

// ============================================================================
// ToJSON / ToYAML methods
// ============================================================================

function emitToJSON(typeName: string, lines: string[]): void {
  lines.push(`// ToJSON serializes ${typeName} to JSON string`);
  lines.push(`func (obj *${typeName}) ToJSON() (string, error) {`);
  lines.push("\tctx := NewSaveContext()");
  lines.push("\tdata := obj.Save(ctx)");
  lines.push("\tbytes, err := json.Marshal(data)");
  lines.push("\tif err != nil {");
  lines.push('\t\treturn "", err');
  lines.push("\t}");
  lines.push("\treturn string(bytes), nil");
  lines.push("}");
  lines.push("");
}

function emitToYAML(typeName: string, lines: string[]): void {
  lines.push(`// ToYAML serializes ${typeName} to YAML string`);
  lines.push(`func (obj *${typeName}) ToYAML() (string, error) {`);
  lines.push("\tctx := NewSaveContext()");
  lines.push("\tdata := obj.Save(ctx)");
  lines.push("\treturn marshalYAMLDocument(data)");
  lines.push("}");
  lines.push("");
}

// ============================================================================
// FromJSON / FromYAML functions
// ============================================================================

function emitFromJSON(typeName: string, isPolymorphic: boolean, hasCoercions: boolean, lines: string[]): void {
  lines.push(`// FromJSON creates ${typeName} from JSON string`);
  if (isPolymorphic) {
    lines.push("// Returns interface{} because this is a polymorphic base type that can resolve to different child types");
  }

  const returnType = isPolymorphic ? "interface{}" : typeName;
  const errorReturn = isPolymorphic ? "nil" : `${typeName}{}`;

  lines.push(`func ${typeName}FromJSON(jsonStr string) (${returnType}, error) {`);
  lines.push(hasCoercions ? "\tvar data interface{}" : "\tvar data map[string]interface{}");
  lines.push("\tif err := json.Unmarshal([]byte(jsonStr), &data); err != nil {");
  lines.push(`\t\treturn ${errorReturn}, err`);
  lines.push("\t}");
  lines.push("\tctx := NewLoadContext()");
  lines.push(`\treturn Load${typeName}(data, ctx)`);
  lines.push("}");
  lines.push("");
}

function emitFromYAML(typeName: string, isPolymorphic: boolean, hasCoercions: boolean, lines: string[]): void {
  lines.push(`// FromYAML creates ${typeName} from YAML string`);
  if (isPolymorphic) {
    lines.push("// Returns interface{} because this is a polymorphic base type that can resolve to different child types");
  }

  const returnType = isPolymorphic ? "interface{}" : typeName;
  const errorReturn = isPolymorphic ? "nil" : `${typeName}{}`;

  lines.push(`func ${typeName}FromYAML(yamlStr string) (${returnType}, error) {`);
  lines.push(hasCoercions ? "\tvar data interface{}" : "\tvar data map[string]interface{}");
  lines.push("\tif err := yaml.Unmarshal([]byte(yamlStr), &data); err != nil {");
  lines.push(`\t\treturn ${errorReturn}, err`);
  lines.push("\t}");
  lines.push("\tctx := NewLoadContext()");
  lines.push(`\treturn Load${typeName}(data, ctx)`);
  lines.push("}");
  lines.push("");
}

// ============================================================================
// Type helpers
// ============================================================================

function getGoFieldType(
  category: PropertyCategory,
  isOptional: boolean,
  polymorphicTypeNames: Set<string>,
  enumName?: string | null,
): string {
  // Named enum — use enum type alias
  if (enumName) {
    return isOptional ? `*${enumName}` : enumName;
  }
  switch (category.kind) {
    case "scalar": {
      const goType = GO_TYPE_MAP[category.scalarType] || "interface{}";
      if (goType === "interface{}") {
        return isOptional ? "*interface{}" : "interface{}";
      }
      return isOptional ? `*${goType}` : goType;
    }
    case "complex": {
      const isPolymorphic = polymorphicTypeNames.has(category.typeName);
      if (isPolymorphic) {
        // Polymorphic complex: always interface{} (no pointer even for optional)
        return "interface{}";
      }
      return isOptional ? `*${category.typeName}` : category.typeName;
    }
    case "collection_scalar": {
      const goType = GO_TYPE_MAP[category.scalarType] || "interface{}";
      return `[]${goType}`;
    }
    case "collection_complex": {
      const isPolymorphic = polymorphicTypeNames.has(category.typeName);
      if (isPolymorphic) {
        return "[]interface{}";
      }
      return `[]${category.typeName}`;
    }
    case "dict":
      return "map[string]interface{}";
  }
}

function getStructTag(fieldName: string, isOptional: boolean, hasExplicitDefault = false): string {
  const omitEmpty = isOptional && !hasExplicitDefault;
  const jsonTag = omitEmpty ? `${fieldName},omitempty` : fieldName;
  const yamlTag = omitEmpty ? `${fieldName},omitempty` : fieldName;
  return `\`json:"${jsonTag}" yaml:"${yamlTag}"\``;
}

// ============================================================================
// Factory functions
// ============================================================================

/** Emit a package-level factory function that creates a pre-populated struct. */
function emitFactoryFunction(
  typeName: string,
  factory: FactoryDecl,
  visitor: ExprVisitor,
  lines: string[],
): void {
  const funcName = getGoFactoryName(factory.name, typeName);
  const params = Object.entries(factory.params)
    .map(([pName, pType]) => `${pName} ${goFactoryParamType(pType)}`)
    .join(", ");

  lines.push(`// ${funcName} creates a ${typeName} with preset field values.`);
  lines.push(`func ${funcName}(${params}) ${typeName} {`);
  lines.push(`\treturn ${visitor.visitExpr(factory.body)}`);
  lines.push("}");
  lines.push("");
}

/** Map factory name to an exported Go function name, prefixed with the type for disambiguation. */
function getGoFactoryName(factoryName: string, typeName: string): string {
  // Go factories are package-level functions, so prefix with type name to avoid collisions.
  // e.g., Message.user → NewUserMessage, GuardrailResult.allow → NewAllowGuardrailResult
  const capitalizedFactory = factoryName.charAt(0).toUpperCase() + factoryName.slice(1);
  return `New${capitalizedFactory}${typeName}`;
}

/** Map IR type strings to Go parameter types. */
function goFactoryParamType(typeStr: string): string {
  switch (typeStr) {
    case "string":
      return "string";
    case "boolean":
      return "bool";
    case "int32":
      return "int32";
    case "int64":
    case "integer":
      return "int64";
    case "float32":
      return "float32";
    case "float64":
    case "float":
      return "float64";
    case "unknown":
    case "any":
      return "interface{}";
    default:
      return typeStr;
  }
}

// ============================================================================
// Method stubs
// ============================================================================

/** Emit Go interface + comment stubs for @method-decorated helpers. */
function emitMethodStubs(typeName: string, methods: MethodStubDecl[], lines: string[]): void {
  // Emit an interface that the user implements in a separate file.
  const interfaceName = `${typeName}Helpers`;
  lines.push(`// ${interfaceName} defines helper methods for ${typeName}.`);
  lines.push(`// Implement these in a separate file (e.g., ${typeName.toLowerCase()}_helpers.go).`);
  lines.push(`type ${interfaceName} interface {`);
  for (const method of methods) {
    if (method.description) {
      lines.push(`\t// ${toPascalCase(method.name)} — ${method.description}`);
    }
    const params = Object.entries(method.params)
      .map(([pName, pType]) => `${pName} ${protocolGoType(pType)}`);
    if (method.runtimeCancellable) {
      params.unshift("ctx context.Context");
    }
    const ret = goMethodReturnType(method.returns);
    lines.push(`\t${toPascalCase(method.name)}(${params.join(", ")})${ret ? ` ${ret}` : ""}`);
  }
  lines.push("}");
  lines.push("");
}

function goMethodReturnType(returns: string): string {
  if (returns === "void") return "";
  return GO_TYPE_MAP[returns] || returns;
}

// ============================================================================
// Protocol interface emission
// ============================================================================

/** Map a protocol type string to a Go type. */
function protocolGoType(typeStr: string): string {
  // Handle nullable types
  if (typeStr.endsWith("?")) {
    const inner = typeStr.slice(0, -1);
    return `*${protocolGoType(inner)}`;
  }
  // Handle array types
  if (typeStr.endsWith("[]")) {
    const inner = typeStr.slice(0, -2);
    return `[]${protocolGoType(inner)}`;
  }
  if (typeStr === "Record<unknown>" || typeStr === "dictionary") return "map[string]interface{}";
  if (typeStr === "unknown" || typeStr === "any") return "interface{}";
  if (typeStr === "void") return "";
  return GO_TYPE_MAP[typeStr] || typeStr;
}

function goProtocolReturn(method: MethodStubDecl): string {
  const ret = protocolGoType(method.returns);
  if (method.sync && method.optional) {
    return ret ? ` ${ret}` : "";
  }
  if (method.sync) {
    return ret ? ` (${ret}, error)` : " error";
  }
  return ret ? ` (${ret}, error)` : " error";
}

/**
 * Emit a Go interface for a protocol type.
 */
function emitProtocolInterface(type: TypeDecl, lines: string[]): void {
  const name = type.typeName.name;

  if (type.description) {
    emitDescriptionComment(name, type.description, lines);
  }
  lines.push(`type ${name} interface {`);

  for (const method of type.methods) {
    if (method.description) {
      lines.push(`\t// ${toPascalCase(method.name)} — ${method.description}`);
    }
    const params = Object.entries(method.params)
      .map(([pName, pType]) => `${pName} ${protocolGoType(pType)}`)
    if (method.runtimeCancellable) {
      params.unshift("ctx context.Context");
    }
    lines.push(`\t${toPascalCase(method.name)}(${params.join(", ")})${goProtocolReturn(method)}`);
  }

  lines.push("}");
  lines.push("");
}
