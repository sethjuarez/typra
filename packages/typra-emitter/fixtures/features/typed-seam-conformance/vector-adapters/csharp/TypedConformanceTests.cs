// Committed consumer double for the C# typed @vector conformance entrypoint
// (issue #511 Cat 1). This file is NOT emitted — it is what a real consumer
// authors: a genuine typed seam impl plus a single typed call into the emitted
// VectorConformance.Run<Seam>ConformanceAsync. Because the entrypoint takes the
// ITransformer interface, a forgotten op cannot compile, so this xUnit test
// only passes once the emitter emits the entrypoint (red-first on `main`).
#nullable enable
using System;
using System.Threading.Tasks;
using Typra.Fixtures.Features.TypedSeamConformance;
using Xunit;

namespace Typra.Fixtures.Features.TypedSeamConformance.ConformanceTests;

/// <summary>A real typed Transformer impl — trims, and rejects "boom".</summary>
file sealed class TransformerImpl : ITransformer
{
    public Task<string> TransformAsync(string text)
    {
        if (text == "boom")
        {
            throw new InvalidOperationException("boom not allowed");
        }

        return Task.FromResult(text.Trim());
    }
}

public class TypedConformanceTests
{
    [Fact]
    public async Task TransformerTypedConformance()
    {
        await VectorConformance.RunTransformerConformanceAsync(new TransformerImpl());
    }
}
