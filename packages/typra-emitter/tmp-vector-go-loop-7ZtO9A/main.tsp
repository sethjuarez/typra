import "@typra/emitter";

namespace Typra.Proof;

model Root {
  id: string;
}

const EchoVectors = #[
  #{ name: "shout", input: #{ payload: "hi" }, expected: "HI" },
  #{ name: "empty", input: #{ payload: "" }, expectedError: #{ code: "empty" } }
];

const SumVectors = #[
  #{ name: "basic", input: #{ values: #[1, 2, 3] }, expected: 6 }
];

interface Echo {
  @vector(EchoVectors)
  echo(payload: string): string;
}

interface Sum {
  @vector(SumVectors)
  sum(values: int32[]): int32;
}
