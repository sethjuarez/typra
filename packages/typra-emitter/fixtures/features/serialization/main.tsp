import "@typra/emitter";

namespace Typra.Fixtures.Features.Serialization;

// `@serializable` marks this model as a serialization root. Load/save is emitted
// over its transitive + discriminated closure (Profile, ContentPart + variants).
@serializable
model Root {
  @sample(#{ name: "assistant", apiKey: "sk-secret-value" })
  name: string;

  // Write-only secret: injected on load, never written on save.
  @sensitive("save")
  apiKey?: string;

  // Least-privilege default (bare): never loaded, never saved.
  @sensitive
  scratch?: string;

  // Save-only: persisted but never reloaded.
  @sensitive("load")
  computedAt?: string;

  // Reaches a nested model — pulled into the closure without its own annotation.
  profile?: Profile;

  // Reaches a discriminated base — the closure expands to every variant so a
  // polymorphic load can switch on `kind`.
  parts?: ContentPart[];
}

model Profile {
  @sample(#{ title: "primary" })
  title: string;
}

@abstract
@discriminator("kind")
model ContentPart {
  kind: string;
}

model TextPart extends ContentPart {
  kind: "text";
  text: string;
}

model ImagePart extends ContentPart {
  kind: "image";
  url: string;
}

// Shape-only witness: carries `@sample` to prove its shape, but is NOT
// `@serializable` and is unreachable from any serialization root. Under the
// opt-in capability it must emit NO load/save — `@sample` alone never implies
// serialization intent (the regression this fixture locks red-first).
//
// It ALSO carries a `@knownAs` provider wire mapping. Wire conversion
// (to/from-wire) routes through the type's save/load, so a non-serialized type
// with wire mappings must emit NO wire methods either — else the generated wire
// code references pruned save/load symbols and the target fails to compile
// (the Go-only regression this fixture also locks red-first).
@@knownAs(Detached.label, "foundry", "detached_label");
model Detached {
  @sample(#{ label: "detached" })
  label: string;
}
