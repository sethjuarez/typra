import "@typra/emitter";

namespace Typra.Fixtures.Features.Nullable;

// `T | null` on a REQUIRED property means "the key is always present on the wire,
// but its value may be null": load rejects an absent key yet accepts an explicit
// null, and save always writes the key (as null when unset). This is distinct from
// `x?: T`, which is omitted when unset. `x?: T | null` behaves like `x?: T`.
@serializable
model Root {
  row: Row;
}

alias Mood = "calm" | "busy";

model Detail {
  label: string;
}

model Row {
  @sample(#{ caption: null })
  @sample(#{ caption: "hello" })
  caption: string | null;

  count: int32 | null;
  mood: Mood | null;
  detail: Detail | null;
  tags: string[] | null;
  details: Detail[] | null;
  labels: Record<string> | null;

  // Plain optional: omitted when unset.
  note?: string;

  // Optional + nullable: same as optional (absent or null → unset, omitted on save).
  hint?: string | null;
}