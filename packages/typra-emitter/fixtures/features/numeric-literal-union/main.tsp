import "@typra/emitter";

namespace Typra.Fixtures.Features.NumericLiteralUnion;

@serializable
model Root {
  level?: 1 | 2 | 3;
}
