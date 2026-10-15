import type { ClosedRouter } from "../closed-router";
import type { DirectRenderer } from "../direct-renderer";
import type { OptionalRenderer } from "../optional-renderer";
import type { Processor } from "../processor";
import type { Renderer } from "../renderer";
import type { ClosedRouterProvider } from "../closed-router-resolver";
import type { DirectRendererProvider } from "../direct-renderer-resolver";
import type { OptionalRendererProvider } from "../optional-renderer-resolver";
import type { ProcessorProvider } from "../processor-resolver";
import type { RendererProvider } from "../renderer-resolver";

const renderer = (route: string): Renderer => ({
  async render() {
    return route;
  },
});

const closedRouter = (route: string): ClosedRouter => ({
  async route() {
    return route;
  },
});

export const closedRouterProvider: ClosedRouterProvider = {
  alpha: closedRouter("closed:alpha"),
  beta: closedRouter("closed:beta"),
};

const wildcardRenderer: Renderer = {
  async render(agent) {
    const wire = agent.template!.format.save();
    const plugin = wire.plugin as Record<string, unknown>;
    return `renderer:wildcard:${String(wire.format_kind)}:${String(plugin.tag)}`;
  },
};

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

const wildcardDirectRenderer: DirectRenderer = {
  async render(format) {
    const wire = format.save();
    const plugin = wire.plugin as Record<string, unknown>;
    return `direct:wildcard:${String(wire.format_kind)}:${String(plugin.tag)}`;
  },
};

const optionalRenderer = (route: string): OptionalRenderer => ({
  async render() {
    return route;
  },
});

export const rendererProvider: RendererProvider = {
  jinja2: renderer("renderer:jinja2"),
  mustache: renderer("renderer:mustache"),
  wildcard: wildcardRenderer,
};

export const processorProvider: ProcessorProvider = {
  azure: processor("processor:azure"),
  openai: processor("processor:openai"),
  wildcard: processor("processor:wildcard"),
};

export const directRendererProvider: DirectRendererProvider = {
  jinja2: directRenderer("direct:jinja2"),
  mustache: directRenderer("direct:mustache"),
  wildcard: wildcardDirectRenderer,
};

export const optionalRendererProvider: OptionalRendererProvider = {
  jinja2: optionalRenderer("optional:jinja2"),
  mustache: optionalRenderer("optional:mustache"),
  wildcard: optionalRenderer("optional:wildcard"),
};
