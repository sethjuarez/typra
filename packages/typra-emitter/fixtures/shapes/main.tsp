import "@typra/emitter";
import "./model/events/session.tsp";
import "./model/pipeline/harness.tsp";

namespace Typra.Fixtures;

model FixtureRoot {
  @sample(#{ name: "fixture-root" })
  @doc("Required scalar field")
  name: string;

  @sample(#{ description: "A generated fixture with broad emitter coverage." })
  @doc("Optional scalar field")
  description?: string;

  @sample(#{ tags: #["typespec", "emitter", "validation"] })
  @doc("Array of scalar tags")
  tags: string[];

  @sample(#{ metadata: #{ source: "fixture", version: 1 } })
  @doc("Dictionary-shaped metadata")
  metadata?: Record<unknown>;

  @sample(#{ owner: #{ id: "owner-1", displayName: "Fixture Owner" } })
  @doc("Nested object field")
  owner: FixtureOwner;

  @sample(#{ content: #{ kind: "text", text: "hello from a polymorphic sample" } })
  @doc("Discriminated union field")
  content: FixtureContent;

  @sample(#{ contentItems: #[#{ kind: "text", text: "hello from a polymorphic collection" }] })
  @doc("Array of discriminated union values")
  contentItems: FixtureContent[];

  @sample(#{ status: "ready" })
  @doc("Closed string union field")
  status: FixtureStatus;

  @sample(#{ mode: "batch" })
  @doc("Open string union field")
  mode?: FixtureMode;
}

model FixtureOwner {
  @sample(#{ id: "owner-1" })
  id: string;

  @sample(#{ displayName: "Fixture Owner" })
  displayName?: string;
}

@discriminator("kind")
model FixtureContent {
  kind: string;
}

model TextContent extends FixtureContent {
  kind: "text";

  @sample(#{ text: "hello from text content" })
  text: string;
}

model ImageContent extends FixtureContent {
  kind: "image";

  @sample(#{ url: "https://example.test/image.png" })
  url: string;
}

@discriminator("kind")
model FixtureProperty {
  kind: string;

  name: string;

  required: boolean;

  nullable: boolean;

  default?: unknown;

  example?: unknown;

  enumValues?: string[];

  description?: string;
}

model FixtureUnionProperty extends FixtureProperty {
  kind: "union";

  @sample(#{ members: #["one", "two"] })
  members: string[];
}

@parseAlias("ready", #["complete"])
union FixtureStatus {
  draft: "draft";
  ready: "ready";
  archived: "archived";
}

@parseAlias("batch", #["bulk"])
union FixtureMode {
  interactive: "interactive";
  batch: "batch";
  custom: string;
}

@@coerce(FixtureReference, string, #{ id: "{value}", label: "coerced reference" }, "reference", "Load a reference from an id string.", "ref-coerced");
@@factory(FixtureReference, "named", #{ id: "{id}", label: "{label}" }, #{ id: "string", label: "string" });
@@method(FixtureReference, "display", "string", "Render the reference label.", #{ prefix: "string" }, true, true);
model FixtureReference {
  @sample(#{ id: "ref-1" })
  id: string;

  @sample(#{ label: "Primary Reference" })
  label?: string;
}

model FixtureTool {
  @sample(#{ name: "search" })
  name: string;

  @sample(#{ command: "search --query" })
  command: string;
}

model FixtureToolbox {
  @sample(#{ tools: #[#{ name: "search", command: "search --query" }] })
  tools: FixtureTool[];
}

model FixtureShortcut {
  @sample(#{ reference: "ref-shortcut" })
  reference: FixtureReference;
}

model FixtureInput {
  @sample(#{ name: "input" })
  name: string;

  @sample(#{ defaultValue: "fallback" })
  defaultValue?: unknown;
}

model FixtureInputSet {
  @sample(#{ inputs: #[#{ name: "input", defaultValue: "fallback" }] })
  inputs: FixtureInput[];
}

model FixtureStopOptions {
  @sample(#{ stopSequences: #["\n"] })
  stopSequences: string[];
}

@@knownAs(WireOptions.maxOutputTokens, "openai", "max_completion_tokens");
@@knownAs(WireOptions.maxOutputTokens, "anthropic", "max_tokens");
@@knownAs(WireOptions.temperature, "openai", "temperature");
@@defaultFor(WireOptions.temperature, "openai", 0.2);
model WireOptions {
  @sample(#{ maxOutputTokens: 256 })
  maxOutputTokens?: int32;

  @sample(#{ temperature: 0.7 })
  temperature?: float32;
}
