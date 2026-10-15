import "@typra/emitter";

namespace Typra.Fixtures.Features.Nullable;

// `T | null` on a REQUIRED property means "the key is always present on the wire,
// but its value may be null": load rejects an absent key yet accepts an explicit
// null, and save always writes the key (as null when unset). This is distinct from
// `x?: T`, which is omitted when unset. `x?: T | null` behaves like `x?: T`.
@serializable
model Root {
  row: Row;

  // Reached through polymorphic dispatch on `kind`: the inherited base field and the
  // variant's own nullable field must both keep the required-nullable contract.
  shape: Shape;
  shapes: Shape[];
}

@discriminator("kind")
model Shape {
  kind: string;

  // Inherited required-nullable field declared on the discriminated base.
  @sample(#{ label: null })
  @sample(#{ label: "unit" })
  label: string | null;
}

model Circle extends Shape {
  kind: "circle";
  radius: int32;

  // The variant's own required-nullable field.
  @sample(#{ center: null })
  @sample(#{ center: 4 })
  center: int32 | null;
}

model Square extends Shape {
  kind: "square";
  side: int32;
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