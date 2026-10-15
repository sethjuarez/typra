package typra.fixtures.features.dispatchdelegate;

public final class Jinja2Renderer implements Renderer, RendererWithoutVectors {
  public String render(Request request) {
    return "jinja2:" + request.text;
  }
}
