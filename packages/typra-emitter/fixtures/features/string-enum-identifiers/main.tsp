import "@typra/emitter";

namespace Typra.Fixtures.Features.StringEnumIdentifiers;

alias Odd = "kebab-case" | "with space" | "1x" | "dot.ted" | "dot ted";
alias CasePair = "UPPER" | "upper";
alias Empty = "" | "a";

@serializable
model Root {
  @sample(#{ odd: "dot ted" })
  odd: Odd;

  @sample(#{ pair: "upper" })
  pair: CasePair;

  @sample(#{ empty: "" })
  empty: Empty;
}
