import "@typra/emitter";

namespace Typra.Fixtures.Features.DispatchVectorCoerce;

// ===========================================================================
// TYPED @vector conformance where the @dispatch discriminator is reached through
// a COERCED `T | string` union AND the seam ops carry NON-MODEL params, including
// a BARE `unknown`. This is prompty's real, previously-unexercised combination:
//
//   * `dispatch-union-coerce` proved coerce-aware path resolution but its seams
//     have NO @vector ops, so the conformance DRIVER never ran over a coerce
//     union.
//   * `dispatch-vector-params` proved non-model @vector param mapping but its
//     discriminator is a DIRECT `format: FormatConfig` reference, never a coerce
//     union.
//
// This fixture is the intersection: dispatched @vector ops whose discriminator
// lives behind a `FormatConfig | string` / `Model | string` coerce union, with
// scalar (`string`), generic (`Record<unknown>`), optional (`Record<unknown>?`)
// and BARE `unknown` op params. It pins down two things by real emit:
//   Q2 — a bare `unknown` @vector param decodes to the language's dynamic-JSON
//        type (Rust `serde_json::Value`, Python passthrough) and is EXCLUDED
//        from the typed model import list (never `use ...::unknown`).
//   Q3 — the conformance discriminator read matches each language's field
//        representation for a COERCE-UNION field: Rust reads it off the
//        `serde_json::Value` field (`.get("kind")`/`.get("provider")`), Python
//        off the typed hydrated object (`.kind`/`.provider`). Both compile;
//        neither leaks raw TypeSpec type syntax.
// ===========================================================================

// --- Format discriminator: OPEN union + pin-only + declared `*`, coerced -----

@doc("Open discriminator union naming the known template dialects plus a bare string escape hatch.")
union FormatKind {
  jinja2: "jinja2",
  mustache: "mustache",
  string,
}

@doc("Polymorphic base over template dialects. `kind` is the @dispatch discriminator.")
@discriminator("kind")
model FormatConfig {
  kind: FormatKind = "*";
}

@doc("Jinja2 dialect (pin-only).")
model Jinja2Format extends FormatConfig {
  kind: "jinja2";
}

@doc("Mustache dialect (pin-only).")
model MustacheFormat extends FormatConfig {
  kind: "mustache";
}

@doc("Wildcard catch-all dialect (declared `*` child → tolerant fallback slot).")
model CustomFormat extends FormatConfig {
  kind: "*";
}

// The scalar shorthand IS a FormatConfig with that kind: the coerce target IS
// the discriminator field.
@@coerce(FormatConfig, string, #{ kind: "{value}" }, "format", "Load a format from its dialect name.", "mustache");

// --- Model discriminator: OPEN union + pin-only + declared `*`, coerced ------
// The load-bearing case: the coerce target (`id`) is NOT the discriminator
// (`provider`), and `provider` is OPTIONAL with no base default. The declared
// `CustomModel { provider: "*" }` child owns the fallback slot, so a bare-string
// shorthand (`{ id: "gpt-4" }`, no provider) still hydrates.

@doc("Open discriminator union: the known providers plus a bare string escape hatch for downstream providers.")
union ModelProvider {
  openai: "openai",
  azure: "azure",
  string,
}

@doc("Polymorphic base over model providers. `provider` is the @dispatch discriminator; the string coercion targets `id`, NOT provider.")
@discriminator("provider")
model Model {
  provider?: ModelProvider;

  @doc("Opaque model id (e.g. deployment or model name).")
  id: string = "";
}

@doc("OpenAI-hosted model (pin-only).")
model OpenAIModel extends Model {
  provider: "openai";
}

@doc("Azure-hosted model (pin-only).")
model AzureModel extends Model {
  provider: "azure";
}

@doc("Wildcard catch-all model (declared `*` child → tolerant fallback; absorbs the no-provider shorthand).")
model CustomModel extends Model {
  provider: "*";
}

@@coerce(Model, string, #{ id: "{value}" }, "model", "Load a model from its bare id.", "gpt-4");

// --- Container models: format nested under a Template on the Agent -----------

@doc("A template: a dialect behind a coerced union, plus its source content.")
model Template {
  @doc("Dialect — `template.format.kind` is the render dispatch key. Accepts an object OR a shorthand string.")
  format: FormatConfig | string;

  @doc("Raw template source.")
  content: string;
}

@doc("An agent that owns a template and a model — the seam-param graph the dispatch paths walk.")
model Agent {
  @doc("Human-facing agent name.")
  name: string;

  @doc("The template; `template.format.kind` is the render dispatch key.")
  template: Template;

  @doc("The model; `model.provider` is the process dispatch key. Accepts an object OR a bare id string.")
  `model`: Model | string;
}

// --- Seam 1: Renderer — coerce-union discriminator + scalar/generic params ---

@doc("Behavioral seam resolved by template dialect through a coerced union, with scalar + generic + optional op params.")
@dispatch(FormatConfig.kind)
interface Renderer {
  @vector(#{
    name: "mustache-basic",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{ content: "Hello {{name}}", format: #{ kind: "mustache" } },
        `model`: #{ provider: "openai", id: "gpt-4" },
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
        template: #{ content: "Hello {{ name }}", format: #{ kind: "jinja2" } },
        `model`: #{ provider: "azure", id: "gpt-4" },
      },
      template: "Hello {{ name }}",
      inputs: #{ name: "world" },
      context: #{ locale: "en" },
    },
    expected: "Hello world",
  })
  @doc("Render the agent's template against the supplied inputs; `context` is an optional generic map.")
  render(
    agent: Agent,
    template: string,
    inputs: Record<unknown>,
    context?: Record<unknown>,
  ): string;
}

// --- Seam 2: Processor — coerce-union discriminator + BARE `unknown` param ----
// `provider` dispatch reached via `agent.model.provider` through the coerced
// `Model | string` union whose coerce target (`id`) is NOT the discriminator.
// `response: unknown` is the shape flagged as possibly-unmapped in Rust
// (`::unknown` is not a real alias): it must decode as serde_json::Value / Any
// and be excluded from the typed model import list.

@doc("Behavioral seam resolved by model provider through a coerced union, with a bare `unknown` op param.")
@dispatch(Model.provider)
interface Processor {
  @vector(#{
    name: "openai-passthrough",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{ content: "x", format: #{ kind: "mustache" } },
        `model`: #{ provider: "openai", id: "gpt-4" },
      },
      response: #{ text: "hi" },
    },
    expected: #{ text: "hi" },
  })
  @doc("Process a raw provider response (bare `unknown`).")
  process(agent: Agent, response: unknown): unknown;
}

@doc("Fixture root aggregating the dispatched-seam graph.")
model Root {
  @doc("The agent whose template + model carry the dispatch discriminators behind coerced unions.")
  agent: Agent;
}
