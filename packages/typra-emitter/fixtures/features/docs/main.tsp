import "@typra/emitter";

namespace Typra.Fixtures.Features.Docs;

@doc("Root model for documentation and metadata fixture coverage.")
model Root {
  @doc("Human-readable display name.")
  name: string;

  @doc("Multiline text that must preserve ordinary whitespace.")
  @sample(#{ description: "first line\nsecond line\n" })
  description: string;
}
