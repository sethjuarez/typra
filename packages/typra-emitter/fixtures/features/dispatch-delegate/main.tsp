import "@typra/emitter";

namespace Typra.Fixtures.Features.DispatchDelegate;

union FormatKind {
  jinja2: "jinja2";
  mustache: "mustache";
  string;
}

@discriminator("kind")
model Format {
  @encodedName("application/json", "format_kind")
  kind: FormatKind = "*";
}

model Jinja2Format extends Format {
  kind: "jinja2";
}

model MustacheFormat extends Format {
  kind: "mustache";
}

model CustomFormat extends Format {
  kind: "*";
}

model Request {
  format: Format;
  text: string;
}

@dispatch(Format.kind)
@delegate(#{
  jinja2: "Jinja2Renderer",
  mustache: "MustacheRenderer",
  wildcard: "CustomRenderer",
})
interface Renderer {
  @vector(#{
    name: "jinja2",
    stage: "callable",
    input: #{ request: #{ format: #{ format_kind: "jinja2" }, text: "hi" } },
    expected: "jinja2:hi",
  })
  render(request: Request): string;
}

@dispatch(Format.kind)
@delegate(#{
  jinja2: "NoVectorJinja2Renderer",
  mustache: "NoVectorMustacheRenderer",
  wildcard: "NoVectorCustomRenderer",
})
interface RendererWithoutVectors {
  render(request: Request): string;
}

namespace Nested {
  @dispatch(Format.kind)
  interface ConsumerOwnedRenderer {
    @vector(#{
      name: "consumer-owned-jinja2",
      stage: "callable",
      input: #{ request: #{ format: #{ format_kind: "jinja2" }, text: "hi" } },
      expected: "jinja2:hi",
    })
    render(request: Request): string;
  }
}

@discriminator("category")
model MetaFormat {
  category: "type" | "kind";
}

model TypeFormat extends MetaFormat {
  category: "type";
}

model KindFormat extends MetaFormat {
  category: "kind";
}

model MetaRequest {
  format: MetaFormat;
}

@dispatch(MetaFormat.category)
@delegate(#{ type: "TypeRenderer", kind: "KindRenderer" })
interface MetaRenderer {
  render(request: MetaRequest): string;
}

@serializable
model Root {
  request: Request;
  meta: MetaRequest;
}
