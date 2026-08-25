import { createTypeSpecLibrary, JSONSchemaType } from "@typespec/compiler";

export interface EmitTarget {
  type: string;
  "output-dir"?: string;
  "test-dir"?: string;
  "namespace-output"?: "structural" | "flat";
  outputs?: EmitTargetOutput[];
  alias?: { [key: string]: any };
  format?: FormatterOption;
  namespace?: string;
  "import-path"?: string;
  "package-name"?: string;
  "enum-parsing"?: "case-sensitive" | "case-insensitive";
  "protocol-scaffolds"?: "none" | "compile-only";
  "cancellation-token-path"?: string;
  "vector-adapter-path"?: string;
  "test-resources"?: string[];
  "harness-test-dir"?: string;
  "native-serialization"?:
    | "none"
    | "pydantic"
    | "jackson"
    | "serde"
    | "zod"
    | "standard-schema"
    | "codable";
}
export interface EmitTargetOutput {
  kind: string;
  provider?: string;
}
/**
 * A single consumer-declared formatter invocation for a target's post-emit
 * pass. Supplying one (or an array) as {@link EmitTarget.format} replaces the
 * built-in per-language formatter with the consumer's own command, turning the
 * previously implicit host-tool dependency into an explicit, declared one.
 *
 * `args` support `{dir}` (the emitted output directory) and `{testDir}` (the
 * generated test directory, when the target emits one) placeholders; an
 * argument that references `{testDir}` is dropped when no test directory
 * exists. When `args` is omitted the command is invoked as `command {dir}`.
 *
 * Because a `{testDir}` argument is dropped wholesale when no test directory
 * exists, prefer a self-contained combined form (e.g. `--include={testDir}`)
 * over a separate flag/value pair (`["--include", "{testDir}"]`) so no dangling
 * flag is left behind. A custom command also replaces the built-in formatter
 * entirely and runs over the whole output tree, so any per-file exclusions the
 * built-in applied (e.g. create-once editable helpers) are the consumer's
 * responsibility to reproduce in their own command's ignore configuration.
 */
export interface FormatterCommand {
  command: string;
  args?: string[];
  version?: string;
  "version-args"?: string[];
}
/**
 * Formatter selection for a target's post-emit pass: `true`/unset runs the
 * built-in per-language formatter, `false` disables formatting entirely, and a
 * {@link FormatterCommand} (or array of them) runs consumer-declared commands
 * instead.
 */
export type FormatterOption = boolean | FormatterCommand | FormatterCommand[];
export interface TypraEmitterOptions {
  "root-object": string;
  "emit-targets"?: EmitTarget[];
  "root-namespace"?: string;
  "root-alias"?: string;
  "namespace-output"?: "structural" | "flat";
  "omit-models"?: string[];
  "schema-output-dir"?: string;
  "additional-roots"?: string[];
  "allow-unsupported-typespec-version"?: boolean;
  "protected-paths"?: string[];
  "hydration-zones"?: string[];
  "deterministic-output"?: boolean;
}

const formatterCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: {
    command: {
      type: "string",
      description: "Formatter executable to run over the emitted tree.",
    },
    args: {
      type: "array",
      items: { type: "string" },
      nullable: true,
      description:
        "Arguments for the formatter. Supports {dir} and {testDir} placeholders; defaults to ['{dir}'] when omitted.",
    },
    version: {
      type: "string",
      nullable: true,
      description:
        "Optional pinned version or semver range. A mismatch with the installed tool emits a loud, non-fatal warning.",
    },
    "version-args": {
      type: "array",
      items: { type: "string" },
      nullable: true,
      description:
        "Arguments used to probe the tool's version; defaults to ['--version'].",
    },
  },
};

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
          type: {
            type: "string",
            enum: [
              "TypeScript",
              "Python",
              "CSharp",
              "Go",
              "Java",
              "Rust",
              "Swift",
              "Markdown",
              "typescript",
              "python",
              "csharp",
              "go",
              "java",
              "rust",
              "swift",
              "markdown",
            ],
          },
          "output-dir": {
            type: "string",
            nullable: true,
          },
          "test-dir": {
            type: "string",
            nullable: true,
          },
          "namespace-output": {
            type: "string",
            enum: ["structural", "flat"],
            nullable: true,
            default: "structural",
            description:
              "Controls namespace-derived folder/module layout. Defaults to structural; set flat for compatibility with older flat output.",
          },
          outputs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: {
                  type: "string",
                  nullable: false,
                  description:
                    "Output contributor kind, such as models, native-serialization, server, or client.",
                },
                provider: {
                  type: "string",
                  nullable: true,
                  description:
                    "Output contributor provider, such as typra, pydantic, zod, or a future transport provider.",
                },
              },
              required: ["kind"],
            },
            nullable: true,
            description:
              "Internal output contributor requests for optional generated surfaces. Existing target generation remains compatible with top-level options.",
          },
          alias: {
            type: "object",
            additionalProperties: true,
            nullable: true,
          },
          format: {
            description:
              "Formatter selection for the post-emit pass: true/unset runs the built-in per-language formatter, false disables formatting, or supply a formatter command object (or array of them) with { command, args, version, version-args } to run consumer-declared formatters instead. Command args support {dir} and {testDir} placeholders.",
            default: true,
            anyOf: [
              { type: "boolean" },
              formatterCommandSchema,
              { type: "array", items: formatterCommandSchema, minItems: 1 },
            ],
            // Widened past the strict JSONSchemaType boolean slot; ajv validates
            // the anyOf branches at runtime. No `{ type: "null" }` branch: the
            // compiler validates with coerceTypes, which would rewrite a literal
            // `false` into `null` to satisfy a leading null branch.
          } as any,
          namespace: {
            type: "string",
            nullable: true,
            description: "Override the namespace for the emitted code",
          },
          "import-path": {
            type: "string",
            nullable: true,
            description:
              "Import path for generated code in tests. Defaults vary by language.",
          },
          "package-name": {
            type: "string",
            nullable: true,
            description:
              "Language package/module name override. Used by Go, Java, and Swift; defaults to the emitted root namespace.",
          },
          "enum-parsing": {
            type: "string",
            enum: ["case-sensitive", "case-insensitive"],
            nullable: true,
            description:
              "Enum/string-union parsing policy. Currently used by Rust; defaults to case-sensitive for existing behavior.",
          },
          "protocol-scaffolds": {
            type: "string",
            enum: ["none", "compile-only"],
            nullable: true,
            default: "none",
            description:
              "Opt-in generated test scaffolds for protocol conformance. 'compile-only' emits test-dir-only implementations that compile but do not provide runtime fake behavior.",
          },
          "native-serialization": {
            type: "string",
            enum: [
              "none",
              "pydantic",
              "jackson",
              "serde",
              "zod",
              "standard-schema",
              "codable",
            ],
            nullable: true,
            default: "none",
            description:
              "Native serialization/validation artifact for the target. Python supports opt-in 'pydantic'; Java supports opt-in 'jackson'; Rust supports 'serde' with cfg(feature = \"serde\") impls that delegate to Typra's canonical load/save mapping; TypeScript supports opt-in 'zod'; Swift supports opt-in 'codable'; 'standard-schema' is reserved for TypeScript. Defaults to 'none'.",
          },
          "cancellation-token-path": {
            type: "string",
            nullable: true,
            description:
              "Full runtime-native cancellation token symbol path. Rust uses :: separators; Python uses dotted module.symbol syntax. For Python, a leading-dot (relative) path is resolved relative to the model output root and its dot count is scaled by each generated file's group depth, so it resolves correctly from any subfolder; a path without a leading dot is emitted as an absolute import unchanged.",
          },
          "vector-adapter-path": {
            type: "string",
            nullable: true,
            description:
              "Import path to the runtime-authored vector adapter registry consumed by the generated @vector conformance harness. Lives outside the regenerated/pruned output tree. Defaults to './vector-adapters' (TypeScript), 'vector_adapters' (Python), 'vectoradapters' (Go), 'vector_adapters.rs' (Rust), '<root-namespace>.Conformance' (C#), '<package-name>.VectorAdapters' (Java), and 'VectorAdapters' (Swift; the enum's name, authored beside the generated files in the same test target).",
          },
          "test-resources": {
            type: "array",
            items: { type: "string" },
            nullable: true,
            description:
              "Swift only. Resource directory/file names (relative to the generated test target) to declare as bundled test resources on the emitted Package.swift test target, e.g. ['Resources'] emits `resources: [.process(\"Resources\")]`. Keeps hand-added test resource wiring reproducible across regeneration instead of being dropped when Package.swift is regenerated.",
          },
          "harness-test-dir": {
            type: "string",
            nullable: true,
            description:
              "Swift only. Directory to emit the @vector conformance harness (VectorConformanceTests.swift) into, decoupled from the model target's 'test-dir'. For split-package runtimes where the model types live in one package and the provider/pipeline stages live in a separate SDK package, point this at the SDK package's test target so the harness can reach every stage's adapter (authored beside it via 'vector-adapter-path') instead of only the stages reachable from the model package. The 'VectorConformanceTests.swift' file in this directory is emitter-owned and regenerated each run (cleanup prunes it if the option is later removed/changed), but other files there are left untouched. Model tests, discovery ConformanceTests, and protocol scaffolds still land in 'test-dir'. Defaults to 'test-dir' when unset.",
          },
        },
        required: ["type"],
      },
      nullable: true,
      description: "List of target languages to emit code for",
    },
    "root-namespace": {
      type: "string",
      nullable: true,
      description: "Root namespace for the emitted code",
    },
    "root-object": {
      type: "string",
      nullable: false,
      description: "Root object for the emitted artifacts",
    },
    "root-alias": {
      type: "string",
      nullable: true,
      description: "Alias for the root object",
    },
    "namespace-output": {
      type: "string",
      enum: ["structural", "flat"],
      nullable: true,
      default: "structural",
      description:
        "Default namespace-derived folder/module layout for targets. Targets can override this value.",
    },
    "omit-models": {
      type: "array",
      items: { type: "string" },
      nullable: true,
      description: "List of model names to omit from generation",
    },
    "schema-output-dir": {
      type: "string",
      nullable: true,
      description:
        "Directory containing JSON schema files. Reserved for future manifest-based cleanup of omitted models.",
    },
    "additional-roots": {
      type: "array",
      items: { type: "string" },
      nullable: true,
      description:
        "Additional root types to resolve and generate alongside the main root object. These types need not be referenced from the main root. Specified as fully-qualified names (e.g., 'Typra.Message').",
    },
    "allow-unsupported-typespec-version": {
      type: "boolean",
      nullable: true,
      default: false,
      description:
        "Allow generation with an unvalidated TypeSpec compiler/json-schema version. Unsupported versions report a warning instead of an error.",
    },
    "protected-paths": {
      type: "array",
      items: { type: "string" },
      nullable: true,
      description:
        "Hand-authored paths Typra must not own. Recorded for verifier boundary checks; generation still does not delete files.",
    },
    "hydration-zones": {
      type: "array",
      items: { type: "string" },
      nullable: true,
      description:
        "Hand-authored extension zones adjacent to generated output. Recorded as verifier boundary metadata; Typra does not generate runtime behavior.",
    },
    "deterministic-output": {
      type: "boolean",
      nullable: true,
      default: false,
      description:
        "Emit stable metadata for CI verification. When enabled, generated manifest timestamps use a fixed value instead of wall-clock time.",
    },
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
    operationEffects: {
      description:
        "TypeSpec-native operation metadata for callable runtime effects",
    },
    knownAs: { description: "Wire field name mappings per target system" },
    defaultFor: { description: "Per-target required default values" },
    protocols: { description: "Pipeline interface markers" },
    dispatch: {
      description:
        "Behavioral polymorphic dispatch discriminator for a seam interface",
    },
    vectors: { description: "Operation-level callable behavior vectors" },
    parseAliases: { description: "Parse-only aliases for named string unions" },
    entryShorthands: {
      description:
        "Field populated by an immediate scalar in name-keyed collection form",
    },
  },
});

export const { reportDiagnostic, createDiagnostic } = $lib;
export const StateKeys = $lib.stateKeys;
