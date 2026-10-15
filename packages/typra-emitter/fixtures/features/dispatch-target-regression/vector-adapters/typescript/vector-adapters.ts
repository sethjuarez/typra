import type { DirectRenderer } from "../direct-renderer";
import type { OptionalRenderer } from "../optional-renderer";
import type { Processor } from "../processor";
import type { Renderer } from "../renderer";
import type { DirectRendererProvider } from "../direct-renderer-resolver";
import type { OptionalRendererProvider } from "../optional-renderer-resolver";
import type { ProcessorProvider } from "../processor-resolver";
import type { RendererProvider } from "../renderer-resolver";

const renderer = (route: string): Renderer => ({
  async render() {
    return route;
  },
});

const processor = (route: string): Processor => ({
  async process() {
    return { route };
  },
});

const directRenderer = (route: string): DirectRenderer => ({
  async render() {
    return route;
  },
});

const optionalRenderer = (route: string): OptionalRenderer => ({
  async render() {
    return route;
  },
});

export const rendererProvider: RendererProvider = {
  jinja2: renderer("renderer:jinja2"),
  mustache: renderer("renderer:mustache"),
  custom: renderer("renderer:custom"),
};

export const processorProvider: ProcessorProvider = {
  azure: processor("processor:azure"),
  openai: processor("processor:openai"),
  custom: processor("processor:custom"),
};

export const directRendererProvider: DirectRendererProvider = {
  jinja2: directRenderer("direct:jinja2"),
  mustache: directRenderer("direct:mustache"),
  custom: directRenderer("direct:custom"),
};

export const optionalRendererProvider: OptionalRendererProvider = {
  jinja2: optionalRenderer("optional:jinja2"),
  mustache: optionalRenderer("optional:mustache"),
  custom: optionalRenderer("optional:custom"),
};
