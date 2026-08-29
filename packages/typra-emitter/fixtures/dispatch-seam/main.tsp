import "@typra/emitter";
import "./vectors.tsp";

namespace Typra.Fixtures.DispatchSeam;

// ===========================================================================
// Dispatched seam, end to end.
//
// This fixture exists to be *looked at*: it stands up a full model + sample +
// polymorphic discriminated union + @dispatch seam interface + vectors, and is
// generated across every target under generated/dispatch-seam/<lang>. That output
// is git-ignored (like all generated trees) but reproduced deterministically by
// `npm run generate:fixtures:dispatch-seam` — read it alongside this source.
//
// Part II-A resolved the @dispatch discriminator to a deterministic access path
// (surfaced in export-surfaces.json); Part II-B made the emitted vector-runner +
// harness route dispatched vectors through a per-discriminator registry keyed
// `Contract.operation#<value>`. Part III (this rail) adds the TYPED resolver: for
// this seam every target emits a provider + resolver twin of the shape Load
// switch beside the interface — e.g. csharp/RendererResolver.cs (compile-time
// IRendererProvider) and python/_renderer_resolver.py (runtime completeness
// guard) — one slot per @dispatch variant, so a forgotten attachment fails to
// compile (C#/TS/Java/Rust/Swift) or errors at collection (Go/Python). The
// emitted vector-conformance harness still routes via the retained `#value`
// path; the typed resolver is proven load-bearing by the per-language
// test/dispatch-resolver.typed-<lang>.test.ts proofs.
// ===========================================================================

// ---- Polymorphic discriminator union: the dispatch key --------------------

@doc("Closed discriminator union naming each supported template dialect.")
union TemplateFormatKind {
  mustache: "mustache",
  jinja2: "jinja2",
  liquid: "liquid",
}

@doc("Polymorphic base over template dialects. `kind` is the discriminator that `@dispatch` resolves the Renderer on.")
@discriminator("kind")
model TemplateFormat {
  kind: TemplateFormatKind;
}

@doc("Mustache dialect variant.")
model MustacheFormat extends TemplateFormat {
  kind: "mustache";

  @sample(#{ partialsEnabled: true })
  @doc("Whether `{{> partial }}` expansion is enabled.")
  partialsEnabled: boolean;
}

@doc("Jinja2 dialect variant.")
model Jinja2Format extends TemplateFormat {
  kind: "jinja2";

  @sample(#{ autoescape: true })
  @doc("Whether HTML autoescaping is on.")
  autoescape: boolean;
}

@doc("Liquid dialect variant.")
model LiquidFormat extends TemplateFormat {
  kind: "liquid";

  @sample(#{ strictVariables: false })
  @doc("Whether undefined variables raise instead of rendering empty.")
  strictVariables: boolean;
}

// ---- Container models (sample synthesis exercised) ------------------------

@doc("A template: a dialect plus its source content.")
model Template {
  @sample(#{
    format: #{ kind: "mustache", partialsEnabled: true },
    content: "Hello {{name}}",
  })
  @doc("The dialect this template is written in — the polymorphic dispatch key lives here.")
  format: TemplateFormat;

  @doc("Raw template source in the declared dialect.")
  content: string;
}

@doc("An agent that owns a template.")
model Agent {
  @doc("Human-facing agent name.")
  name: string;

  @doc("The template the agent renders; `template.format.kind` is the dispatch discriminator.")
  template: Template;
}

@doc("Runtime inputs bound into the template at render time.")
model Inputs {
  @doc("Free-form name/value bindings.")
  values: Record<unknown>;
}

// ---- Dispatched seam ------------------------------------------------------

// The concrete Renderer implementation is selected at runtime by the value of
// `TemplateFormat.kind`, uniquely reachable from the `agent` parameter as
// `agent.template.format.kind`. `inputs` does not reach the discriminator, so
// the path is unambiguous. The seam method stays key-free — the engine is never
// a parameter; it is resolved once from the discriminator field.
@doc("Behavioral seam whose implementation is resolved by template dialect.")
@dispatch(TemplateFormat.kind)
interface Renderer {
  // Executable cases are named value objects declared in ./vectors.tsp, applied
  // here so this file stays focused on the dispatched shape.
  @vector(mustacheBasic)
  @vector(jinja2Basic)
  @doc("Render the agent's template against the supplied inputs.")
  render(agent: Agent, inputs: Inputs): string;
}

@doc("Fixture root aggregating the dispatched-seam graph.")
@serializable
model Root {
  @doc("The agent whose template carries the dispatch discriminator.")
  agent: Agent;
}
