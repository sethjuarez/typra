import "@typra/emitter";

namespace Typra.Fixtures;

interface EventSink {
  @runtimeCancellable
  @doc("Emit an event.")
  emit(event: unknown): void;
}

interface CheckpointStore {
  @effect(#{ atomic: true })
  @doc("Save a checkpoint.")
  save(checkpoint: Checkpoint): void;
}
