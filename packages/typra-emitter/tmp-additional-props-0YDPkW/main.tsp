import "@typra/emitter";

namespace Probe;

model Root {
  row: Row;
}

model Row {
  IsKnownWireKey: string;
  ...Record<unknown>;
}
