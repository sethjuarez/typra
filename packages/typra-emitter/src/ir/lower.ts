/**
 * Lowering pass — TypeNode graph → Declaration IR.
 *
 * This module converts the emitter's type graph (TypeNode/PropertyNode)
 * into the language-agnostic Declaration IR (FileDecl/TypeDecl).
 *
 * The lowering is shared across all 5 target languages. Per-language
 * emitter functions consume the FileDecl tree and emit code.
 *
 * Key responsibilities:
 *   - Classify every property into a PropertyCategory
 *   - Build load/save method specifications
 *   - Resolve polymorphic dispatch
 *   - Resolve collection helpers
 *   - Resolve factory methods via the Expression IR
 *   - Compute file-level imports
 */

import { TypeNode, PropertyNode, TypeName } from "./ast.js";
import {
  TypeRegistry,
  resolveFactoryExpr,
  collectExprTypeRefs,
  Expr,
} from "./expansion.js";
import {
  PropertyCategory,
  FileDecl,
  TypeDecl,
  FieldDecl,
  EnumDef,
  LoadDecl,
  SaveDecl,
  CoercionDecl,
  CoercionAssignment,
  LoadAssignment,
  SaveAssignment,
  PolymorphicDispatchDecl,
  PolymorphicVariant,
  PolymorphicDefault,
  CollectionHelperDecl,
  EntryShorthandDecl,
  EntryShorthandCase,
  FactoryDecl,
  MethodStubDecl,
  ImportRef,
  WireDecl,
  WireFieldMapping,
} from "./declarations.js";

// ============================================================================
// Public API
// ============================================================================

/**
 * Lower a base TypeNode (and all its children) into a FileDecl.
 *
 * This is the main entry point for the lowering pass. It produces a complete
 * FileDecl containing one or more TypeDecls (parent + children for polymorphic types).
 *
 * The result is fully language-agnostic — per-language emitters handle rendering.
 *
 * @param node - The base TypeNode (must not have a parent — i.e., `node.base === null`)
 * @param registry - TypeRegistry for resolving type references
 * @param polymorphicTypeNames - Set of type names that are polymorphic bases
 * @param serializationClosure - Set of simple names in the serialization closure
 *   of some `@serializable` root; types outside it emit no load/save. When
 *   omitted, all types serialize (legacy behavior for direct callers/tests).
 */
export function lowerFile(
  node: TypeNode,
  registry: TypeRegistry,
  polymorphicTypeNames?: Set<string>,
  serializationClosure?: Set<string>,
): FileDecl {
  const polyNames =
    polymorphicTypeNames ?? collectPolymorphicTypeNames(node, registry);

  // Lower all types in this file (parent + children)
  const types: TypeDecl[] = [
    lowerType(node, registry, polyNames, serializationClosure),
    ...node.childTypes.map((ct) =>
      lowerType(ct, registry, polyNames, serializationClosure),
    ),
  ];

  // Resolve file-level imports
  const imports = resolveImports(node, types, registry);

  // Collect unique enum definitions from all fields across all types
  const enums = collectEnums(types);

  return {
    typeName: node.typeName,
    types,
    imports,
    containsAbstract:
      node.isAbstract || node.childTypes.some((c) => c.isAbstract),
    enums,
    group: node.group,
  };
}

/**
 * Collect all polymorphic type names from a set of nodes.
 */
export function collectPolymorphicTypeNames(
  rootNode: TypeNode,
  registry: TypeRegistry,
): Set<string> {
  const names = new Set<string>();

  function walk(node: TypeNode): void {
    if (node.discriminator && node.childTypes.length > 0) {
      names.add(node.typeName.name);
    }
    for (const prop of node.properties) {
      if (prop.type) walk(prop.type);
    }
    for (const child of node.childTypes) {
      walk(child);
    }
  }

  walk(rootNode);
  return names;
}

/**
 * Compute the serialization closure across a set of root nodes.
 *
 * Serialization is opt-in: the roots are the models marked `@serializable`,
 * plus every model that appears as a seam operation parameter or return type
 * (those are serialization boundaries the emitter's own vector/conformance
 * harness loads and saves). From each root the closure grows by:
 *   (a) transitive property reachability — every referenced model type is
 *       pulled in so nested shapes can load/save (including dictionary/`Record`
 *       value models, whose element type is carried out-of-band in
 *       `dictValueType`),
 *   (b) discriminated variant expansion — every child of a genuine
 *       `@discriminator` base is pulled in so polymorphic load/save stays total,
 *       and
 *   (c) base-chain inheritance — a serialized derived model reaches its base(s),
 *       whose load/save its own generated methods delegate to.
 *
 * Plain `extends` subclasses of a NON-discriminated base are NOT auto-pulled:
 * `childTypes` holds every derived model, so expansion is gated on the node
 * actually being a discriminated base (`discriminator && childTypes.length`),
 * mirroring {@link TypeNode.retrievePolymorphicTypes} and
 * {@link collectPolymorphicTypeNames}.
 *
 * A field withheld from BOTH directions (`@sensitive` with no arguments, i.e.
 * least-privilege) carries no reachability: the type it references is only
 * pulled in if some other, non-fully-withheld path reaches it. Field-level
 * per-direction withholding does not remove a type from the closure — it is a
 * property-level omission handled during emission, not a closure hole, so
 * polymorphic load stays total. The closure is deliberately direction-agnostic:
 * a participating type receives the full load+save capability (never half), so
 * the union of load- and save-reachability is the correct membership set.
 *
 * The returned set contains the simple names of every type that participates in
 * serialization, matching the emitter-wide simple-name gating convention
 * (`collectPolymorphicTypeNames`). Types absent from it emit no load/save. The
 * walk is cycle-safe (the closure set doubles as the visited set) and resolves
 * referenced types via `prop.type` first, falling back to the registry by name
 * so reachability survives the build-time `.type` cycle-prevention gap (a
 * repeated element type carries `.type` only on its first occurrence).
 */
export function computeSerializationClosure(
  nodes: TypeNode[],
  registry: TypeRegistry,
): Set<string> {
  const closure = new Set<string>();

  function isFullyWithheld(prop: PropertyNode): boolean {
    return (
      prop.sensitive.includes("load") && prop.sensitive.includes("save")
    );
  }

  function visit(node: TypeNode): void {
    const name = node.typeName.name;
    if (closure.has(name)) return;
    closure.add(name);

    // (c) base-chain inheritance
    if (node.base) {
      const base = registry.get(node.base.name);
      if (base) visit(base);
    }

    // (b) discriminated variant expansion (genuine `@discriminator` bases only)
    if (node.discriminator && node.childTypes.length > 0) {
      for (const child of node.childTypes) {
        visit(child);
      }
    }

    // (a) transitive property reachability
    for (const prop of node.properties) {
      if (isFullyWithheld(prop)) continue;
      const referenced =
        prop.type ??
        (prop.dictValueType
          ? registry.get(prop.dictValueType)
          : undefined) ??
        registry.get(prop.typeName.name);
      if (referenced) visit(referenced);
    }
  }

  for (const root of nodes) {
    if (root.serializable) visit(root);
  }

  // Seam operation boundaries are serialization boundaries. Every model that
  // appears as a seam operation parameter or return type is loaded/saved by the
  // emitter's own generated vector/conformance harness (e.g. `InputsFromJSON`,
  // `LoadInputs`), so it must carry load/save even when no `@serializable` root
  // reaches it through the property graph. Seed the closure from every seam
  // method's parameter and return type names (transitively, via `visit`). Names
  // that don't resolve to a model in the registry (scalars, `unknown`,
  // `Record<...>`, `void`) are skipped.
  for (const node of nodes) {
    for (const method of node.methods) {
      const typeStrings = [method.returns, ...Object.values(method.params)];
      for (const typeString of typeStrings) {
        for (const candidate of extractModelTypeNames(typeString)) {
          const referenced = registry.get(candidate);
          if (referenced) visit(referenced);
        }
      }
    }
  }

  return closure;
}

/**
 * Extract candidate model type names from a callable type string as produced by
 * the callable-contract lowering (e.g. `"Message[]"`, `"Model | string"`,
 * `"Inputs?"`, `"Record<unknown>"`). Splits union alternates and strips the
 * optional (`?`) and array (`[]`) markers so the bare names can be resolved
 * against the type registry. Scalars, `unknown`, `void`, and `Record<...>`
 * intentionally fall through as non-model names (they simply won't resolve).
 */
function extractModelTypeNames(typeString: string): string[] {
  const names: string[] = [];
  for (const alternate of typeString.split("|")) {
    let token = alternate.trim();
    while (token.endsWith("?") || token.endsWith("[]")) {
      token = token.endsWith("?") ? token.slice(0, -1) : token.slice(0, -2);
      token = token.trim();
    }
    if (token.length > 0) names.push(token);
  }
  return names;
}

// ============================================================================
// Type lowering
// ============================================================================

/**
 * Lower a single TypeNode into a TypeDecl.
 */
export function lowerType(
  node: TypeNode,
  registry: TypeRegistry,
  polymorphicTypeNames: Set<string>,
  serializationClosure?: Set<string>,
): TypeDecl {
  const fields = node.properties.map((p) =>
    lowerField(p, polymorphicTypeNames),
  );
  const collectionHelpers = lowerCollectionHelpers(node, registry);
  const polymorphicDispatch = lowerPolymorphicDispatch(node);
  const factories = lowerFactories(node, registry);
  const coercionProperty = findCoercionProperty(node);

  // Clear enum metadata from discriminator fields — they're handled by polymorphic dispatch
  if (polymorphicDispatch) {
    for (const field of fields) {
      if (field.name === polymorphicDispatch.discriminatorField) {
        field.enumName = null;
        field.isOpenEnum = false;
      }
    }
  }

  // Build load/save method specs
  const load = lowerLoad(node, fields, polymorphicDispatch);
  const save = lowerSave(node, fields);

  // Serialization is opt-in: a type emits load/save only when it is in the
  // serialization closure of some `@serializable` root. When no closure is
  // supplied (direct API/test callers), default to true to preserve legacy
  // behavior; real emit runs always thread the closure from the driver.
  const serialized = serializationClosure
    ? serializationClosure.has(node.typeName.name)
    : true;

  return {
    typeName: node.typeName,
    base: node.base,
    isAbstract: node.isAbstract,
    isProtocol: node.isProtocol,
    isError: node.isError,
    description: node.description,
    fields,
    coercionProperty,
    load,
    save,
    serialized,
    factories,
    collectionHelpers,
    polymorphicDispatch,
    methods: lowerMethods(node),
    wire: lowerWire(node, fields),
  };
}

// ============================================================================
// Property classification — the core insight
// ============================================================================

/**
 * Classify a property into one of 5 categories.
 * This is the fundamental decision that drives ALL code generation.
 *
 * Decision tree:
 *   isDict → "dict"
 *   isCollection && isScalar → "collection_scalar"
 *   isCollection && !isScalar → "collection_complex"
 *   isScalar → "scalar"
 *   !isScalar → "complex"
 */
export function classifyProperty(
  prop: PropertyNode,
  polymorphicTypeNames: Set<string>,
): PropertyCategory {
  if (prop.isDict) {
    return prop.dictValueType
      ? { kind: "dict", valueType: prop.dictValueType }
      : { kind: "dict" };
  }

  if (prop.isCollection) {
    if (prop.isScalar) {
      return { kind: "collection_scalar", scalarType: prop.typeName.name };
    }
    return { kind: "collection_complex", typeName: prop.typeName.name };
  }

  if (prop.isScalar) {
    return { kind: "scalar", scalarType: prop.typeName.name };
  }

  return { kind: "complex", typeName: prop.typeName.name };
}

// ============================================================================
// Field lowering
// ============================================================================

/**
 * Lower a PropertyNode into a FieldDecl.
 */
function lowerField(
  prop: PropertyNode,
  polymorphicTypeNames: Set<string>,
): FieldDecl {
  const knownAs: Record<string, string> = {};
  for (const entry of prop.knownAs) {
    knownAs[entry.provider] = entry.name;
  }
  return {
    name: prop.name,
    typeName: prop.typeName,
    category: classifyProperty(prop, polymorphicTypeNames),
    isOptional: prop.isOptional,
    defaultValue: prop.defaultValue,
    hasExplicitDefault: prop.hasExplicitDefault,
    allowedValues: prop.allowedValues,
    parseAliases: prop.parseAliases,
    enumName: prop.enumName,
    isOpenEnum: prop.isOpenEnum,
    description: prop.description,
    knownAs,
  };
}

// ============================================================================
// Load method lowering
// ============================================================================

/**
 * Lower the load/deserialization method specification.
 *
 * Produces language-agnostic coercion and assignment data. Each emitter
 * decides variable names, rendering, and expression formatting.
 */
function lowerLoad(
  node: TypeNode,
  fields: FieldDecl[],
  polymorphicDispatch: PolymorphicDispatchDecl | null,
): LoadDecl {
  // Determine if this type has a discriminator with child variants
  const hasDiscriminatorWithChildren =
    node.discriminator != null && (node.childTypes?.length ?? 0) > 0;

  const coercions: CoercionDecl[] = (node.coercions || []).map((c) => {
    // Build structured assignments from the expansion dict
    const assignments: CoercionAssignment[] = Object.entries(c.expansion).map(
      ([key, value]) => ({
        fieldName: key,
        isInput: value === "{value}",
        literalValue: value === "{value}" ? undefined : String(value),
      }),
    );

    // Determine if this coercion needs runtime dispatch:
    // only when the discriminator field is set dynamically AND child types exist
    const setsDiscriminator =
      node.discriminator != null &&
      assignments.some((a) => a.fieldName === node.discriminator && a.isInput);
    const needsDispatch = setsDiscriminator && hasDiscriminatorWithChildren;

    return {
      scalarType: c.scalar,
      assignments,
      needsDispatch,
    };
  });

  // Per-property load assignments. Fields withheld from the load direction
  // (`@sensitive` / `@sensitive("load")`) are omitted from the load body while
  // remaining real struct fields — the closure stays total, only the property
  // is skipped during deserialization.
  const assignments: LoadAssignment[] = fields
    .filter((_f, i) => !node.properties[i]?.sensitive.includes("load"))
    .map((f) => ({
      sourceName: f.name,
      fieldName: f.name,
      category: f.category,
      isOptional: f.isOptional,
      hasExplicitDefault: f.hasExplicitDefault,
      parentTypeName: node.typeName.name,
      enumName: f.enumName,
      allowedValues: f.allowedValues,
      parseAliases: f.parseAliases,
      defaultValue: f.defaultValue,
      isOpenEnum: f.isOpenEnum,
    }));

  return {
    coercions,
    assignments,
    hasPolymorphicDispatch: polymorphicDispatch !== null,
    hasContextHooks: true, // All types support context hooks
  };
}

// ============================================================================
// Save method lowering
// ============================================================================

/**
 * Lower the save/serialization method specification.
 */
function lowerSave(node: TypeNode, fields: FieldDecl[]): SaveDecl {
  // Fields withheld from the save direction (`@sensitive` / `@sensitive("save")`,
  // e.g. a write-only secret) are omitted from the save body while remaining real
  // struct fields.
  const assignments: SaveAssignment[] = fields
    .filter((_f, i) => !node.properties[i]?.sensitive.includes("save"))
    .map((f) => ({
      targetName: f.name,
      fieldName: f.name,
      category: f.category,
      isOptional: f.isOptional,
      hasExplicitDefault: f.hasExplicitDefault,
      parentTypeName: node.typeName.name,
      enumName: f.enumName,
      isOpenEnum: f.isOpenEnum,
    }));

  return {
    assignments,
    hasBase: node.base !== null,
    hasContextHooks: true,
  };
}

// ============================================================================
// Polymorphic dispatch lowering
// ============================================================================

/**
 * Lower polymorphic dispatch specification from TypeNode.
 * Returns null if the type is not polymorphic (no discriminator or no children).
 *
 * Exported so the behavioral `@dispatch` seam rail (src/ir/callable.ts) can reuse
 * the SAME discriminator lowering that drives the shape `Load` switch — one decl,
 * two twins (shape construction + behavior resolution).
 */
export function lowerPolymorphicDispatch(
  node: TypeNode,
): PolymorphicDispatchDecl | null {
  const polyTypes = node.retrievePolymorphicTypes();
  if (!polyTypes) return null;

  const variants: PolymorphicVariant[] = polyTypes.types.map((t: any) => ({
    value: t.value,
    typeName: (t.instance as TypeNode).typeName,
  }));

  const discriminatorProperty = node.properties.find(
    (property) => property.name === node.discriminator,
  );

  // A wildcard subtype declared in the schema owns unknown discriminator values, and that
  // declaration is what makes the discriminator open — the emitter never infers it.
  // This matters when the discriminator union itself lists "*" as a member (e.g.
  // `union Kind { known: "known", wildcard: "*" }`), which TypeSpec accepts: allowedValues
  // is then non-empty and the dispatch would otherwise look closed, so backends that
  // validate closed-ness before dispatching (Rust) would reject unknown values and leave
  // the declared wildcard arm unreachable.
  const hasDeclaredWildcard =
    polyTypes.default !== undefined &&
    polyTypes.default !== null &&
    (polyTypes.default.instance as TypeNode).typeName.name !==
      node.typeName.name;
  const isClosed =
    !hasDeclaredWildcard &&
    (discriminatorProperty?.allowedValues.length ?? 0) > 0 &&
    discriminatorProperty?.isOpenEnum !== true;

  // A non-abstract base is itself instantiable, so discriminator values that its own declared
  // union permits but that no subtype claims (e.g. `kind: "string"` on a concrete `Property`
  // whose only subtypes are array/object/union) must load as the base rather than be rejected.
  // This only applies when such unclaimed values actually exist: when every permitted value is
  // claimed by a subtype the dispatch is genuinely closed and the base needs no fallback arm.
  // Closedness still bounds which values are legal; it must not strip the base's self-reference.
  const claimedValues = new Set(variants.map((variant) => variant.value));
  const absorbsUnclaimedValues =
    !node.isAbstract &&
    (discriminatorProperty?.allowedValues ?? []).some(
      (value) => !claimedValues.has(value),
    );

  let defaultVariant: PolymorphicDefault | null = null;
  if (polyTypes.default) {
    const defaultNode = polyTypes.default.instance as TypeNode;
    const isSelfReference = defaultNode.typeName.name === node.typeName.name;
    if (!isClosed || !isSelfReference || absorbsUnclaimedValues) {
      defaultVariant = {
        typeName: defaultNode.typeName,
        isSelfReference,
      };
    }
  }

  const baseDispatch: PolymorphicDispatchDecl = {
    discriminatorField: node.discriminator!,
    variants,
    defaultVariant,
    isAbstract: node.isAbstract,
    isClosed,
  };

  return baseDispatch;
}

// ============================================================================
// Collection helper lowering
// ============================================================================

/**
 * Lower collection helpers for complex collection properties.
 * These are properties like `tools: Tool[]` or `parts: ContentPart[]`
 * that need dedicated load/save helper methods for dict↔array conversion.
 */
function lowerCollectionHelpers(
  node: TypeNode,
  registry: TypeRegistry,
): CollectionHelperDecl[] {
  return node.properties
    .filter((p) => p.isCollection && !p.isScalar && !p.isDict)
    .map((p) => {
      // A collection property's `p.type` is UNSET when the same element type was already
      // resolved via an earlier sibling property (cycle-prevention in resolveModel). Recover
      // it for shorthand field metadata, but do not infer keyed wire semantics from a regular
      // element field named `name`: ordinary lists must preserve duplicates and ordering.
      const elementType = p.type ?? registry.get(p.typeName.name);
      // Only the explicit Record<T> | Named<T>[] schema shape opts into a name-keyed map.
      // The structural flag survives when the Named<T> wrapper is unavailable on later
      // same-element siblings.
      const hasNameProperty = p.isNamedCollection;
      return {
        propertyName: p.name,
        elementTypeName: p.typeName,
        innerFields:
          elementType?.properties
            .filter((t) => t.name !== "name")
            .map((t) => t.name) || [],
        coercionProperty: elementType
          ? findCoercionProperty(elementType)
          : null,
        entryShorthand: elementType ? lowerEntryShorthand(elementType) : null,
        hasNameProperty,
      };
    });
}

/**
 * Build the immediate-scalar entry expansion declared by `@entryShorthand`.
 *
 * The value field comes from the decorator; the constant assignments (typically
 * the discriminator) are inferred from the element's `@coerce` table, dropping
 * each coercion's own `{value}` assignment since that value is redirected to the
 * declared field instead.
 */
function lowerEntryShorthand(node: TypeNode): EntryShorthandDecl | null {
  const valueField = node.entryShorthand;
  if (!valueField) return null;

  const cases: EntryShorthandCase[] = (node.coercions || []).map(
    (coercion) => ({
      scalarType: coercion.scalar,
      assignments: Object.entries(coercion.expansion)
        .filter(([, value]) => value !== "{value}")
        .map(([fieldName, value]) => ({
          fieldName,
          literalValue: value as string | number | boolean | null,
        })),
    }),
  );

  return { valueField, cases };
}

// ============================================================================
// Factory method lowering
// ============================================================================

/**
 * Lower factory methods. Resolves the Expr tree via the Expression IR
 * but stores it as a typed Expr (not pre-rendered string).
 * Emitters will visit the Expr with their own visitor for language-specific output.
 */
function lowerFactories(node: TypeNode, registry: TypeRegistry): FactoryDecl[] {
  if (!node.factories || node.factories.length === 0) return [];

  return node.factories.map((f) => {
    const expr = resolveFactoryExpr(f.sets, f.params, node, registry);

    return {
      name: f.name,
      params: f.params,
      body: expr,
    };
  });
}

// ============================================================================
// Method stub lowering
// ============================================================================

function lowerMethods(node: TypeNode): MethodStubDecl[] {
  return (node.methods || []).map((m) => ({
    name: m.name,
    returns: m.returns,
    description: m.description,
    params: m.params || {},
    optional: m.optional ?? false,
    sync: m.sync ?? false,
    runtimeCancellable: m.runtimeCancellable ?? false,
    atomic: m.atomic ?? false,
    nonFatal: m.nonFatal ?? false,
  }));
}

// ============================================================================
// Wire conversion lowering
// ============================================================================

/**
 * Lower wire conversion data from knownAs mappings on fields.
 * Returns null if no field has wire mappings.
 */
function lowerWire(node: TypeNode, fields: FieldDecl[]): WireDecl | null {
  const providerSet = new Set<string>();
  const mappings: WireFieldMapping[] = [];

  for (const field of fields) {
    if (Object.keys(field.knownAs).length > 0) {
      for (const provider of Object.keys(field.knownAs)) {
        providerSet.add(provider);
      }
      mappings.push({
        fieldName: field.name,
        category: field.category,
        isOptional: field.isOptional,
        parentTypeName: node.typeName.name,
        wireNames: field.knownAs,
      });
    }
  }

  if (mappings.length === 0) return null;

  return {
    providers: Array.from(providerSet).sort(),
    mappings,
  };
}

/**
 * A provider whose wire name is claimed by more than one canonical field.
 *
 * Because `fromWire(provider)` inverts the wire map (wire name → canonical
 * field), two canonical fields mapping to the same provider wire name cannot be
 * disambiguated on the way back in. That is an author error, surfaced as the
 * `typra-emitter-wire-collision` diagnostic (see resolveModel in ast.ts, which
 * has access to the compiler `Program` needed to report it — lowering runs once
 * per target language and would otherwise report the same collision N times).
 */
export interface WireCollision {
  /** Provider identifier the collision occurs for (e.g. "openai"). */
  provider: string;
  /** The shared provider-native wire name. */
  wireName: string;
  /** Canonical field names that collide on `wireName`, in declaration order. */
  fields: string[];
}

/**
 * Detect wire-name collisions in a set of field → provider-name mappings.
 *
 * Iterates `mappings` (and each field's providers) in declaration order so the
 * reported collisions are deterministic. Returns one {@link WireCollision} per
 * `(provider, wireName)` pair claimed by two or more canonical fields.
 */
export function detectWireCollisions(
  mappings: { fieldName: string; wireNames: Record<string, string> }[],
): WireCollision[] {
  // provider → wire name → canonical field names (in declaration order)
  const byProvider = new Map<string, Map<string, string[]>>();

  for (const mapping of mappings) {
    for (const [provider, wireName] of Object.entries(mapping.wireNames)) {
      let wireNames = byProvider.get(provider);
      if (!wireNames) {
        wireNames = new Map<string, string[]>();
        byProvider.set(provider, wireNames);
      }
      const claimants = wireNames.get(wireName);
      if (claimants) {
        claimants.push(mapping.fieldName);
      } else {
        wireNames.set(wireName, [mapping.fieldName]);
      }
    }
  }

  const collisions: WireCollision[] = [];
  for (const [provider, wireNames] of byProvider) {
    for (const [wireName, fields] of wireNames) {
      if (fields.length > 1) {
        collisions.push({ provider, wireName, fields });
      }
    }
  }
  return collisions;
}

// ============================================================================
// Coercion property detection
// ============================================================================

/**
 * Find the property that receives "{value}" in coercion expansions.
 */
function findCoercionProperty(node: TypeNode): string | null {
  if (!node.coercions || node.coercions.length === 0) return null;

  for (const alt of node.coercions) {
    for (const [key, value] of Object.entries(alt.expansion)) {
      if (value === "{value}") {
        return key;
      }
    }
  }
  return null;
}

// ============================================================================
// Enum collection
// ============================================================================

/**
 * Collect unique enum definitions from all fields across all types in a file.
 * Deduplicates by enum name — same-named enums with the same values share one definition.
 */
function collectEnums(types: TypeDecl[]): EnumDef[] {
  const seen = new Map<string, EnumDef>();
  // Collect discriminator field names to skip — these are handled by polymorphic dispatch
  const discriminatorFields = new Set<string>();
  for (const type of types) {
    if (type.polymorphicDispatch) {
      discriminatorFields.add(type.polymorphicDispatch.discriminatorField);
    }
  }
  for (const type of types) {
    for (const field of type.fields) {
      // Skip discriminator fields — they use the polymorphic Kind enum instead
      if (discriminatorFields.has(field.name)) continue;
      if (
        field.enumName &&
        field.allowedValues.length > 0 &&
        !seen.has(field.enumName)
      ) {
        seen.set(field.enumName, {
          name: field.enumName,
          values: field.allowedValues,
          parseAliases: field.parseAliases,
          isOpen: field.isOpenEnum,
        });
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Import resolution
// ============================================================================

/**
 * Resolve file-level imports from type references.
 * Groups imports by module: each module maps to the symbols imported from it.
 */
function resolveImports(
  rootNode: TypeNode,
  types: TypeDecl[],
  registry: TypeRegistry,
): ImportRef[] {
  // Types defined in this file (excluded from imports)
  const definedInFile = new Set([
    rootNode.typeName.name,
    ...rootNode.childTypes.map((c) => c.typeName.name),
  ]);
  const importMap = new Map<string, Set<string>>();

  const addImport = (typeName: string, module?: string) => {
    if (definedInFile.has(typeName)) return;
    // Determine which module this type lives in
    const refNode = registry.get(typeName);
    const mod = module ?? (refNode?.base ? refNode.base.name : typeName);
    if (!importMap.has(mod)) importMap.set(mod, new Set());
    importMap.get(mod)!.add(typeName);
  };

  // Collect import refs from all properties across all types in this file
  for (const type of types) {
    for (const field of type.fields) {
      // Only import non-scalar, non-dict types
      if (
        field.category.kind === "complex" ||
        field.category.kind === "collection_complex"
      ) {
        addImport(field.typeName.name);
      } else if (
        field.category.kind === "dict" &&
        field.category.valueType &&
        registry.get(field.category.valueType)
      ) {
        addImport(field.category.valueType);
      }
    }

    // Factory-referenced imports (may include child types like TextPart)
    for (const factory of type.factories) {
      for (const ref of collectExprTypeRefs(factory.body)) {
        if (definedInFile.has(ref.name)) continue;
        addImport(ref.name);
      }
    }

    // Protocol method type references (param types and return types)
    for (const method of type.methods) {
      for (const typeName of extractMethodTypeRefs(method)) {
        addImport(typeName);
      }
    }
  }

  return Array.from(importMap.entries())
    .map(([module, names]) => {
      // Look up the group of the module's root node in the registry
      const modNode = registry.get(module);
      const group = modNode?.group ?? "";
      return { module, names: Array.from(names).sort(), group };
    })
    .sort((a, b) => a.module.localeCompare(b.module));
}

/**
 * Extract type names referenced in method parameter types and return type.
 * Handles formats like "Prompty", "Message[]", "Record<unknown>", "string", "unknown".
 */
function extractMethodTypeRefs(method: MethodStubDecl): string[] {
  const SCALARS = new Set([
    "void",
    "string",
    "number",
    "integer",
    "int32",
    "int64",
    "float",
    "float32",
    "float64",
    "numeric",
    "boolean",
    "unknown",
    "any",
  ]);
  const refs: string[] = [];

  const extract = (typeStr: string) => {
    for (const option of typeStr.split("|").map((part) => part.trim())) {
      extractSingle(option);
    }
  };

  const extractSingle = (typeStr: string) => {
    // Strip nullable suffix and array suffix: "string?" → "string", "Message[]" → "Message"
    const base = typeStr.replace(/\?$/, "").replace(/\[\]$/, "");
    // Skip scalars, Record<>, and generic types
    if (SCALARS.has(base) || base.startsWith("Record<")) return;
    refs.push(base);
  };

  extract(method.returns);
  for (const pType of Object.values(method.params)) {
    extract(pType);
  }

  return refs;
}
