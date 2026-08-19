// Reference adapters for the integration fixture's @vector suite. Copied into
// the C# target's tests/ dir by validate-fixtures before the generated
// conformance suite runs. See fixtures/integration/vector-adapters.
#nullable enable
using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;

namespace Typra.Fixtures.Conformance;

public sealed class VectorContext
{
    public string Contract { get; init; } = "";
    public string Operation { get; init; } = "";
    public JsonNode? Vector { get; init; }
    public string? Provider { get; init; }
    public string? TargetApi { get; init; }
    public JsonNode? Doubles { get; init; }
    public string BaseDir { get; init; } = "";
}

public sealed class VectorException : Exception
{
    public JsonNode? Payload { get; }
    public VectorException(string message, JsonNode? payload = null)
        : base(message) { Payload = payload; }
}

public sealed class VectorAdapter
{
    public required Func<JsonNode?, VectorContext, JsonNode?> Invoke { get; init; }
    public Func<JsonNode?, VectorContext, JsonNode?>? Normalize { get; init; }
}

public static class VectorAdapters
{
    private static JsonNode? AuthorizeInvoke(JsonNode? input, VectorContext ctx) =>
        new JsonObject { ["approved"] = true };

    private static JsonNode? FormatInvoke(JsonNode? input, VectorContext ctx) =>
        input?["messages"]?.DeepClone();

    public static IReadOnlyDictionary<string, VectorAdapter> Adapters() =>
        new Dictionary<string, VectorAdapter>
        {
            ["CanonicalEnginePort.authorize"] = new VectorAdapter { Invoke = AuthorizeInvoke },
            ["CanonicalEnginePort.format"] = new VectorAdapter { Invoke = FormatInvoke },
        };

    public static IReadOnlyDictionary<string, string> Waivers() =>
        new Dictionary<string, string>();

    public static JsonNode? Doubles() => new JsonObject();
}
