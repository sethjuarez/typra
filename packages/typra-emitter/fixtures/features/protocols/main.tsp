import "@typra/emitter";

namespace Typra.Fixtures.Features.Protocols;

model Root {
  checkpoint: Checkpoint;
  summary: SessionSummary;
}

model Checkpoint {
  id: string;
  payload: Record<unknown>;
}

model SessionSummary {
  id: string;
  title: string;
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

// Regression coverage for native-op optional/nullable lowering. Each operation
// pins one of the three gaps fixed alongside this fixture so the seam keeps
// carrying nullability (the `?` suffix) through to every backend renderer.
interface OptionalSeam {
  // GAP 1: an optional operation parameter must keep its optionality (lowers to
  // `Option<T>`), not drop the `?` the way it did before the fix.
  @doc("Persist an optional summary.")
  writeSummary(summary?: SessionSummary): void;

  // GAP 2: a nullable return must fold `T | null` to the seam's nullable form
  // (`Checkpoint?`); it must never leak raw union text or synthesize a phantom
  // `null` import.
  @doc("Load a checkpoint that may be absent.")
  loadCheckpoint(id: string): Checkpoint | null;

  // GAP 3: an optional, value-returning operation must lower to a typed default
  // body per backend, not a type-incorrect placeholder for its non-unit return.
  @optionalOperation
  @sync
  @doc("Optionally pre-render a prompt.")
  preRender(prompt: string): string;
}
