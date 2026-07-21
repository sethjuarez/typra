import { createTypeSpecLibrary, JSONSchemaType } from "@typespec/compiler";

export interface EmitTarget {
  "type": string;
  "output-dir"?: string;
  "test-dir"?: string;
  "alias"?: { [key: string]: any };
  "format"?: boolean;
  "namespace"?: string;
  "import-path"?: string;
  "package-name"?: string;
  "enum-parsing"?: "case-sensitive" | "case-insensitive";
  "protocol-scaffolds"?: "none" | "compile-only";
}
export interface TypraEmitterOptions {
  "root-object": string;
  "emit-targets"?: EmitTarget[];
  "root-namespace"?: string;
  "root-alias"?: string;
  "omit-models"?: string[];
  "schema-output-dir"?: string;
  "additional-roots"?: string[];
  "allow-unsupported-typespec-version"?: boolean;
  "protected-paths"?: string[];
  "hydration-zones"?: string[];
  "deterministic-output"?: boolean;
}

const TypraEmitterOptionsSchema: JSONSchemaType<TypraEmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "emit-targets": {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          "type": {
            type: "string",
            enum: [
              "TypeScript", "Python", "CSharp", "Go", "Java", "Rust", "Swift", "Markdown",
              "typescript", "python", "csharp", "go", "java", "rust", "swift", "markdown",
            ],
          },
          "output-dir": {
            type: "string",
            nullable: true
          },
          "test-dir": {
            type: "string",
            nullable: true
          },
          "alias": {
            type: "object",
            additionalProperties: true,
            nullable: true
          },
          "format": {
            type: "boolean",
            nullable: true,
            default: true,
            description: "Run formatters on emitted files"
          },
          "namespace": {
            type: "string",
            nullable: true,
            description: "Override the namespace for the emitted code"
          },
          "import-path": {
            type: "string",
            nullable: true,
            description: "Import path for generated code in tests. Defaults vary by language."
          },
          "package-name": {
            type: "string",
            nullable: true,
            description: "Language package/module name override. Currently used by Go and Swift; defaults to the emitted root namespace."
          },
          "enum-parsing": {
            type: "string",
            enum: ["case-sensitive", "case-insensitive"],
            nullable: true,
            description: "Enum/string-union parsing policy. Currently used by Rust; defaults to case-sensitive for existing behavior."
          },
          "protocol-scaffolds": {
            type: "string",
            enum: ["none", "compile-only"],
            nullable: true,
            default: "none",
            description: "Opt-in generated test scaffolds for protocol conformance. 'compile-only' emits test-dir-only implementations that compile but do not provide runtime fake behavior."
          }
        },
        required: ["type"]
      },
      nullable: true,
      description: "List of target languages to emit code for"
    },
    "root-namespace": {
      type: "string",
      nullable: true,
      description: "Root namespace for the emitted code"
    },
    "root-object": {
      type: "string",
      nullable: false,
      description: "Root object for the emitted artifacts"
    },
    "root-alias": {
      type: "string",
      nullable: true,
      description: "Alias for the root object"
    },
    "omit-models": {
      type: "array",
      items: { type: "string" },
      nullable: true,
      description: "List of model names to omit from generation"
    },
    "schema-output-dir": {
      type: "string",
      nullable: true,
      description: "Directory containing JSON schema files. Reserved for future manifest-based cleanup of omitted models."
    },
    "additional-roots": {
      type: "array",
      items: { type: "string" },
      nullable: true,
      description: "Additional root types to resolve and generate alongside the main root object. These types need not be referenced from the main root. Specified as fully-qualified names (e.g., 'Typra.Message')."
    },
    "allow-unsupported-typespec-version": {
      type: "boolean",
      nullable: true,
      default: false,
      description: "Allow generation with an unvalidated TypeSpec compiler/json-schema version. Unsupported versions report a warning instead of an error."
    },
    "protected-paths": {
      type: "array",
      items: { type: "string" },
      nullable: true,
      description: "Hand-authored paths Typra must not own. Recorded for verifier boundary checks; generation still does not delete files."
    },
    "hydration-zones": {
      type: "array",
      items: { type: "string" },
      nullable: true,
      description: "Hand-authored extension zones adjacent to generated output. Recorded as verifier boundary metadata; Typra does not generate runtime behavior."
    },
    "deterministic-output": {
      type: "boolean",
      nullable: true,
      default: false,
      description: "Emit stable metadata for CI verification. When enabled, generated manifest timestamps use a fixed value instead of wall-clock time."
    }
  },
  required: ["root-object"],
};

export const $lib = createTypeSpecLibrary({
  name: "typra-emitter",
  diagnostics: {},
  emitter: { options: TypraEmitterOptionsSchema },
  state: {
    samples: { description: "Sample values for properties" },
    coercions: { description: "Scalar-to-object implicit conversions" },
    abstracts: { description: "Abstract models" },
    factories: { description: "Factory methods for model construction" },
    methods: { description: "Method stubs for model types" },
    knownAs: { description: "Wire field name mappings per target system" },
    defaultFor: { description: "Per-target required default values" },
    protocols: { description: "Pipeline interface markers" },
    parseAliases: { description: "Parse-only aliases for named string unions" }
  }
});

export const { reportDiagnostic, createDiagnostic } = $lib;
export const StateKeys = $lib.stateKeys;
