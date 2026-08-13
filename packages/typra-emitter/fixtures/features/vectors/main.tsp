import "@typra/emitter";
import "./vector-items.tsp";

namespace Typra.Fixtures.Features.Vectors;

model RenderRequest {
  prompt: string;
  context: Record<unknown>;
}

model RenderResult {
  text: string;
  tokens: int32;
}

interface Renderer {
  @vector(#{
    name: "inline-success",
    stage: "callable",
    input: #{ request: #{ prompt: "hello inline", context: #{ locale: "en-US" } } },
    expected: #{ text: "hello inline", tokens: 2 }
  })
  @vector(FileBackedRenderVectors)
  render(request: RenderRequest): RenderResult;
}

model Root {
  request: RenderRequest;
}
