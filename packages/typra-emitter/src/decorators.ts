import {
  type DecoratorContext,
  type Model,
  Program,
  Type,
  Interface,
  ModelProperty,
  ObjectValue,
  Operation,
  serializeValueAsJson,
  StringValue,
  Union,
} from "@typespec/compiler";
import { StateKeys } from "./lib.js";
import { Coercion } from "./ir/ast.js";
import type { VectorEntry } from "./ir/vector.js";

export const appendStateValue = <T>(
  context: DecoratorContext,
  key: symbol,
  target: Type,
  value: T | T[],
) => {
  const state = context.program.stateMap(key).get(target) || [];
  if (Array.isArray(value)) {
    const newState = [...state, ...value];
    context.program.stateMap(key).set(target, newState);
  } else {
    const newState = [...state, value];
    context.program.stateMap(key).set(target, newState);
  }
};

export const getStateValue = <T>(
  program: Program,
  key: symbol,
  target: Type,
): T[] => {
  return program.stateMap(key).get(target) || [];
};

export const setStateScalar = <T>(
  context: DecoratorContext,
  key: symbol,
  target: Type,
  value: T,
) => {
  context.program.stateMap(key).set(target, value);
};

export const getStateScalar = <T>(
  program: Program,
  key: symbol,
  target: Type,
): T | undefined => {
  const value = program.stateMap(key).get(target);
  return value ? value : undefined;
};

export interface SampleOptions {
  title?: string;
  description?: string;
}

export interface SampleEntry {
  sample: object;
  title?: string;
  description?: string;
}

export function $sample(
  context: DecoratorContext,
  target: ModelProperty,
  sample: ObjectValue | object,
  options?: SampleOptions,
) {
  // With valueof unknown, TypeSpec passes a plain JavaScript object
  // With unknown (no valueof), TypeSpec passes an ObjectValue with a type property
  let s: object;

  if (
    sample &&
    typeof sample === "object" &&
    "type" in sample &&
    (sample as ObjectValue).type
  ) {
    // Old-style ObjectValue with type property
    const sampleValue = sample as ObjectValue;
    const serialized = serializeValueAsJson(
      context.program,
      sampleValue,
      sampleValue.type,
    );
    if (!serialized) {
      context.program.reportDiagnostic({
        code: "typra-emitter-sample-serialization",
        message: `Failed to serialize sample value.`,
        severity: "error",
        target: sampleValue,
      });
      return;
    }
    s = serialized;
  } else {
    // New-style: plain JavaScript object from valueof unknown
    s = sample as object;
  }

  if (!s.hasOwnProperty(target.name)) {
    context.program.reportDiagnostic({
      code: "typra-emitter-sample-name-mismatch",
      message: `Sample object must have a property named '${target.name}' to match the target property.`,
      severity: "error",
      target: target,
    });
    return;
  }
  const entry: SampleEntry = {
    sample: s,
    title: options?.title ?? "",
    description: options?.description ?? "",
  };
  appendStateValue<SampleEntry>(context, StateKeys.samples, target, entry);
}

export function $abstract(context: DecoratorContext, target: Model) {
  setStateScalar(context, StateKeys.abstracts, target, true);
}

export function $coerce(
  context: DecoratorContext,
  target: Model,
  scalar: Type,
  expansion: ObjectValue | object,
  title?: string,
  description?: string,
  example?: string,
) {
  if (scalar.kind !== "Scalar") {
    context.program.reportDiagnostic({
      code: "typra-emitter-coerce-scalar-type",
      message: `Coerce decorator requires a scalar type for the scalar representation.`,
      severity: "error",
      target: scalar,
    });
    return;
  }

  // Handle both ObjectValue (old style) and plain object (valueof unknown)
  let exp: object;
  if (
    expansion &&
    typeof expansion === "object" &&
    "type" in expansion &&
    (expansion as ObjectValue).type
  ) {
    const serialized = serializeValueAsJson(
      context.program,
      expansion as ObjectValue,
      (expansion as ObjectValue).type,
    );
    if (!serialized) {
      context.program.reportDiagnostic({
        code: "typra-emitter-coerce-serialization",
        message: `Failed to serialize expansion value.`,
        severity: "error",
        target: target,
      });
      return;
    }
    exp = serialized;
  } else {
    exp = expansion as object;
  }

  // Handle string parameters that come as plain strings from valueof
  const titleValue =
    typeof title === "object" && title !== null && "value" in title
      ? (title as StringValue).value
      : (title as string | undefined);
  const descValue =
    typeof description === "object" &&
    description !== null &&
    "value" in description
      ? (description as StringValue).value
      : (description as string | undefined);
  const exampleValue =
    typeof example === "object" && example !== null && "value" in example
      ? (example as StringValue).value
      : (example as string | undefined);

  const entry: Coercion = {
    scalar: scalar.name,
    expansion: exp,
    example: exampleValue,
    title: titleValue ?? "",
    description: descValue ?? "",
  };
  appendStateValue<Coercion>(context, StateKeys.coercions, target, entry);
}

// ============================================================================
// Factory and Method decorators
// ============================================================================

export interface FactoryEntry {
  /** Factory method name (e.g., "allow", "deny") */
  name: string;
  /** Field assignments — { fieldName: value } */
  sets: Record<string, any>;
  /** Optional parameters — { paramName: typeString } */
  params: Record<string, string>;
}

export interface MethodOptions {
  /** Whether runtimes expose a synthetic native cancellation parameter */
  runtimeCancellable?: boolean;
  /** Whether the operation is atomic (metadata/documentation only) */
  atomic?: boolean;
  /** Whether failures are non-fatal (metadata/documentation only) */
  nonFatal?: boolean;
}

export interface OperationEffectOptions {
  /** Whether the operation is atomic (metadata/documentation only) */
  atomic?: boolean;
  /** Whether failures are non-fatal (metadata/documentation only) */
  nonFatal?: boolean;
}

export interface OperationEffectEntry extends MethodOptions {
  /** Whether this operation is optional on generated callable surfaces */
  optional?: boolean;
  /** Whether this operation is synchronous */
  sync?: boolean;
}

export interface MethodEntry extends MethodOptions {
  /** Method name (e.g., "text") */
  name: string;
  /** Return type as a string (e.g., "string") */
  returns: string;
  /** Human-readable description of what the method does */
  description: string;
  /** Method parameters as an ordered map of name → type string */
  params: Record<string, string>;
  /** Whether this method is optional (has a default implementation) */
  optional: boolean;
  /** Whether this method is synchronous (not wrapped in async/Promise/Task) */
  sync: boolean;
}

function setOperationEffect(
  context: DecoratorContext,
  target: Operation,
  effect: OperationEffectEntry,
) {
  const existing =
    getStateScalar<OperationEffectEntry>(
      context.program,
      StateKeys.operationEffects,
      target,
    ) ?? {};
  setStateScalar(context, StateKeys.operationEffects, target, {
    ...existing,
    ...effect,
  });
}

function deserializeValue(value: unknown): any {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    (value as ObjectValue).type
  ) {
    // ObjectValue from TypeSpec — shouldn't happen with valueof but handle defensively
    return value;
  }
  return value;
}

export function $factory(
  context: DecoratorContext,
  target: Model,
  name: string,
  sets: object,
  params?: object,
) {
  // Handle string values from valueof
  const nameValue =
    typeof name === "object" && name !== null && "value" in name
      ? (name as StringValue).value
      : (name as string);

  const setsValue = deserializeValue(sets) as Record<string, any>;
  const paramsValue = params
    ? (deserializeValue(params) as Record<string, string>)
    : {};

  const entry: FactoryEntry = {
    name: nameValue,
    sets: setsValue,
    params: paramsValue,
  };

  appendStateValue<FactoryEntry>(context, StateKeys.factories, target, entry);
}

export function $runtimeCancellable(
  context: DecoratorContext,
  target: Operation,
) {
  setOperationEffect(context, target, { runtimeCancellable: true });
}

export function $sync(context: DecoratorContext, target: Operation) {
  setOperationEffect(context, target, { sync: true });
}

export function $effect(
  context: DecoratorContext,
  target: Operation,
  options: object,
) {
  const optionsValue = deserializeValue(options);
  if (!isRecord(optionsValue)) {
    reportEffectDiagnostic(
      context,
      target,
      "@effect options must be an object.",
    );
    return;
  }
  const allowed = new Set(["atomic", "nonFatal"]);
  for (const key of Object.keys(optionsValue)) {
    if (!allowed.has(key)) {
      reportEffectDiagnostic(
        context,
        target,
        `Unknown @effect option '${key}'. Supported options are 'atomic' and 'nonFatal'.`,
      );
      return;
    }
  }
  setOperationEffect(context, target, {
    atomic: (optionsValue as OperationEffectOptions).atomic === true,
    nonFatal: (optionsValue as OperationEffectOptions).nonFatal === true,
  });
}

export function $optionalOperation(
  context: DecoratorContext,
  target: Operation,
) {
  setOperationEffect(context, target, { optional: true });
}

export function $vector(
  context: DecoratorContext,
  target: Operation,
  vector: object,
) {
  const raw = readVectorArgument(context, target, deserializeValue(vector));
  if (raw === undefined) return;
  const entries = Array.isArray(raw) ? raw : [raw];
  const valid: VectorEntry[] = [];

  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      reportVectorDiagnostic(
        context,
        target,
        `Vector entry ${index} must be an object.`,
      );
      continue;
    }

    if (!Object.hasOwn(entry, "input")) {
      reportVectorDiagnostic(
        context,
        target,
        `Vector entry ${index} must provide an input field.`,
      );
      continue;
    }

    const hasExpected = Object.hasOwn(entry, "expected");
    const hasExpectedError = Object.hasOwn(entry, "expectedError");
    if (hasExpected === hasExpectedError) {
      reportVectorDiagnostic(
        context,
        target,
        `Vector entry ${index} must provide exactly one of expected or expectedError.`,
      );
      continue;
    }

    if (
      Object.hasOwn(entry, "operation") &&
      entry.operation !== undefined &&
      entry.operation !== target.name
    ) {
      reportVectorDiagnostic(
        context,
        target,
        `Vector entry ${index} operation must match the decorated operation '${target.name}'.`,
      );
      continue;
    }

    if (Object.hasOwn(entry, "requires") && entry.requires !== undefined) {
      const requires = entry.requires;
      if (
        !Array.isArray(requires) ||
        requires.some(
          (token) => typeof token !== "string" || token.length === 0,
        )
      ) {
        reportVectorDiagnostic(
          context,
          target,
          `Vector entry ${index} 'requires' must be an array of non-empty capability token strings.`,
        );
        continue;
      }
    }

    valid.push(entry as unknown as VectorEntry);
  }

  if (valid.length > 0) {
    appendStateValue<VectorEntry>(context, StateKeys.vectors, target, valid);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolves the marshalled `@vector` argument into vector entries.
 *
 * TypeSpec object-value literals (`#{ ... }`) require keys to be bare,
 * non-keyword identifiers, so they cannot express vector inputs whose domain
 * models carry TypeSpec-keyword field names (e.g. `model`) or that embed opaque
 * provider wire payloads with arbitrary keys. To keep such behavior authorable
 * as first-class evidence, a vector set may instead be supplied as a JSON
 * string (typically a triple-quoted TypeSpec string constant), which Typra
 * parses into the entries. Returns `undefined` when a supplied JSON string
 * fails to parse (a diagnostic is reported), so the caller stops processing.
 */
function readVectorArgument(
  context: DecoratorContext,
  target: Operation,
  raw: unknown,
): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch (error) {
    reportVectorDiagnostic(
      context,
      target,
      `Vector JSON literal could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

function reportVectorDiagnostic(
  context: DecoratorContext,
  target: Operation,
  message: string,
): void {
  context.program.reportDiagnostic({
    code: "typra-emitter-vector-shape",
    message,
    severity: "error",
    target,
  });
}

function reportEffectDiagnostic(
  context: DecoratorContext,
  target: Operation,
  message: string,
): void {
  context.program.reportDiagnostic({
    code: "typra-emitter-effect-shape",
    message,
    severity: "error",
    target,
  });
}

// ============================================================================
// Wire mapping decorators (@knownAs, @defaultFor)
// ============================================================================

export interface KnownAsEntry {
  /** Provider identifier (e.g., "openai", "anthropic") */
  provider: string;
  /** Wire field name for that provider */
  name: string;
}

export function $knownAs(
  context: DecoratorContext,
  target: ModelProperty,
  provider: string,
  name: string,
) {
  const providerValue =
    typeof provider === "object" && provider !== null && "value" in provider
      ? (provider as StringValue).value
      : (provider as string);
  const nameValue =
    typeof name === "object" && name !== null && "value" in name
      ? (name as StringValue).value
      : (name as string);

  const entry: KnownAsEntry = { provider: providerValue, name: nameValue };
  appendStateValue<KnownAsEntry>(context, StateKeys.knownAs, target, entry);
}

export interface ParseAliasEntry {
  /** Canonical string-union value emitted during serialization */
  canonical: string;
  /** Alternate input strings accepted during parsing/loading */
  aliases: string[];
}

function readStringValue(value: unknown): string {
  return typeof value === "object" && value !== null && "value" in value
    ? (value as StringValue).value
    : (value as string);
}

function readStringArray(
  context: DecoratorContext,
  target: Type,
  value: ObjectValue | object | string[],
): string[] | undefined {
  let deserialized: unknown;
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    (value as ObjectValue).type
  ) {
    deserialized = serializeValueAsJson(
      context.program,
      value as ObjectValue,
      (value as ObjectValue).type,
    );
  } else {
    deserialized = value;
  }

  if (
    !Array.isArray(deserialized) ||
    !deserialized.every((item) => typeof item === "string")
  ) {
    context.program.reportDiagnostic({
      code: "typra-emitter-parse-aliases",
      message: `parseAlias aliases must be an array of strings.`,
      severity: "error",
      target,
    });
    return undefined;
  }

  return deserialized;
}

export function $parseAlias(
  context: DecoratorContext,
  target: Union,
  canonical: string,
  aliases: ObjectValue | object | string[],
) {
  const canonicalValue = readStringValue(canonical);
  const aliasValues = readStringArray(context, target as Type, aliases);
  if (!aliasValues) return;

  const variants = Array.from(target.variants).map(([, v]) => v.type);
  const allowedValues = new Set(
    variants.filter((v) => v.kind === "String").map((v) => v.value),
  );
  if (!allowedValues.has(canonicalValue)) {
    context.program.reportDiagnostic({
      code: "typra-emitter-parse-alias-canonical",
      message: `parseAlias canonical value '${canonicalValue}' is not a string literal in union '${target.name || "anonymous"}'.`,
      severity: "error",
      target,
    });
    return;
  }

  const existing = getStateValue<ParseAliasEntry>(
    context.program,
    StateKeys.parseAliases,
    target as Type,
  );
  const seen = new Map<string, string>();
  for (const entry of existing) {
    for (const alias of entry.aliases) {
      seen.set(alias, entry.canonical);
    }
  }
  for (const alias of aliasValues) {
    const existingCanonical = seen.get(alias);
    if (existingCanonical) {
      context.program.reportDiagnostic({
        code:
          existingCanonical === canonicalValue
            ? "typra-emitter-parse-alias-duplicate"
            : "typra-emitter-parse-alias-conflict",
        message:
          existingCanonical === canonicalValue
            ? `parseAlias alias '${alias}' is already declared for canonical value '${canonicalValue}'.`
            : `parseAlias alias '${alias}' already maps to canonical value '${existingCanonical}'.`,
        severity: "error",
        target,
      });
      return;
    }
    if (allowedValues.has(alias)) {
      context.program.reportDiagnostic({
        code: "typra-emitter-parse-alias-conflict",
        message: `parseAlias alias '${alias}' conflicts with a canonical union value.`,
        severity: "error",
        target,
      });
      return;
    }
    seen.set(alias, canonicalValue);
  }

  appendStateValue<ParseAliasEntry>(
    context,
    StateKeys.parseAliases,
    target as Type,
    {
      canonical: canonicalValue,
      aliases: aliasValues,
    },
  );
}

export interface DefaultForEntry {
  /** Provider identifier (e.g., "openai", "anthropic") */
  provider: string;
  /** Default value for that provider */
  defaultValue: any;
}

export function $defaultFor(
  context: DecoratorContext,
  target: ModelProperty,
  provider: string,
  defaultValue: ObjectValue | object | string | number | boolean,
) {
  const providerValue =
    typeof provider === "object" && provider !== null && "value" in provider
      ? (provider as StringValue).value
      : (provider as string);

  let val: any;
  if (
    defaultValue &&
    typeof defaultValue === "object" &&
    "type" in defaultValue &&
    (defaultValue as ObjectValue).type
  ) {
    const serialized = serializeValueAsJson(
      context.program,
      defaultValue as ObjectValue,
      (defaultValue as ObjectValue).type,
    );
    if (!serialized) {
      context.program.reportDiagnostic({
        code: "typra-emitter-defaultfor-serialization",
        message: `Failed to serialize default value.`,
        severity: "error",
        target: target,
      });
      return;
    }
    val = serialized;
  } else {
    val = defaultValue;
  }

  const entry: DefaultForEntry = { provider: providerValue, defaultValue: val };
  appendStateValue<DefaultForEntry>(
    context,
    StateKeys.defaultFor,
    target,
    entry,
  );
}

// ============================================================================
// Protocol decorator
// ============================================================================


// ============================================================================
// Dispatch decorator (@dispatch)
// ============================================================================

/**
 * Declares that a seam `interface` is resolved by behavioral polymorphic
 * dispatch keyed by the value of the `discriminator` ModelProperty. The
 * decorator only records the discriminator; the access path from the seam
 * methods' parameters to that field is resolved deterministically during IR
 * lowering (see `resolveCallableDispatch`).
 */
export function $dispatch(
  context: DecoratorContext,
  target: Interface,
  discriminator: ModelProperty,
) {
  setStateScalar(context, StateKeys.dispatch, target, discriminator);
}

// ============================================================================
// Entry shorthand decorator
// ============================================================================

/**
 * Declares which field of this model receives an immediate scalar value when the
 * model appears as an entry of a name-keyed collection. This is deliberately
 * distinct from the `@coerce` expansion target: a bare scalar reaching the type
 * directly and a bare scalar reaching it as a named collection entry are
 * different contexts and may legitimately populate different fields.
 */
export function $entryShorthand(
  context: DecoratorContext,
  target: Model,
  field: string | StringValue,
) {
  const fieldName =
    typeof field === "object" && field !== null && "value" in field
      ? (field as StringValue).value
      : (field as string);

  if (!fieldName || !target.properties.has(fieldName)) {
    context.program.reportDiagnostic({
      code: "typra-emitter-entry-shorthand-field",
      message: `@entryShorthand requires a field declared on ${target.name}; "${fieldName}" is not.`,
      severity: "error",
      target,
    });
    return;
  }

  setStateScalar(context, StateKeys.entryShorthands, target, fieldName);
}

// ============================================================================
// Serialization capability decorators (@serializable, @sensitive)
// ============================================================================

/** A serialization direction a field may be withheld from. */
export type SerializationDirection = "load" | "save";

/**
 * Marks a model as a serialization root. Only records the intent; the emitter
 * derives the serialized set (transitive property reach + discriminated variant
 * expansion) from every `@serializable` root during IR lowering.
 */
export function $serializable(context: DecoratorContext, target: Model) {
  setStateScalar(context, StateKeys.serializable, target, true);
}

/**
 * Withholds a field from the named serialization direction(s). Records the set
 * of directions the field is excluded from; an empty argument list defaults to
 * both directions (least-privilege / fail-closed). Repeated applications (e.g. a
 * direct decorator plus an augment) are merged by set union so a later
 * application can only ever tighten — never relax — the withheld set.
 */
export function $sensitive(
  context: DecoratorContext,
  target: ModelProperty,
  ...directions: (SerializationDirection | StringValue)[]
) {
  const named = directions.map((direction) =>
    typeof direction === "object" && direction !== null && "value" in direction
      ? (direction as StringValue).value
      : (direction as string),
  ) as SerializationDirection[];
  const withheld: SerializationDirection[] =
    named.length > 0 ? named : ["load", "save"];
  const existing =
    getStateScalar<SerializationDirection[]>(
      context.program,
      StateKeys.sensitive,
      target,
    ) ?? [];
  const merged = Array.from(
    new Set<SerializationDirection>([...existing, ...withheld]),
  );
  setStateScalar(context, StateKeys.sensitive, target, merged);
}
