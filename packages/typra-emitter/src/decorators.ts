import { type DecoratorContext, type Model, Program, Type, ModelProperty, ObjectValue, serializeValueAsJson, StringValue, Union } from "@typespec/compiler";
import { StateKeys } from "./lib.js";
import { Coercion } from "./ir/ast.js";

export const appendStateValue = <T>(context: DecoratorContext, key: symbol, target: Type, value: T | T[]) => {
  const state = context.program.stateMap(key).get(target) || [];
  if (Array.isArray(value)) {
    const newState = [...state, ...value];
    context.program.stateMap(key).set(target, newState);
  } else {
    const newState = [...state, value];
    context.program.stateMap(key).set(target, newState);
  }
};

export const getStateValue = <T>(program: Program, key: symbol, target: Type): T[] => {
  return program.stateMap(key).get(target) || [];
};

export const setStateScalar = <T>(context: DecoratorContext, key: symbol, target: Type, value: T) => {
  context.program.stateMap(key).set(target, value);
};

export const getStateScalar = <T>(program: Program, key: symbol, target: Type): T | undefined => {
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

export function $sample(context: DecoratorContext, target: ModelProperty, sample: ObjectValue | object, options?: SampleOptions) {
  // With valueof unknown, TypeSpec passes a plain JavaScript object
  // With unknown (no valueof), TypeSpec passes an ObjectValue with a type property
  let s: object;

  if (sample && typeof sample === 'object' && 'type' in sample && (sample as ObjectValue).type) {
    // Old-style ObjectValue with type property
    const sampleValue = sample as ObjectValue;
    const serialized = serializeValueAsJson(context.program, sampleValue, sampleValue.type);
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
  }
  appendStateValue<SampleEntry>(context, StateKeys.samples, target, entry);
}

export function $abstract(context: DecoratorContext, target: Model) {
  setStateScalar(context, StateKeys.abstracts, target, true);
}

export function $coerce(context: DecoratorContext, target: Model, scalar: Type, expansion: ObjectValue | object, title?: string, description?: string, example?: string) {
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
  if (expansion && typeof expansion === 'object' && 'type' in expansion && (expansion as ObjectValue).type) {
    const serialized = serializeValueAsJson(context.program, expansion as ObjectValue, (expansion as ObjectValue).type);
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
  const titleValue = typeof title === 'object' && title !== null && 'value' in title ? (title as StringValue).value : title as string | undefined;
  const descValue = typeof description === 'object' && description !== null && 'value' in description ? (description as StringValue).value : description as string | undefined;
  const exampleValue = typeof example === 'object' && example !== null && 'value' in example ? (example as StringValue).value : example as string | undefined;

  const entry: Coercion = {
    scalar: scalar.name,
    expansion: exp,
    example: exampleValue,
    title: titleValue ?? "",
    description: descValue ?? "",
  }
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

export interface MethodEntry {
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

function deserializeValue(value: unknown): any {
  if (value && typeof value === 'object' && 'type' in value && (value as ObjectValue).type) {
    // ObjectValue from TypeSpec — shouldn't happen with valueof but handle defensively
    return value;
  }
  return value;
}

export function $factory(context: DecoratorContext, target: Model, name: string, sets: object, params?: object) {
  // Handle string values from valueof
  const nameValue = typeof name === 'object' && name !== null && 'value' in name ? (name as StringValue).value : name as string;

  const setsValue = deserializeValue(sets) as Record<string, any>;
  const paramsValue = params ? deserializeValue(params) as Record<string, string> : {};

  const entry: FactoryEntry = {
    name: nameValue,
    sets: setsValue,
    params: paramsValue,
  };

  appendStateValue<FactoryEntry>(context, StateKeys.factories, target, entry);
}

export function $method(context: DecoratorContext, target: Model, name: string, returns: string, description?: string, params?: object, optional?: boolean, sync?: boolean) {
  const nameValue = typeof name === 'object' && name !== null && 'value' in name ? (name as StringValue).value : name as string;
  const returnsValue = typeof returns === 'object' && returns !== null && 'value' in returns ? (returns as StringValue).value : returns as string;
  const descValue = typeof description === 'object' && description !== null && 'value' in description ? (description as StringValue).value : description as string | undefined;
  const paramsValue = params ? deserializeValue(params) as Record<string, string> : {};
  const optionalValue = typeof optional === 'object' && optional !== null && 'value' in optional ? (optional as { value: boolean }).value : optional ?? false;
  const syncValue = typeof sync === 'object' && sync !== null && 'value' in sync ? (sync as { value: boolean }).value : sync ?? false;

  const entry: MethodEntry = {
    name: nameValue,
    returns: returnsValue,
    description: descValue ?? "",
    params: paramsValue,
    optional: optionalValue,
    sync: syncValue,
  };

  appendStateValue<MethodEntry>(context, StateKeys.methods, target, entry);
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

export function $knownAs(context: DecoratorContext, target: ModelProperty, provider: string, name: string) {
  const providerValue = typeof provider === 'object' && provider !== null && 'value' in provider ? (provider as StringValue).value : provider as string;
  const nameValue = typeof name === 'object' && name !== null && 'value' in name ? (name as StringValue).value : name as string;

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
  return typeof value === 'object' && value !== null && 'value' in value ? (value as StringValue).value : value as string;
}

function readStringArray(context: DecoratorContext, target: Type, value: ObjectValue | object | string[]): string[] | undefined {
  let deserialized: unknown;
  if (value && typeof value === 'object' && 'type' in value && (value as ObjectValue).type) {
    deserialized = serializeValueAsJson(context.program, value as ObjectValue, (value as ObjectValue).type);
  } else {
    deserialized = value;
  }

  if (!Array.isArray(deserialized) || !deserialized.every(item => typeof item === "string")) {
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

export function $parseAlias(context: DecoratorContext, target: Union, canonical: string, aliases: ObjectValue | object | string[]) {
  const canonicalValue = readStringValue(canonical);
  const aliasValues = readStringArray(context, target as Type, aliases);
  if (!aliasValues) return;

  const variants = Array.from(target.variants).map(([, v]) => v.type);
  const allowedValues = new Set(variants.filter(v => v.kind === "String").map(v => v.value));
  if (!allowedValues.has(canonicalValue)) {
    context.program.reportDiagnostic({
      code: "typra-emitter-parse-alias-canonical",
      message: `parseAlias canonical value '${canonicalValue}' is not a string literal in union '${target.name || "anonymous"}'.`,
      severity: "error",
      target,
    });
    return;
  }

  const existing = getStateValue<ParseAliasEntry>(context.program, StateKeys.parseAliases, target as Type);
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
        code: existingCanonical === canonicalValue ? "typra-emitter-parse-alias-duplicate" : "typra-emitter-parse-alias-conflict",
        message: existingCanonical === canonicalValue
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

  appendStateValue<ParseAliasEntry>(context, StateKeys.parseAliases, target as Type, {
    canonical: canonicalValue,
    aliases: aliasValues,
  });
}

export interface DefaultForEntry {
  /** Provider identifier (e.g., "openai", "anthropic") */
  provider: string;
  /** Default value for that provider */
  defaultValue: any;
}

export function $defaultFor(context: DecoratorContext, target: ModelProperty, provider: string, defaultValue: ObjectValue | object | string | number | boolean) {
  const providerValue = typeof provider === 'object' && provider !== null && 'value' in provider ? (provider as StringValue).value : provider as string;

  let val: any;
  if (defaultValue && typeof defaultValue === 'object' && 'type' in defaultValue && (defaultValue as ObjectValue).type) {
    const serialized = serializeValueAsJson(context.program, defaultValue as ObjectValue, (defaultValue as ObjectValue).type);
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
  appendStateValue<DefaultForEntry>(context, StateKeys.defaultFor, target, entry);
}

// ============================================================================
// Protocol decorator
// ============================================================================

export function $protocol(context: DecoratorContext, target: Model) {
  setStateScalar(context, StateKeys.protocols, target, true);
}
