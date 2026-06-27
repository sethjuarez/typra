import "@typra/emitter";

namespace Typra.Fixtures;

@@protocol(EventSink);
@@method(EventSink, "emit", "void", "Emit an event.", #{ event: "unknown" }, false, true);
model EventSink {}

@@protocol(CheckpointStore);
@@method(CheckpointStore, "save", "void", "Save a checkpoint.", #{ checkpoint: "Checkpoint" }, false, false);
model CheckpointStore {}
