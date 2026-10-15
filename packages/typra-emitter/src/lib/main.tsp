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
 * Marks an operation as accepting host/runtime cancellation outside the logical
 * serialized contract. Target emitters project this to native cancellation
 * parameters such as AbortSignal, CancellationToken, context.Context, or a
 * configured runtime token path.
 */
extern dec runtimeCancellable(target: Operation);

/**
 * Marks an operation as synchronously callable. Targets that distinguish sync
 * and async surfaces emit a sync signature; other targets may treat this as
 * metadata.
 */
extern dec sync(target: Operation);

/**
 * Records operation effect metadata for conformance and documentation. Typra
 * does not implement transactions or error policy; host applications own the
 * runtime behavior.
 */
extern dec effect(target: Operation, options: valueof unknown);

/**
 * Marks an operation as optional on generated protocol/capability surfaces.
 * Prefer smaller capability interfaces unless optional behavior is required for
 * compatibility.
 */
extern dec optionalOperation(target: Operation);

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
 *
 * Vector `input`/`expected` values are opaque conformance evidence, not typed
 * against the operation's parameters. TypeSpec object-value literals (`#{ ... }`)
 * require keys to be bare, non-keyword identifiers, so they cannot express inputs
 * whose domain models carry TypeSpec-keyword field names (e.g. `model`) or that
 * replay opaque provider wire payloads with arbitrary keys. For those cases,
 * author the vector set as a JSON string (typically a triple-quoted string
 * constant); Typra parses it into the entries.
 *
 * @example
 * ```typespec
 * const WireVectors = """
 * [
 *   {
 *     "name": "wire-replay",
 *     "input": { "request": { "model": { "provider": "openai" } } },
 *     "expected": "Hello!"
 *   }
 * ]
 * """;
 *
 * interface Processor {
 *   @vector(WireVectors)
 *   process(request: CallRequest, response: unknown): unknown;
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
 * Declares that a seam `interface` is resolved by behavioral polymorphic
 * dispatch: at runtime one of several interchangeable implementations is
 * selected by the value of a discriminator field on an ambient config/context
 * model, not by an operation parameter. Seam methods stay key-free — the engine
 * is never a parameter; the implementation is resolved once from the field.
 *
 * The discriminator argument is a reference to the ModelProperty whose value is
 * the registry key (the same target class `@knownAs` uses). The field must be
 * uniquely reachable from the seam methods' parameters via a field-access path
 * (e.g. `agent` → `agent.template.format.kind`); the emitter resolves that path
 * deterministically and reports a diagnostic when the field is unreachable or
 * ambiguously reachable rather than guessing a path.
 *
 * Applies to an `interface` only. A standalone `op` is the static/free-function
 * case and contributes nothing to the seam surface, so `@dispatch` on an `op` is
 * a target-type error.
 *
 * @param discriminator The ModelProperty whose value selects the implementation
 *
 * @example
 * ```typespec
 * @dispatch(TemplateFormat.kind)
 * interface Renderer {
 *   render(agent: Agent, inputs: Inputs): string;
 * }
 * ```
 */
extern dec dispatch(target: Interface, discriminator: ModelProperty);

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

/**
 * Marks a model as a serialization root. Load and save are emitted over the
 * model's transitive + discriminated closure (every model reachable through its
 * properties, and — for an `@abstract @discriminator` base — all of its
 * variants). Models that are never reached from a serialization root receive no
 * load/save. This is the opt-in that replaces the historical behavior where any
 * `@sample`-tagged model was unconditionally made loadable/savable.
 *
 * Serialization format is a target capability, not a model concern, so this
 * decorator takes no format argument: a serializable model is emitted for every
 * format the target supports (JSON + YAML today).
 *
 * @example
 * ```typespec
 * @serializable
 * model Agent {
 *   @sample(NameSample) name: string;
 *   messages?: Message[];
 * }
 * ```
 */
extern dec serializable(target: Model);

/**
 * Withholds a sensitive field from the named serialization direction(s). The
 * argument names the direction(s) the field is excluded from — it reads off the
 * decorator: `@sensitive("save")` must not appear in saved output.
 *
 * The default is least-privilege / fail-closed: a bare `@sensitive` withholds
 * the field from **both** directions (never loaded, never saved). Naming a
 * direction relaxes that — `@sensitive("save")` keeps the field loadable (the
 * write-only-secret case: injected from env/file, never persisted), and
 * `@sensitive("load")` keeps it savable but never reloaded.
 *
 * This is a field-level omission, not a type-level exclusion: the enclosing
 * model stays serializable and polymorphic load stays total. A model reached
 * only through withheld fields naturally falls out of the relevant closure.
 *
 * @param directions Serialization direction(s) to withhold from; omit for both.
 *
 * @example
 * ```typespec
 * @serializable
 * model Agent {
 *   @sample(NameSample) name: string;
 *   @sensitive("save") apiKey?: string;   // loaded, never saved
 *   @sensitive scratch?: string;          // neither loaded nor saved
 * }
 * ```
 */
extern dec sensitive(target: ModelProperty, ...directions: valueof ("load" | "save")[]);
