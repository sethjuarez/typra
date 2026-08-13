import "@typra/emitter";

namespace Typra.Fixtures.Features.Protocols;

model Root {
  checkpoint: Checkpoint;
}

model Checkpoint {
  id: string;
  payload: Record<unknown>;
}

interface CheckpointStore {
  @runtimeCancellable
  @doc("Persist a checkpoint.")
  save(checkpoint: Checkpoint): void;

  @sync
  @doc("Load a checkpoint.")
  load(id: string): Checkpoint;

  @optionalOperation
  @effect(#{ nonFatal: true })
  @doc("Observe a checkpoint write.")
  observe(id: string): void;
}
