import "@typra/emitter";

namespace Typra.Fixtures.Features.AdditionalProperties;

// A model whose string indexer is `unknown` (`...Record<unknown>` or
// `is Record<unknown>`) passes unknown fields through: load captures every key
// that is not a declared wire key into an `additionalProperties` map, and save
// writes those entries back after the declared fields (declared fields win), so
// a document authored by a newer schema round-trips through an older client.
@serializable
model Root {
  row: Row;
  bag: Bag;
  plain: Plain;
  event: Event;
  events: Event[];
}

// Spread form. The `@encodedName` field proves known-key detection uses the wire
// key (`started_at`), not the property name (`startedAt`).
model Row {
  time: string;

  @encodedName("application/json", "started_at")
  startedAt?: string;

  ...Record<unknown>;
}

// `is` form.
model Bag is Record<unknown> {
  label: string;
}

// No indexer: unknown keys are not captured.
model Plain {
  label: string;
}

// A passthrough discriminated base: every variant inherits the passthrough, and
// the discriminator plus inherited fields count as known keys.
@discriminator("kind")
model Event {
  kind: string;

  @encodedName("application/json", "event_id")
  eventId: string;

  ...Record<unknown>;
}

model ClickEvent extends Event {
  kind: "click";
  x: int32;
}
