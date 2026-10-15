using System.Threading.Tasks;
using Typra.Fixtures.Features.DispatchDelegate;

namespace Typra.Fixtures.Features.DispatchDelegate.Conformance;

public sealed class Jinja2Renderer : IRenderer
{
    public Task<string> RenderAsync(Request request) => Task.FromResult($"jinja2:{request.Text}");
}
public sealed class MustacheRenderer : IRenderer
{
    public Task<string> RenderAsync(Request request) => Task.FromResult($"mustache:{request.Text}");
}
public sealed class CustomRenderer : IRenderer
{
    public Task<string> RenderAsync(Request request) => Task.FromResult($"custom:{request.Text}");
}
public sealed class NoVectorJinja2Renderer : IRendererWithoutVectors
{
    public Task<string> RenderAsync(Request request) => Task.FromResult($"no-vector-jinja2:{request.Text}");
}
public sealed class NoVectorMustacheRenderer : IRendererWithoutVectors
{
    public Task<string> RenderAsync(Request request) => Task.FromResult($"no-vector-mustache:{request.Text}");
}
public sealed class NoVectorCustomRenderer : IRendererWithoutVectors
{
    public Task<string> RenderAsync(Request request) => Task.FromResult($"no-vector-custom:{request.Text}");
}
public sealed class TypeRenderer : IMetaRenderer
{
    public Task<string> RenderAsync(MetaRequest request) => Task.FromResult("type");
}
public sealed class KindRenderer : IMetaRenderer
{
    public Task<string> RenderAsync(MetaRequest request) => Task.FromResult("kind");
}
