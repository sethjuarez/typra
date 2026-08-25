import "@typra/emitter";

namespace Typra.Fixtures.Features.Dispatch;

// The discriminator field lives on an ambient config model, several hops away
// from the seam parameter (`agent.template.format.kind`). `@dispatch` resolves
// that access path deterministically; the engine is never a seam parameter.
model TemplateFormat {
  kind: string;
  parser: string;
}

model Template {
  format: TemplateFormat;
  content: string;
}

model Agent {
  template: Template;
  name: string;
}

model Inputs {
  values: Record<unknown>;
}

// `Renderer` is resolved at runtime by the value of `TemplateFormat.kind`,
// reachable only through the `agent` parameter — `inputs` does not reach it, so
// the path is uniquely `agent.template.format.kind`. Seam methods stay key-free.
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
          format: #{ kind: "mustache", parser: "mustache" }
        }
      },
      inputs: #{ values: #{ name: "world" } }
    },
    expected: "Hello world"
  })
  @vector(#{
    name: "jinja2-basic",
    stage: "callable",
    input: #{
      agent: #{
        name: "greeter",
        template: #{
          content: "Hello {{ name }}",
          format: #{ kind: "jinja2", parser: "jinja2" }
        }
      },
      inputs: #{ values: #{ name: "world" } }
    },
    expected: "Hello world"
  })
  render(agent: Agent, inputs: Inputs): string;
}

model Root {
  agent: Agent;
}
