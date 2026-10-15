import "@typra/emitter";

namespace Typra.Fixtures.Features.DispatchTargetRegression;

// ===========================================================================
// Language-target regression seam for emitter bugs that only surface in
// GENERATED conformance-test output (issue: 2.0.0 target fixes). It is the
// `dispatch-vector-coerce` shape with the two twists that activate the last two
// bugs — OPTIONAL `template?`/`model?` on the Agent, and a vector whose input
// carries a ```markdown fence — so a single seam reproduces all four:
//
//   Go#1   — a vector input containing a backtick (a ```python fence) must NOT
//            be embedded as a Go raw-string literal, whose backtick would
//            terminate the string mid-literal. The per-interface conformance
//            harness must emit an interpreted double-quoted literal instead.
//   Java#2 — a `Record<unknown>` op param maps to `Map<String, Object>`; the
//            per-interface conformance class imports nothing, so the type must
//            be FQN-qualified to `java.util.Map<String, Object>`.
//   Swift#3 — `agent.template?`/`agent.model?` are OPTIONAL, so discriminator
//            access must use optional chaining and fall back when absent.
//   Rust#4 — the coerce-union bare-string shorthand lands the discriminator via a
//            runtime `String`; the `*Kind` enum has no `From<String>`, so the
//            coercion must route through the `CustomFormat { kind_name, raw }`
//            fallback arm rather than `value.into()`.
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
  @encodedName("application/json", "format_kind")
  kind: FormatKind = "*";

  // Opaque third-party configuration must survive old-consumer decode/encode so
  // the wildcard implementation can locate plugin behavior.
  plugin?: Record<unknown>;
}

@doc("Jinja2 dialect (pin-only).")
model Jinja2Format extends FormatConfig {
  kind: "jinja2";
}

@doc("Mustache dialect (pin-only).")
model MustacheFormat extends FormatConfig {
  kind: "mustache";
}

@doc("Wildcard catch-all dialect (declared `*` child → tolerant fallback slot; absorbs the bare-string shorthand).")
model CustomFormat extends FormatConfig {
  kind: "*";
}

// The scalar shorthand IS a FormatConfig with that kind: the coerce target IS
// the discriminator field. A bare `"jinja2"` therefore lands the discriminator
// as a runtime string — the exact Rust#4 seam.
@@coerce(FormatConfig, string, #{ kind: "{value}" }, "format", "Load a format from its dialect name.", "mustache");

// --- Model discriminator: OPEN union + pin-only + declared `*`, coerced ------

@doc("Open discriminator union: the known providers plus a bare string escape hatch for downstream providers.")
union ModelProvider {
  openai: "openai",
  azure: "azure",
  string,
}

@doc("Polymorphic base over model providers. `provider` is the @dispatch discriminator; the string coercion targets `id`, NOT provider.")
@discriminator("provider")
model Model {
  @encodedName("application/json", "model_provider")
  provider: ModelProvider = "*";

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

@doc("An agent whose template and model are OPTIONAL — the optionality that forces the Swift accessor to unwrap.")
model Agent {
  @doc("Human-facing agent name.")
  name: string;

  @doc("The template; `template.format.kind` is the render dispatch key. OPTIONAL → safe chained access.")
  // The @sample carries the optional `template` into the per-model conformance
  // payload (synthesis otherwise omits optionals), and pins `format` as a bare
  // string — the coerce-union shorthand. That drives the Go per-model conformance
  // to read the discriminator off the lowered `interface{}` field (Go BUG 2): a
  // direct `.Format.Kind` would not compile, so the read must type-assert + Save.
  @sample(#{ template: #{ content: "Hello {{name}}", format: "mustache" } })
  template?: Template;

  @doc("The model; `model.provider` is the process dispatch key. OPTIONAL → safe chained access.")
  `model`?: Model | string;

  @doc("Optional typed collection alongside value-backed fields.")
  templates?: Template[];

  @doc("Optional polymorphic collection; collection lowering must remain distinct from scalar value backing.")
  models?: Model[];
}

// --- Seam 1: Renderer — coerce-union discriminator + generic param -----------

@doc("Behavioral seam resolved by template dialect through a coerced, optional union, with a generic op param.")
@dispatch(FormatConfig.kind)
interface Renderer {
  @vector(#{
    name: "mustache-basic",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{ content: "Hello {{name}}", format: #{ format_kind: "mustache" } },
        `model`: #{ model_provider: "openai", id: "gpt-4" },
        templates: #[#{ content: "Hello {{name}}", format: "mustache" }],
        models: #[#{ model_provider: "openai", id: "gpt-4" }, "gpt-4-mini"],
      },
      template: "Hello {{name}}",
      inputs: #{ name: "world" },
    },
    expected: "renderer:mustache",
  })
  @vector(#{
    name: "jinja2-bare-string-format",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{ content: "Hello {{ name }}", format: "jinja2" },
        `model`: "gpt-4",
      },
      template: "Hello {{ name }}",
      inputs: #{ name: "world" },
    },
    expected: "renderer:jinja2",
  })
  @vector(#{
    name: "assistant_with_code_block",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{ content: "x", format: #{ format_kind: "jinja2" } },
        `model`: #{ model_provider: "openai", id: "gpt-4" },
      },
      template: "assistant:\nHere is code:\n```python\nprint('hello')\n```\n\nuser:\nThanks",
      inputs: #{ name: "world" },
    },
    expected: "renderer:jinja2",
  })
  @vector(#{
    name: "unknown-format-contoso",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{
          content: "x",
          format: #{ format_kind: "contoso", plugin: #{ tag: "alpha", enabled: true } }
        },
        `model`: #{ model_provider: "openai", id: "gpt-4" },
      },
      template: "x",
      inputs: #{},
    },
    expected: "renderer:wildcard:contoso:alpha",
  })
  @vector(#{
    name: "unknown-format-fabrikam",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{
          content: "x",
          format: #{ format_kind: "fabrikam", plugin: #{ tag: "beta", enabled: false } }
        },
        `model`: #{ model_provider: "openai", id: "gpt-4" },
      },
      template: "x",
      inputs: #{},
    },
    expected: "renderer:wildcard:fabrikam:beta",
  })
  @doc("Render the agent's template against the supplied inputs; `inputs` is a generic map.")
  render(agent: Agent, template: string, inputs: Record<unknown>): string;
}

// --- Seam 2: Processor — coerce-union discriminator via optional `model?` -----

@doc("Behavioral seam resolved by model provider through a coerced, optional union.")
@dispatch(Model.provider)
interface Processor {
  @vector(#{
    name: "openai-passthrough",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{ content: "x", format: #{ format_kind: "mustache" } },
        `model`: #{ model_provider: "openai", id: "gpt-4" },
      },
      response: #{ text: "hi" },
    },
    expected: #{ route: "processor:openai" },
  })
  @vector(#{
    name: "custom-bare-model",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{ content: "x", format: "mustache" },
        `model`: "gpt-4",
      },
      response: #{ text: "custom" },
    },
    expected: #{ route: "processor:wildcard" },
  })
  @doc("Process a raw provider response (bare `unknown`).")
  process(agent: Agent, response: unknown): unknown;
}

// Direct polymorphic roots exercise Rust's temporary-lifetime boundary.
@dispatch(FormatConfig.kind)
interface DirectRenderer {
  @vector(#{
    name: "direct-mustache",
    stage: "callable",
    input: #{ format: #{ format_kind: "mustache" }, template: "hello" },
    expected: "direct:mustache",
  })
  @vector(#{
    name: "direct-unknown-fallback",
    stage: "callable",
    input: #{
      format: #{ format_kind: "liquid", plugin: #{ tag: "gamma" } },
      template: "hello"
    },
    expected: "direct:wildcard:liquid:gamma",
  })
  render(format: FormatConfig, template: string): string;
}

// An optional operation head plus a nested path must safely fall back instead
// of dereferencing Option<Agent> in Rust or null in Java.
@dispatch(FormatConfig.kind)
interface OptionalRenderer {
  @vector(#{
    name: "optional-agent",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{ content: "hello", format: #{ format_kind: "mustache" } },
      },
      template: "hello",
    },
    expected: "optional:mustache",
  })
  render(agent?: Agent, template: string): string;
}

// --- Closed control: unknown values must reject, never use a wildcard --------

union ClosedKind {
  alpha: "alpha",
  beta: "beta",
}

@discriminator("kind")
model ClosedConfig {
  kind: ClosedKind;
}

model AlphaClosedConfig extends ClosedConfig {
  kind: "alpha";
}

model BetaClosedConfig extends ClosedConfig {
  kind: "beta";
}

@dispatch(ClosedConfig.kind)
interface ClosedRouter {
  @vector(#{
    name: "closed-known-alpha",
    stage: "callable",
    input: #{ config: #{ kind: "alpha" } },
    expected: "closed:alpha",
  })
  route(config: ClosedConfig): string;
}

// The rendered-code contract test invokes every emitted ClosedRouter resolver
// with the control input discriminator "contoso" and proves it rejects. Keeping
// the invalid closed value out of @vector avoids asking the typed harness to
// construct an input that the generated shape loader correctly refuses.

@doc("Fixture root aggregating the dispatched-seam graph.")
@serializable
model Root {
  @doc("The agent whose optional template + model carry the dispatch discriminators behind coerced unions.")
  agent: Agent;

  @doc("Required value-backed coerce union outside the dispatched path; guards required-field lowering without making @dispatch ambiguous.")
  requiredModel: Model | string;
}
