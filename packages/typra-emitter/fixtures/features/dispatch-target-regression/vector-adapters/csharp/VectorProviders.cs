#nullable enable
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Typra.Fixtures.Features.DispatchTargetRegression.Conformance;

using Typra.Fixtures.Features.DispatchTargetRegression;

public static class VectorProviders
{
    public static IClosedRouterProvider ClosedRouter() => new ClosedRouterProvider();
    public static IRendererProvider Renderer() => new RendererProvider();
    public static IProcessorProvider Processor() => new ProcessorProvider();
    public static IDirectRendererProvider DirectRenderer() => new DirectRendererProvider();
    public static IOptionalRendererProvider OptionalRenderer() => new OptionalRendererProvider();

    private sealed class ClosedRouterProvider : IClosedRouterProvider
    {
        public IClosedRouter Alpha { get; } = new ClosedRouterImpl("closed:alpha");
        public IClosedRouter Beta { get; } = new ClosedRouterImpl("closed:beta");
    }

    private sealed class RendererProvider : IRendererProvider
    {
        public IRenderer Jinja2 { get; } = new RendererImpl("renderer:jinja2");
        public IRenderer Mustache { get; } = new RendererImpl("renderer:mustache");
        public IRenderer Wildcard { get; } = new WildcardRendererImpl();
    }

    private sealed class ProcessorProvider : IProcessorProvider
    {
        public IProcessor Openai { get; } = new ProcessorImpl("processor:openai");
        public IProcessor Azure { get; } = new ProcessorImpl("processor:azure");
        public IProcessor Wildcard { get; } = new ProcessorImpl("processor:wildcard");
    }

    private sealed class DirectRendererProvider : IDirectRendererProvider
    {
        public IDirectRenderer Jinja2 { get; } = new DirectRendererImpl("direct:jinja2");
        public IDirectRenderer Mustache { get; } = new DirectRendererImpl("direct:mustache");
        public IDirectRenderer Wildcard { get; } = new WildcardDirectRendererImpl();
    }

    private sealed class OptionalRendererProvider : IOptionalRendererProvider
    {
        public IOptionalRenderer Jinja2 { get; } = new OptionalRendererImpl("optional:jinja2");
        public IOptionalRenderer Mustache { get; } = new OptionalRendererImpl("optional:mustache");
        public IOptionalRenderer Wildcard { get; } = new OptionalRendererImpl("optional:wildcard");
    }

    private sealed class RendererImpl(string route) : IRenderer
    {
        public Task<string> RenderAsync(Agent agent, string template, Dictionary<string, object?> inputs) =>
            Task.FromResult(route);
    }

    private sealed class ClosedRouterImpl(string route) : IClosedRouter
    {
        public Task<string> RouteAsync(ClosedConfig config) => Task.FromResult(route);
    }

    private sealed class WildcardRendererImpl : IRenderer
    {
        public Task<string> RenderAsync(Agent agent, string template, Dictionary<string, object?> inputs) =>
            Task.FromResult(WildcardRoute("renderer", agent.Template!.Format));
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

    private sealed class WildcardDirectRendererImpl : IDirectRenderer
    {
        public Task<string> RenderAsync(FormatConfig format, string template) =>
            Task.FromResult(WildcardRoute("direct", format));
    }

    private sealed class OptionalRendererImpl(string route) : IOptionalRenderer
    {
        public Task<string> RenderAsync(Agent? agent, string template) =>
            Task.FromResult(route);
    }

    private static string WildcardRoute(string prefix, FormatConfig format)
    {
        var wire = format.Save();
        var plugin = (Dictionary<string, object?>)wire["plugin"]!;
        return $"{prefix}:wildcard:{wire["format_kind"]}:{plugin["tag"]}";
    }
}
