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

// `model` is a TypeSpec keyword, so it is only authorable as a field via a
// quoted key. Object-value literals (`#{ ... }`) cannot express such keys at
// all, nor can they carry opaque provider wire payloads with arbitrary keys.
model ProviderConfig {
  id: string = "";
  provider?: string;
}

model CallRequest {
  "model"?: ProviderConfig;
}

interface Processor {
  // A JSON-string vector set is the blessed escape hatch for inputs whose
  // domain models carry keyword field names (`model`) and that replay raw
  // provider wire payloads as evidence.
  @vector(WirePayloadVectors)
  process(request: CallRequest, response: unknown): unknown;
}

model Root {
  request: RenderRequest;
}
