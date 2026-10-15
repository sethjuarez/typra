import "@typra/emitter";

namespace Typra.Fixtures.Features.Scalars;

model Root {
  text: string;
  flag: boolean;
  count32: int32;
  count64: int64;
  tiny: int8;
  small: int16;
  octet: uint8;
  port: uint16;
  durationMs?: uint32;
  byteSize: uint64;
  safeCount?: safeint;
  decimalLike: numeric;
  singleRatio: float32;
  ratio: float64;
  anything: unknown;
}
