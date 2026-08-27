import "@typra/emitter";

namespace Typra.Fixtures.Features.DispatchVectorParams;

// ===========================================================================
// TYPED @vector conformance with NON-MODEL seam-op params (issue #282 §8 twin).
//
// The Part III per-interface conformance driver emits, for every dispatched
// @vector op, a per-language test that deserializes each op param from the
// vector JSON and routes the discriminator through the emitted resolver. The
// per-model test path maps each param to its language type + native JSON
// decoder; the per-interface path must do the same. A regression made the
// per-interface path collect param types VERBATIM — so a scalar (`string`), a
// generic (`Record<unknown>`), or an optional (`T?`) op param leaked its raw
// TypeSpec spelling into the `use`/import list AND the decode receiver, emitting
// uncompilable tests (`use prompty::model::{Record<unknown>?}` aborts
// `cargo fmt`; `from fixtures import Record<unknown>?` will not import).
//
// This fixture stands up exactly that shape: a dispatched Renderer whose
// @vector op mixes a MODEL param (`agent`, routed through the typed loader) with
// a scalar, a generic, and an optional generic param (each native-decoded to the
// mapped language type). It exists to keep the per-interface conformance driver
// honest across all seven runtimes.
// ===========================================================================

// ---- Polymorphic discriminator: pin-only subtypes -------------------------

@doc("Closed discriminator union naming each supported template dialect.")
union TemplateFormatKind {
  mustache: "mustache",
  jinja2: "jinja2",
}

@doc("Polymorphic base over template dialects. `kind` is the @dispatch key.")
@discriminator("kind")
model TemplateFormat {
  kind: TemplateFormatKind;
}

@doc("Mustache dialect variant (pin-only: contributes just the discriminator).")
model MustacheFormat extends TemplateFormat {
  kind: "mustache";
}

@doc("Jinja2 dialect variant (pin-only).")
model Jinja2Format extends TemplateFormat {
  kind: "jinja2";
}

// ---- Container models -----------------------------------------------------

@doc("A template: a dialect plus its source content.")
model Template {
  @doc("The dialect this template is written in — the dispatch key lives here.")
  format: TemplateFormat;

  @doc("Raw template source in the declared dialect.")
  content: string;
}

@doc("An agent that owns a template.")
model Agent {
  @doc("Human-facing agent name.")
  name: string;

  @doc("The template the agent renders; `template.format.kind` is the discriminator.")
  template: Template;
}

// ---- Dispatched seam with non-model params --------------------------------

// `render` mixes a MODEL param (`agent`) with the three non-model shapes that
// tripped the per-interface conformance driver:
//   * `template: string`            — a scalar
//   * `inputs: Record<unknown>`     — a generic map
//   * `context?: Record<unknown>`   — an optional generic map
// The discriminator is reached from the model param as `agent.template.format.kind`;
// the extra params never reach it, so the path stays unambiguous.
@doc("Behavioral seam whose implementation is resolved by template dialect.")
@dispatch(TemplateFormat.kind)
interface Renderer {
  @vector(#{
    name: "mustache-basic",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{
          content: "Hello {{name}}",
          format: #{ kind: "mustache" },
        },
      },
      template: "Hello {{name}}",
      inputs: #{ name: "world" },
      context: #{ locale: "en" },
    },
    expected: "Hello world",
  })
  @vector(#{
    name: "jinja2-basic",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{
          content: "Hello {{ name }}",
          format: #{ kind: "jinja2" },
        },
      },
      template: "Hello {{ name }}",
      inputs: #{ name: "world" },
      context: #{ locale: "en" },
    },
    expected: "Hello world",
  })
  @doc("Render the agent's template against the supplied inputs.")
  render(
    agent: Agent,
    template: string,
    inputs: Record<unknown>,
    context?: Record<unknown>,
  ): string;
}

@doc("Fixture root aggregating the dispatched-seam graph.")
model Root {
  @doc("The agent whose template carries the dispatch discriminator.")
  agent: Agent;
}
