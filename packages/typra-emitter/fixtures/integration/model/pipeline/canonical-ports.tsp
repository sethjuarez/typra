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

interface CanonicalEnginePort {
  @runtimeCancellable
  @doc("Authorize a request.")
  authorize(request: Request): Decision;

  @doc("Append an event.")
  append(event: Event): void;

  @effect(#{ atomic: true })
  @doc("Append events and a checkpoint atomically.")
  appendWithCheckpoint(events: Event[], checkpoint: Checkpoint): void;

  @runtimeCancellable
  @effect(#{ nonFatal: true })
  @doc("Run a non-fatal post-commit effect.")
  afterCommit(effectId: string, commit: Commit): void;

  @sync
  @doc("Format messages.")
  format(messages: Message[]): Message[];
}
