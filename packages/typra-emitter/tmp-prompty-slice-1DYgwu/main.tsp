import "@typra/emitter";

namespace Typra.PromptySlice;

model Root {
  name: string;
}

model RenderRequest {
  template: string;
  variables?: Record<unknown>;
}

model RenderResult {
  instructions: string;
}

model ParseRequest {
  content: string;
}

model ParseResult {
  messages: string[];
}

model ProcessRequest {
  text: string;
}

model ProcessResult {
  value: string;
}

const RenderVectors = #[
  #{ name: "frontmatter-body", stage: "render", provider: "prompty", targetApi: "local", portability: "portable", normalization: #{ trailingNewline: "trim" }, input: #{ request: #{ template: "Hello {{name}}", variables: #{ name: "Typra" } } }, expected: #{ instructions: "Hello Typra" } }
];

interface Renderer {
  @vector(RenderVectors)
  render(request: RenderRequest): RenderResult;
}

interface Parser {
  @vector(#{ name: "markdown-body", stage: "parse", input: #{ request: #{ content: "---\nname: demo\n---\nHello" } }, expected: #{ messages: #["Hello"] } })
  parse(request: ParseRequest): ParseResult;
}

interface Processor {
  @vector(#{ name: "extract-text", stage: "process", input: #{ request: #{ text: "hello" } }, expected: #{ value: "hello" } })
  process(request: ProcessRequest): ProcessResult;
}

interface Harness {
  @vector(#{ name: "replay-mismatch", stage: "replay", input: #{ request: #{ text: "" } }, expectedError: #{ code: "replay-drift" } })
  verify(request: ProcessRequest): ProcessResult;
}
