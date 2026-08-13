import "@typra/emitter";

namespace Typra.Fixtures.Features.Scalars;

model Root {
  text: string;
  flag: boolean;
  count32: int32;
  count64: int64;
  decimalLike: numeric;
  singleRatio: float32;
  ratio: float64;
  anything: unknown;
}
