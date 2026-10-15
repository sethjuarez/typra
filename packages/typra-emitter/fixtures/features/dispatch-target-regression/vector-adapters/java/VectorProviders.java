package typra.fixtures.features.dispatchtargetregression;

import java.util.LinkedHashMap;
import java.util.Map;

public final class VectorProviders {
  private VectorProviders() { }

  public static ClosedRouterProvider closedRouter() {
    return new ClosedRouterProvider() {
      public ClosedRouter alpha() { return config -> "closed:alpha"; }
      public ClosedRouter beta() { return config -> "closed:beta"; }
    };
  }

  public static RendererProvider renderer() {
    return new RendererProvider() {
      public Renderer jinja2() { return rendererImpl("renderer:jinja2"); }
      public Renderer mustache() { return rendererImpl("renderer:mustache"); }
      public Renderer wildcard() { return VectorProviders::wildcardRenderer; }
    };
  }

  public static ProcessorProvider processor() {
    return new ProcessorProvider() {
      public Processor openai() { return processorImpl("processor:openai"); }
      public Processor azure() { return processorImpl("processor:azure"); }
      public Processor wildcard() { return processorImpl("processor:wildcard"); }
    };
  }

  public static DirectRendererProvider directRenderer() {
    return new DirectRendererProvider() {
      public DirectRenderer jinja2() { return directRendererImpl("direct:jinja2"); }
      public DirectRenderer mustache() { return directRendererImpl("direct:mustache"); }
      public DirectRenderer wildcard() { return VectorProviders::wildcardDirectRenderer; }
    };
  }

  public static OptionalRendererProvider optionalRenderer() {
    return new OptionalRendererProvider() {
      public OptionalRenderer jinja2() { return optionalRendererImpl("optional:jinja2"); }
      public OptionalRenderer mustache() { return optionalRendererImpl("optional:mustache"); }
      public OptionalRenderer wildcard() { return optionalRendererImpl("optional:wildcard"); }
    };
  }

  private static Renderer rendererImpl(String route) {
    return (agent, template, inputs) -> route;
  }

  private static String wildcardRenderer(
      Agent agent, String template, Map<String, Object> inputs) {
    return wildcardRoute("renderer", agent.template.format);
  }

  private static Processor processorImpl(String route) {
    return (agent, response) -> {
      Map<String, Object> result = new LinkedHashMap<>();
      result.put("route", route);
      return result;
    };
  }

  private static DirectRenderer directRendererImpl(String route) {
    return (format, template) -> route;
  }

  private static String wildcardDirectRenderer(FormatConfig format, String template) {
    return wildcardRoute("direct", format);
  }

  @SuppressWarnings("unchecked")
  private static String wildcardRoute(String prefix, FormatConfig format) {
    Map<String, Object> wire = format.save(null);
    Map<String, Object> plugin = (Map<String, Object>) wire.get("plugin");
    return prefix + ":wildcard:" + wire.get("format_kind") + ":" + plugin.get("tag");
  }

  private static OptionalRenderer optionalRendererImpl(String route) {
    return (agent, template) -> route;
  }
}
