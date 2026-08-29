import "@typra/emitter";

namespace Typra.Fixtures;

@serializable
model Checkpoint {
  id: string;
  label?: string;
}

@serializable
model SessionSummary {
  sessionId: string;
  latestCheckpoint?: Checkpoint;
}
