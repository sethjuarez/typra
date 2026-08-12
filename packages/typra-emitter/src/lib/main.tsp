import "../../dist/src/decorators.js";
using TypeSpec.Reflection;

/**
 * Adds a sample to the target model property.
 */
extern dec sample(target: ModelProperty, sample: valueof unknown);

/**
 * Marks the target model as abstract, preventing direct instantiation.
 */
extern dec abstract(target: Model);

/**
 * Marks the target model as having a scalar-to-object implicit conversion.
 * When a scalar value is encountered during deserialization, it is expanded
 * into a full object using the provided expansion template.
 */
extern dec coerce(
  target: Model,
  `scalar`: Scalar,
  expansion: valueof unknown,
  title?: valueof string,
  description?: valueof string,
  example?: valueof unknown
);

/**
 * Declares a factory method on the target model. Factory methods are fully
 * generated — the emitter produces both signature and body. The `sets` parameter
 * specifies which fields to assign and their values. The optional `params`
 * parameter specifies method parameters (name → type string).
 *
 * @example
 * ```typespec
 * @@factory("allow", #{ allowed: true })
 * @@factory("deny", #{ allowed: false }, #{ reason: "string" })
 * ```
 */
extern dec factory(
  target: Model,
  name: valueof string,
  sets: valueof unknown,
  params?: valueof unknown
);

/**
 * Declares a method stub on the target model. Method stubs are
 * stub-generated — the emitter produces the signature in the generated file
 * and a create-if-missing extension file where the body must be hand-written.
 * This enforces that every runtime implements the method (compile/test failure
 * if missing) while allowing language-idiomatic implementations.
 *
 * The optional `params` parameter specifies method parameters (name → type string).
 * When used on `@protocol` models, params drive the generated interface method
 * signatures.
 *
 * @example
 * ```typespec
 * @@method("text", "string", "Concatenate all TextPart values joined by newline")
 * @@method("render", "string", "Render template with inputs", #{ agent: "Prompty", template: "string", inputs: "Record<unknown>" })
 * @@method("invoke", "Result", "Invoke with native cancellation", #{ request: "Request" }, false, false, #{ runtimeCancellable: true })
 * ```
 */
extern dec method(
  target: Model,
  name: valueof string,
  returns: valueof string,
  description?: valueof string,
  params?: valueof unknown,
  optional?: valueof boolean,
  sync?: valueof boolean,
  options?: valueof unknown
);

/**
 * Attaches callable behavior expectations to a TypeSpec operation.
 *
 * A vector must provide `input` and exactly one of `expected` or `expectedError`.
 * Large vector sets can be authored as TypeSpec constants and referenced from the
 * operation, keeping TypeSpec as the source of truth while avoiding bulky
 * contract files.
 *
 * @example
 * ```typespec
 * const RenderVectors = #[
 *   #{ name: "basic", input: #{ prompt: "hi" }, expected: #{ output: "hi" } }
 * ];
 *
 * interface Renderer {
 *   @vector(RenderVectors)
 *   render(request: RenderRequest): RenderResult;
 * }
 * ```
 */
extern dec vector(target: Operation, vector: valueof unknown);

/**
 * Maps a property's wire name for a specific provider. Used in provider
 * wire.tsp files via augment syntax (`@@`) to declare how core property names
 * map to provider-specific API parameter names.
 *
 * @param provider The target provider identifier (e.g., "openai", "anthropic")
 * @param name The wire field name used by that provider's API
 *
 * @example
 * ```typespec
 * @@knownAs(ModelOptions.maxOutputTokens, "openai", "max_completion_tokens")
 * @@knownAs(ModelOptions.maxOutputTokens, "anthropic", "max_tokens")
 * ```
 */
extern dec knownAs(target: ModelProperty, provider: valueof string, name: valueof string);

/**
 * Declares a per-provider required default value for a property. Used in provider
 * wire.tsp files via augment syntax (`@@`) when a provider requires a value that
 * the core schema treats as optional.
 *
 * @param provider The target provider identifier (e.g., "openai", "anthropic")
 * @param defaultValue The default value for that provider
 *
 * @example
 * ```typespec
 * @@defaultFor(ModelOptions.maxOutputTokens, "openai", 4096)
 * ```
 */
extern dec defaultFor(target: ModelProperty, provider: valueof string, defaultValue: valueof unknown);

/**
 * Declares parse-only aliases for a canonical named string-union value. Aliases
 * are accepted while loading/deserializing values; saving always emits the
 * canonical TypeSpec union value.
 *
 * @param canonical The canonical union value to produce after parsing an alias
 * @param aliases Alternate input strings that should parse as the canonical value
 *
 * @example
 * ```typespec
 * @parseAlias("ready", #["complete", "done"])
 * union FixtureStatus {
 *   draft: "draft";
 *   ready: "ready";
 *   archived: "archived";
 * }
 * ```
 */
extern dec parseAlias(target: Union, canonical: valueof string, aliases: valueof unknown);

/**
 * Marks the target model as a protocol interface. Protocol interfaces define
 * the pipeline stage contracts (renderer, parser, executor, processor). The
 * emitter generates language-appropriate interface/trait/protocol definitions.
 */
extern dec protocol(target: Model);

/**
 * Declares which field of this model receives an immediate scalar value when the
 * model appears as an entry of a name-keyed collection.
 *
 * This is deliberately distinct from the `@coerce` expansion target. A bare scalar
 * reaching the type directly and a bare scalar reaching it as a named collection
 * entry are different contexts and may populate different fields. When declared,
 * the discriminator value is inferred from the model's `@coerce` table and the raw
 * scalar is assigned to the named field.
 *
 * @example
 * ```typespec
 * @entryShorthand("default")
 * model Property { kind: SimpleTypes; default?: unknown; example?: unknown; }
 * ```
 * With this declaration `inputs: { city: "Seattle" }` loads as
 * `{ name: "city", kind: "string", default: "Seattle" }`, leaving `example` unset.
 */
extern dec entryShorthand(target: Model, field: valueof string);
