package typra.fixtures.features.dispatchdelegate;

public final class NoVectorCustomRenderer implements RendererWithoutVectors {
  public String render(Request request) {
    return "no-vector-custom:" + request.text;
  }
}
