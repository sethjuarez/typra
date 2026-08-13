import "@typra/emitter";

namespace Typra.Fixtures.Features.Wire;

model Root {
  options: WireOptions;
}

@@knownAs(WireOptions.maxTokens, "openai", "max_completion_tokens");
@@knownAs(WireOptions.maxTokens, "anthropic", "max_tokens");
@@knownAs(WireOptions.stopSequences, "openai", "stop");
@@knownAs(WireOptions.stopSequences, "anthropic", "stop_sequences");
@@defaultFor(WireOptions.temperature, "openai", 0.2);
model WireOptions {
  maxTokens?: int32;
  stopSequences?: string[];
  temperature?: float32;
}
