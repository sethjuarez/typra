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
  @vector(#{
    name: "authorize-grants",
    stage: "callable",
    input: #{ request: #{ id: "req-1" } },
    expected: #{ approved: true }
  })
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
  @vector(#{
    name: "format-passthrough",
    stage: "callable",
    input: #{ messages: #[#{ text: "alpha" }, #{ text: "beta" }] },
    expected: #[#{ text: "alpha" }, #{ text: "beta" }]
  })
  @doc("Format messages.")
  format(messages: Message[]): Message[];
}
