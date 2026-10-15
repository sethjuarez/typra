import TypraFixturesFeaturesDispatchDelegate

struct Jinja2Renderer: Renderer {
  func render(request: Request) async throws -> String { "jinja2:\(request.text)" }
}
struct MustacheRenderer: Renderer {
  func render(request: Request) async throws -> String { "mustache:\(request.text)" }
}
struct CustomRenderer: Renderer {
  func render(request: Request) async throws -> String { "custom:\(request.text)" }
}
struct NoVectorJinja2Renderer: RendererWithoutVectors {
  func render(request: Request) async throws -> String { "no-vector-jinja2:\(request.text)" }
}
struct NoVectorMustacheRenderer: RendererWithoutVectors {
  func render(request: Request) async throws -> String { "no-vector-mustache:\(request.text)" }
}
struct NoVectorCustomRenderer: RendererWithoutVectors {
  func render(request: Request) async throws -> String { "no-vector-custom:\(request.text)" }
}
struct TypeRenderer: MetaRenderer {
  func render(request: MetaRequest) async throws -> String { "type" }
}
struct KindRenderer: MetaRenderer {
  func render(request: MetaRequest) async throws -> String { "kind" }
}
