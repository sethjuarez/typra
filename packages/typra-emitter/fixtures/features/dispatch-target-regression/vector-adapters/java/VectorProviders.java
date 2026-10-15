package typra.fixtures.features.dispatchtargetregression;

import java.util.LinkedHashMap;
import java.util.Map;

public final class VectorProviders {
  private VectorProviders() { }

  public static RendererProvider renderer() {
    return new RendererProvider() {
      public Renderer jinja2() { return rendererImpl("renderer:jinja2"); }
      public Renderer mustache() { return rendererImpl("renderer:mustache"); }
      public Renderer custom() { return rendererImpl("renderer:custom"); }
    };
  }

  public static ProcessorProvider processor() {
    return new ProcessorProvider() {
      public Processor openai() { return processorImpl("processor:openai"); }
      public Processor azure() { return processorImpl("processor:azure"); }
      public Processor custom() { return processorImpl("processor:custom"); }
    };
  }

  public static DirectRendererProvider directRenderer() {
    return new DirectRendererProvider() {
      public DirectRenderer jinja2() { return directRendererImpl("direct:jinja2"); }
      public DirectRenderer mustache() { return directRendererImpl("direct:mustache"); }
      public DirectRenderer custom() { return directRendererImpl("direct:custom"); }
    };
  }

  public static OptionalRendererProvider optionalRenderer() {
    return new OptionalRendererProvider() {
      public OptionalRenderer jinja2() { return optionalRendererImpl("optional:jinja2"); }
      public OptionalRenderer mustache() { return optionalRendererImpl("optional:mustache"); }
      public OptionalRenderer custom() { return optionalRendererImpl("optional:custom"); }
    };
  }

  private static Renderer rendererImpl(String route) {
    return (agent, template, inputs) -> route;
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

  private static OptionalRenderer optionalRendererImpl(String route) {
    return (agent, template) -> route;
  }
}
