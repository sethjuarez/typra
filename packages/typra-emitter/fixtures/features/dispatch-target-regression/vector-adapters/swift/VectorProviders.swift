import Foundation
import TypraFixturesFeaturesDispatchTargetRegression

private struct ClosedRouterImpl: ClosedRouter {
  let routeValue: String
  func route(config: ClosedConfig) async throws -> String { routeValue }
}

private struct RendererImpl: Renderer {
  let route: String
  func render(agent: Agent, template: String, inputs: [String: Any]) async throws -> String {
    route
  }
}

private struct WildcardRendererImpl: Renderer {
  func render(agent: Agent, template: String, inputs: [String: Any]) async throws -> String {
    try wildcardRoute("renderer", agent.template!.format)
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

private struct WildcardDirectRendererImpl: DirectRenderer {
  func render(format: FormatConfig, template: String) async throws -> String {
    try wildcardRoute("direct", format)
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
  let wildcard: any Renderer = WildcardRendererImpl()
}

private struct ClosedRouterProviderImpl: ClosedRouterProvider {
  let alpha: (any ClosedRouter)? = ClosedRouterImpl(routeValue: "closed:alpha")
  let beta: (any ClosedRouter)? = ClosedRouterImpl(routeValue: "closed:beta")
}

private struct ProcessorProviderImpl: ProcessorProvider {
  let openai: (any Processor)? = ProcessorImpl(route: "processor:openai")
  let azure: (any Processor)? = ProcessorImpl(route: "processor:azure")
  let wildcard: any Processor = ProcessorImpl(route: "processor:wildcard")
}

private struct DirectRendererProviderImpl: DirectRendererProvider {
  let jinja2: (any DirectRenderer)? = DirectRendererImpl(route: "direct:jinja2")
  let mustache: (any DirectRenderer)? = DirectRendererImpl(route: "direct:mustache")
  let wildcard: any DirectRenderer = WildcardDirectRendererImpl()
}

private struct OptionalRendererProviderImpl: OptionalRendererProvider {
  let jinja2: (any OptionalRenderer)? = OptionalRendererImpl(route: "optional:jinja2")
  let mustache: (any OptionalRenderer)? = OptionalRendererImpl(route: "optional:mustache")
  let wildcard: any OptionalRenderer = OptionalRendererImpl(route: "optional:wildcard")
}

private func wildcardRoute(_ prefix: String, _ format: FormatConfig) throws -> String {
  let wire = try format.save()
  let plugin = wire["plugin"] as! [String: Any]
  return "\(prefix):wildcard:\(wire["format_kind"]!):\(plugin["tag"]!)"
}

enum VectorProviders {
  static func closedRouter() -> any ClosedRouterProvider { ClosedRouterProviderImpl() }
  static func renderer() -> any RendererProvider { RendererProviderImpl() }
  static func processor() -> any ProcessorProvider { ProcessorProviderImpl() }
  static func directRenderer() -> any DirectRendererProvider { DirectRendererProviderImpl() }
  static func optionalRenderer() -> any OptionalRendererProvider { OptionalRendererProviderImpl() }
}
