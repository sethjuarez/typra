import "@typra/emitter";

namespace Typra.Fixtures.Features.DispatchTargetRegression;

// ===========================================================================
// Language-target regression seam for four emitter bugs that only surface in
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
//   Swift#3 — `agent.template?`/`agent.model?` are OPTIONAL, so the discriminator
//            accessor navigating to the union's `.save()` must force-unwrap:
//            `agent.template!.format` / `agent.model!`.
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

@doc("An agent whose template and model are OPTIONAL — the optionality that forces the Swift accessor to unwrap.")
model Agent {
  @doc("Human-facing agent name.")
  name: string;

  @doc("The template; `template.format.kind` is the render dispatch key. OPTIONAL → Swift `agent.template!`.")
  // The @sample carries the optional `template` into the per-model conformance
  // payload (synthesis otherwise omits optionals), and pins `format` as a bare
  // string — the coerce-union shorthand. That drives the Go per-model conformance
  // to read the discriminator off the lowered `interface{}` field (Go BUG 2): a
  // direct `.Format.Kind` would not compile, so the read must type-assert + Save.
  @sample(#{ template: #{ content: "Hello {{name}}", format: "mustache" } })
  template?: Template;

  @doc("The model; `model.provider` is the process dispatch key. OPTIONAL → Swift `agent.model!`.")
  `model`?: Model | string;
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
        template: #{ content: "Hello {{name}}", format: #{ kind: "mustache" } },
        `model`: #{ provider: "openai", id: "gpt-4" },
      },
      template: "Hello {{name}}",
      inputs: #{ name: "world" },
    },
    expected: "Hello world",
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
    expected: "Hello world",
  })
  @vector(#{
    name: "assistant_with_code_block",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{ content: "x", format: #{ kind: "jinja2" } },
        `model`: #{ provider: "openai", id: "gpt-4" },
      },
      template: "assistant:\nHere is code:\n```python\nprint('hello')\n```\n\nuser:\nThanks",
      inputs: #{ name: "world" },
    },
    expected: "ok",
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
  @doc("The agent whose optional template + model carry the dispatch discriminators behind coerced unions.")
  agent: Agent;
}
