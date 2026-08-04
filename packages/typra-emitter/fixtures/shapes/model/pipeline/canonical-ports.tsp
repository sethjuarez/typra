import "@typra/emitter";
import "../events/session.tsp";

namespace Typra.Fixtures;

model Request {
  id: string;
}

model Decision {
  approved: boolean;
}

model Event {
  kind: string;
}

model Commit {
  id: string;
}

model Message {
  text: string;
}

@@protocol(CanonicalEnginePort);
@@method(
  CanonicalEnginePort,
  "authorize",
  "Decision",
  "Authorize a request.",
  #{ request: "Request" },
  false,
  false,
  #{ runtimeCancellable: true }
);
@@method(
  CanonicalEnginePort,
  "append",
  "void",
  "Append an event.",
  #{ event: "Event" }
);
@@method(
  CanonicalEnginePort,
  "appendWithCheckpoint",
  "void",
  "Append events and a checkpoint atomically.",
  #{ events: "Event[]", checkpoint: "Checkpoint" },
  false,
  false,
  #{ atomic: true }
);
@@method(
  CanonicalEnginePort,
  "afterCommit",
  "void",
  "Run a non-fatal post-commit effect.",
  #{ effectId: "string", commit: "Commit" },
  false,
  false,
  #{ runtimeCancellable: true, nonFatal: true }
);
@@method(
  CanonicalEnginePort,
  "format",
  "Message[]",
  "Format a value as messages.",
  #{ value: "unknown" },
  false,
  true
);
model CanonicalEnginePort {}
