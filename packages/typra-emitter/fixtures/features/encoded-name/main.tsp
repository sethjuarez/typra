import "@typra/emitter";

namespace Typra.Fixtures.Features.EncodedName;

model Named<T> {
  name: string;
  ...T;
}

@serializable
model Root {
  narration: Narration;
  shapes?: Shape[];
}

// `@encodedName("application/json", ...)` renames the canonical wire key while the
// generated property keeps its idiomatic, TypeSpec-derived name.
model Narration {
  @encodedName("application/json", "duration_ms")
  @sample(#{ duration_ms: 1500 })
  durationMs?: int32;

  @encodedName("application/json", "voice_settings")
  voiceSettings?: VoiceSettings;

  @encodedName("application/json", "cue_points")
  cuePoints?: string[];

  // Only the JSON mime drives the canonical key; other encodings are ignored.
  @encodedName("application/xml", "Title")
  title?: string;

  // `@knownAs` maps the (encoded) canonical key to a provider-specific key.
  @encodedName("application/json", "max_tokens")
  maxTokens?: int32;

  // Wire keys need not be identifiers: hyphens and format-string metacharacters
  // must stay inert in every runtime's generated source.
  @encodedName("application/json", "delay-ms")
  @sample(#{ `delay-ms`: 40 })
  delayMs?: int32;

  @encodedName("application/json", "fade-out {ms} $100%")
  @sample(#{ `fade-out {ms} $100%`: 250 })
  fadeOutMs?: int32;

  @encodedName("application/json", "gain {db} %")
  gainDb: float64;

  @encodedName("application/json", "alt {voice} $")
  altVoice: VoiceSettings;

  @encodedName("application/json", "alt-cues {list}")
  altCues?: Cue[];

  // A renamed keyed dual-form collection (`Record<T> | Named<T>[]`).
  @encodedName("application/json", "cue-map {keyed} $%")
  cueMap?: Record<Cue> | Named<Cue>[];
}

model Cue {
  @encodedName("application/json", "at_ms")
  atMs: int32;
}

@@knownAs(Narration.maxTokens, "openai", "max_completion_tokens");

model VoiceSettings {
  @encodedName("application/json", "speaking_rate")
  speakingRate: float64;
}

// A renamed discriminator: polymorphic dispatch reads the encoded key.
@discriminator("shapeKind")
model Shape {
  @encodedName("application/json", "shape_kind")
  shapeKind: string;
}

model Circle extends Shape {
  // Inherits the base discriminator's encoded key without redeclaring it.
  shapeKind: "circle";

  @encodedName("application/json", "radius_px")
  radiusPx: int32;
}
