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
  EntryShorthandAssignment,
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
  isIntegralScalar,
  isFractionalScalar,
  isStringEncodedScalar,
  isBooleanScalar,
  orderedEntryShorthandCases,
  entryShorthandTarget,
} from "../../ir/scalar-kinds.js";
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
const NUMERIC_GO_TYPES = new Set([
  "int",
  "int32",
  "int64",
  "float32",
  "float64",
]);

/** Float Go types get an identity case (v = n) in the type switch. */
const FLOAT_GO_TYPES = new Set(["float32", "float64"]);

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
  scalarCoercibleTypeNames: Set<string> = new Set(
    types
      .filter((t) => t.load.coercions.length > 0)
      .map((t) => t.typeName.name),
  ),
  declarationUniverse: TypeDecl[] = types,
): string {
  const lines: string[] = [];

  // Go has no inheritance: flatten transitive base fields into each child struct
  // so inherited (non-discriminator) fields are not dropped. All ancestors live in
  // Ancestors can live in another emitted file, so resolve them from the complete
  // declaration universe rather than assuming every hierarchy is co-located.
  types = flattenInheritance(types, declarationUniverse);

  // Protocol-only files have a simpler header (no JSON/YAML imports)
  const hasNonProtocol = types.some((t) => !t.isProtocol);
  const needsContext = types.some((type) =>
    type.methods.some((method) => method.runtimeCancellable),
  );
  const needsNamedCollections = types.some((type) =>
    type.collectionHelpers.some((helper) => helper.hasNameProperty),
  );
  const needsRequiredComplexValidation = types.some((type) =>
    type.fields.some((field) => shouldGuardMissingRequiredField(field)),
  );
  const needsFmt =
    enums.some((enumDef) => hasParseAliases(enumDef) && !enumDef.isOpen) ||
    types.some((type) => type.polymorphicDispatch) ||
    needsNamedCollections ||
    needsRequiredComplexValidation;
  // math.Trunc is only referenced when a type coerces from both a whole-number and a
  // fractional scalar, since that is the only case needing integral discrimination.
  //
  // The entry-shorthand arms that reference math.Trunc are emitted only for a name-keyed
  // collection (see emitLoadCollectionComplex), so this term has to carry the same
  // hasNameProperty guard. Without it a plain array of an element type that declares an
  // entry shorthand over both integral and fractional scalars requests the import while
  // emitting no use of it, and Go rejects the file for an unused import.
  const needsMath =
    types.some(
      (type) =>
        type.load.coercions.some((c) =>
          INTEGRAL_SCALAR_TYPES.has(c.scalarType),
        ) &&
        type.load.coercions.some((c) =>
          FRACTIONAL_SCALAR_TYPES.has(c.scalarType),
        ) &&
        !type.load.coercions.some(
          (c) => (GO_TYPE_MAP[c.scalarType] || c.scalarType) === "float64",
        ),
    ) ||
    types.some((type) =>
      type.collectionHelpers.some(
        (helper) => helper.hasNameProperty && entryShorthandNeedsMath(helper),
      ),
    );
  if (hasNonProtocol) {
    emitHeader(
      lines,
      packageName,
      group,
      needsFmt,
      needsContext,
      needsNamedCollections,
      needsMath,
    );
  } else {
    emitProtocolHeader(lines, packageName, group, needsContext);
  }

  // Emit enum type definitions
  for (const enumDef of enums) {
    emitGoEnum(enumDef, lines);
  }

  // Emit each type in the hierarchy
  for (const type of types) {
    emitTypeBlock(
      type,
      lines,
      visitor,
      polymorphicTypeNames,
      scalarCoercibleTypeNames,
    );
  }

  return emitCleanGoLines(lines);
}

function emitCleanGoLines(lines: string[], suffix = ""): string {
  return lines.map((line) => line.trimEnd()).join("\n") + suffix;
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

function emitProtocolHeader(
  lines: string[],
  packageName: string,
  group: string = "",
  needsContext: boolean = false,
): void {
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
  lines.push(
    `// ${enumDef.name} represents the allowed values for ${enumDef.name}.`,
  );
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
      lines.push(
        `func Parse${enumDef.name}(value string) (${enumDef.name}, error) {`,
      );
    }
    lines.push("\tswitch value {");
    for (const value of enumDef.values) {
      lines.push(`\tcase ${JSON.stringify(value)}:`);
      lines.push(
        `\t\treturn ${enumDef.name}${toPascalCase(value)}${enumDef.isOpen ? "" : ", nil"}`,
      );
    }
    for (const [canonical, aliases] of Object.entries(enumDef.parseAliases)) {
      for (const alias of aliases) {
        lines.push(`\tcase ${JSON.stringify(alias)}:`);
      }
      lines.push(
        `\t\treturn ${enumDef.name}${toPascalCase(canonical)}${enumDef.isOpen ? "" : ", nil"}`,
      );
    }
    lines.push("\tdefault:");
    if (enumDef.isOpen) {
      lines.push(`\t\treturn ${enumDef.name}(value)`);
    } else {
      lines.push(
        `\t\treturn "", fmt.Errorf("invalid ${enumDef.name} value: %s", value)`,
      );
    }
    lines.push("\t}");
    lines.push("}");
    lines.push("");
  }
}

function hasParseAliases(enumDef: EnumDef): boolean {
  return Object.values(enumDef.parseAliases).some(
    (aliases) => aliases.length > 0,
  );
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
  const fieldNames = buildGoFieldNames(type.fields.map((field) => field.name));

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
  if (absorbsUnknownIntoBase(type.polymorphicDispatch)) {
    emitRawCloneHelper(typeName, lines);
  }

  // Load function
  emitLoadFunction(
    type,
    lines,
    polymorphicTypeNames,
    scalarCoercibleTypeNames,
    fieldNames,
  );

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

function emitDescriptionComment(
  typeName: string,
  description: string,
  lines: string[],
): void {
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

/**
 * True when the base type itself is the lossless carrier for discriminator values that no
 * subtype claims, and therefore needs the `raw` passthrough map.
 *
 * Two shapes qualify. A non-abstract base declares itself as the wildcard variant, so the IR
 * hands back a self-referencing default. An abstract base never gets that default (see
 * `TypeNode.retrievePolymorphicTypes`), but when its discriminator is open the unknown values
 * still have to land somewhere -- and Go has no abstract construct, so the base struct is a
 * perfectly good carrier. Closed dispatches absorb nothing and get no `raw` field.
 */
function absorbsUnknownIntoBase(
  dispatch: PolymorphicDispatchDecl | null | undefined,
): boolean {
  if (!dispatch) {
    return false;
  }
  if (dispatch.defaultVariant) {
    return dispatch.defaultVariant.isSelfReference;
  }
  return !isClosedPolymorphicDispatch(dispatch);
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
    const goType = getGoFieldType(
      field.category,
      field.isOptional,
      polymorphicTypeNames,
      field.enumName,
    );
    const fieldName = fieldNames.get(field.name) ?? goFieldName(field.name);
    const tag = getStructTag(field.name, shouldPreserveOptionalAbsence(field));
    lines.push(`\t${fieldName} ${goType} ${tag}`);
  }
  if (absorbsUnknownIntoBase(type.polymorphicDispatch)) {
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
  // A closed discriminator has no value left to absorb, so an unrecognized one is
  // an error. `isAbstract` is a separate axis: an abstract base over an open
  // discriminator must still absorb the unknown kind rather than reject it.
  const hasTerminalDispatch =
    type.polymorphicDispatch !== null &&
    isClosedPolymorphicDispatch(type.polymorphicDispatch) &&
    !type.polymorphicDispatch.defaultVariant;
  const hasCoercions = type.load.coercions.length > 0;
  const returnType = isPolymorphicBase ? "interface{}" : typeName;

  // Comment
  lines.push(
    `// Load${typeName} creates a ${typeName} from a map[string]interface{}`,
  );
  if (isPolymorphicBase) {
    lines.push(
      "// Returns interface{} because this is a polymorphic base type that can resolve to different child types",
    );
  }

  // Signature
  lines.push(
    `func Load${typeName}(data interface{}, ctx *LoadContext) (${returnType}, error) {`,
  );

  // The body is assembled into a separate buffer so the `ctx == nil` guard can be
  // elided for leaf loaders that never touch `ctx`. Go's LoadContext has no
  // ProcessInput hook (unlike the other targets), so when the body neither threads
  // `ctx` into a nested load nor calls `ctx.At(...)` for a required-field path, the
  // `ctx = NewLoadContext()` assignment is a dead store that CodeQL flags
  // (go/useless-assignment-to-local). The `ctx *LoadContext` parameter is always
  // retained so the loader API stays uniform across every generated type.
  const body: string[] = [];

  if (!hasTerminalDispatch) {
    const explicitCollectionDefaults = type.fields.filter((field) =>
      shouldMaterializeCollectionDefault(field, "explicit-only"),
    );
    if (explicitCollectionDefaults.length === 0) {
      body.push(`\tresult := ${typeName}{}`);
    } else {
      body.push(`\tresult := ${typeName}{`);
      for (const field of explicitCollectionDefaults) {
        body.push(
          `\t\t${goFieldName(field.name)}: ${getGoFieldType(field.category, field.isOptional, polymorphicTypeNames, field.enumName)}{},`,
        );
      }
      body.push("\t}");
    }
    body.push("");
  }

  // 1. Coercions
  if (hasCoercions) {
    emitCoercions(type.load.coercions, typeName, body);
  }

  // 2. Polymorphic dispatch
  let terminated = false;
  if (type.polymorphicDispatch) {
    emitPolymorphicDispatch(typeName, type.polymorphicDispatch, body);
    if (hasTerminalDispatch) {
      terminated = true;
    }
  }

  if (!terminated) {
    // 3. Map loading
    body.push("\t// Load from map");
    body.push("\tif m, ok := data.(map[string]interface{}); ok {");

    for (const assign of type.load.assignments) {
      const field = type.fields.find(
        (candidate) => candidate.name === assign.fieldName,
      );
      if (!shouldGuardMissingRequiredField(field)) continue;
      body.push(
        `\t\tif requiredValue, exists := m["${assign.sourceName}"]; !exists || requiredValue == nil {`,
      );
      body.push(
        `\t\t\treturn result, fmt.Errorf("%s: missing required field", ctx.At("${assign.sourceName}").Path)`,
      );
      body.push("\t\t}");
    }

    for (const assign of type.load.assignments) {
      const helper = type.collectionHelpers.find(
        (candidate) => candidate.propertyName === assign.sourceName,
      );
      emitLoadAssignment(
        assign,
        helper,
        polymorphicTypeNames,
        scalarCoercibleTypeNames,
        fieldNames,
        body,
      );
    }
    if (absorbsUnknownIntoBase(type.polymorphicDispatch)) {
      body.push("\t\tresult.raw = make(map[string]interface{}, len(m))");
      body.push("\t\tfor key, value := range m {");
      body.push(`\t\t\tresult.raw[key] = clone${typeName}RawValue(value)`);
      body.push("\t\t}");
      for (const field of type.fields) {
        body.push(`\t\tdelete(result.raw, "${field.name}")`);
      }
    }

    body.push("\t}");
    body.push("");
    body.push("\treturn result, nil");
  }

  // Dead-store elimination: only emit the guard when the body actually reads `ctx`.
  if (body.some((line) => /\bctx\b/.test(line))) {
    lines.push("\tif ctx == nil {");
    lines.push("\t\tctx = NewLoadContext()");
    lines.push("\t}");
  }
  lines.push(...body);
  lines.push("}");
  lines.push("");
}

// ============================================================================
// Polymorphic dispatch
// ============================================================================

function emitPolymorphicDispatch(
  typeName: string,
  dispatch: PolymorphicDispatchDecl,
  lines: string[],
): void {
  const isClosed = isClosedPolymorphicDispatch(dispatch);
  lines.push("\t// Handle polymorphic types based on discriminator");
  lines.push("\tif m, ok := data.(map[string]interface{}); ok {");
  lines.push(
    `\t\tif discriminator, ok := m["${dispatch.discriminatorField}"]; ok {`,
  );
  lines.push("\t\t\tswitch discriminator := discriminator.(type) {");
  lines.push("\t\t\tcase string:");
  lines.push('\t\t\t\tif discriminator == "" {');
  lines.push(
    `\t\t\t\t\treturn nil, fmt.Errorf("invalid ${typeName} discriminator field '${dispatch.discriminatorField}': expected non-blank string")`,
  );
  lines.push("\t\t\t\t}");
  lines.push("\t\t\t\tswitch discriminator {");

  for (const variant of dispatch.variants) {
    lines.push(`\t\t\t\tcase "${variant.value}":`);
    lines.push(`\t\t\t\t\treturn Load${variant.typeName.name}(data, ctx)`);
  }

  // Default variant
  if (dispatch.defaultVariant) {
    if (!dispatch.defaultVariant.isSelfReference) {
      lines.push("\t\t\t\tdefault:");
      lines.push(
        `\t\t\t\t\treturn Load${dispatch.defaultVariant.typeName.name}(data, ctx)`,
      );
    }
  } else if (isClosed) {
    lines.push("\t\t\t\tdefault:");
    lines.push(
      `\t\t\t\t\treturn nil, fmt.Errorf("unknown ${typeName} discriminator field '${dispatch.discriminatorField}' value: %s", discriminator)`,
    );
  }

  lines.push("\t\t\t\t}");
  if (isClosed && !dispatch.defaultVariant) {
    lines.push("\t\t\tdefault:");
    lines.push(
      `\t\t\t\treturn nil, fmt.Errorf("unknown ${typeName} discriminator field '${dispatch.discriminatorField}' value: %v", discriminator)`,
    );
  } else {
    lines.push("\t\t\tdefault:");
    lines.push(
      `\t\t\t\treturn nil, fmt.Errorf("invalid ${typeName} discriminator field '${dispatch.discriminatorField}': expected non-blank string")`,
    );
  }
  lines.push("\t\t\t}");
  lines.push("\t\t} else {");
  lines.push(
    `\t\t\treturn nil, fmt.Errorf("missing ${typeName} discriminator property: ${dispatch.discriminatorField}")`,
  );
  lines.push("\t\t}");
  lines.push("\t}");
  if (isClosed && !dispatch.defaultVariant) {
    lines.push(
      `\treturn nil, fmt.Errorf("invalid ${typeName} discriminator property '${dispatch.discriminatorField}': expected non-blank string")`,
    );
  }
}

// ============================================================================
// Coercions
// ============================================================================

function emitCoercions(
  coercions: CoercionDecl[],
  typeName: string,
  lines: string[],
): void {
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
  const integral = coercions.find((c) =>
    INTEGRAL_SCALAR_TYPES.has(c.scalarType),
  );
  const fractional = coercions.find((c) =>
    FRACTIONAL_SCALAR_TYPES.has(c.scalarType),
  );

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
        lines.push(
          `\t\texpansion := ${coercionExpansion((integral ?? fractional)!)}`,
        );
        lines.push(`\t\treturn Load${typeName}(expansion, ctx)`);
      }
    }
    if (!emitted.has("int")) {
      lines.push("\tcase int:");
      lines.push(`\t\t// Shorthand: YAML integer -> ${typeName}`);
      lines.push(
        `\t\texpansion := ${coercionExpansion((integral ?? fractional)!)}`,
      );
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
  const fieldName =
    fieldNames.get(assign.fieldName) ?? goFieldName(assign.fieldName);
  const cat = assign.category;

  switch (cat.kind) {
    case "scalar":
      emitLoadScalar(assign, fieldName, cat.scalarType, lines);
      break;
    case "complex":
      emitLoadComplex(
        assign,
        fieldName,
        cat.typeName,
        polymorphicTypeNames,
        scalarCoercibleTypeNames,
        lines,
      );
      break;
    case "collection_scalar":
      emitLoadCollectionScalar(assign, fieldName, cat.scalarType, lines);
      break;
    case "collection_complex":
      emitLoadCollectionComplex(
        assign,
        helper,
        fieldName,
        cat.typeName,
        polymorphicTypeNames,
        lines,
      );
      break;
    case "dict":
      emitLoadDict(assign, fieldName, polymorphicTypeNames, lines);
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
      lines.push(
        `\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`,
      );
      lines.push(`\t\t\tresult.${fieldName} = &val`);
      lines.push("\t\t}");
    } else {
      lines.push(
        `\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`,
      );
      lines.push(`\t\t\tresult.${fieldName} = val`);
      lines.push("\t\t}");
    }
    return;
  }

  if (goType === "bool") {
    if (assign.isOptional) {
      lines.push(
        `\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`,
      );
      lines.push(`\t\t\tv := val.(bool)`);
      lines.push(`\t\t\tresult.${fieldName} = &v`);
      lines.push("\t\t}");
    } else {
      lines.push(
        `\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`,
      );
      lines.push(`\t\t\tresult.${fieldName} = val.(bool)`);
      lines.push("\t\t}");
    }
    return;
  }

  // string (and others) — if the field is a named enum type, cast from string
  const castType = assign.enumName ?? goType;
  const useParser =
    assign.enumName && Object.keys(assign.parseAliases).length > 0;
  const parseExpr = useParser
    ? `Parse${assign.enumName}(val.(string))`
    : `${castType}(val.(string))`;
  if (assign.isOptional) {
    lines.push(
      `\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`,
    );
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
    lines.push(
      `\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`,
    );
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
    lines.push(
      `\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil { // Handle various numeric types from JSON/YAML/roundtrip`,
    );
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
    lines.push(
      `\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil { // Handle various numeric types from JSON/YAML/roundtrip`,
    );
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
  lines.push(
    `\t\t\t\tloaded, err := Load${typeName}(m, ctx.At("${assign.sourceName}"))`,
  );
  lines.push("\t\t\t\tif err != nil {");
  lines.push("\t\t\t\t\treturn result, err");
  lines.push("\t\t\t\t}");

  if (isPolymorphic) {
    if (assign.isOptional) {
      lines.push(
        `\t\t\t\t// Polymorphic type - keep as interface{} (no pointer needed, interface{} can be nil)`,
      );
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
    lines.push(
      `\t\t\t\tloaded, err := Load${typeName}(val, ctx.At("${assign.sourceName}"))`,
    );
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
    lines.push(
      `\t\t\t\tresult.${fieldName} = make([]${goElemType}, 0, len(keys))`,
    );
    lines.push("\t\t\t\tfor _, key := range keys {");
    lines.push("\t\t\t\t\tentry := named[key]");
    lines.push("\t\t\t\t\tif _, invalid := entry.([]interface{}); invalid {");
    lines.push(
      `\t\t\t\t\t\treturn result, fmt.Errorf("%s: invalid named collection entry category array", ctx.At("${assign.sourceName}").At(key).Path)`,
    );
    lines.push("\t\t\t\t\t}");
    lines.push("\t\t\t\t\titem, ok := entry.(map[string]interface{})");
    lines.push("\t\t\t\t\tif !ok {");
    lines.push("\t\t\t\t\t\titem = map[string]interface{}{}");
    emitGoEntryShorthandArms(helper, lines);
    lines.push("\t\t\t\t\t} else {");
    lines.push("\t\t\t\t\t\tcopy := make(map[string]interface{}, len(item)+1)");
    lines.push("\t\t\t\t\t\tfor itemKey, itemValue := range item {");
    lines.push("\t\t\t\t\t\t\tcopy[itemKey] = itemValue");
    lines.push("\t\t\t\t\t\t}");
    lines.push("\t\t\t\t\t\titem = copy");
    lines.push("\t\t\t\t\t}");
    lines.push('\t\t\t\t\titem["name"] = key');
    lines.push(
      `\t\t\t\t\tloaded, err := Load${typeName}(item, ctx.At("${assign.sourceName}").At(key))`,
    );
    lines.push("\t\t\t\t\tif err != nil {");
    lines.push("\t\t\t\t\t\treturn result, err");
    lines.push("\t\t\t\t\t}");
    lines.push(
      `\t\t\t\t\tresult.${fieldName} = append(result.${fieldName}, loaded)`,
    );
    lines.push("\t\t\t\t}");
    lines.push("\t\t\t} else if arr, ok := val.([]interface{}); ok {");
  } else {
    lines.push("\t\t\tif arr, ok := val.([]interface{}); ok {");
  }
  lines.push(`\t\t\t\tresult.${fieldName} = make([]${goElemType}, len(arr))`);
  lines.push("\t\t\t\tfor i, v := range arr {");
  lines.push("\t\t\t\t\tif item, ok := v.(map[string]interface{}); ok {");
  lines.push(
    `\t\t\t\t\t\tloaded, err := Load${typeName}(item, ctx.At("${assign.sourceName}").AtIndex(i))`,
  );
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
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  const valueType =
    assign.category.kind === "dict" ? assign.category.valueType : undefined;
  lines.push(`\t\tif val, ok := m["${assign.sourceName}"]; ok && val != nil {`);
  if (!valueType || valueType === "unknown") {
    lines.push("\t\t\tif m, ok := val.(map[string]interface{}); ok {");
    lines.push(`\t\t\t\tresult.${fieldName} = m`);
    lines.push("\t\t\t}");
  } else {
    lines.push(
      `\t\t\tif items, ok := val.(${getGoDictFieldType(valueType, polymorphicTypeNames)}); ok {`,
    );
    lines.push(`\t\t\t\tresult.${fieldName} = items`);
    lines.push("\t\t\t} else if m, ok := val.(map[string]interface{}); ok {");
    lines.push(
      `\t\t\t\titems := make(${getGoDictFieldType(valueType, polymorphicTypeNames)}, len(m))`,
    );
    lines.push("\t\t\t\tfor key, item := range m {");
    emitGoDictValueLoad(
      valueType,
      "item",
      "loaded",
      `ctx.At("${assign.sourceName}").At(key)`,
      polymorphicTypeNames,
      lines,
    );
    lines.push("\t\t\t\t\titems[key] = loaded");
    lines.push("\t\t\t\t}");
    lines.push(`\t\t\t\tresult.${fieldName} = items`);
    lines.push("\t\t\t}");
  }
  lines.push("\t\t}");
}

function emitGoDictValueLoad(
  valueType: string,
  valueExpr: string,
  targetName: string,
  contextExpr: string,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  const goType = GO_TYPE_MAP[valueType];
  if (goType === "string") {
    lines.push(`\t\t\t\t\t${targetName} := ${valueExpr}.(string)`);
    return;
  }
  if (goType === "bool") {
    lines.push(`\t\t\t\t\t${targetName} := ${valueExpr}.(bool)`);
    return;
  }
  if (goType && NUMERIC_GO_TYPES.has(goType)) {
    lines.push(`\t\t\t\t\tvar ${targetName} ${goType}`);
    lines.push(`\t\t\t\t\tswitch n := ${valueExpr}.(type) {`);
    lines.push("\t\t\t\t\tcase int:");
    lines.push(`\t\t\t\t\t\t${targetName} = ${goType}(n)`);
    lines.push("\t\t\t\t\tcase int32:");
    lines.push(`\t\t\t\t\t\t${targetName} = ${goType}(n)`);
    lines.push("\t\t\t\t\tcase int64:");
    lines.push(`\t\t\t\t\t\t${targetName} = ${goType}(n)`);
    lines.push("\t\t\t\t\tcase float32:");
    lines.push(`\t\t\t\t\t\t${targetName} = ${goType}(n)`);
    lines.push("\t\t\t\t\tcase float64:");
    lines.push(`\t\t\t\t\t\t${targetName} = ${goType}(n)`);
    lines.push("\t\t\t\t\t}");
    return;
  }
  if (goType === "interface{}") {
    lines.push(`\t\t\t\t\t${targetName} := ${valueExpr}`);
    return;
  }
  lines.push(
    `\t\t\t\t\t${targetName}, err := Load${valueType}(${valueExpr}, ${contextExpr})`,
  );
  lines.push("\t\t\t\t\tif err != nil {");
  lines.push("\t\t\t\t\t\treturn result, err");
  lines.push("\t\t\t\t\t}");
  void polymorphicTypeNames;
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
  lines.push(
    `func (obj ${typeName}) Save(ctx *SaveContext) map[string]interface{} {`,
  );
  lines.push("\tresult := make(map[string]interface{})");
  if (absorbsUnknownIntoBase(type.polymorphicDispatch)) {
    lines.push("\tfor key, value := range obj.raw {");
    lines.push(`\t\tresult[key] = clone${typeName}RawValue(value)`);
    lines.push("\t}");
  }

  for (const assign of type.save.assignments) {
    const helper = type.collectionHelpers.find(
      (candidate) => candidate.propertyName === assign.targetName,
    );
    emitSaveAssignment(assign, helper, polymorphicTypeNames, fieldNames, lines);
  }

  lines.push("");
  lines.push("\treturn result");
  lines.push("}");
  lines.push("");
}

// ============================================================================
// Named-collection entry shorthand
// ============================================================================

/**
 * True when the emitted shorthand switch will reference `math.Trunc`.
 *
 * `encoding/json` decodes every JSON number into `float64`, so a type that can be
 * either integral or fractional has to reconstruct integrality from the value. A
 * type with only one numeric kind needs no discrimination and so no `math` import.
 */
function entryShorthandNeedsMath(helper: CollectionHelperDecl): boolean {
  const cases = helper.entryShorthand?.cases ?? [];
  return (
    cases.some((c) => isIntegralScalar(c.scalarType)) &&
    cases.some((c) => isFractionalScalar(c.scalarType))
  );
}

/**
 * Emit the immediate-scalar branch of a name-keyed collection entry.
 *
 * With `@entryShorthand` declared, each `@coerce` scalar type contributes a type
 * switch case that applies that coercion's constant assignments (typically the
 * discriminator) and routes the raw scalar to the declared value field. Without it,
 * this falls back to the historical single-field assignment.
 *
 * `float64` carries both JSON numeric kinds, so when the declaration admits both
 * integral and fractional scalars that case discriminates with `math.Trunc` — the
 * same bridge the direct-coercion path uses, and for the same decoder reason.
 * `math.Trunc` is preferred over `float64(int64(v))` because the latter is
 * undefined for magnitudes at or above 2^63.
 *
 * These arms are emitted only for a name-keyed collection, so `needsMath` in the
 * header decision must apply the same `hasNameProperty` guard. Keep the two in step:
 * requesting the import without emitting a use makes the generated file fail to build.
 */
function emitGoEntryShorthandArms(
  helper: CollectionHelperDecl,
  lines: string[],
): void {
  const shorthand = helper.entryShorthand;
  const indent = "\t\t\t\t\t\t";

  if (!shorthand || shorthand.cases.length === 0) {
    lines.push(`${indent}item["${entryShorthandTarget(helper)}"] = entry`);
    return;
  }

  const ordered = orderedEntryShorthandCases(shorthand.cases);
  const integral = ordered.find((c) => isIntegralScalar(c.scalarType));
  const fractional = ordered.find((c) => isFractionalScalar(c.scalarType));

  const assignConstants = (
    entryCase: { assignments: EntryShorthandAssignment[] },
    depth: string,
  ) => {
    for (const a of entryCase.assignments) {
      lines.push(
        `${depth}item["${a.fieldName}"] = ${goLiteral(a.literalValue)}`,
      );
    }
  };

  lines.push(`${indent}switch shorthandValue := entry.(type) {`);

  // yaml.v3 decodes whole numbers as int, so the integral case needs a native arm.
  if (integral) {
    lines.push(`${indent}case int, int32, int64:`);
    assignConstants(integral, `${indent}\t`);
    lines.push(`${indent}\titem["${shorthand.valueField}"] = shorthandValue`);
  }

  if (integral && fractional) {
    lines.push(`${indent}case float64:`);
    lines.push(`${indent}\tif shorthandValue == math.Trunc(shorthandValue) {`);
    assignConstants(integral, `${indent}\t\t`);
    lines.push(`${indent}\t} else {`);
    assignConstants(fractional, `${indent}\t\t`);
    lines.push(`${indent}\t}`);
    lines.push(`${indent}\titem["${shorthand.valueField}"] = shorthandValue`);
  } else if (fractional) {
    lines.push(`${indent}case float32, float64:`);
    assignConstants(fractional, `${indent}\t`);
    lines.push(`${indent}\titem["${shorthand.valueField}"] = shorthandValue`);
  }

  for (const entryCase of ordered) {
    if (
      isIntegralScalar(entryCase.scalarType) ||
      isFractionalScalar(entryCase.scalarType)
    )
      continue;
    const goCase = goScalarSwitchCase(entryCase.scalarType);
    if (!goCase) continue;
    lines.push(`${indent}case ${goCase}:`);
    assignConstants(entryCase, `${indent}\t`);
    lines.push(`${indent}\titem["${shorthand.valueField}"] = shorthandValue`);
  }

  lines.push(`${indent}default:`);
  lines.push(`${indent}\titem["${shorthand.valueField}"] = shorthandValue`);
  lines.push(`${indent}}`);
}

/** Go type-switch case matching a decoded value of the given non-numeric TypeSpec scalar. */
function goScalarSwitchCase(scalarType: string): string | null {
  if (isStringEncodedScalar(scalarType)) return "string";
  if (isBooleanScalar(scalarType)) return "bool";
  return null;
}

/**
 * Render a coercion constant as a Go literal, preserving its declared JSON type.
 *
 * The target is `map[string]interface{}`, so an untyped constant of any kind is
 * assignable. Stringifying everything here would retype a schema that expands
 * into a boolean or numeric constant.
 */
function goLiteral(value: string | number | boolean | null): string {
  if (value === null) return "nil";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
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
  const fieldName =
    fieldNames.get(assign.fieldName) ?? goFieldName(assign.fieldName);
  const cat = assign.category;

  switch (cat.kind) {
    case "scalar":
      emitSaveScalar(assign, fieldName, cat.scalarType, lines);
      break;
    case "complex":
      emitSaveComplex(
        assign,
        fieldName,
        cat.typeName,
        polymorphicTypeNames,
        lines,
      );
      break;
    case "collection_scalar":
      emitSaveCollectionScalar(assign, fieldName, lines);
      break;
    case "collection_complex":
      emitSaveCollectionComplex(
        assign,
        helper,
        fieldName,
        cat.typeName,
        polymorphicTypeNames,
        lines,
      );
      break;
    case "dict":
      emitSaveDict(assign, fieldName, polymorphicTypeNames, lines);
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
  const saveExpr = assign.enumName
    ? `string(obj.${fieldName})`
    : `obj.${fieldName}`;
  const saveExprDeref = assign.enumName
    ? `string(*obj.${fieldName})`
    : `*obj.${fieldName}`;

  if (shouldOmitAbsentOnSave(assign, "go")) {
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
    if (shouldOmitAbsentOnSave(assign, "go")) {
      // Optional polymorphic complex — double nil check pattern
      lines.push(`\tif obj.${fieldName} != nil {`);
      lines.push(
        `\t\t// Handle polymorphic type (stored as interface{} without pointer)`,
      );
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
    if (shouldOmitAbsentOnSave(assign, "go")) {
      lines.push(`\tif obj.${fieldName} != nil {`);
      lines.push(
        `\t\tresult["${assign.targetName}"] = obj.${fieldName}.Save(ctx)`,
      );
      lines.push("\t}");
    } else {
      // Required non-polymorphic complex — blank line before
      lines.push("");
      lines.push(
        `\tresult["${assign.targetName}"] = obj.${fieldName}.Save(ctx)`,
      );
    }
  }
}

function emitSaveCollectionScalar(
  assign: SaveAssignment,
  fieldName: string,
  lines: string[],
): void {
  if (shouldOmitAbsentOnSave(assign, "go")) {
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

  if (shouldOmitAbsentOnSave(assign, "go")) {
    lines.push(`\tif obj.${fieldName} != nil {`);
  }

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
    lines.push('\t\t\tname, hasName := copy["name"].(string)');
    lines.push('\t\t\tif hasName && name == "" {');
    lines.push('\t\t\t\tdelete(copy, "name")');
    lines.push("\t\t\t\tarr[i] = copy");
    lines.push("\t\t\t\thasName = false");
    lines.push("\t\t\t}");
    lines.push('\t\t\tif !hasName || name == "" {');
    lines.push("\t\t\t\tlosslessObject = false");
    lines.push("\t\t\t\tcontinue");
    lines.push("\t\t\t}");
    lines.push("\t\t\tif _, duplicate := seenNames[name]; duplicate {");
    lines.push("\t\t\t\tlosslessObject = false");
    lines.push("\t\t\t\tcontinue");
    lines.push("\t\t\t}");
    lines.push("\t\t\tseenNames[name] = struct{}{}");
    lines.push('\t\t\tdelete(copy, "name")');
    if (helper.coercionProperty) {
      lines.push(
        `\t\t\tif (ctx == nil || ctx.UseShorthand) && len(copy) == 1 {`,
      );
      lines.push(
        `\t\t\t\tif shorthand, ok := copy["${helper.coercionProperty}"]; ok {`,
      );
      lines.push("\t\t\t\t\tobjectItems[name] = shorthand");
      lines.push("\t\t\t\t\tcontinue");
      lines.push("\t\t\t\t}");
      lines.push("\t\t\t}");
    }
    lines.push("\t\t\tobjectItems[name] = copy");
    lines.push("\t\t}");
    lines.push(
      "\t\tif losslessObject && (ctx == nil || ctx.CollectionFormat != CollectionFormatArray) {",
    );
    lines.push(`\t\t\tresult["${assign.targetName}"] = objectItems`);
    lines.push("\t\t} else {");
    lines.push(`\t\t\tresult["${assign.targetName}"] = arr`);
    lines.push("\t\t}");
  } else {
    lines.push(`\t\tresult["${assign.targetName}"] = arr`);
  }

  if (shouldOmitAbsentOnSave(assign, "go")) {
    lines.push("\t}");
  }
}

function emitSaveDict(
  assign: SaveAssignment,
  fieldName: string,
  polymorphicTypeNames: Set<string>,
  lines: string[],
): void {
  const valueType =
    assign.category.kind === "dict" ? assign.category.valueType : undefined;
  const serializesComplexValues = Boolean(
    valueType && valueType !== "unknown" && !GO_TYPE_MAP[valueType],
  );
  if (shouldOmitAbsentOnSave(assign, "go")) {
    lines.push(`\tif obj.${fieldName} != nil {`);
    emitGoDictSaveResult(
      assign.targetName,
      `obj.${fieldName}`,
      serializesComplexValues,
      polymorphicTypeNames.has(valueType ?? ""),
      lines,
      "\t\t",
    );
    lines.push("\t}");
  } else {
    emitGoDictSaveResult(
      assign.targetName,
      `obj.${fieldName}`,
      serializesComplexValues,
      polymorphicTypeNames.has(valueType ?? ""),
      lines,
      "\t",
    );
  }
}

function emitGoDictSaveResult(
  targetName: string,
  sourceExpr: string,
  serializesComplexValues: boolean | undefined,
  valuesArePolymorphic: boolean,
  lines: string[],
  indent: string,
): void {
  if (!serializesComplexValues) {
    lines.push(`${indent}result["${targetName}"] = ${sourceExpr}`);
    return;
  }
  lines.push(
    `${indent}items := make(map[string]interface{}, len(${sourceExpr}))`,
  );
  lines.push(`${indent}for key, item := range ${sourceExpr} {`);
  if (valuesArePolymorphic) {
    lines.push(
      `${indent}\tif savable, ok := item.(interface{ Save(*SaveContext) map[string]interface{} }); ok {`,
    );
    lines.push(`${indent}\t\titems[key] = savable.Save(ctx)`);
    lines.push(`${indent}\t} else {`);
    lines.push(`${indent}\t\titems[key] = item`);
    lines.push(`${indent}\t}`);
  } else {
    lines.push(`${indent}\titems[key] = item.Save(ctx)`);
  }
  lines.push(`${indent}}`);
  lines.push(`${indent}result["${targetName}"] = items`);
}

// ============================================================================
// ToWire method (provider-specific wire format)
// ============================================================================

function emitToWireMethod(type: TypeDecl, lines: string[]): void {
  const typeName = type.typeName.name;
  const wire = type.wire as WireDecl;

  lines.push(`// ToWire converts to provider-specific wire format.`);
  lines.push(
    `func (obj *${typeName}) ToWire(provider string) map[string]interface{} {`,
  );
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

function emitFromJSON(
  typeName: string,
  isPolymorphic: boolean,
  hasCoercions: boolean,
  lines: string[],
): void {
  lines.push(`// FromJSON creates ${typeName} from JSON string`);
  if (isPolymorphic) {
    lines.push(
      "// Returns interface{} because this is a polymorphic base type that can resolve to different child types",
    );
  }

  const returnType = isPolymorphic ? "interface{}" : typeName;
  const errorReturn = isPolymorphic ? "nil" : `${typeName}{}`;

  lines.push(
    `func ${typeName}FromJSON(jsonStr string) (${returnType}, error) {`,
  );
  lines.push(
    hasCoercions
      ? "\tvar data interface{}"
      : "\tvar data map[string]interface{}",
  );
  lines.push(
    "\tif err := json.Unmarshal([]byte(jsonStr), &data); err != nil {",
  );
  lines.push(`\t\treturn ${errorReturn}, err`);
  lines.push("\t}");
  lines.push("\tctx := NewLoadContext()");
  lines.push(`\treturn Load${typeName}(data, ctx)`);
  lines.push("}");
  lines.push("");
}

function emitFromYAML(
  typeName: string,
  isPolymorphic: boolean,
  hasCoercions: boolean,
  lines: string[],
): void {
  lines.push(`// FromYAML creates ${typeName} from YAML string`);
  if (isPolymorphic) {
    lines.push(
      "// Returns interface{} because this is a polymorphic base type that can resolve to different child types",
    );
  }

  const returnType = isPolymorphic ? "interface{}" : typeName;
  const errorReturn = isPolymorphic ? "nil" : `${typeName}{}`;

  lines.push(
    `func ${typeName}FromYAML(yamlStr string) (${returnType}, error) {`,
  );
  lines.push(
    hasCoercions
      ? "\tvar data interface{}"
      : "\tvar data map[string]interface{}",
  );
  lines.push(
    "\tif err := yaml.Unmarshal([]byte(yamlStr), &data); err != nil {",
  );
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
      return getGoDictFieldType(category.valueType, polymorphicTypeNames);
  }
}

function getGoDictFieldType(
  valueType: string | undefined,
  polymorphicTypeNames: Set<string>,
): string {
  if (!valueType || valueType === "unknown") return "map[string]interface{}";
  const mapped = GO_TYPE_MAP[valueType];
  if (mapped) return `map[string]${mapped}`;
  return polymorphicTypeNames.has(valueType)
    ? "map[string]interface{}"
    : `map[string]${valueType}`;
}

function getStructTag(
  fieldName: string,
  preserveOptionalAbsence: boolean,
): string {
  const jsonTag = preserveOptionalAbsence
    ? `${fieldName},omitempty`
    : fieldName;
  const yamlTag = preserveOptionalAbsence
    ? `${fieldName},omitempty`
    : fieldName;
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
  const capitalizedFactory =
    factoryName.charAt(0).toUpperCase() + factoryName.slice(1);
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
function emitMethodStubs(
  typeName: string,
  methods: MethodStubDecl[],
  lines: string[],
): void {
  // Emit an interface that the user implements in a separate file.
  const interfaceName = `${typeName}Helpers`;
  lines.push(`// ${interfaceName} defines helper methods for ${typeName}.`);
  lines.push(
    `// Implement these in a separate file (e.g., ${typeName.toLowerCase()}_helpers.go).`,
  );
  lines.push(`type ${interfaceName} interface {`);
  for (const method of methods) {
    if (method.description) {
      lines.push(`\t// ${toPascalCase(method.name)} — ${method.description}`);
    }
    const params = Object.entries(method.params).map(
      ([pName, pType]) => `${pName} ${protocolGoType(pType)}`,
    );
    if (method.runtimeCancellable) {
      params.unshift("ctx context.Context");
    }
    const ret = goMethodReturnType(method.returns);
    lines.push(
      `\t${toPascalCase(method.name)}(${params.join(", ")})${ret ? ` ${ret}` : ""}`,
    );
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
  if (typeStr === "Record<unknown>" || typeStr === "dictionary")
    return "map[string]interface{}";
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
    const params = Object.entries(method.params).map(
      ([pName, pType]) => `${pName} ${protocolGoType(pType)}`,
    );
    if (method.runtimeCancellable) {
      params.unshift("ctx context.Context");
    }
    lines.push(
      `\t${toPascalCase(method.name)}(${params.join(", ")})${goProtocolReturn(method)}`,
    );
  }

  lines.push("}");
  lines.push("");
}
