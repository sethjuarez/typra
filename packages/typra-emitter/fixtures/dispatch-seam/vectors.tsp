import "@typra/emitter";

namespace Typra.Fixtures.DispatchSeam;

// ===========================================================================
// Executable vectors for the dispatched Renderer seam, as named value objects.
//
// The shape (main.tsp) imports this file and decorates `Renderer.render` with
// `@vector(mustacheBasic)` / `@vector(jinja2Basic)`, keeping the input → expected
// cases out of the interface declaration while still applying them at the seam.
//
// Each case selects a concrete dialect through `agent.template.format.kind` —
// the same access path @dispatch resolves the Renderer on.
// ===========================================================================

// Mustache dialect render case: partials on, simple substitution.
const mustacheBasic = #{
  name: "mustache-basic",
  stage: "callable",
  input: #{
    agent: #{
      name: "greeter",
      template: #{
        content: "Hello {{name}}",
        format: #{ kind: "mustache", partialsEnabled: true },
      },
    },
    inputs: #{ values: #{ name: "world" } },
  },
  expected: "Hello world",
};

// Jinja2 dialect render case: autoescape on, spaced substitution.
const jinja2Basic = #{
  name: "jinja2-basic",
  stage: "callable",
  input: #{
    agent: #{
      name: "greeter",
      template: #{
        content: "Hello {{ name }}",
        format: #{ kind: "jinja2", autoescape: true },
      },
    },
    inputs: #{ values: #{ name: "world" } },
  },
  expected: "Hello world",
};
