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

  // Built-in scalars whose JSON wire form is a string (ISO 8601 text, base64, ...)
  // render as the target's string; decimals arrive as JSON numbers and render as
  // float64 (issue #359).
  createdAt: utcDateTime;
  birthday?: plainDate;
  alarm?: plainTime;
  localStamp?: offsetDateTime;
  payload?: bytes;
  timeout?: duration;
  homepage?: url;
  price: decimal;
  bigPrice?: decimal128;
  history?: utcDateTime[];
  stamps?: Record<utcDateTime>;
}
