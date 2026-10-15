package typra.fixtures.features.dispatchdelegate;

public final class NoVectorMustacheRenderer implements RendererWithoutVectors {
  public String render(Request request) {
    return "no-vector-mustache:" + request.text;
  }
}
