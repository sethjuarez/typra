package typra.fixtures.features.dispatchdelegate;

public final class NoVectorJinja2Renderer implements RendererWithoutVectors {
  public String render(Request request) {
    return "no-vector-jinja2:" + request.text;
  }
}
