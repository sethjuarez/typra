package typra.fixtures.features.dispatchdelegate;

public final class CustomRenderer implements Renderer, RendererWithoutVectors {
  public String render(Request request) {
    return "custom:" + request.text;
  }
}
