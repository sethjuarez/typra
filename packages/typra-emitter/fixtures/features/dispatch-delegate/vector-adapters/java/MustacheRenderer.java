package typra.fixtures.features.dispatchdelegate;

public final class MustacheRenderer implements Renderer, RendererWithoutVectors {
  public String render(Request request) {
    return "mustache:" + request.text;
  }
}
