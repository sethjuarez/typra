import "@typra/emitter";

namespace Typra.Fixtures.Features.DispatchUnionCoerce;

// ===========================================================================
// @dispatch reached through a coerced `T | string` union parameter.
//
// This fixture exercises the exact prompty seam shape: the discriminator lives
// on a polymorphic model that seam params reference as `Model | string` (the
// "accepts an object OR a shorthand string" wire spelling), with a `@coerce`
// declaring that the bare string IS the model. Without coerce-aware path
// resolution the union arm would make the discriminator unreachable and emit
// would fail with `typra-emitter-dispatch-unreachable`; with it, the seam
// resolves `agent.template.format.kind` through the coerce-canonical arm.
//
// It also proves PIN-ONLY discriminated subtypes (children that add no fields,
// only pin the discriminator literal) still lower a PolymorphicDispatchDecl and
// activate the typed dispatch rail.
// ===========================================================================

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
// coerce target is the discriminator-bearing canonical arm of the union below.
@@coerce(TemplateFormat, string, #{ kind: "{value}" }, "format", "Load a format from its dialect name.", "mustache");

@doc("A template: a dialect plus its source content.")
model Template {
  @doc("Dialect — the polymorphic dispatch key lives here. Accepts an object OR a shorthand string.")
  format: TemplateFormat | string;

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

// The concrete Renderer is selected at runtime by `TemplateFormat.kind`,
// uniquely reachable from `agent` as `agent.template.format.kind` — through the
// `TemplateFormat | string` union via the @coerce-designated canonical arm.
@doc("Behavioral seam resolved by template dialect, reached through a coerced union param.")
@dispatch(TemplateFormat.kind)
interface Renderer {
  @doc("Render the agent's template against the supplied inputs.")
  render(agent: Agent, inputs: Inputs): string;
}

@doc("Fixture root aggregating the dispatched-seam graph.")
model Root {
  @doc("The agent whose template carries the dispatch discriminator.")
  agent: Agent;
}
