import "@typra/emitter";

namespace Typra.Proof;

model Root {
  id: string;
}

const EchoVectors = #[
  #{ name: "shout", input: #{ payload: "hi" }, expected: "HI" },
  #{ name: "loud", input: #{ payload: "lo" }, expected: "LO" }
];

interface Echo {
  @vector(EchoVectors)
  echo(payload: string): string;
}
