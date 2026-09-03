/**
 * Shared Test Context Builder
 * ===========================
 * Provides standardized helper functions for building test contexts across all language emitters.
 * This ensures consistency in how tests are generated from @sample decorators.
 */

import {
  TypeNode,
  PropertyNode,
  PropertyValidation,
  TestExample,
  CoercionTest,
  BaseTestContext,
} from "../ir/ast.js";
import { getCombinations, scalarValue, toSnakeCase } from "../ir/utilities.js";
import { toPascalCase } from "../ir/visitor.js";
import {
  swiftPropertyName,
  swiftTypeName,
} from "../languages/swift/identifiers.js";
import { goFieldName } from "../languages/go/identifiers.js";
import * as YAML from "yaml";

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
 * Options for building test context - language-specific transformations.
 */
export interface TestContextOptions {
  /** Transform property name to target language casing (e.g., PascalCase, snake_case) */
  renderKey: (key: string) => string;

  /** Render boolean value as language-specific literal (e.g., "True"/"False" for Python) */
  renderBoolean: (val: boolean) => string;

  /** Escape string for use in language-specific string literal */
  escapeString: (str: string) => string;

  /** Get string delimiter based on content (e.g., '"' or '"""' for multiline) */
  getDelimiter: (str: string) => string;

  /** Escape JSON for embedding in test template (optional - for languages that need it) */
  escapeJsonForTemplate?: (json: string) => string;

  /** Escape YAML for embedding in test template (optional - for languages that need it) */
  escapeYamlForTemplate?: (yaml: string) => string;

  /** Use YAML block literals for multiline strings instead of quoted folding. */
  yamlMultilineStyle?: "block-literal";

  /** Minimum encoded length at which double-quoted multiline values may be folded. */
  yamlDoubleQuotedMinMultiLineLength?: number;

  /** Default scalar values for each type (used when @sample doesn't provide example) */
  scalarValues: Record<string, string>;

  /** Type mapper for scalar types */
  typeMapper: Record<string, string>;

  /**
   * Render an enum assertion value for a closed enum field.
   * Called with (enumName, rawStringValue, fieldName).
   * If provided and returns non-null, overrides default string/bool/number rendering.
   * The returned value+delimiter replace the default.
   */
  renderEnumValue?: (
    enumName: string,
    rawValue: string,
    fieldName: string,
    isOpenEnum?: boolean,
  ) => { value: string; delimiter: string } | null;

  /** Include scalar samples for complex properties that support scalar coercion. */
  includeCoercedComplexValues?: boolean;
}

/**
 * Resolves a declared type name to its node. Supplied by each language driver from the
 * `TypeRegistry` it already builds, so synthesis can follow a property whose own `.type`
 * back-reference was left unresolved by `resolveModel`'s cycle prevention (only the first
 * property of a given element type gets one).
 */
export type TypeResolver = (name: string) => TypeNode | undefined;

/**
 * Wire-level stand-ins for required scalars that carry no `@sample`. These are payload
 * values (they get serialized into the generated JSON/YAML), not language literals, so they
 * are deliberately separate from `TestContextOptions.scalarValues`, which holds rendered
 * source-code literals like `"3.14f"` or `"True"`.
 */
const WIRE_SCALAR_DEFAULTS: Record<string, unknown> = {
  string: "sample",
  bytes: "c2FtcGxl",
  plainDate: "1970-01-01",
  plainTime: "00:00:00",
  utcDateTime: "1970-01-01T00:00:00Z",
  offsetDateTime: "1970-01-01T00:00:00+00:00",
  duration: "P1D",
  url: "https://example.test",
  uuid: "00000000-0000-0000-0000-000000000001",
  boolean: true,
  int8: 1,
  int16: 1,
  int32: 1,
  int64: 1,
  integer: 1,
  safeint: 1,
  uint8: 1,
  uint16: 1,
  uint32: 1,
  uint64: 1,
  float: 1.5,
  float32: 1.5,
  float64: 1.5,
  number: 1.5,
  numeric: 1.5,
  decimal: 1.5,
  decimal128: 1.5,
};

/**
 * Build the payload a complex property needs when it carries no `@sample` of its own.
 *
 * Every emitter validates that required complex fields are present before it constructs an
 * instance, so a sample payload that omits one cannot pass the validation generated beside
 * it — the generated test fails against its own generated loader. The data needed to build
 * that payload is already in the IR (the target type's own `@sample` decorators), so it is
 * derived here rather than demanded a second time from the schema author.
 *
 * Returns `undefined` when nothing can be derived, leaving the property absent rather than
 * emitting a payload that is confidently wrong.
 */
/** The literal a concrete variant pins for its base's discriminator, if it pins one. */
function discriminatorLiteral(
  child: TypeNode,
  discriminator: string,
): string | undefined {
  const prop = child.properties.find(
    (candidate) => candidate.name === discriminator,
  );
  return typeof prop?.defaultValue === "string" ? prop.defaultValue : undefined;
}

function synthesizeComplexSample(
  type: TypeNode,
  resolveType: TypeResolver,
  seen: Set<string>,
): Record<string, any> | undefined {
  if (!type.typeName?.name) {
    return undefined;
  }
  const key = `${type.typeName.namespace}.${type.typeName.name}`;
  if (seen.has(key)) {
    // Self-referential model. The cycle can only be broken by an optional edge, and an
    // omitted optional is exactly what the loaders accept.
    return undefined;
  }
  const nested = new Set(seen).add(key);

  // A polymorphic base cannot be described without naming a concrete variant, so build the
  // payload from a declared child; its discriminator literal comes along with it. Prefer a
  // child that pins a real literal: a wildcard variant's discriminator is `*`, which is a
  // routing rule rather than a value, and emitting it would hand the loaders a fabricated
  // string that names nothing.
  const children = type.childTypes ?? [];
  const concrete =
    type.discriminator && children.length > 0
      ? (children.find(
          (child) => discriminatorLiteral(child, type.discriminator!) !== "*",
        ) ?? children[0])
      : type;

  const payload: Record<string, any> = {};
  for (const prop of concrete.properties) {
    const sampled = prop.samples?.[0]?.sample;
    if (sampled) {
      Object.assign(payload, sampled);
      continue;
    }
    if (prop.isOptional || prop.hasExplicitDefault) continue;

    const value = synthesizeRequiredValue(prop, resolveType, nested);
    if (value !== undefined) {
      payload[prop.name] = value;
    }
  }
  return payload;
}

function synthesizeCompleteComplexSample(
  type: TypeNode,
  resolveType: TypeResolver,
  seen: Set<string>,
): Record<string, any> | undefined {
  if (!type.typeName?.name) {
    return undefined;
  }
  const key = `${type.typeName.namespace}.${type.typeName.name}`;
  if (seen.has(key)) {
    return undefined;
  }
  const nested = new Set(seen).add(key);

  const children = type.childTypes ?? [];
  const concrete =
    type.discriminator && children.length > 0
      ? (children.find(
          (child) => discriminatorLiteral(child, type.discriminator!) !== "*",
        ) ?? children[0])
      : type;

  const payload: Record<string, any> = {};
  for (const prop of concrete.properties) {
    const sampled = prop.samples?.[0]?.sample;
    if (sampled) {
      Object.assign(payload, sampled);
      continue;
    }
    if (prop.isOptional || prop.hasExplicitDefault) continue;

    const value = synthesizeCompleteRequiredValue(prop, resolveType, nested);
    if (value === undefined) {
      return undefined;
    }
    payload[prop.name] = value;
  }
  return payload;
}

/** Derive a wire value for a single required property that carries no `@sample`. */
function synthesizeRequiredValue(
  prop: PropertyNode,
  resolveType: TypeResolver,
  seen: Set<string>,
): any {
  // A discriminator on a concrete subtype is pinned to its literal; honour that first so the
  // synthesized payload dispatches back to the type it was built from.
  if (prop.defaultValue !== null && prop.defaultValue !== undefined)
    return prop.defaultValue;
  if ((prop.allowedValues ?? []).length > 0) return prop.allowedValues[0];
  if (prop.isCollection) return [];
  if (prop.isDict || prop.isAny) return {};
  if (prop.isScalar) return WIRE_SCALAR_DEFAULTS[prop.typeName?.name ?? ""];

  const target = prop.type ?? resolveType(prop.typeName.name);
  return target
    ? synthesizeComplexSample(target, resolveType, seen)
    : undefined;
}

function synthesizeCompleteRequiredValue(
  prop: PropertyNode,
  resolveType: TypeResolver,
  seen: Set<string>,
): any {
  if (prop.defaultValue !== null && prop.defaultValue !== undefined)
    return prop.defaultValue;
  if ((prop.allowedValues ?? []).length > 0) return prop.allowedValues[0];
  if (prop.isCollection) return [];
  if (prop.isDict || prop.isAny) return {};
  if (prop.isScalar) return WIRE_SCALAR_DEFAULTS[prop.typeName?.name ?? ""];

  const target = prop.type ?? resolveType(prop.typeName.name);
  return target
    ? synthesizeCompleteComplexSample(target, resolveType, seen)
    : undefined;
}

/**
 * Add payloads for required complex properties the `@sample` combinations left out.
 *
 * `buildExamples` derives a payload from `@sample` decorators alone, so a required complex
 * property that declares none is silently dropped — and the generated validation then
 * rejects the very payload the generator produced.
 *
 * Exported because C# renders its conversion tests through its own driver rather than
 * `buildBaseTestContext`; it must complete payloads through this same helper so every
 * backend's generated fixtures stay in agreement.
 */
export function withRequiredComplexSamples(
  sample: Record<string, any>,
  node: TypeNode,
  resolveType: TypeResolver,
): Record<string, any> {
  const seed = new Set<string>([
    `${node.typeName.namespace}.${node.typeName.name}`,
  ]);
  const completed = { ...sample };

  // A discriminated base declares its discriminator as a required property, so a payload that
  // omits it is invalid against the schema no matter how each loader chooses to react — and
  // the backends do not agree: C# throws while the other six invent a base instance (#92).
  // Complete it from the first declared child exactly as `synthesizeComplexSample` does for a
  // nested polymorphic property, so the fixture dispatches to a real variant instead of
  // exercising seven different opinions about an invalid document. Keys the `@sample`
  // combination already supplied win, so this only fills genuine gaps.
  if (
    node.discriminator &&
    !(node.discriminator in completed) &&
    node.childTypes.length > 0
  ) {
    const variant = synthesizeComplexSample(node, resolveType, new Set());
    for (const [key, value] of Object.entries(variant ?? {})) {
      if (!(key in completed)) completed[key] = value;
    }
  }

  for (const prop of node.properties) {
    if (prop.name in completed) continue;
    if (prop.isOptional || prop.hasExplicitDefault) continue;
    if (prop.isScalar || prop.isAny || prop.isDict || prop.enumName) continue;

    const target = prop.type ?? resolveType(prop.typeName.name);
    if (!target) continue;

    const payload = synthesizeComplexSample(target, resolveType, seed);
    if (payload === undefined) continue;

    completed[prop.name] = prop.isCollection ? [payload] : payload;
  }

  return completed;
}

export function buildExampleSamples(
  node: TypeNode,
  resolveType: TypeResolver,
): Record<string, any>[] {
  const samples = node.properties
    .filter((p) => p.samples && p.samples.length > 0)
    .map((p) => p.samples?.map((s) => ({ ...s.sample })));

  if (samples.length === 0) {
    const synthesized = synthesizeCompleteComplexSample(
      node,
      resolveType,
      new Set(),
    );
    return synthesized === undefined ? [] : [synthesized];
  }

  return getCombinations(samples).map((c) =>
    withRequiredComplexSamples(Object.assign({}, ...c), node, resolveType),
  );
}

/**
 * Build a standardized test context from a TypeNode.
 * All language emitters should use this to ensure consistent test generation.
 */
export function buildBaseTestContext(
  node: TypeNode,
  packageName: string | undefined,
  options: TestContextOptions,
  resolveType: TypeResolver = () => undefined,
): BaseTestContext {
  const examples = buildExamples(node, options, resolveType);
  const coercions = buildCoercions(node, options);
  const isAbstract =
    node.isAbstract ||
    (node.discriminator !== undefined && node.discriminator.length > 0);

  return {
    node,
    isAbstract,
    package: packageName,
    examples,
    coercions,
    factories: node.factories,
  };
}

/**
 * Build test examples from @sample decorators on properties.
 */
function buildExamples(
  node: TypeNode,
  options: TestContextOptions,
  resolveType: TypeResolver,
): TestExample[] {
  return buildExampleSamples(node, resolveType).map((sample) => {
    // Create YAML document with proper string escaping
    const doc = new YAML.Document(sample);
    let requiresJsonDoubleQuotes = false;
    YAML.visit(doc, {
      Scalar(key, yamlNode) {
        if (typeof yamlNode.value === "string") {
          const str = yamlNode.value as string;
          const hasTrailingHorizontalWhitespace = /[ \t]+(?:\r?\n|$)/.test(str);
          const supportsBlockLiteral =
            str.includes("\n") &&
            /\S/.test(str) &&
            !/[\u2028\u2029]/.test(str) &&
            !hasTrailingHorizontalWhitespace &&
            !/(?:^|\n)[ ]*\t/.test(str);
          if (
            supportsBlockLiteral &&
            options.yamlMultilineStyle === "block-literal"
          ) {
            yamlNode.type = "BLOCK_LITERAL";
          } else if (
            str.includes("\n") ||
            str.includes("\t") ||
            str.includes("#") ||
            str.includes(":") ||
            str.includes('"')
          ) {
            yamlNode.type = "QUOTE_DOUBLE";
            requiresJsonDoubleQuotes ||= hasTrailingHorizontalWhitespace;
          }
        }
      },
    });

    // Generate JSON and optionally escape for embedding in template strings
    let jsonStr = JSON.stringify(sample, null, 2);
    if (options.escapeJsonForTemplate) {
      jsonStr = options.escapeJsonForTemplate(jsonStr);
    }

    // Generate YAML and optionally escape for embedding in template strings
    let yamlStr = doc.toString({
      indent: 2,
      lineWidth: 0,
      doubleQuotedAsJSON: requiresJsonDoubleQuotes,
      ...(options.yamlDoubleQuotedMinMultiLineLength === undefined
        ? {}
        : {
            doubleQuotedMinMultiLineLength:
              options.yamlDoubleQuotedMinMultiLineLength,
          }),
    });
    if (options.escapeYamlForTemplate) {
      yamlStr = options.escapeYamlForTemplate(yamlStr);
    }

    return {
      sample,
      json: jsonStr.split("\n"),
      yaml: yamlStr.split("\n"),
      validations: buildValidations(sample, node, options),
    };
  });
}

/**
 * Build property validations from a sample object.
 */
function buildValidations(
  sample: Record<string, any>,
  node: TypeNode,
  options: TestContextOptions,
): PropertyValidation[] {
  return Object.keys(sample)
    .filter((key) => {
      const prop = node.properties.find((p) => p.name === key);
      const supportsScalarCoercion =
        options.includeCoercedComplexValues &&
        (prop?.type?.coercions.length ?? 0) > 0;
      return (
        typeof sample[key] !== "object" &&
        (prop?.isScalar || prop?.enumName || supportsScalarCoercion)
      );
    })
    .map((key) => {
      const prop = node.properties.find((p) => p.name === key);
      const rawValue = sample[key];

      // Check for enum field (skip discriminator fields)
      const isDiscriminator = node.discriminator === key;
      if (
        prop &&
        prop.enumName &&
        !isDiscriminator &&
        typeof rawValue === "string" &&
        options.renderEnumValue
      ) {
        const enumResult = options.renderEnumValue(
          prop.enumName,
          rawValue,
          key,
          prop.isOpenEnum,
        );
        if (enumResult) {
          return {
            sourceKey: key,
            key: options.renderKey(key),
            value: enumResult.value,
            delimiter: enumResult.delimiter,
            isOptional: prop?.isOptional || false,
            withheldOnSave: (prop?.sensitive ?? []).includes("save"),
          };
        }
      }

      let value: any;
      let delimiter = "";

      if (typeof rawValue === "boolean") {
        value = options.renderBoolean(rawValue);
      } else if (typeof rawValue === "string") {
        value = options.escapeString(rawValue);
        delimiter = options.getDelimiter(rawValue);
      } else {
        value = rawValue;
      }

      return {
        sourceKey: key,
        key: options.renderKey(key),
        value,
        delimiter,
        isOptional: prop?.isOptional || false,
        withheldOnSave: (prop?.sensitive ?? []).includes("save"),
      };
    });
}

/**
 * Source-key names of a node's fields that are withheld from the `save`
 * direction (`@sensitive("save")` or bare `@sensitive`).
 */
function withheldOnSaveKeys(node: TypeNode): Set<string> {
  return new Set(
    node.properties
      .filter((prop) => (prop.sensitive ?? []).includes("save"))
      .map((prop) => prop.name),
  );
}

/**
 * Project a test example onto the shape a load → save → load round-trip can
 * actually reproduce: `save()` omits `@sensitive("save")` fields, so a reloaded
 * instance never carries them. Drops their validations and removes their keys
 * from the raw sample (so structured-validation passes skip them too). The
 * original example is returned untouched when the node has no save-withheld
 * field. Use this at every reload/round-trip validation site; the load-side
 * (`instance`) validations must keep asserting these fields.
 */
export function postSaveExample(
  example: TestExample,
  node: TypeNode,
): TestExample {
  const withheld = withheldOnSaveKeys(node);
  if (withheld.size === 0) {
    return example;
  }
  const sample: Record<string, any> = {};
  for (const [key, value] of Object.entries(example.sample)) {
    if (!withheld.has(key)) {
      sample[key] = value;
    }
  }
  return {
    ...example,
    sample,
    validations: example.validations.filter(
      (validation) => !validation.withheldOnSave,
    ),
  };
}

/**
 * Build coercion (scalar-to-object) test cases from node coercions.
 */
function buildCoercions(
  node: TypeNode,
  options: TestContextOptions,
): CoercionTest[] {
  if (!node.coercions || node.coercions.length === 0) {
    return [];
  }

  return node.coercions.map((alt) => {
    // Get example value - use provided example or default scalar value
    const example = alt.example
      ? typeof alt.example === "string"
        ? '"' + alt.example + '"'
        : alt.example.toString()
      : options.scalarValues[alt.scalar] || "null";

    // Build validations for expanded properties
    const validations: PropertyValidation[] = Object.keys(alt.expansion)
      .filter((key) => typeof alt.expansion[key] !== "object")
      .map((key) => {
        const prop = node.properties.find((p) => p.name === key);
        const rawValue = alt.expansion[key];
        const isValuePlaceholder = rawValue === "{value}";
        const value = isValuePlaceholder ? example : rawValue;

        // Check for closed enum field (skip discriminator fields)
        const isDiscriminator = node.discriminator === key;
        if (
          prop &&
          prop.enumName &&
          !isDiscriminator &&
          options.renderEnumValue
        ) {
          // Extract the raw string value (strip quotes if present from example substitution)
          const strValue =
            typeof value === "string"
              ? value.replace(/^"|"$/g, "")
              : String(value);
          const enumResult = options.renderEnumValue(
            prop.enumName,
            strValue,
            key,
            prop.isOpenEnum,
          );
          if (enumResult) {
            return {
              sourceKey: key,
              key: options.renderKey(key),
              value: enumResult.value,
              delimiter: enumResult.delimiter,
              isOptional: prop?.isOptional || false,
            };
          }
        }

        // Determine delimiter - don't add quotes if it's the {value} placeholder (already has quotes)
        const needsQuotes =
          typeof value === "string" &&
          !value.includes('"') &&
          !isValuePlaceholder;

        return {
          sourceKey: key,
          key: options.renderKey(key),
          value: needsQuotes ? options.escapeString(value) : value,
          delimiter: needsQuotes ? '"' : "",
          isOptional: prop?.isOptional || false,
        };
      });

    return {
      title: alt.title || alt.scalar,
      scalarType: options.typeMapper[alt.scalar] || alt.scalar,
      value: example,
      validations,
    };
  });
}

// =============================================================================
// Language-Specific Presets
// =============================================================================

/**
 * C# test context options.
 */
export const csharpTestOptions: TestContextOptions = {
  renderKey: (key: string) => {
    // Convert snake_case to PascalCase
    const pascal = key.replace(/_([a-z])/g, (_, letter) =>
      letter.toUpperCase(),
    );
    return pascal.charAt(0).toUpperCase() + pascal.slice(1);
  },
  renderBoolean: (val: boolean) => (val ? "True" : "False"),
  escapeString: (str: string) =>
    str.replace(/\\/g, "\\\\").replace(/"/g, '\\"'),
  getDelimiter: (str: string) => (str.includes("\n") ? '@"' : '"'),
  scalarValues: {
    boolean: "false",
    float: "3.14f",
    float32: "3.14f",
    float64: "3.14",
    number: "3.14f",
    int32: "3",
    int64: "3L",
    integer: "3",
    string: '"example"',
  },
  typeMapper: {
    string: "string",
    boolean: "bool",
    int32: "int",
    int64: "long",
    float32: "float",
    float64: "double",
    number: "float",
  },
};

/**
 * Python test context options.
 */
export const pythonTestOptions: TestContextOptions = {
  renderKey: (key: string) => toSnakeCase(key), // camelCase from TypeSpec → snake_case for Python
  renderBoolean: (val: boolean) => (val ? "True" : "False"),
  escapeString: (str: string) =>
    str.replace(/\\/g, "\\\\").replace(/"/g, '\\"'),
  getDelimiter: (str: string) => (str.includes("\n") ? '"""' : '"'),
  yamlDoubleQuotedMinMultiLineLength: Number.MAX_SAFE_INTEGER,
  scalarValues: {
    boolean: "False",
    float: "3.14",
    float32: "3.14",
    float64: "3.14",
    number: "3.14",
    int32: "3",
    int64: "3",
    integer: "3",
    string: '"example"',
  },
  typeMapper: {
    string: "str",
    boolean: "bool",
    int32: "int",
    int64: "int",
    float32: "float",
    float64: "float",
    number: "float",
  },
};

/**
 * TypeScript test context options.
 */
export const typescriptTestOptions: TestContextOptions = {
  renderKey: (key: string) => key, // camelCase - already correct from TypeSpec
  renderBoolean: (val: boolean) => (val ? "true" : "false"),
  escapeString: (str: string) =>
    str
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/"/g, '\\"'),
  getDelimiter: (str: string) => '"',
  // Escape backslashes in JSON so escape sequences like \n remain as literals in template strings
  escapeJsonForTemplate: (json: string) => json.replace(/\\/g, "\\\\"),
  // Escape backslashes in YAML so escape sequences remain as literals in template strings
  escapeYamlForTemplate: (yaml: string) => yaml.replace(/\\/g, "\\\\"),
  scalarValues: {
    boolean: "false",
    float: "3.14",
    float32: "3.14",
    float64: "3.14",
    number: "3.14",
    int32: "3",
    int64: "3",
    integer: "3",
    string: '"example"',
  },
  typeMapper: {
    string: "string",
    boolean: "boolean",
    int32: "number",
    int64: "number",
    float32: "number",
    float64: "number",
    number: "number",
  },
};

/**
 * Rust test context options.
 */
export const rustTestOptions: TestContextOptions = {
  renderKey: (key: string) => {
    return rustFieldName(key);
  },
  renderBoolean: (val: boolean) => (val ? "true" : "false"),
  escapeString: (str: string) =>
    str
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t"),
  getDelimiter: (str: string) => '"',
  yamlDoubleQuotedMinMultiLineLength: Number.MAX_SAFE_INTEGER,
  renderEnumValue: (enumName: string, rawValue: string) => ({
    value: `${enumName}::${toPascalCase(rawValue)}`,
    delimiter: "",
  }),
  escapeJsonForTemplate: undefined,
  escapeYamlForTemplate: undefined,
  scalarValues: {
    boolean: "false",
    float: "3.14",
    float32: "3.14",
    float64: "3.14",
    number: "3.14",
    int32: "3",
    int64: "3",
    integer: "3",
    string: '"example"',
  },
  typeMapper: {
    string: "String",
    boolean: "bool",
    int32: "i32",
    int64: "i64",
    float32: "f32",
    float64: "f64",
    number: "f64",
  },
};

/**
 * Swift test context options.
 */
export const swiftTestOptions: TestContextOptions = {
  renderKey: (key: string) => {
    const pascal = key.replace(/_([a-z])/g, (_, letter) =>
      letter.toUpperCase(),
    );
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
  },
  renderBoolean: (val: boolean) => (val ? "true" : "false"),
  escapeString: (str: string) =>
    str
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t"),
  getDelimiter: () => '"',
  yamlDoubleQuotedMinMultiLineLength: Number.MAX_SAFE_INTEGER,
  escapeJsonForTemplate: (json: string) => json.replace(/\\/g, "\\\\"),
  escapeYamlForTemplate: (yaml: string) => yaml.replace(/\\/g, "\\\\"),
  renderEnumValue: (
    enumName: string,
    rawValue: string,
    _fieldName: string,
    isOpenEnum?: boolean,
  ) => ({
    value: isOpenEnum
      ? `${swiftTypeName(enumName)}(rawValue: "${rawValue}")`
      : `${swiftTypeName(enumName)}.${swiftPropertyName(rawValue)}`,
    delimiter: "",
  }),
  includeCoercedComplexValues: true,
  scalarValues: {
    boolean: "false",
    float: "3.14",
    float32: "3.14",
    float64: "3.14",
    number: "3.14",
    int32: "3",
    int64: "3",
    integer: "3",
    string: '"example"',
  },
  typeMapper: {
    string: "String",
    boolean: "Bool",
    int32: "Int32",
    int64: "Int64",
    float32: "Float",
    float64: "Double",
    number: "Double",
  },
};

/**
 * Go test context options.
 */
export const goTestOptions: TestContextOptions = {
  renderKey: goFieldName,
  renderBoolean: (val: boolean) => (val ? "true" : "false"),
  escapeString: (str: string) =>
    str
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t"),
  getDelimiter: (str: string) => '"',
  yamlMultilineStyle: "block-literal",
  yamlDoubleQuotedMinMultiLineLength: Number.MAX_SAFE_INTEGER,
  scalarValues: {
    boolean: "false",
    float: "3.14",
    float32: "3.14",
    float64: "3.14",
    number: "3.14",
    int32: "3",
    int64: "3",
    integer: "3",
    string: '"example"',
  },
  typeMapper: {
    string: "string",
    boolean: "bool",
    int32: "int32",
    int64: "int64",
    float32: "float32",
    float64: "float64",
    number: "float64",
  },
};
