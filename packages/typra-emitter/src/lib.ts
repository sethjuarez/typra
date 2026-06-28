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
}

const TypraEmitterOptionsSchema: JSONSchemaType<TypraEmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "emit-targets": {
      type: "array",
      items: {
        type: "object",
        properties: {
          "type": {
            type: "string"
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
            description: "Language package/module name override. Currently used by Go; defaults to the emitted root namespace."
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
    protocols: { description: "Pipeline interface markers" }
  }
});

export const { reportDiagnostic, createDiagnostic } = $lib;
export const StateKeys = $lib.stateKeys;
