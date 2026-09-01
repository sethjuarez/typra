// Committed consumer double for the C# typed @vector conformance entrypoint
// (issue #511 Cat 1). This file is NOT emitted — it is what a real consumer
// authors: genuine typed seam impls plus a single typed call into the emitted
// VectorConformance.Run<Seam>ConformanceAsync. Because the entrypoint takes the
// I<Seam> interface, a forgotten op cannot compile, so this xUnit test only
// passes once the emitter emits the entrypoint (red-first on `main`).
// Transformer covers the scalar rail; Reviser covers the Phase 2
// model-in/model-out rail (its boundary model Note is in the @serializable
// closure, so the entrypoint decodes via Note.FromJson and compares via ToJson).
#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
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

/// <summary>A real typed Reviser impl — upper-cases the note title, passes the
/// body through. The note arrives decoded (Note.FromJson); mutate and return it
/// so the result stays a Note for the entrypoint's ToJson compare.</summary>
file sealed class ReviserImpl : IReviser
{
    public Task<Note> ReviseAsync(Note note)
    {
        note.Title = note.Title.ToUpperInvariant();
        return Task.FromResult(note);
    }
}

/// <summary>A real typed Collator impl — reverses the notes, each passing
/// through unchanged. The notes arrive decoded (per-element Note.FromJson);
/// return a List&lt;Note&gt; so the entrypoint's per-element ToJson compare stays
/// canonical.</summary>
file sealed class CollatorImpl : ICollator
{
    public Task<List<Note>> CollateAsync(List<Note> notes)
    {
        return Task.FromResult(notes.AsEnumerable().Reverse().ToList());
    }
}

public class TypedConformanceTests
{
    [Fact]
    public async Task TransformerTypedConformance()
    {
        await VectorConformance.RunTransformerConformanceAsync(new TransformerImpl());
    }

    [Fact]
    public async Task ReviserTypedConformance()
    {
        await VectorConformance.RunReviserConformanceAsync(new ReviserImpl());
    }

    [Fact]
    public async Task CollatorTypedConformance()
    {
        await VectorConformance.RunCollatorConformanceAsync(new CollatorImpl());
    }
}
