import "@typra/emitter";

namespace Typra.Fixtures.Features.DispatchUnionCoerce;

// ===========================================================================
// @dispatch reached through a coerced `T | string` union parameter.
//
// This fixture exercises the exact prompty seam shapes: the discriminator lives
// on a polymorphic model that seam params reference as `Model | string` (the
// "accepts an object OR a shorthand string" wire spelling), with a `@coerce`
// declaring that the bare string IS the model. Without coerce-aware path
// resolution the union arm would make the discriminator unreachable and emit
// would fail with `typra-emitter-dispatch-unreachable`; with it, each seam
// resolves the discriminator through the coerce-canonical arm.
//
// Three seam shapes are proven side by side:
//   1. Renderer   — CLOSED discriminator union; field IS the coerce target
//                   (kind == coerce #{kind}).
//   2. Executor   — OPEN discriminator union (`string` member) + a `*` wildcard
//                   catch-all subtype, AND the discriminator field DIFFERS from
//                   the coerce target: Model's coerce targets `id`, but the
//                   dispatch key is `provider`. This is prompty's real, highest-
//                   blast-radius provider shape; proving emit + path reachability
//                   here directly is the insurance we want. The `*` subtype
//                   lowers to the decl's `defaultVariant` (fallback hook); known
//                   providers stay enumerated `variants`. (Runtime absent/unknown
//                   provider handling stays out of band; the fixture only needs
//                   the path to resolve.)
//   3. Parser     — CLOSED discriminator union; a second field-IS-coerce-target
//                   seam on a distinct model.
//   4. Embedder    — OPEN discriminator union (`string` member) but NO `*`
//                   wildcard subtype: proves an open union ALWAYS yields a
//                   fallback — here the discriminator base model itself, as a
//                   self-reference (isSelfReference:true) — while only a CLOSED
//                   union has defaultVariant null.
//
// It also proves PIN-ONLY discriminated subtypes (children that add no fields,
// only pin the discriminator literal) still lower a PolymorphicDispatchDecl and
// activate the typed dispatch rail.
// ===========================================================================

// --- Seam 1: Renderer, dispatched by template dialect -----------------------

@doc("Closed discriminator union naming each supported template dialect.")
union TemplateFormatKind {
  mustache: "mustache",
  jinja2: "jinja2",
}

@doc("Polymorphic base over template dialects. `kind` is the @dispatch discriminator.")
@discriminator("kind")
model TemplateFormat {
  kind: TemplateFormatKind;
}

// Pin-only subtypes: no extra fields, only the pinned discriminator literal.
@doc("Mustache dialect.")
model MustacheFormat extends TemplateFormat {
  kind: "mustache";
}

@doc("Jinja2 dialect.")
model Jinja2Format extends TemplateFormat {
  kind: "jinja2";
}

// The scalar shorthand `"mustache"` IS a TemplateFormat with that kind: the
// coerce target IS the discriminator field.
@@coerce(TemplateFormat, string, #{ kind: "{value}" }, "format", "Load a format from its dialect name.", "mustache");

@doc("A template: a dialect plus its source content.")
model Template {
  @doc("Dialect — the polymorphic dispatch key lives here. Accepts an object OR a shorthand string.")
  format: TemplateFormat | string;

  @doc("Raw template source in the declared dialect.")
  content: string;
}

// --- Seam 2: Executor, dispatched by model provider -------------------------
// The load-bearing case: the coerce target (`id`) is NOT the discriminator
// (`provider`). The bare-string shorthand `"gpt-4"` yields `{ id: "gpt-4" }`
// with no provider — accepted, because absent-provider is a RUNTIME registry
// concern, out of band from the typed resolver. Emit must still succeed and the
// `provider` path must resolve through the coerce-canonical model arm.

@doc("Open discriminator union: the known closed providers PLUS a bare `string` escape hatch for downstream/unregistered providers.")
union ModelProvider {
  openai: "openai",
  azure: "azure",
  string,
}

@doc("Polymorphic base over model providers. `provider` is the @dispatch discriminator; the string coercion targets `id`, NOT provider.")
@discriminator("provider")
model Model {
  provider: ModelProvider;

  @doc("Opaque model id (e.g. deployment or model name).")
  id: string = "";
}

@doc("OpenAI-hosted model.")
model OpenAIModel extends Model {
  provider: "openai";
}

@doc("Azure-hosted model.")
model AzureModel extends Model {
  provider: "azure";
}

// Wildcard catch-all: an OPEN discriminator union (`string` member) plus a `*`
// pin lowers `CustomModel` to the decl's `defaultVariant` (the fallback seam),
// while the literal providers stay enumerated `variants`. A runtime provider
// value that is none of the known literals routes to this default — the
// downstream-registry delegation hook. This proves the coerce-aware path fix
// composes with prompty's REAL open+wildcard provider shape, not just closed
// unions.
@doc("Wildcard catch-all model for downstream/unregistered providers.")
model CustomModel extends Model {
  provider: "*";
}

// Shorthand `"gpt-4"` IS a Model whose id is that string. Note the coerce target
// (`id`) deliberately differs from the dispatch discriminator (`provider`).
@@coerce(Model, string, #{ id: "{value}" }, "model", "Load a model from its bare id.", "gpt-4");

// --- Seam 3: Parser, dispatched by parser kind ------------------------------

@doc("Closed discriminator union naming each supported parser kind.")
union ParserKind {
  chat: "chat",
  completion: "completion",
}

@doc("Polymorphic base over parser kinds. `kind` is the @dispatch discriminator.")
@discriminator("kind")
model ParserConfig {
  kind: ParserKind;
}

@doc("Chat-completion parser.")
model ChatParser extends ParserConfig {
  kind: "chat";
}

@doc("Text-completion parser.")
model CompletionParser extends ParserConfig {
  kind: "completion";
}

@@coerce(ParserConfig, string, #{ kind: "{value}" }, "parser", "Load a parser from its kind name.", "chat");

// --- Seam 4: Embedder, dispatched by an OPEN union with NO `*` wildcard ------
// The complement of the Executor case: an OPEN discriminator union (bare `string`
// escape hatch) but WITHOUT a `*` catch-all subtype. This pins down the fallback
// behavior of an open union with no explicit wildcard: `isClosed` is false (the
// bare `string` member keeps the set open), and the discriminator base model
// itself becomes the fallback `defaultVariant` as a SELF-REFERENCE
// (isSelfReference:true) — an unknown provider hydrates as the base rather than
// hard-erroring. Only a CLOSED union has no fallback (defaultVariant:null).
// Coerced behind `Embedding | string` so it also exercises the coerce-aware
// traversal for the no-wildcard open union.

@doc("Open discriminator union with a bare `string` escape hatch but no `*` catch-all.")
union EmbeddingProvider {
  local: "local",
  remote: "remote",
  string,
}

@doc("Polymorphic base over embedding providers. `provider` is the @dispatch discriminator.")
@discriminator("provider")
model Embedding {
  provider: EmbeddingProvider;

  @doc("Opaque embedding model id.")
  id: string = "";
}

@doc("Local in-process embedding provider.")
model LocalEmbedding extends Embedding {
  provider: "local";
}

@doc("Remote hosted embedding provider.")
model RemoteEmbedding extends Embedding {
  provider: "remote";
}

// No `CustomEmbedding { provider: "*" }` subtype: the open union stays open, but
// there is no fallback variant to catch unknown providers.
@@coerce(Embedding, string, #{ id: "{value}" }, "embedding", "Load an embedding from its bare id.", "local");

// --- Aggregate: an Agent that owns all four coerce-union seams ---------------

@doc("An agent that owns a template, a model, and a parser — each a coerced union.")
model Agent {
  @doc("Human-facing agent name.")
  name: string;

  @doc("The template the agent renders; `template.format.kind` is the render dispatch key.")
  template: Template;

  @doc("The model the agent runs on; `model.provider` is the execute dispatch key. Accepts an object OR a bare id string.")
  `model`: Model | string;

  @doc("The parser for model output; `parser.kind` is the parse dispatch key. Accepts an object OR a shorthand kind string.")
  parser: ParserConfig | string;

  @doc("The embedding provider; `embedding.provider` is the embed dispatch key. Open union with no `*` fallback. Accepts an object OR a bare id string.")
  embedding: Embedding | string;
}

@doc("Runtime inputs bound into the seam at call time.")
model Inputs {
  @doc("Free-form name/value bindings.")
  values: Record<unknown>;
}

// The concrete Renderer is selected by `TemplateFormat.kind`, uniquely reachable
// from `agent` as `agent.template.format.kind` through the coerced union arm.
@doc("Behavioral seam resolved by template dialect, reached through a coerced union param.")
@dispatch(TemplateFormat.kind)
interface Renderer {
  @doc("Render the agent's template against the supplied inputs.")
  render(agent: Agent, inputs: Inputs): string;
}

// The concrete Executor is selected by `Model.provider`, uniquely reachable from
// `agent` as `agent.model.provider` — where `agent.model` is itself the coerced
// `Model | string` union and the discriminator (`provider`) is NOT the coerce
// target (`id`).
@doc("Behavioral seam resolved by model provider, reached through a coerced union param whose coerce target differs from the discriminator.")
@dispatch(Model.provider)
interface Executor {
  @doc("Execute the agent's model against the supplied inputs.")
  execute(agent: Agent, inputs: Inputs): string;
}

// The concrete Parser is selected by `ParserConfig.kind`, uniquely reachable
// from `agent` as `agent.parser.kind` through the coerced union arm.
@doc("Behavioral seam resolved by parser kind, reached through a coerced union param.")
@dispatch(ParserConfig.kind)
interface Parser {
  @doc("Parse the agent's raw model output against the supplied inputs.")
  parse(agent: Agent, inputs: Inputs): string;
}

// The concrete Embedder is selected by `Embedding.provider`, uniquely reachable
// from `agent` as `agent.embedding.provider` through the coerced union arm. The
// discriminator union is open (bare `string`) but has NO `*` wildcard subtype.
@doc("Behavioral seam resolved by embedding provider through an open union with no `*` fallback subtype.")
@dispatch(Embedding.provider)
interface Embedder {
  @doc("Embed the supplied inputs using the agent's embedding provider.")
  embed(agent: Agent, inputs: Inputs): string;
}

@doc("Fixture root aggregating the dispatched-seam graph.")
model Root {
  @doc("The agent whose template, model, and parser each carry a dispatch discriminator behind a coerced union.")
  agent: Agent;
}
