import type { MetaRenderer } from "../meta-renderer";
import type { Renderer } from "../renderer";
import type { RendererWithoutVectors } from "../renderer-without-vectors";

export class Jinja2Renderer implements Renderer {
  async render(request: any): Promise<string> { return `jinja2:${request.text}`; }
}
export class MustacheRenderer implements Renderer {
  async render(request: any): Promise<string> { return `mustache:${request.text}`; }
}
export class CustomRenderer implements Renderer {
  async render(request: any): Promise<string> { return `custom:${request.text}`; }
}
export class NoVectorJinja2Renderer implements RendererWithoutVectors {
  async render(request: any): Promise<string> { return `no-vector-jinja2:${request.text}`; }
}
export class NoVectorMustacheRenderer implements RendererWithoutVectors {
  async render(request: any): Promise<string> { return `no-vector-mustache:${request.text}`; }
}
export class NoVectorCustomRenderer implements RendererWithoutVectors {
  async render(request: any): Promise<string> { return `no-vector-custom:${request.text}`; }
}
export class TypeRenderer implements MetaRenderer {
  async render(_request: any): Promise<string> { return "type"; }
}
export class KindRenderer implements MetaRenderer {
  async render(_request: any): Promise<string> { return "kind"; }
}
