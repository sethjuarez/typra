import Foundation
import TypraFixturesFeaturesDispatchTargetRegression

private struct RendererImpl: Renderer {
  let route: String
  func render(agent: Agent, template: String, inputs: [String: Any]) async throws -> String {
    route
  }
}

private struct ProcessorImpl: Processor {
  let route: String
  func process(agent: Agent, response: Any) async throws -> Any {
    ["route": route]
  }
}

private struct DirectRendererImpl: DirectRenderer {
  let route: String
  func render(format: FormatConfig, template: String) async throws -> String {
    route
  }
}

private struct OptionalRendererImpl: OptionalRenderer {
  let route: String
  func render(agent: Agent?, template: String) async throws -> String {
    route
  }
}

private struct RendererProviderImpl: RendererProvider {
  let jinja2: (any Renderer)? = RendererImpl(route: "renderer:jinja2")
  let mustache: (any Renderer)? = RendererImpl(route: "renderer:mustache")
  let custom: (any Renderer)? = RendererImpl(route: "renderer:custom")
}

private struct ProcessorProviderImpl: ProcessorProvider {
  let openai: (any Processor)? = ProcessorImpl(route: "processor:openai")
  let azure: (any Processor)? = ProcessorImpl(route: "processor:azure")
  let custom: (any Processor)? = ProcessorImpl(route: "processor:custom")
}

private struct DirectRendererProviderImpl: DirectRendererProvider {
  let jinja2: (any DirectRenderer)? = DirectRendererImpl(route: "direct:jinja2")
  let mustache: (any DirectRenderer)? = DirectRendererImpl(route: "direct:mustache")
  let custom: (any DirectRenderer)? = DirectRendererImpl(route: "direct:custom")
}

private struct OptionalRendererProviderImpl: OptionalRendererProvider {
  let jinja2: (any OptionalRenderer)? = OptionalRendererImpl(route: "optional:jinja2")
  let mustache: (any OptionalRenderer)? = OptionalRendererImpl(route: "optional:mustache")
  let custom: (any OptionalRenderer)? = OptionalRendererImpl(route: "optional:custom")
}

enum VectorProviders {
  static func renderer() -> any RendererProvider { RendererProviderImpl() }
  static func processor() -> any ProcessorProvider { ProcessorProviderImpl() }
  static func directRenderer() -> any DirectRendererProvider { DirectRendererProviderImpl() }
  static func optionalRenderer() -> any OptionalRendererProvider { OptionalRendererProviderImpl() }
}
