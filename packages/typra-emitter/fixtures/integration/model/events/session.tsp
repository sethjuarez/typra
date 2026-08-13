import "@typra/emitter";

namespace Typra.Fixtures;

model Checkpoint {
  id: string;
  label?: string;
}

model SessionSummary {
  sessionId: string;
  latestCheckpoint?: Checkpoint;
}
