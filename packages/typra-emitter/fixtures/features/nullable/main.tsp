import "@typra/emitter";

namespace Typra.Fixtures.Features.Nullable;

// `T | null` on a REQUIRED property means "the key is always present on the wire,
// but its value may be null": load rejects an absent key yet accepts an explicit
// null, and save always writes the key (as null when unset). This is distinct from
// `x?: T`, which is omitted when unset. `x?: T | null` behaves like `x?: T`.
//
// `x: T | null = null` keeps the same save rule but lets load treat an absent key
// as null (lenient load, strict save), e.g. for legacy documents that omit it.
@serializable
model Root {
  row: Row;

  // Reached through polymorphic dispatch on `kind`: the inherited base field and the
  // variant's own nullable field must both keep the required-nullable contract.
  shape: Shape;
  shapes: Shape[];

  legacyOnly: LegacyOnly;
}

// Every nullable field has a `null` default, so load emits no missing-key guard at all
// (Go must then not import an unused `fmt`).
model LegacyOnly {
  @sample(#{ legacyNote: null })
  @sample(#{ legacyNote: "kept" })
  legacyNote: string | null = null;
}

@discriminator("kind")
model Shape {
  kind: string;

  // Inherited required-nullable field declared on the discriminated base.
  @sample(#{ label: null })
  @sample(#{ label: "unit" })
  label: string | null;

  // Inherited required-nullable field with a `null` default: absent loads as null.
  legacyLabel: string | null = null;
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
alias Combo = "other" | Mood;

model Detail {
  label: string;
}

model Row {
  @sample(#{ caption: null })
  @sample(#{ caption: "hello" })
  caption: string | null;

  count: int32 | null;
  mood: Mood | null;
  combo?: Combo | null;
  detail: Detail | null;
  tags: string[] | null;
  details: Detail[] | null;
  labels: Record<string> | null;

  // Required nullable with a `null` default: an absent key loads as null, and save
  // still always writes the key.
  legacy: string | null = null;
  legacyDetail: Detail | null = null;

  // Plain optional: omitted when unset.
  note?: string;

  // Optional + nullable: same as optional (absent or null → unset, omitted on save).
  hint?: string | null;
}