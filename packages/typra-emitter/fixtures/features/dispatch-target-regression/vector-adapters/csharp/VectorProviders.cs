#nullable enable
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Typra.Fixtures.Features.DispatchTargetRegression.Conformance;

using Typra.Fixtures.Features.DispatchTargetRegression;

public static class VectorProviders
{
    public static IRendererProvider Renderer() => new RendererProvider();
    public static IProcessorProvider Processor() => new ProcessorProvider();
    public static IDirectRendererProvider DirectRenderer() => new DirectRendererProvider();
    public static IOptionalRendererProvider OptionalRenderer() => new OptionalRendererProvider();

    private sealed class RendererProvider : IRendererProvider
    {
        public IRenderer Jinja2 { get; } = new RendererImpl("renderer:jinja2");
        public IRenderer Mustache { get; } = new RendererImpl("renderer:mustache");
        public IRenderer Custom { get; } = new RendererImpl("renderer:custom");
    }

    private sealed class ProcessorProvider : IProcessorProvider
    {
        public IProcessor Openai { get; } = new ProcessorImpl("processor:openai");
        public IProcessor Azure { get; } = new ProcessorImpl("processor:azure");
        public IProcessor Custom { get; } = new ProcessorImpl("processor:custom");
    }

    private sealed class DirectRendererProvider : IDirectRendererProvider
    {
        public IDirectRenderer Jinja2 { get; } = new DirectRendererImpl("direct:jinja2");
        public IDirectRenderer Mustache { get; } = new DirectRendererImpl("direct:mustache");
        public IDirectRenderer Custom { get; } = new DirectRendererImpl("direct:custom");
    }

    private sealed class OptionalRendererProvider : IOptionalRendererProvider
    {
        public IOptionalRenderer Jinja2 { get; } = new OptionalRendererImpl("optional:jinja2");
        public IOptionalRenderer Mustache { get; } = new OptionalRendererImpl("optional:mustache");
        public IOptionalRenderer Custom { get; } = new OptionalRendererImpl("optional:custom");
    }

    private sealed class RendererImpl(string route) : IRenderer
    {
        public Task<string> RenderAsync(Agent agent, string template, Dictionary<string, object?> inputs) =>
            Task.FromResult(route);
    }

    private sealed class ProcessorImpl(string route) : IProcessor
    {
        public Task<object> ProcessAsync(Agent agent, object response) =>
            Task.FromResult<object>(new Dictionary<string, object?> { ["route"] = route });
    }

    private sealed class DirectRendererImpl(string route) : IDirectRenderer
    {
        public Task<string> RenderAsync(FormatConfig format, string template) =>
            Task.FromResult(route);
    }

    private sealed class OptionalRendererImpl(string route) : IOptionalRenderer
    {
        public Task<string> RenderAsync(Agent? agent, string template) =>
            Task.FromResult(route);
    }
}
